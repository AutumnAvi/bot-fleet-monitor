import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS, RATE_LIMITS } from "../src/shared/model";
import { LEAF_KEY, WORK_KEY } from "./fixtures";
import { CHIEF, DISK_SAVER, call, detail, findBot, fleet, freshStore, ingest, sessionCookie, sql, storeStub } from "./helpers";

beforeEach(freshStore);

describe("status updates", () => {
  it("stores status, step and server time for a seeded bot", async () => {
    const before = Date.now();
    const res = await ingest("status", { botId: CHIEF, status: "waiting_user", step: "Waiting on Avi: approve merge" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: false });
    const chief = findBot(await fleet(await sessionCookie()), "work", CHIEF);
    expect(chief).toMatchObject({ status: "waiting_user", step: "Waiting on Avi: approve merge" });
    expect(chief?.statusAt).toBeGreaterThanOrEqual(before);
  });

  it("records 'done' as an activity event, then shows the bot as idle", async () => {
    await ingest("status", { botId: CHIEF, status: "working", step: "Building" });
    await ingest("status", { botId: CHIEF, status: "done", step: "Shipped build" });
    const data = await fleet(await sessionCookie());
    expect(findBot(data, "work", CHIEF)).toMatchObject({ status: "idle", step: "Shipped build" });
    expect(data.activity.items.map((e) => [e.kind, e.detail])).toEqual([
      ["done", "Shipped build"],
      ["working", "Building"],
    ]);
  });

  it("does not add duplicate feed events for repeated identical reports", async () => {
    for (let i = 0; i < 3; i++) await ingest("status", { botId: CHIEF, status: "working", step: "Same" });
    await ingest("status", { botId: CHIEF, status: "working", step: "Next step" });
    const data = await fleet(await sessionCookie());
    expect(data.activity.items.map((e) => e.detail)).toEqual(["Next step", "Same"]);
  });

  it("clears the step when none is sent", async () => {
    await ingest("status", { botId: CHIEF, status: "working", step: "Building" });
    await ingest("status", { botId: CHIEF, status: "idle" });
    expect(findBot(await fleet(await sessionCookie()), "work", CHIEF)).toMatchObject({ status: "idle", step: null });
  });

  it("rejects unknown statuses", async () => {
    for (const status of ["stuck", "WORKING", "", 3, null]) {
      expect((await ingest("status", { botId: CHIEF, status })).status).toBe(400);
    }
  });
});

describe("sanitization and payload limits", () => {
  it("truncates the step to 80 characters and strips control/bidi characters", async () => {
    const long = "a".repeat(200);
    await ingest("status", { botId: CHIEF, status: "working", step: long });
    let chief = findBot(await fleet(await sessionCookie()), "work", CHIEF);
    expect(Array.from(chief?.step ?? "")).toHaveLength(LIMITS.stepChars);
    expect(chief?.step?.endsWith("…")).toBe(true);

    await ingest("status", { botId: CHIEF, status: "working", step: "Deploy\u0000ing‮ now\n\tplease​" });
    chief = findBot(await fleet(await sessionCookie()), "work", CHIEF);
    expect(chief?.step).toBe("Deploying now please");
  });

  it("redacts obvious credentials", async () => {
    await ingest("summary", {
      botId: CHIEF,
      summary: "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    });
    const d = await detail(await sessionCookie(), "work", CHIEF);
    expect(d.summary).not.toContain("ghp_");
    expect(d.summary).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(d.summary).toContain("[redacted]");
  });

  it("rejects invalid JSON, non-objects, wrong content type and unknown fields", async () => {
    expect((await ingest("status", "{not json")).status).toBe(400);
    expect((await ingest("status", "[1,2]")).status).toBe(400);
    expect((await ingest("status", "null")).status).toBe(400);
    expect((await ingest("status", { botId: CHIEF, status: "idle" }, WORK_KEY, { "Content-Type": "text/plain" })).status).toBe(415);
    const unknown = await ingest("status", { botId: CHIEF, status: "idle", stauts: "x" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "invalid_payload" });
    expect((await ingest("summary", { botId: CHIEF, summary: "x", step: "y" })).status).toBe(400);
  });

  it("rejects bad bot ids", async () => {
    for (const botId of ["", " ", "../etc", "a b", "x".repeat(65), 42, "-leading"]) {
      expect((await ingest("status", { botId, status: "idle" })).status).toBe(400);
    }
  });

  it("rejects oversize bodies, with or without Content-Length", async () => {
    const big = JSON.stringify({ botId: CHIEF, summary: "x".repeat(LIMITS.ingestBodyBytes) });
    const withLength = await ingest("summary", big);
    expect(withLength.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const chunked = await call("/ingest/v1/summary", {
      method: "POST",
      headers: { Authorization: `Bearer ${WORK_KEY}`, "Content-Type": "application/json" },
      body: stream,
    });
    expect(chunked.status).toBe(413);
  });

  it("rejects non-UTF-8 bodies", async () => {
    const res = await call("/ingest/v1/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${WORK_KEY}`, "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
    });
    expect(res.status).toBe(400);
  });

  it("caps summaries at a paragraph and lets an empty summary clear it", async () => {
    await ingest("summary", { botId: CHIEF, summary: `First line\n\n\n\nSecond ${"w ".repeat(500)}` });
    const cookie = await sessionCookie();
    let d = await detail(cookie, "work", CHIEF);
    expect(Array.from(d.summary ?? "").length).toBeLessThanOrEqual(LIMITS.summaryChars);
    expect(d.summary?.startsWith("First line\n\nSecond")).toBe(true);
    expect(d.bot.summaryAt).not.toBeNull();

    await ingest("summary", { botId: CHIEF, summary: "" });
    d = await detail(cookie, "work", CHIEF);
    expect(d.summary).toBeNull();
    expect(d.bot.summaryAt).toBeNull();
    expect((await ingest("summary", { botId: CHIEF })).status).toBe(400);
  });
});

describe("upsert", () => {
  it("unknown work bot without a name is rejected; with a name it is registered in Unassigned", async () => {
    const res = await ingest("status", { botId: "new-bot-1", status: "working" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_bot" });

    const created = await ingest("status", { botId: "new-bot-1", name: "New Bot", status: "working", step: "Hello" });
    expect(created.status).toBe(201);
    expect(findBot(await fleet(await sessionCookie()), "work", "new-bot-1")).toMatchObject({
      name: "New Bot",
      group: "Unassigned",
      status: "working",
    });
  });

  it("accepts a valid work group and moves/renames existing bots", async () => {
    await ingest("status", { botId: "pm-x", name: "PM X", group: "PMs", status: "idle" });
    await ingest("summary", { botId: DISK_SAVER, name: "Disk Saver 2", group: "Sub-Bots", summary: "ok" });
    const data = await fleet(await sessionCookie());
    expect(findBot(data, "work", "pm-x")).toMatchObject({ group: "PMs" });
    expect(findBot(data, "work", DISK_SAVER)).toMatchObject({ name: "Disk Saver 2", group: "Sub-Bots" });
    expect((await ingest("status", { botId: "pm-x", group: "Leaf account", status: "idle" })).status).toBe(400);
    expect((await ingest("status", { botId: "pm-x", group: "Nope", status: "idle" })).status).toBe(400);
  });

  it("Leaf bots start empty and are created by authenticated upserts with a name", async () => {
    const cookie = await sessionCookie();
    expect((await fleet(cookie)).bots.filter((b) => b.account === "leaf")).toEqual([]);

    expect((await ingest("status", { botId: "leaf-reports", status: "working" }, LEAF_KEY)).status).toBe(404);
    const res = await ingest("status", { botId: "leaf-reports", name: "Leaf Reports", status: "working", step: "Generating report" }, LEAF_KEY);
    expect(res.status).toBe(201);
    expect((await ingest("status", { botId: "leaf-reports", status: "idle" }, LEAF_KEY)).status).toBe(200);

    const leaf = (await fleet(cookie)).bots.filter((b) => b.account === "leaf");
    expect(leaf).toHaveLength(1);
    expect(leaf[0]).toMatchObject({ id: "leaf-reports", name: "Leaf Reports", group: "Leaf account", status: "idle" });
  });

  it("caps bots per account", async () => {
    await runInDurableObject(storeStub(), (_i, state) => {
      for (let i = 0; i < LIMITS.botsPerAccount; i++) {
        state.storage.sql.exec(
          "INSERT INTO bots (account, id, name, grp, created_at, updated_at) VALUES ('leaf', ?, ?, 'Leaf account', 0, 0)",
          `leaf-${i}`,
          `Leaf ${i}`,
        );
      }
    });
    const res = await ingest("status", { botId: "one-too-many", name: "Extra", status: "idle" }, LEAF_KEY);
    expect(res.status).toBe(409);
    expect((await ingest("status", { botId: "leaf-3", status: "working" }, LEAF_KEY)).status).toBe(200);
  });
});

describe("rate limits", () => {
  it("limits each bot per minute and tells the caller when to come back", async () => {
    for (let i = 0; i < RATE_LIMITS.ingestPerBotPerMinute; i++) {
      expect((await ingest("status", { botId: CHIEF, status: "working", step: `s${i}` })).status).toBe(200);
    }
    const limited = await ingest("status", { botId: CHIEF, status: "working", step: "one more" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    // Another bot on the same key is still fine.
    expect((await ingest("status", { botId: DISK_SAVER, status: "idle" })).status).toBe(200);
    // The dropped report did not change state.
    expect(findBot(await fleet(await sessionCookie()), "work", CHIEF)?.step).toBe(`s${RATE_LIMITS.ingestPerBotPerMinute - 1}`);
  });

  it("a runaway bot cannot use up the key budget and starve other bots", async () => {
    for (let i = 0; i < RATE_LIMITS.ingestPerKeyPerMinute + 5; i++) {
      await ingest("status", { botId: CHIEF, status: "working", step: `loop ${i}` });
    }
    // Only the 30 accepted reports count against the shared key budget.
    const res = await ingest("status", { botId: DISK_SAVER, status: "waiting_user", step: "Need Avi" });
    expect(res.status).toBe(200);
    const [key] = await sql<{ count: number }>("SELECT count FROM rate_limits WHERE bucket = 'ingest:work'");
    expect(key?.count).toBe(RATE_LIMITS.ingestPerBotPerMinute + 1);
  });

  it("limits each write key per minute, independently per account", async () => {
    const bots = ["a", "b", "c", "d", "e"];
    for (const id of bots) await ingest("status", { botId: id, name: id, status: "idle" });
    // 5 creates above + 115 more = 120 allowed in the window.
    for (let i = 0; i < RATE_LIMITS.ingestPerKeyPerMinute - bots.length; i++) {
      const res = await ingest("status", { botId: bots[i % bots.length], status: "working", step: `n${i}` });
      expect(res.status).toBe(200);
    }
    expect((await ingest("status", { botId: "a", status: "idle" })).status).toBe(429);
    // The Leaf key has its own budget.
    expect((await ingest("status", { botId: "l1", name: "L1", status: "idle" }, LEAF_KEY)).status).toBe(201);

    // After the window passes the key works again.
    await sql("UPDATE rate_limits SET window_start = window_start - 61000");
    expect((await ingest("status", { botId: "a", status: "idle" })).status).toBe(200);
  });

  it("the fixed-window limiter counts, blocks and resets", async () => {
    await runInDurableObject(storeStub(), (instance) => {
      const t = 1_000_000;
      expect(instance.hitRateLimit("t", 2, 1000, t).ok).toBe(true);
      expect(instance.hitRateLimit("t", 2, 1000, t + 10).ok).toBe(true);
      const blocked = instance.hitRateLimit("t", 2, 1000, t + 500);
      expect(blocked).toEqual({ ok: false, retryAfterSec: 1 });
      expect(instance.hitRateLimit("t", 2, 1000, t + 1000).ok).toBe(true);
      expect(instance.hitRateLimit("other", 2, 1000, t + 500).ok).toBe(true);
    });
  });

  it("made-up bot ids do not create rate-limit rows (bounded storage)", async () => {
    for (let i = 0; i < 50; i++) {
      expect((await ingest("status", { botId: `ghost-${i}`, status: "idle" })).status).toBe(404);
    }
    const buckets = await sql<{ bucket: string }>("SELECT bucket FROM rate_limits");
    expect(buckets.map((b) => b.bucket)).toEqual(["ingest:work"]);
    // Real bots still get their own counter.
    await ingest("status", { botId: CHIEF, status: "idle" });
    expect((await sql("SELECT bucket FROM rate_limits")).length).toBe(2);
  });

  it("invalid keys never reach storage", async () => {
    for (let i = 0; i < 5; i++) await ingest("status", { botId: CHIEF, status: "idle" }, "bad-key");
    expect(await sql("SELECT * FROM rate_limits")).toEqual([]);
  });
});
