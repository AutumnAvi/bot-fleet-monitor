// The Mac app's control key: POST /api/v1/bots/<account>/<id>/saved and nothing else.

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE, CONTROL_KEY, LEAF_KEY, READ_KEY, SESSIONS_KEY, WORK_KEY } from "./fixtures";
import worker from "../src/worker";
import { CHIEF, call, findBot, fleet, freshStore, ingest, sessionCookie } from "./helpers";

beforeEach(freshStore);

function saveFromApp(
  key: string | null,
  account: string,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (key !== null) h.Authorization = `Bearer ${key}`;
  return call(`/api/v1/bots/${account}/${encodeURIComponent(id)}/saved`, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Calls the Worker with a different configuration (same Durable Object). */
function fetchWith(request: Request, config: Env): Promise<Response> {
  return Promise.resolve(worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, config));
}

async function savedAt(id: string, account = "work"): Promise<number | null> {
  const bot = findBot(await fleet(await sessionCookie()), account, id);
  if (!bot) throw new Error("missing bot");
  return bot.savedAt;
}

describe("Save for later from the Mac app", () => {
  it("saves and moves back with the control key, with its own feed wording", async () => {
    const res = await saveFromApp(CONTROL_KEY, "work", CHIEF, { saved: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, saved: true });
    expect(await savedAt(CHIEF)).not.toBeNull();
    // Idempotent: saving again keeps the first time and adds no event.
    expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, { saved: true })).status).toBe(200);
    expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, { saved: false })).status).toBe(200);
    expect(await savedAt(CHIEF)).toBeNull();
    const events = (await fleet(await sessionCookie())).activity.items.filter((e) => e.botId === CHIEF);
    expect(events.map((e) => [e.kind, e.detail])).toEqual([
      ["unsaved", "Moved back from the Mac app"],
      ["saved", "Saved from the Mac app"],
    ]);
  });

  it("works for Leaf bots", async () => {
    await ingest("status", { botId: "leaf-1", name: "Leaf Helper", status: "idle" }, LEAF_KEY);
    expect((await saveFromApp(CONTROL_KEY, "leaf", "leaf-1", { saved: true })).status).toBe(200);
    expect(await savedAt("leaf-1", "leaf")).not.toBeNull();
  });

  it("401 without a key or with an unknown one; 403 for every other key", async () => {
    const none = await saveFromApp(null, "work", CHIEF, { saved: true });
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect((await saveFromApp("bfc_not_the_control_key_0123456789abcdefgh", "work", CHIEF, { saved: true })).status).toBe(401);
    for (const key of [READ_KEY, WORK_KEY, LEAF_KEY, SESSIONS_KEY]) {
      const res = await saveFromApp(key, "work", CHIEF, { saved: true });
      expect(res.status, key.slice(0, 4)).toBe(403);
      expect(await res.text()).not.toContain(key);
    }
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("a dashboard cookie is not enough on the app route", async () => {
    const cookie = await sessionCookie();
    expect((await saveFromApp(null, "work", CHIEF, { saved: true }, { Cookie: cookie, Origin: BASE })).status).toBe(401);
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("404s unknown bots, accounts and malformed ids", async () => {
    expect((await saveFromApp(CONTROL_KEY, "work", "no-such-bot", { saved: true })).status).toBe(404);
    expect((await saveFromApp(CONTROL_KEY, "nope", CHIEF, { saved: true })).status).toBe(404);
    expect((await saveFromApp(CONTROL_KEY, "leaf", CHIEF, { saved: true })).status).toBe(404);
    const badId = await call("/api/v1/bots/work/%E0%A4%A/saved", {
      method: "POST",
      headers: { Authorization: `Bearer ${CONTROL_KEY}`, "Content-Type": "application/json" },
      body: '{"saved":true}',
    });
    expect(badId.status).toBe(404);
  });

  it("400 on a bad body, 415 on a non-JSON type, 413 over 256 bytes, 405 on GET", async () => {
    for (const body of ['{"saved":"yes"}', "nope", "[]", "null", "{}", '{"saved":true,"x":1}']) {
      expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, body)).status, body).toBe(400);
    }
    expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, '{"saved":true}', { "Content-Type": "text/plain" })).status).toBe(415);
    const big = JSON.stringify({ saved: true, pad: "x".repeat(300) });
    expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, big)).status).toBe(413);
    const get = await call(`/api/v1/bots/work/${CHIEF}/saved`, { headers: { Authorization: `Bearer ${CONTROL_KEY}` } });
    expect(get.status).toBe(405);
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("rate limits to 30 a minute with Retry-After", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, { saved: i % 2 === 0 })).status).toBe(200);
    }
    const limited = await saveFromApp(CONTROL_KEY, "work", CHIEF, { saved: true });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("other keys never spend the control budget", async () => {
    for (let i = 0; i < 35; i++) await saveFromApp(READ_KEY, "work", CHIEF, { saved: true });
    expect((await saveFromApp(CONTROL_KEY, "work", CHIEF, { saved: true })).status).toBe(200);
  });
});

describe("the control key can do nothing else", () => {
  const auth = { Authorization: `Bearer ${CONTROL_KEY}` };

  it("cannot read state or the dashboard routes", async () => {
    for (const path of ["/api/v1/state", "/api/fleet", "/api/activity", `/api/bots/work/${CHIEF}`]) {
      expect((await call(path, { headers: auth })).status, path).toBe(401);
    }
    const page = await call("/", { headers: auth });
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe("/login");
  });

  it("cannot use the dashboard's cookie Save route", async () => {
    const res = await call(`/api/bots/work/${CHIEF}/saved`, {
      method: "POST",
      headers: { ...auth, Origin: BASE, "Content-Type": "application/json" },
      body: '{"saved":true}',
    });
    expect(res.status).toBe(401);
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("cannot post any report or snapshot", async () => {
    const bodies: Record<string, unknown> = {
      status: { botId: CHIEF, status: "idle" },
      summary: { botId: CHIEF, summary: "x" },
      message: { botId: CHIEF, text: "x" },
      "avi-replied": { botId: CHIEF },
      "save-for-later": { botId: CHIEF },
      sessions: { sessions: [] },
      usage: { accounts: [] },
      "grok-usage": { account: "work", pctUsed: 1, resetAt: null, bots: [] },
    };
    for (const [kind, body] of Object.entries(bodies)) {
      expect((await ingest(kind, body, CONTROL_KEY)).status, kind).toBe(401);
    }
    expect(await savedAt(CHIEF)).toBeNull();
  });

  it("a control key equal to another key turns the route (and that key) off", async () => {
    for (const reused of [READ_KEY, WORK_KEY, SESSIONS_KEY]) {
      const badEnv = { ...env, CONTROL_KEY: reused };
      const req = new Request(`${BASE}/api/v1/bots/work/${CHIEF}/saved`, {
        method: "POST",
        headers: { Authorization: `Bearer ${reused}`, "Content-Type": "application/json" },
        body: '{"saved":true}',
      });
      expect((await fetchWith(req, badEnv)).status, reused.slice(0, 4)).toBe(401);
      const state = new Request(`${BASE}/api/v1/state`, { headers: { Authorization: `Bearer ${reused}` } });
      expect((await fetchWith(state, badEnv)).status).toBe(401);
    }
    expect(await savedAt(CHIEF)).toBeNull();
  });
});

describe("dashboard cookie route is unchanged", () => {
  it("still saves with a session and keeps its wording", async () => {
    const cookie = await sessionCookie();
    const res = await call(`/api/bots/work/${CHIEF}/saved`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: BASE, "Content-Type": "application/json" },
      body: '{"saved":true}',
    });
    expect(res.status).toBe(200);
    const events = (await fleet(cookie)).activity.items.filter((e) => e.botId === CHIEF);
    expect(events[0]).toMatchObject({ kind: "saved", detail: "Saved from the dashboard" });
  });
});
