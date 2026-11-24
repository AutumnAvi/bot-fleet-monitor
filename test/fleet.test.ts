import { abortAllDurableObjects } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import seed from "../docs/roster-seed.json";
import { seedVersion } from "../src/fleet-store";
import { buildFleetView } from "../src/shared/fleet-view";
import { LIMITS, STALE_AFTER_MS, type ActivityPage } from "../src/shared/model";
import { bucketOf, displayState } from "../src/shared/status";
import { CHIEF, DISK_SAVER, INTERNAL_DAM, call, findBot, fleet, freshStore, getJson, ingest, sessionCookie, sql } from "./helpers";

beforeEach(freshStore);

describe("roster seed", () => {
  it("seeds every work-account bot from docs/roster-seed.json, with no status", async () => {
    const data = await fleet(await sessionCookie());
    const work = data.bots.filter((b) => b.account === "work");
    expect(work).toHaveLength(seed.bots.length);
    expect(data.bots.filter((b) => b.account === "leaf")).toEqual([]);
    for (const b of work) {
      expect(b.status).toBeNull();
      expect(b.step).toBeNull();
      expect(b.statusAt).toBeNull();
    }
    expect(findBot(data, "work", CHIEF)).toMatchObject({ name: "Chief · Chief of Staff", group: "Main" });
    expect(findBot(data, "work", DISK_SAVER)).toMatchObject({ group: "Unassigned" });
    const groups = new Set(work.map((b) => b.group));
    expect([...groups].sort()).toEqual(["Asana", "Main", "PMs", "Sub-Bots", "Unassigned"]);
  });

  it("keeps the seed's order within each group", async () => {
    const data = await fleet(await sessionCookie());
    const seedOrder = seed.bots.map((b) => b.id);
    expect(data.bots.map((b) => b.id)).toEqual(seedOrder);
  });

  it("re-running the seed (restart) neither duplicates bots nor wipes status", async () => {
    await ingest("status", { botId: CHIEF, status: "working", step: "Kept" });
    await sql("DELETE FROM meta");
    await abortAllDurableObjects();
    const data = await fleet(await sessionCookie());
    expect(data.bots.filter((b) => b.account === "work")).toHaveLength(seed.bots.length);
    expect(findBot(data, "work", CHIEF)).toMatchObject({ status: "working", step: "Kept" });
  });

  it("seed version is stable for the same roster and changes when it changes", () => {
    expect(seedVersion(seed.bots)).toBe(seedVersion(JSON.parse(JSON.stringify(seed.bots))));
    expect(seedVersion(seed.bots)).not.toBe(seedVersion(seed.bots.slice(1)));
  });
});

describe("stale working timer", () => {
  it("a working report goes stale (Stuck) after 10 minutes of silence, and a fresh report clears it", async () => {
    const cookie = await sessionCookie();
    await ingest("status", { botId: CHIEF, status: "working", step: "Building" });

    let data = await fleet(cookie);
    let chief = findBot(data, "work", CHIEF);
    if (!chief) throw new Error("missing");
    expect(displayState(chief, data.now)).toBe("working");

    await sql("UPDATE bots SET status_at = ? WHERE id = ?", Date.now() - STALE_AFTER_MS - 1000, CHIEF);
    data = await fleet(cookie);
    chief = findBot(data, "work", CHIEF);
    if (!chief) throw new Error("missing");
    expect(displayState(chief, data.now)).toBe("stale");
    expect(bucketOf(displayState(chief, data.now))).toBe("stuck");
    const view = buildFleetView(data.bots, { account: "both", filter: "all", query: "", now: data.now });
    expect(view.counts.stuck).toBe(1);
    expect(view.counts.working).toBe(0);

    await ingest("status", { botId: CHIEF, status: "working", step: "Building" });
    data = await fleet(cookie);
    chief = findBot(data, "work", CHIEF);
    if (!chief) throw new Error("missing");
    expect(displayState(chief, data.now)).toBe("working");
  });

  it("idle and waiting bots never go stale", async () => {
    const cookie = await sessionCookie();
    await ingest("status", { botId: CHIEF, status: "idle" });
    await ingest("status", { botId: INTERNAL_DAM, status: "waiting_user", step: "Waiting on Avi" });
    await sql("UPDATE bots SET status_at = ? WHERE status IS NOT NULL", Date.now() - 24 * 60 * 60 * 1000);
    const data = await fleet(cookie);
    expect(displayState(findBot(data, "work", CHIEF)!, data.now)).toBe("idle");
    expect(displayState(findBot(data, "work", INTERNAL_DAM)!, data.now)).toBe("waiting_user");
  });
});

describe("activity feed", () => {
  it("is derived from ingest events, newest first, and paginates", async () => {
    const cookie = await sessionCookie();
    await ingest("status", { botId: CHIEF, status: "working", step: "Build" });
    await ingest("status", { botId: CHIEF, status: "error", step: "Auth expired" });
    await ingest("summary", { botId: CHIEF, summary: "Needs a new token" });
    await ingest("message", { botId: CHIEF, text: "Can you rotate the token?" });
    await ingest("avi-replied", { botId: CHIEF });
    await ingest("status", { botId: INTERNAL_DAM, status: "waiting_user", step: "Waiting on Avi" });

    const data = await fleet(cookie);
    expect(data.activity.items.map((e) => e.kind)).toEqual([
      "waiting_user",
      "avi_replied",
      "message",
      "summary",
      "error",
      "working",
    ]);
    expect(data.activity.items[0]).toMatchObject({ botName: "Internal DAM", account: "work", detail: "Waiting on Avi" });
    expect(data.activity.nextBefore).toBeNull();
  });

  it("pages older activity with a cursor", async () => {
    const cookie = await sessionCookie();
    const total = LIMITS.activityPageSize + 5;
    for (let i = 0; i < total; i++) {
      if (i > 0 && i % 25 === 0) await sql("DELETE FROM rate_limits");
      await ingest("status", { botId: CHIEF, status: "working", step: `step ${i}` });
    }
    const first = (await fleet(cookie)).activity;
    expect(first.items).toHaveLength(LIMITS.activityPageSize);
    expect(first.items[0]?.detail).toBe(`step ${total - 1}`);
    expect(first.nextBefore).not.toBeNull();

    const older = await getJson<ActivityPage>(`/api/activity?before=${first.nextBefore}`, cookie);
    expect(older.items.map((e) => e.detail)).toEqual(["step 4", "step 3", "step 2", "step 1", "step 0"]);
    expect(older.nextBefore).toBeNull();

    expect((await call("/api/activity?before=abc", { headers: { Cookie: cookie } })).status).toBe(400);
    expect((await call("/api/activity?before=-1", { headers: { Cookie: cookie } })).status).toBe(400);
  });

  it("keeps a bounded number of events", async () => {
    await sql(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO events (account, bot_id, kind, detail, at) SELECT 'work', ?, 'working', 'x', 0 FROM n`,
      LIMITS.eventsRetained + 50,
      CHIEF,
    );
    await ingest("status", { botId: CHIEF, status: "error", step: "boom" });
    const [{ n } = { n: 0 }] = await sql<{ n: number }>("SELECT COUNT(*) AS n FROM events");
    expect(n).toBeLessThanOrEqual(LIMITS.eventsRetained);
  });
});
