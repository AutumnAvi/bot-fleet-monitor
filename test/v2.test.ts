import { beforeEach, describe, expect, it } from "vitest";
import { containsSecret } from "../src/lib/sanitize";
import { parseSessionsPayload } from "../src/lib/validate";
import type { StateResponse } from "../src/shared/model";
import { codingNote, displayStatus, linkSessions, orphanLine } from "../src/shared/sessions";
import { meterRemaining, usageDisplayName, weeklyResetMeter } from "../src/shared/usage";
import { LEAF_KEY, READ_KEY, SESSIONS_KEY, WORK_KEY } from "./fixtures";
import { CHIEF, call, findBot, freshStore, getJson, ingest, sessionCookie, sql } from "./helpers";

beforeEach(freshStore);

function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-1",
    tool: "t3",
    title: "Reply drafts",
    status: "running",
    step: 2,
    steps: 6,
    helpers: [{ name: "lint", status: "running", step: 1, steps: 2, runtimeSec: 40 }],
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    alive: true,
    lastSeenAt: Date.now(),
    ownerBotId: CHIEF,
    ownerName: "Chief",
    account: "claudeMax",
    ...overrides,
  };
}

async function state(auth: { cookie?: string; key?: string | null }): Promise<Response> {
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (auth.key) headers.Authorization = `Bearer ${auth.key}`;
  return call("/api/v1/state", { headers });
}

describe("sessions ingest", () => {
  it("replaces the whole snapshot and never creates attention or bot reports", async () => {
    await ingest("status", { botId: CHIEF, status: "working", step: "Building" });
    const cookie = await sessionCookie();
    const before = await getJson<StateResponse>("/api/v1/state", cookie);
    const first = await ingest("sessions", { sessions: [session()] }, SESSIONS_KEY);
    expect(first.status).toBe(200);
    const second = await ingest(
      "sessions",
      {
        sessions: [
          session({
            id: "sess-2",
            title: "Other",
            status: "finished",
            step: 1,
            steps: 1,
            ownerBotId: null,
            finishedAt: Date.now(),
          }),
        ],
      },
      SESSIONS_KEY,
    );
    expect(second.status).toBe(200);

    const after = await getJson<StateResponse>("/api/v1/state", cookie);
    expect(after.sessions.map((item) => item.id)).toEqual(["sess-2"]);
    expect(after.sessions[0]).toMatchObject({ title: "Other", status: "finished", ownerBotId: null, account: "claudeMax" });
    expect(findBot(after, "work", CHIEF)).toMatchObject({ status: "working", step: "Building" });
    expect(after.activity.items.length).toBe(before.activity.items.length);
    expect(after.attention.find((item) => item.id === "sess-2")).toBeUndefined();
    expect(after.attention.every((item) => after.bots.some((bot) => bot.account === item.account && bot.id === item.id))).toBe(true);

    const cleared = await ingest("sessions", { sessions: [] }, SESSIONS_KEY);
    expect(cleared.status).toBe(200);
    expect((await getJson<StateResponse>("/api/v1/state", cookie)).sessions).toEqual([]);
  });

  it("a stale working bot stays in attention after a session snapshot, and Save for later is untouched", async () => {
    await ingest("status", { botId: CHIEF, status: "working", step: "Still going" });
    await ingest("save-for-later", { botId: CHIEF });
    const old = Date.now() - 11 * 60_000;
    await sql("UPDATE bots SET status_at = ?, last_report_at = ?, saved_at = ? WHERE account = 'work' AND id = ?", old, old, old, CHIEF);
    const posted = await ingest(
      "sessions",
      { sessions: [session({ status: "failed", title: "Should not page Avi", attentionReason: "stalled", alive: false })] },
      SESSIONS_KEY,
    );
    expect(posted.status).toBe(200);

    const cookie = await sessionCookie();
    const body = await getJson<StateResponse>("/api/v1/state", cookie);
    const chief = findBot(body, "work", CHIEF);
    expect(chief?.savedAt).toBe(old);
    expect(body.attention.find((item) => item.id === CHIEF)).toBeUndefined();

    await sql("UPDATE bots SET saved_at = NULL WHERE account = 'work' AND id = ?", CHIEF);
    const unsaved = await getJson<StateResponse>("/api/v1/state", await sessionCookie());
    expect(unsaved.attention.find((item) => item.id === CHIEF)).toMatchObject({ state: "stale", accountLabel: "Avi's Work" });
    expect(unsaved.sessions).toHaveLength(1);
  });

  it("a saved bot still returns to attention on a new waiting_user report after a session snapshot", async () => {
    await ingest("status", { botId: CHIEF, status: "waiting_user", step: "First ask" });
    await ingest("save-for-later", { botId: CHIEF });
    await ingest("sessions", { sessions: [session()] }, SESSIONS_KEY);
    expect(findBot(await getJson<StateResponse>("/api/v1/state", await sessionCookie()), "work", CHIEF)?.savedAt).not.toBeNull();
    await ingest("status", { botId: CHIEF, status: "waiting_user", step: "Asking again" });
    const body = await getJson<StateResponse>("/api/v1/state", await sessionCookie());
    expect(findBot(body, "work", CHIEF)?.savedAt).toBeNull();
    expect(body.attention.find((item) => item.id === CHIEF)?.state).toBe("waiting_user");
  });

  it("rejects secrets, bad fields and the wrong keys, and keeps the previous snapshot", async () => {
    expect((await ingest("sessions", { sessions: [session()] }, SESSIONS_KEY)).status).toBe(200);
    const secret = await ingest("sessions", { sessions: [session({ title: "sk-ant-abcdefghijklmnopqrstuvwxyz" })] }, SESSIONS_KEY);
    expect(secret.status).toBe(400);
    const secretBody = await secret.text();
    expect(secretBody).toContain("secret_rejected");
    expect(secretBody).not.toContain("sk-ant-");

    const cookie = await sessionCookie();
    expect((await getJson<StateResponse>("/api/v1/state", cookie)).sessions[0]?.title).toBe("Reply drafts");

    expect((await ingest("sessions", { sessions: [session({ tool: "vim" })] }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session()], extra: true }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session(), session({ id: "sess-1" })] }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session({ prUrl: "javascript:alert(1)" })] }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session({ prUrl: "http://example.com/pull/1" })] }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session({ pool: "Main Claude" })] }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session({ status: "stalled" })] }, SESSIONS_KEY)).status).toBe(400);
    expect((await ingest("sessions", { sessions: [session({ ci: "failing" })] }, SESSIONS_KEY)).status).toBe(400);

    for (const key of [WORK_KEY, LEAF_KEY, READ_KEY, null]) {
      const res = await ingest("sessions", { sessions: [session({ id: "nope" })] }, key);
      expect(res.status).toBe(401);
      const text = await res.text();
      if (key) expect(text).not.toContain(key);
    }
    expect((await getJson<StateResponse>("/api/v1/state", cookie)).sessions.map((item) => item.id)).toEqual(["sess-1"]);
  });

  it("rejects an oversized snapshot", async () => {
    const res = await call("/ingest/v1/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${SESSIONS_KEY}`, "Content-Type": "application/json" },
      body: `{"sessions":[]}${" ".repeat(256 * 1024)}`,
    });
    expect(res.status).toBe(413);
  });

  it("keeps an FYI attentionReason off Needs my attention", async () => {
    await ingest("status", { botId: CHIEF, status: "idle", step: "Quiet" });
    const posted = await ingest(
      "sessions",
      { sessions: [session({ attentionReason: "pr_ready", status: "running", alive: false })] },
      SESSIONS_KEY,
    );
    expect(posted.status).toBe(200);
    const body = await getJson<StateResponse>("/api/v1/state", await sessionCookie());
    expect(body.attention.find((item) => item.id === CHIEF)).toBeUndefined();
    expect(body.sessions[0]).toMatchObject({
      attentionReason: "pr_ready",
      alive: false,
      status: "running",
      helpers: [{ name: "lint", runtimeSec: 40 }],
    });
  });
});

describe("usage and grok plan", () => {
  it("stores multi-meter accounts from the sessions key only", async () => {
    const soon = Date.now() + 10 * 60 * 60 * 1000;
    const body = {
      accounts: [
        {
          id: "claudeMax",
          label: "Main Claude",
          group: "claude",
          meters: [
            { id: "5h", label: "5-hour", pctUsed: 38, resetAt: Date.now() + 3 * 60 * 60 * 1000, state: "ok" },
            { id: "weekly", label: "Weekly", pctUsed: 29, resetAt: soon },
          ],
        },
        {
          id: "claudeApi-main",
          label: "API · Main",
          group: "api",
          parentId: "claudeMax",
          meters: [],
          spend: 41,
          remaining: 209,
          granted: 250,
          routingVerified: false,
        },
      ],
    };
    expect((await ingest("usage", body, SESSIONS_KEY)).status).toBe(200);
    expect((await ingest("usage", body, WORK_KEY)).status).toBe(401);
    expect((await ingest("usage", { accounts: [{ id: "orphan", label: "API", group: "api", parentId: "missing", meters: [] }] }, SESSIONS_KEY)).status).toBe(400);
    const accounts = (await getJson<StateResponse>("/api/v1/state", await sessionCookie())).accounts;
    expect(accounts.map((account) => account.id)).toEqual(["claudeMax", "claudeApi-main"]);
    expect(accounts[0]?.meters.map((meter) => meter.id)).toEqual(["5h", "weekly"]);
    expect(accounts[1]).toMatchObject({ parentId: "claudeMax", routingVerified: false, remaining: { amount: 209 } });
  });

  it("stores Grok usage on the matching account key and ranks bots by share", async () => {
    const payload = {
      account: "work",
      pctUsed: 41,
      resetAt: Date.now() + 3 * 86_400_000,
      bots: [
        { botId: "b", name: "Beta", share: 10 },
        { botId: "a", name: "Alpha", share: 22, routinesShare: 18 },
      ],
    };
    expect((await ingest("grok-usage", payload, WORK_KEY)).status).toBe(200);
    expect((await ingest("grok-usage", payload, LEAF_KEY)).status).toBe(403);
    expect((await ingest("grok-usage", payload, SESSIONS_KEY)).status).toBe(401);
    expect((await ingest("grok-usage", { ...payload, account: "leaf" }, WORK_KEY)).status).toBe(403);
    const grok = (await getJson<StateResponse>("/api/v1/state", await sessionCookie())).grok;
    expect(grok).toHaveLength(1);
    expect(grok[0]?.account).toBe("work");
    expect(grok[0]?.bots.map((bot) => bot.botId)).toEqual(["a", "b"]);
    expect(grok[0]?.bots[0]?.routinesShare).toBe(18);
  });
});

describe("read key", () => {
  it("can read /api/v1/state and cannot write or use the other read routes", async () => {
    await ingest("status", { botId: CHIEF, status: "error", step: "Blocked" });
    const ok = await state({ key: READ_KEY });
    expect(ok.status).toBe(200);
    const body = await ok.json<StateResponse>();
    expect(body.version).toBe(2);
    expect(body.attention.find((item) => item.id === CHIEF)?.state).toBe("error");

    const cookie = await sessionCookie();
    expect((await state({ cookie })).status).toBe(200);
    expect((await state({})).status).toBe(401);

    for (const key of [WORK_KEY, LEAF_KEY, SESSIONS_KEY, "not-a-key"]) {
      const res = await state({ key });
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(key);
    }

    const fleet = await call("/api/fleet", { headers: { Authorization: `Bearer ${READ_KEY}` } });
    expect(fleet.status).toBe(401);

    const saved = await call(`/api/bots/work/${CHIEF}/saved`, {
      method: "POST",
      headers: { Authorization: `Bearer ${READ_KEY}`, "Content-Type": "application/json", Origin: "https://fleet.test" },
      body: JSON.stringify({ saved: true }),
    });
    expect(saved.status).toBe(401);
    expect(findBot(await getJson<StateResponse>("/api/v1/state", cookie), "work", CHIEF)?.savedAt).toBeNull();

    const status = await ingest("status", { botId: CHIEF, status: "idle" }, READ_KEY);
    expect(status.status).toBe(401);
    expect(findBot(await getJson<StateResponse>("/api/v1/state", cookie), "work", CHIEF)?.status).toBe("error");
  });
});

describe("session list helpers", () => {
  it("links sessions by ownerBotId and collapses missing owners", () => {
    expect(containsSecret("bfr_abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(() => parseSessionsPayload({ sessions: [session({ title: "ghp_0123456789abcdefghijABCDEFGHIJ" })] })).toThrow();
    const bots = [
      {
        account: "work" as const,
        id: CHIEF,
        name: "Chief",
        group: "Main",
        sortIndex: 0,
        status: "working" as const,
        step: "On it",
        statusAt: 1,
        summaryAt: null,
        unread: 0,
        lastAviReplyAt: null,
        lastReportAt: 1,
        savedAt: null,
        avatar: null,
      },
    ];
    const live = parseSessionsPayload({ sessions: [session({ id: "live" })] }).sessions[0];
    const orphan = parseSessionsPayload({ sessions: [session({ id: "orphan", ownerBotId: null, title: "scratch" })] }).sessions[0];
    const finished = parseSessionsPayload({ sessions: [session({ id: "done", status: "finished", step: 1, steps: 1 })] }).sessions[0];
    const stalled = parseSessionsPayload({ sessions: [session({ id: "quiet", status: "running", alive: false })] }).sessions[0];
    const paused = parseSessionsPayload({
      sessions: [session({ id: "hold", status: "paused_limit", alive: false, attentionReason: "paused_limit" })],
    }).sessions[0];
    if (!live || !orphan || !finished || !stalled || !paused) throw new Error("expected sessions");
    const linked = linkSessions([orphan, live], bots);
    expect(linked.linked.map((item) => item.bot?.name)).toEqual(["Chief"]);
    expect(orphanLine(linked.orphans)).toBe("1 unassigned (scratch)");
    expect(codingNote(linked.linked.map((item) => item.session))).toBe("⌨ 1 coding session");
    expect(codingNote([finished])).toBeNull();
    expect(displayStatus(stalled)).toBe("stalled");
    expect(displayStatus(paused)).toBe("paused_limit");
    expect(displayStatus(finished)).toBe("finished");
    expect(usageDisplayName({ id: "claudeMax", label: "Main" })).toBe("Avi's Work");
    expect(usageDisplayName({ id: "claudeAdmin", label: "Admin Claude" })).toBe("Admin");
    expect(meterRemaining({ id: "5h", label: "5-hour", pctUsed: 38, resetAt: null, state: "ok" })).toBe(62);
    expect(meterRemaining({ id: "5h", label: "5-hour", pctUsed: null, resetAt: null, state: "no_limit" })).toBeNull();
    const weekly = weeklyResetMeter(
      {
        id: "claudeMax",
        label: "Main",
        group: "claude",
        parentId: null,
        meters: [{ id: "weekly", label: "Weekly", pctUsed: 10, resetAt: Date.now() + 60 * 60 * 1000, state: "ok" }],
        spend: null,
        remaining: null,
        granted: null,
        expiresAt: null,
        verified: null,
        routingVerified: null,
        note: null,
        reportedAt: 0,
      },
      Date.now(),
    );
    expect(weekly?.id).toBe("weekly");
  });
});
