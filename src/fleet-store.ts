// FleetStore: the single SQLite-backed Durable Object that holds the roster, the
// latest pushed status of every bot, need-to-know summaries, message copies,
// the activity feed, dashboard sessions and rate-limit counters.
//
// It never makes outbound requests. Everything here is written by an
// authenticated bot push or read by the password-protected dashboard.

import { DurableObject } from "cloudflare:workers";
import seedFile from "../docs/roster-seed.json";
import {
  LEAF_GROUP,
  LIMITS,
  RATE_LIMITS,
  WORK_GROUPS,
  accountLabel,
  type Account,
  type ActivityItem,
  type ActivityPage,
  type AttentionItem,
  type BotDetail,
  type BotView,
  type CodingSession,
  type EventKind,
  type FleetResponse,
  type GrokBotUsage,
  type GrokUsage,
  type StateResponse,
  type StoredStatus,
  type UsageAccount,
} from "./shared/model";
import { STALE_AFTER_MS } from "./shared/model";
import { buildFleetView } from "./shared/fleet-view";
import { cleanLine } from "./lib/sanitize";
import type { GrokUsagePayload, IngestPayload, SessionsPayload, UsagePayload } from "./lib/validate";

export type IngestResult =
  | { ok: true; created: boolean }
  | { ok: false; status: number; error: string; message: string; retryAfterSec?: number };

type ResolvedBot = {
  id: string;
  status: string | null;
  step: string | null;
  summary: string | null;
  saved_at: number | null;
};

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

interface BotRow extends Record<string, SqlStorageValue> {
  account: string;
  id: string;
  name: string;
  grp: string;
  sort_index: number;
  status: string | null;
  step: string | null;
  status_at: number | null;
  summary: string | null;
  summary_at: number | null;
  last_avi_reply_at: number | null;
  last_report_at: number | null;
  saved_at: number | null;
  unread: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  grp TEXT NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 100000,
  seeded INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  step TEXT,
  status_at INTEGER,
  summary TEXT,
  summary_at INTEGER,
  last_avi_reply_at INTEGER,
  last_report_at INTEGER,
  saved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account, id)
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_bot ON messages (account, bot_id, seq);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_account ON events (account, seq);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  password_fp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_sessions (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  step INTEGER,
  steps INTEGER,
  helpers INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  owner_bot_id TEXT,
  owner_name TEXT,
  account TEXT,
  pr_url TEXT,
  ci TEXT,
  pool TEXT,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_pools (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  grp TEXT NOT NULL,
  pct_left REAL,
  pct_used REAL,
  spend TEXT,
  reset_at INTEGER,
  note TEXT,
  sort_index INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  kind TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grok_usage (
  account TEXT PRIMARY KEY,
  pct_used REAL NOT NULL,
  reset_at INTEGER,
  bots_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
`;

const MAX_SESSIONS = 20;
const HOUR_MS = 60 * 60 * 1000;

interface SeedBot {
  id?: unknown;
  name?: unknown;
  group?: unknown;
  account?: unknown;
}

/** Stable short hash of the seed roster, so a changed seed file re-applies once. */
export function seedVersion(bots: unknown): string {
  const text = JSON.stringify(bots);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export class FleetStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private lastPruneAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(() => {
      this.migrate(Date.now());
      return Promise.resolve();
    });
  }

  // ---------------------------------------------------------------- setup

  private migrate(now: number): void {
    this.sql.exec(SCHEMA);
    this.addColumnIfMissing("bots", "saved_at", "INTEGER");
    const bots = (seedFile as { bots?: unknown }).bots;
    const version = seedVersion(bots);
    const current = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seed_version'")
      .toArray()[0]?.value;
    if (current === version) return;
    this.ctx.storage.transactionSync(() => {
      this.applySeed(Array.isArray(bots) ? (bots as SeedBot[]) : [], now);
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('seed_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        version,
      );
    });
  }

  /** Additive schema change for stores created before the column existed. */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const has = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((col) => col.name === column);
    if (!has) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  /** Inserts/refreshes work-account bots from docs/roster-seed.json. Never touches status. */
  private applySeed(bots: SeedBot[], now: number): void {
    bots.forEach((bot, index) => {
      if (bot.account !== "work" || typeof bot.id !== "string" || typeof bot.name !== "string") return;
      const id = bot.id.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(id)) return;
      const group =
        typeof bot.group === "string" && (WORK_GROUPS as readonly string[]).includes(bot.group)
          ? bot.group
          : "Unassigned";
      const name = cleanLine(bot.name, LIMITS.nameChars) || id;
      this.sql.exec(
        `INSERT INTO bots (account, id, name, grp, sort_index, seeded, created_at, updated_at)
         VALUES ('work', ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (account, id) DO UPDATE SET
           name = excluded.name, grp = excluded.grp, sort_index = excluded.sort_index, seeded = 1`,
        id,
        name,
        group,
        index,
        now,
        now,
      );
    });
  }

  // ---------------------------------------------------------------- rate limits

  /** Says whether a hit would be allowed, without counting it (no write). */
  private peekRateLimit(bucket: string, limit: number, windowMs: number, now: number): RateResult {
    const row = this.sql
      .exec<{ window_start: number; count: number }>(
        "SELECT window_start, count FROM rate_limits WHERE bucket = ?",
        bucket,
      )
      .toArray()[0];
    if (!row || now - row.window_start >= windowMs || now < row.window_start || row.count < limit) {
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)) };
  }

  /** Fixed-window counter. Counts this hit and says whether it is allowed. */
  hitRateLimit(bucket: string, limit: number, windowMs: number, now: number = Date.now()): RateResult {
    const row = this.sql
      .exec<{ window_start: number; count: number }>(
        "SELECT window_start, count FROM rate_limits WHERE bucket = ?",
        bucket,
      )
      .toArray()[0];
    if (!row || now - row.window_start >= windowMs || now < row.window_start) {
      this.sql.exec(
        `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        bucket,
        now,
      );
      return { ok: true, retryAfterSec: 0 };
    }
    if (row.count >= limit) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000)) };
    }
    this.sql.exec("UPDATE rate_limits SET count = count + 1 WHERE bucket = ?", bucket);
    return { ok: true, retryAfterSec: 0 };
  }

  private pruneIfDue(now: number): void {
    if (now - this.lastPruneAt < HOUR_MS) return;
    this.lastPruneAt = now;
    this.sql.exec("DELETE FROM rate_limits WHERE window_start < ?", now - 24 * HOUR_MS);
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
  }

  // ---------------------------------------------------------------- sessions

  /**
   * `passwordFp` fingerprints the current password hash; changing the password
   * (re-setting DASHBOARD_PASSWORD_HASH) invalidates every existing session.
   */
  createSession(tokenHash: string, passwordFp: string, ttlMs: number): void {
    const now = Date.now();
    this.pruneIfDue(now);
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.sql.exec(
      `DELETE FROM sessions WHERE token_hash IN (
         SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT -1 OFFSET ?)`,
      MAX_SESSIONS - 1,
    );
    this.sql.exec(
      "INSERT INTO sessions (token_hash, password_fp, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      passwordFp,
      now,
      now + ttlMs,
    );
  }

  isSessionValid(tokenHash: string, passwordFp: string): boolean {
    const row = this.sql
      .exec<{ expires_at: number; password_fp: string }>(
        "SELECT expires_at, password_fp FROM sessions WHERE token_hash = ?",
        tokenHash,
      )
      .toArray()[0];
    return row !== undefined && row.expires_at > Date.now() && row.password_fp === passwordFp;
  }

  deleteSession(tokenHash: string): void {
    this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  // ---------------------------------------------------------------- ingest

  ingest(account: Account, payload: IngestPayload): IngestResult {
    const now = Date.now();
    this.pruneIfDue(now);

    // Per-bot limit is checked first (without counting), so a report the bot limit
    // drops never uses up the shared key budget: one runaway bot can't starve the
    // others. The per-bot counter is only written for bots that exist (or are being
    // registered), so made-up ids cannot grow the rate_limits table.
    const botBucket = `ingest:${account}:${payload.botId}`;
    const botLimit = this.peekRateLimit(botBucket, RATE_LIMITS.ingestPerBotPerMinute, 60_000, now);
    if (!botLimit.ok) return rateLimited(botLimit.retryAfterSec);
    const keyLimit = this.hitRateLimit(`ingest:${account}`, RATE_LIMITS.ingestPerKeyPerMinute, 60_000, now);
    if (!keyLimit.ok) return rateLimited(keyLimit.retryAfterSec);

    let result: IngestResult = { ok: true, created: false };
    this.ctx.storage.transactionSync(() => {
      const resolved = this.resolveBot(account, payload, now);
      if (!resolved.ok) {
        result = resolved;
        return;
      }
      this.hitRateLimit(botBucket, RATE_LIMITS.ingestPerBotPerMinute, 60_000, now);
      const bot = resolved.bot;
      switch (payload.kind) {
        case "status": {
          const stored: StoredStatus = payload.status === "done" ? "idle" : payload.status;
          this.sql.exec(
            "UPDATE bots SET status = ?, step = ?, status_at = ?, updated_at = ? WHERE account = ? AND id = ?",
            stored,
            payload.step,
            now,
            now,
            account,
            bot.id,
          );
          if (payload.status === "done" || bot.status !== stored || bot.step !== payload.step) {
            this.addEvent(account, bot.id, payload.status, payload.step, now);
          }
          // A saved bot that reports it needs Avi (or is stuck) goes back to "Needs my attention".
          if (bot.saved_at !== null && (stored === "waiting_user" || stored === "error")) {
            this.writeSaved(account, bot.id, null, now, "Needs you again");
          }
          break;
        }
        case "summary": {
          this.sql.exec(
            "UPDATE bots SET summary = ?, summary_at = ?, updated_at = ? WHERE account = ? AND id = ?",
            payload.summary,
            payload.summary === null ? null : now,
            now,
            account,
            bot.id,
          );
          if (payload.summary !== null && payload.summary !== bot.summary) {
            this.addEvent(account, bot.id, "summary", payload.summary, now);
          }
          break;
        }
        case "message": {
          this.sql.exec(
            "INSERT INTO messages (account, bot_id, text, at) VALUES (?, ?, ?, ?)",
            account,
            bot.id,
            payload.text,
            now,
          );
          this.sql.exec(
            `DELETE FROM messages WHERE account = ? AND bot_id = ? AND seq NOT IN (
               SELECT seq FROM messages WHERE account = ? AND bot_id = ? ORDER BY seq DESC LIMIT ?)`,
            account,
            bot.id,
            account,
            bot.id,
            LIMITS.messagesPerBot,
          );
          this.sql.exec("UPDATE bots SET updated_at = ? WHERE account = ? AND id = ?", now, account, bot.id);
          this.addEvent(account, bot.id, "message", payload.text, now);
          break;
        }
        case "avi-replied": {
          // Everything sent before Avi's reply has been seen; clear it.
          this.sql.exec("DELETE FROM messages WHERE account = ? AND bot_id = ?", account, bot.id);
          this.sql.exec(
            "UPDATE bots SET last_avi_reply_at = ?, updated_at = ? WHERE account = ? AND id = ?",
            now,
            now,
            account,
            bot.id,
          );
          this.addEvent(account, bot.id, "avi_replied", null, now);
          // Avi came back to this bot, so it is no longer saved for later.
          if (bot.saved_at !== null) this.writeSaved(account, bot.id, null, now, null);
          break;
        }
        case "save-for-later": {
          if (bot.saved_at === null) this.writeSaved(account, bot.id, now, now, "Avi will come back to it");
          break;
        }
      }
      // Any accepted report counts as a sign of life for the stale-working timer.
      this.sql.exec(
        "UPDATE bots SET last_report_at = ?, updated_at = ? WHERE account = ? AND id = ?",
        now,
        now,
        account,
        bot.id,
      );
      result = { ok: true, created: resolved.created };
    });
    return result;
  }

  /** Finds the bot in this account, applying name/group updates, or registers it when a name is given. */
  private resolveBot(
    account: Account,
    payload: IngestPayload,
    now: number,
  ):
    | { ok: true; created: boolean; bot: ResolvedBot }
    | Extract<IngestResult, { ok: false }> {
    const existing = this.sql
      .exec<ResolvedBot & { name: string; grp: string }>(
        "SELECT id, name, grp, status, step, summary, saved_at FROM bots WHERE account = ? AND id = ?",
        account,
        payload.botId,
      )
      .toArray()[0];

    if (existing) {
      if (payload.name !== undefined && payload.name !== existing.name) {
        this.sql.exec("UPDATE bots SET name = ? WHERE account = ? AND id = ?", payload.name, account, existing.id);
      }
      if (payload.group !== undefined && payload.group !== existing.grp) {
        this.sql.exec("UPDATE bots SET grp = ? WHERE account = ? AND id = ?", payload.group, account, existing.id);
      }
      return { ok: true, created: false, bot: existing };
    }

    if (payload.name === undefined) {
      return {
        ok: false,
        status: 404,
        error: "unknown_bot",
        message: 'Unknown botId for this account. Include "name" to register it.',
      };
    }
    const count = this.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM bots WHERE account = ?", account)
      .one().n;
    if (count >= LIMITS.botsPerAccount) {
      return {
        ok: false,
        status: 409,
        error: "bot_limit",
        message: `This account already has ${LIMITS.botsPerAccount} bots`,
      };
    }
    const group = account === "leaf" ? LEAF_GROUP : (payload.group ?? "Unassigned");
    this.sql.exec(
      `INSERT INTO bots (account, id, name, grp, sort_index, seeded, created_at, updated_at)
       VALUES (?, ?, ?, ?, 100000, 0, ?, ?)`,
      account,
      payload.botId,
      payload.name,
      group,
      now,
      now,
    );
    return { ok: true, created: true, bot: { id: payload.botId, status: null, step: null, summary: null, saved_at: null } };
  }

  /** Sets or clears "Save for later" and records it in the feed. */
  private writeSaved(account: Account, botId: string, savedAt: number | null, now: number, detail: string | null): void {
    this.sql.exec(
      "UPDATE bots SET saved_at = ?, updated_at = ? WHERE account = ? AND id = ?",
      savedAt,
      now,
      account,
      botId,
    );
    this.addEvent(account, botId, savedAt === null ? "unsaved" : "saved", detail, now);
  }

  /**
   * "Save for later" / "Move back" from the dashboard button or the Mac app.
   * Returns false for an unknown bot.
   */
  setSaved(account: Account, id: string, saved: boolean, via: "dashboard" | "app" = "dashboard"): boolean {
    const where = via === "app" ? "the Mac app" : "the dashboard";
    const now = Date.now();
    let found = false;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ saved_at: number | null }>("SELECT saved_at FROM bots WHERE account = ? AND id = ?", account, id)
        .toArray()[0];
      if (!row) return;
      found = true;
      if (saved && row.saved_at === null) this.writeSaved(account, id, now, now, `Saved from ${where}`);
      if (!saved && row.saved_at !== null) this.writeSaved(account, id, null, now, `Moved back from ${where}`);
    });
    return found;
  }

  private addEvent(account: Account, botId: string, kind: EventKind, detail: string | null, now: number): void {
    const short = detail === null ? null : cleanLine(detail, LIMITS.eventDetailChars) || null;
    this.sql.exec(
      "INSERT INTO events (account, bot_id, kind, detail, at) VALUES (?, ?, ?, ?, ?)",
      account,
      botId,
      kind,
      short,
      now,
    );
    // Trim per account, so one account's traffic can never push out the other's history.
    this.sql.exec(
      `DELETE FROM events WHERE account = ?1 AND seq <= (
         SELECT seq FROM events WHERE account = ?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)`,
      account,
      LIMITS.eventsRetained,
    );
  }

  // ---------------------------------------------------------------- snapshots
  // The collector replaces a whole list. Validation happens before these run,
  // so a rejected body never deletes the previous snapshot.

  replaceSessions(payload: SessionsPayload): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const limit = this.hitRateLimit("snapshot:sessions", LIMITS.snapshotsPerMinute, 60_000, now);
    if (!limit.ok) return { ok: false, retryAfterSec: limit.retryAfterSec };
    this.writeSnapshot("sessions", payload.sessions, now);
    return { ok: true };
  }

  replacePools(payload: UsagePayload): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const limit = this.hitRateLimit("snapshot:usage", LIMITS.snapshotsPerMinute, 60_000, now);
    if (!limit.ok) return { ok: false, retryAfterSec: limit.retryAfterSec };
    const accounts: UsageAccount[] = payload.accounts.map((account) => ({ ...account, reportedAt: now }));
    this.writeSnapshot("usage", accounts, now);
    return { ok: true };
  }

  replaceGrokUsage(account: Account, payload: GrokUsagePayload): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = Date.now();
    const limit = this.hitRateLimit(`grok:${account}`, LIMITS.grokUsagePerMinute, 60_000, now);
    if (!limit.ok) return { ok: false, retryAfterSec: limit.retryAfterSec };
    this.sql.exec(
      `INSERT INTO grok_usage (account, pct_used, reset_at, bots_json, received_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account) DO UPDATE SET
         pct_used = excluded.pct_used, reset_at = excluded.reset_at,
         bots_json = excluded.bots_json, received_at = excluded.received_at`,
      account,
      payload.pctUsed,
      payload.resetAt,
      JSON.stringify(payload.bots),
      now,
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------- reads

  private botViews(where = "", ...bindings: SqlStorageValue[]): BotView[] {
    return this.sql
      .exec<BotRow>(
        `SELECT b.account, b.id, b.name, b.grp, b.sort_index, b.status, b.step, b.status_at,
                b.summary, b.summary_at, b.last_avi_reply_at, b.last_report_at, b.saved_at,
                (SELECT COUNT(*) FROM messages m WHERE m.account = b.account AND m.bot_id = b.id) AS unread
         FROM bots b ${where}
         ORDER BY b.sort_index, b.name COLLATE NOCASE`,
        ...bindings,
      )
      .toArray()
      .map(toBotView);
  }

  /** All bots, plus the first activity page (optionally for one account only). */
  fleet(activityAccount: Account | null = null): FleetResponse {
    return {
      now: Date.now(),
      staleAfterMs: STALE_AFTER_MS,
      bots: this.botViews(),
      activity: this.activity(null, activityAccount),
    };
  }

  activity(
    before: number | null,
    account: Account | null = null,
    limit: number = LIMITS.activityPageSize,
  ): ActivityPage {
    const size = Math.max(1, Math.min(limit, 100));
    const rows = this.sql
      .exec<{
        seq: number;
        at: number;
        account: string;
        bot_id: string;
        kind: string;
        detail: string | null;
        name: string | null;
      }>(
        `SELECT e.seq, e.at, e.account, e.bot_id, e.kind, e.detail, b.name
         FROM events e LEFT JOIN bots b ON b.account = e.account AND b.id = e.bot_id
         WHERE (?1 IS NULL OR e.seq < ?1) AND (?3 IS NULL OR e.account = ?3)
         ORDER BY e.seq DESC
         LIMIT ?2`,
        before,
        size + 1,
        account,
      )
      .toArray();
    const items: ActivityItem[] = rows.slice(0, size).map((row) => ({
      seq: row.seq,
      at: row.at,
      account: row.account as Account,
      botId: row.bot_id,
      botName: row.name ?? row.bot_id,
      kind: row.kind as EventKind,
      detail: row.detail,
    }));
    const last = items[items.length - 1];
    return { items, nextBefore: rows.length > size && last ? last.seq : null };
  }

  /** Dashboard and Mac app read model. Attention is bots only; sessions are a separate list. */
  state(activityAccount: Account | null = null): StateResponse {
    const fleet = this.fleet(activityAccount);
    const view = buildFleetView(fleet.bots, { account: "both", filter: "all", query: "", now: fleet.now });
    const attention: AttentionItem[] = [];
    for (const row of view.attention ?? []) {
      if (row.state !== "waiting_user" && row.state !== "error" && row.state !== "stale") continue;
      attention.push({
        account: row.bot.account,
        accountLabel: accountLabel(row.bot.account),
        id: row.bot.id,
        name: row.bot.name,
        group: row.bot.group,
        state: row.state,
        step: row.bot.step,
        statusAt: row.bot.statusAt,
      });
    }
    return { ...fleet, version: 2, sessions: this.readSnapshot<CodingSession[]>("sessions", []), accounts: this.readSnapshot<UsageAccount[]>("usage", []), grok: this.grokUsage(), attention };
  }

  /** Full-snapshot JSON. Nested session helpers and usage meters don't fit a flat row. */
  private writeSnapshot(kind: string, body: unknown, now: number): void {
    this.sql.exec(
      `INSERT INTO snapshots (kind, body, received_at) VALUES (?, ?, ?)
       ON CONFLICT (kind) DO UPDATE SET body = excluded.body, received_at = excluded.received_at`,
      kind,
      JSON.stringify(body),
      now,
    );
  }

  private readSnapshot<T>(kind: string, fallback: T): T {
    const row = this.sql.exec<{ body: string }>("SELECT body FROM snapshots WHERE kind = ?", kind).toArray()[0];
    if (!row) return fallback;
    try {
      const parsed = JSON.parse(row.body) as unknown;
      return Array.isArray(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private grokUsage(): GrokUsage[] {
    const rows = this.sql
      .exec<{ account: string; pct_used: number; reset_at: number | null; bots_json: string; received_at: number }>(
        "SELECT account, pct_used, reset_at, bots_json, received_at FROM grok_usage",
      )
      .toArray();
    const out: GrokUsage[] = [];
    for (const row of rows) {
      if (row.account !== "work" && row.account !== "leaf") continue;
      let bots: GrokBotUsage[] = [];
      try {
        const parsed = JSON.parse(row.bots_json) as unknown;
        if (Array.isArray(parsed)) {
          bots = parsed.flatMap((item) => {
            const bot = toGrokBot(item);
            return bot ? [bot] : [];
          });
        }
      } catch {
        bots = [];
      }
      out.push({
        account: row.account,
        pctUsed: row.pct_used,
        resetAt: row.reset_at,
        reportedAt: row.received_at,
        bots,
      });
    }
    return out.sort((a, b) => (a.account === "work" ? 0 : 1) - (b.account === "work" ? 0 : 1));
  }

  botDetail(account: Account, id: string): BotDetail | null {
    const row = this.sql
      .exec<BotRow>(
        `SELECT b.account, b.id, b.name, b.grp, b.sort_index, b.status, b.step, b.status_at,
                b.summary, b.summary_at, b.last_avi_reply_at, b.last_report_at, b.saved_at,
                (SELECT COUNT(*) FROM messages m WHERE m.account = b.account AND m.bot_id = b.id) AS unread
         FROM bots b WHERE b.account = ? AND b.id = ?`,
        account,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const messages = this.sql
      .exec<{ seq: number; at: number; text: string }>(
        "SELECT seq, at, text FROM messages WHERE account = ? AND bot_id = ? ORDER BY seq ASC",
        account,
        id,
      )
      .toArray()
      .map((m) => ({ seq: m.seq, at: m.at, text: m.text }));
    return { now: Date.now(), bot: toBotView(row), summary: row.summary, messages };
  }
}

function toGrokBot(value: unknown): GrokBotUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as GrokBotUsage;
  if (typeof row.botId !== "string" || typeof row.name !== "string" || typeof row.share !== "number") return null;
  return {
    botId: row.botId,
    name: row.name,
    share: row.share,
    routinesShare: typeof row.routinesShare === "number" ? row.routinesShare : null,
  };
}

function rateLimited(retryAfterSec: number): IngestResult {
  return {
    ok: false,
    status: 429,
    error: "rate_limited",
    message: "Too many reports; this one was dropped. Do not retry in a loop.",
    retryAfterSec,
  };
}

function toBotView(row: BotRow): BotView {
  return {
    account: row.account as Account,
    id: row.id,
    name: row.name,
    group: row.grp,
    sortIndex: row.sort_index,
    status: row.status as StoredStatus | null,
    step: row.step,
    statusAt: row.status_at,
    summaryAt: row.summary_at,
    unread: row.unread,
    lastAviReplyAt: row.last_avi_reply_at,
    lastReportAt: row.last_report_at,
    savedAt: row.saved_at,
  };
}
