import { abortAllDurableObjects } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LEAF_KEY, BASE } from "./fixtures";
import { CHIEF, INTERNAL_DAM, call, findBot, fleet, freshStore, ingest, sessionCookie, sql } from "./helpers";

beforeEach(freshStore);

function saveFromDashboard(
  cookie: string | null,
  account: string,
  id: string,
  body: unknown,
  headers: Record<string, string> = { Origin: BASE },
): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (cookie !== null) h.Cookie = cookie;
  return call(`/api/bots/${account}/${encodeURIComponent(id)}/saved`, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function savedAt(id: string, account = "work"): Promise<number | null> {
  const bot = findBot(await fleet(await sessionCookie()), account, id);
  if (!bot) throw new Error("missing bot");
  return bot.savedAt;
}

describe("Save for later from a bot (ingest)", () => {
  it("save-for-later parks the bot, is idempotent, and logs one feed event", async () => {
    await ingest("status", { botId: INTERNAL_DAM, status: "waiting_user", step: "Approve cleanup" });
    expect((await ingest("save-for-later", { botId: INTERNAL_DAM })).status).toBe(200);
    const first = await savedAt(INTERNAL_DAM);
    expect(first).not.toBeNull();
    await ingest("save-for-later", { botId: INTERNAL_DAM });
    expect(await savedAt(INTERNAL_DAM)).toBe(first);
    const data = await fleet(await sessionCookie());
    expect(data.activity.items.filter((e) => e.kind === "saved")).toHaveLength(1);
  });

  it("rejects extra fields on save-for-later", async () => {
    expect((await ingest("save-for-later", { botId: CHIEF, status: "idle" })).status).toBe(400);
  });

  it("a new Needs me or Stuck report pops it back; working/idle/summary/message do not", async () => {
    await ingest("save-for-later", { botId: CHIEF });
    await ingest("status", { botId: CHIEF, status: "working", step: "Still going" });
    await ingest("status", { botId: CHIEF, status: "idle" });
    await ingest("summary", { botId: CHIEF, summary: "Halfway" });
    await ingest("message", { botId: CHIEF, text: "FYI" });
    expect(await savedAt(CHIEF)).not.toBeNull();

    await ingest("status", { botId: CHIEF, status: "waiting_user", step: "Need your OK" });
    expect(await savedAt(CHIEF)).toBeNull();

    await ingest("save-for-later", { botId: CHIEF });
    await ingest("status", { botId: CHIEF, status: "error", step: "Blocked" });
    expect(await savedAt(CHIEF)).toBeNull();
    const kinds = (await fleet(await sessionCookie())).activity.items.map((e) => e.kind);
    expect(kinds.filter((k) => k === "unsaved")).toHaveLength(2);
  });

  it("Avi replying takes it out of Save for later; saving after the reply mark keeps it saved", async () => {
    await ingest("save-for-later", { botId: CHIEF });
    await ingest("avi-replied", { botId: CHIEF });
    expect(await savedAt(CHIEF)).toBeNull();
    // The "I'll come back to you" turn: reply mark first, save last.
    await ingest("avi-replied", { botId: CHIEF });
    await ingest("save-for-later", { botId: CHIEF });
    expect(await savedAt(CHIEF)).not.toBeNull();
  });

  it("works for Leaf bots (registered with a name)", async () => {
    expect((await ingest("save-for-later", { botId: "leaf-1", name: "Leaf Helper" }, LEAF_KEY)).status).toBe(201);
    expect(await savedAt("leaf-1", "leaf")).not.toBeNull();
  });

  it("adds the column to a store created before it existed (the live v1 store)", async () => {
    await ingest("status", { botId: CHIEF, status: "idle", step: "Kept" });
    await sql("ALTER TABLE bots DROP COLUMN saved_at");
    await abortAllDurableObjects(); // restart: the constructor migrates again
    const cols = await sql<{ name: string }>("PRAGMA table_info(bots)");
    expect(cols.map((c) => c.name)).toContain("saved_at");
    const chief = findBot(await fleet(await sessionCookie()), "work", CHIEF);
    expect(chief).toMatchObject({ step: "Kept", savedAt: null });
  });
});

describe("Save for later from the dashboard", () => {
  it("saves and moves back with a session", async () => {
    const cookie = await sessionCookie();
    const res = await saveFromDashboard(cookie, "work", CHIEF, { saved: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, saved: true });
    expect(await savedAt(CHIEF)).not.toBeNull();
    expect((await saveFromDashboard(cookie, "work", CHIEF, { saved: false })).status).toBe(200);
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("requires a session, same origin, JSON and a boolean", async () => {
    const cookie = await sessionCookie();
    expect((await saveFromDashboard(null, "work", CHIEF, { saved: true })).status).toBe(401);
    expect((await saveFromDashboard(cookie, "work", CHIEF, { saved: true }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await saveFromDashboard(cookie, "work", CHIEF, { saved: "yes" })).status).toBe(400);
    expect((await saveFromDashboard(cookie, "work", CHIEF, "nope")).status).toBe(400);
    const notJson = await call(`/api/bots/work/${CHIEF}/saved`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: BASE, "Content-Type": "text/plain" },
      body: '{"saved":true}',
    });
    expect(notJson.status).toBe(415);
    expect((await call(`/api/bots/work/${CHIEF}/saved`, { headers: { Cookie: cookie } })).status).toBe(405);
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("404s unknown bots and accounts", async () => {
    const cookie = await sessionCookie();
    expect((await saveFromDashboard(cookie, "work", "no-such-bot", { saved: true })).status).toBe(404);
    expect((await saveFromDashboard(cookie, "nope", CHIEF, { saved: true })).status).toBe(404);
  });

  it("the write key cannot use the dashboard route", async () => {
    const res = await call(`/api/bots/work/${CHIEF}/saved`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LEAF_KEY}`, Origin: BASE, "Content-Type": "application/json" },
      body: '{"saved":true}',
    });
    expect(res.status).toBe(401);
  });
});
