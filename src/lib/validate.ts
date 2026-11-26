// Parses and validates ingest payloads. Produces clean values or a client error.

import {
  AVATAR_COLORS,
  AVATAR_SHAPES,
  INGEST_STATUSES,
  LEAF_GROUP,
  LIMITS,
  ATTENTION_REASONS,
  METER_STATES,
  POOL_GROUPS,
  REPORTED_SESSION_STATUSES,
  SESSION_TOOLS,
  USAGE_VERIFIED,
  WORK_GROUPS,
  type Account,
  type AttentionReason,
  type BotAvatar,
  type CodingSession,
  type GrokBotUsage,
  type IngestStatus,
  type MeterState,
  type MoneyValue,
  type PoolGroup,
  type ReportedSessionStatus,
  type SessionCi,
  type SessionHelper,
  type SessionTool,
  type UsageAccount,
  type UsageMeter,
  type UsageVerified,
} from "../shared/model";
import { REDACTED, cleanBlock, cleanLine, containsSecret } from "./sanitize";

export const BOT_KINDS = ["status", "summary", "message", "avi-replied", "save-for-later"] as const;
export type BotKind = (typeof BOT_KINDS)[number];
export const SNAPSHOT_KINDS = ["sessions", "usage", "grok-usage"] as const;
export const INGEST_KINDS = [...BOT_KINDS, ...SNAPSHOT_KINDS] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];

export function isIngestKind(value: string): value is IngestKind {
  return (INGEST_KINDS as readonly string[]).includes(value);
}

export function isBotKind(value: string): value is BotKind {
  return (BOT_KINDS as readonly string[]).includes(value);
}

/** Who the payload is about, plus optional upsert fields. */
export interface BotRef {
  botId: string;
  name?: string;
  group?: string;
}

export type IngestPayload =
  /**
   * `status: null` is an avatar-only report: it sets the symbol and changes nothing
   * else (no status time, no event, no sign of life).
   */
  | (BotRef & { kind: "status"; status: IngestStatus | null; step: string | null; avatar: BotAvatar | null })
  | (BotRef & { kind: "summary"; summary: string | null })
  | (BotRef & { kind: "message"; text: string })
  | (BotRef & { kind: "avi-replied" })
  | (BotRef & { kind: "save-for-later" });

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const COMMON_FIELDS = ["botId", "name", "group", "account"];
const KIND_FIELDS: Record<BotKind, string[]> = {
  status: ["status", "step", "avatar"],
  summary: ["summary"],
  message: ["text"],
  "avi-replied": [],
  "save-for-later": [],
};

function bad(message: string, code = "invalid_payload"): ClientError {
  return new ClientError(400, code, message);
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw bad(`"${key}" must be a string`);
  return value;
}

/**
 * `{shape, color}` from the fixed lists, or null. Anything else (unknown shape or
 * color, wrong type, extra keys) is ignored rather than rejected, so a bot on a newer
 * Grok Bot build never loses its status report over a look we do not know yet.
 */
export function parseAvatar(value: unknown): BotAvatar | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { shape, color } = value as { shape?: unknown; color?: unknown };
  if (typeof shape !== "string" || typeof color !== "string") return null;
  const s = shape.trim().toLowerCase();
  const c = color.trim().toLowerCase();
  if (!(AVATAR_SHAPES as readonly string[]).includes(s) || !(AVATAR_COLORS as readonly string[]).includes(c)) return null;
  return { shape: s as BotAvatar["shape"], color: c as BotAvatar["color"] };
}

export function parseIngestPayload(
  kind: BotKind,
  account: Account,
  raw: unknown,
): IngestPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bad("Body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const allowed = new Set([...COMMON_FIELDS, ...KIND_FIELDS[kind]]);
  const unknownKey = Object.keys(obj).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw bad(`Unknown field "${cleanLine(unknownKey, 40)}" for ${kind}`);
  }

  const claimedAccount = optionalString(obj, "account");
  if (claimedAccount !== undefined && claimedAccount !== account) {
    throw new ClientError(403, "account_mismatch", "This write key cannot write to that account");
  }

  const botIdRaw = optionalString(obj, "botId");
  if (botIdRaw === undefined) throw bad('"botId" is required');
  const botId = botIdRaw.trim();
  if (botId.length === 0 || botId.length > LIMITS.botIdChars || !BOT_ID.test(botId)) {
    throw bad(`"botId" must be 1-${LIMITS.botIdChars} characters of A-Z a-z 0-9 . _ : -`);
  }

  const ref: BotRef = { botId };

  const nameRaw = optionalString(obj, "name");
  if (nameRaw !== undefined) {
    const name = cleanLine(nameRaw, LIMITS.nameChars);
    if (name.length === 0) throw bad('"name" must not be empty');
    ref.name = name;
  }

  const groupRaw = optionalString(obj, "group");
  if (groupRaw !== undefined) {
    const group = groupRaw.trim();
    if (account === "leaf") {
      if (group !== LEAF_GROUP) throw bad(`Leaf-account bots always use group "${LEAF_GROUP}"`);
    } else if (!(WORK_GROUPS as readonly string[]).includes(group)) {
      throw bad(`"group" must be one of: ${WORK_GROUPS.join(", ")}`);
    }
    ref.group = group;
  }

  switch (kind) {
    case "status": {
      const avatar = parseAvatar(obj.avatar);
      const status = optionalString(obj, "status");
      const stepRaw = optionalString(obj, "step");
      // Avatar-only report (the backfill): just botId and a valid avatar. No status, step,
      // name or group, so it can never register, rename or regroup a bot.
      const avatarOnly =
        avatar !== null && !("status" in obj) && !("step" in obj) && !("name" in obj) && !("group" in obj);
      if (avatarOnly) {
        return { ...ref, kind, status: null, step: null, avatar };
      }
      if (status === undefined || !(INGEST_STATUSES as readonly string[]).includes(status)) {
        throw bad(`"status" must be one of: ${INGEST_STATUSES.join(", ")}`);
      }
      const step = stepRaw === undefined ? null : cleanLine(stepRaw, LIMITS.stepChars) || null;
      return { ...ref, kind, status: status as IngestStatus, step, avatar };
    }
    case "summary": {
      const summaryRaw = optionalString(obj, "summary");
      if (summaryRaw === undefined) throw bad('"summary" is required (send "" to clear it)');
      const summary = cleanBlock(summaryRaw, LIMITS.summaryChars) || null;
      return { ...ref, kind, summary };
    }
    case "message": {
      const textRaw = optionalString(obj, "text");
      const text = textRaw === undefined ? "" : cleanBlock(textRaw, LIMITS.messageChars);
      if (text.length === 0) throw bad('"text" is required');
      return { ...ref, kind, text };
    }
    case "avi-replied":
    case "save-for-later":
      return { ...ref, kind };
  }
}

// ---------------------------------------------------------------- snapshots

const SESSION_FIELDS = [
  "id",
  "tool",
  "title",
  "status",
  "step",
  "steps",
  "helpers",
  "startedAt",
  "updatedAt",
  "finishedAt",
  "limitReset",
  "ownerBotId",
  "ownerName",
  "account",
  "prUrl",
  "ci",
  "repo",
  "branch",
  "agentUrl",
  "model",
  "effort",
  "alive",
  "lastSeenAt",
  "attentionReason",
] as const;

const HELPER_FIELDS = ["name", "status", "step", "steps", "runtimeSec"] as const;
const CI_FIELDS = ["state", "url"] as const;
const ACCOUNT_FIELDS = [
  "id",
  "label",
  "group",
  "parentId",
  "meters",
  "spend",
  "remaining",
  "granted",
  "expiresAt",
  "verified",
  "routingVerified",
  "note",
] as const;
const METER_FIELDS = ["id", "label", "pctUsed", "resetAt", "state"] as const;
const GROK_BOT_FIELDS = ["botId", "name", "share", "routinesShare"] as const;

const SOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface SessionsPayload {
  sessions: CodingSession[];
}

export interface UsagePayload {
  accounts: Omit<UsageAccount, "reportedAt">[];
}

export interface GrokUsagePayload {
  account: Account;
  pctUsed: number;
  resetAt: number | null;
  /** When the pusher read the numbers; null means "now" (the receive time). */
  asOf: number | null;
  bots: GrokBotUsage[];
}

function secret(field: string): ClientError {
  return new ClientError(400, "secret_rejected", `Field "${field}" looks like a secret and was rejected`);
}

/** Cleans one line and refuses the field when it looks like a credential. */
function publicLine(value: string, max: number, field: string): string {
  if (containsSecret(value)) throw secret(field);
  const cleaned = cleanLine(value, max);
  if (cleaned.includes(REDACTED)) throw secret(field);
  return cleaned;
}

/** Ids are not truncated: a cut id could merge two sessions. */
function exactId(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if (containsSecret(trimmed)) throw secret(field);
  if (trimmed.length === 0 || trimmed.length > max || !BOT_ID.test(trimmed)) {
    throw bad(`"${field}" must be 1-${max} characters of A-Z a-z 0-9 . _ : -`);
  }
  return trimmed;
}

function objectBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("Body must be a JSON object");
  return raw as Record<string, unknown>;
}

function onlyFields(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const ok = new Set(allowed);
  const unknownKey = Object.keys(obj).find((key) => !ok.has(key));
  if (unknownKey !== undefined) throw bad(`Unknown field "${publicLine(unknownKey, 40, "field")}" for ${what}`);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw bad(`"${key}" must be a string`);
  return value;
}

function percent(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw bad(`"${key}" must be a number from 0 to 100`);
  }
  return Math.round(value * 10) / 10;
}

function optionalPercent(obj: Record<string, unknown>, key: string): number | null {
  if (obj[key] === undefined || obj[key] === null) return null;
  return percent(obj[key], key);
}

/** Milliseconds since epoch. Also accepts unix seconds and ISO-8601 strings. */
function timestamp(value: unknown, key: string, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw bad(`"${key}" is required`);
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1_000_000_000_000 && value <= 10_000_000_000_000) return Math.round(value);
    if (value >= 1_000_000_000 && value <= 10_000_000_000) return Math.round(value * 1000);
  }
  if (typeof value === "string" && value.length <= 40) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  throw bad(`"${key}" must be a unix timestamp in milliseconds`);
}

function count(value: unknown, key: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw bad(`"${key}" must be an integer from 0 to ${max}`);
  }
  return value;
}

function optionalCount(obj: Record<string, unknown>, key: string, max: number): number | null {
  if (obj[key] === undefined || obj[key] === null) return null;
  return count(obj[key], key, max);
}

function httpsUrl(value: string, field: string): string {
  if (containsSecret(value)) throw secret(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bad(`"${field}" must be an https URL`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw bad(`"${field}" must be an https URL`);
  }
  if (url.href.length > 300) throw bad(`"${field}" is too long`);
  if (containsSecret(url.href)) throw secret(field);
  return url.href;
}

function reportedStatus(value: unknown, key: string): ReportedSessionStatus {
  if (typeof value !== "string" || !(REPORTED_SESSION_STATUSES as readonly string[]).includes(value)) {
    throw bad(`"${key}" must be one of: ${REPORTED_SESSION_STATUSES.join(", ")}`);
  }
  return value as ReportedSessionStatus;
}

function flag(value: unknown, key: string, required: boolean): boolean | null {
  if (value === undefined || value === null) {
    if (required) throw bad(`"${key}" must be a boolean`);
    return null;
  }
  if (typeof value !== "boolean") throw bad(`"${key}" must be a boolean`);
  return value;
}

function optionalText(obj: Record<string, unknown>, key: string, max: number): string | null {
  if (obj[key] === undefined || obj[key] === null) return null;
  const text = publicLine(requireString(obj, key), max, key);
  return text.length === 0 ? null : text;
}

function optionalHttps(obj: Record<string, unknown>, key: string): string | null {
  if (obj[key] === undefined || obj[key] === null || obj[key] === "") return null;
  if (typeof obj[key] !== "string") throw bad(`"${key}" must be a string`);
  return httpsUrl(obj[key].trim(), key);
}

function sourceId(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if (containsSecret(trimmed)) throw secret(field);
  if (trimmed.length === 0 || trimmed.length > max || !SOURCE_ID.test(trimmed)) {
    throw bad(`"${field}" must be 1-${max} characters, starting with a letter (A-Z a-z 0-9 _ -)`);
  }
  return trimmed;
}

function money(value: unknown, key: string): MoneyValue | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      throw bad(`"${key}" must be a non-negative number`);
    }
    return { amount: Math.round(value * 100) / 100 };
  }
  if (typeof value === "string") {
    const text = publicLine(value, 40, key);
    if (text.length === 0) return null;
    return { text };
  }
  throw bad(`"${key}" must be a number or a string`);
}

function parseHelper(raw: unknown, index: number): SessionHelper {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad(`helpers[${index}] must be an object`);
  const obj = raw as Record<string, unknown>;
  onlyFields(obj, HELPER_FIELDS, `helpers[${index}]`);
  const name = publicLine(requireString(obj, "name"), LIMITS.nameChars, "name");
  if (name.length === 0) throw bad('"name" must not be empty');
  return {
    name,
    status: reportedStatus(obj.status, "status"),
    step: optionalCount(obj, "step", 100_000),
    steps: optionalCount(obj, "steps", 100_000),
    runtimeSec: count(obj.runtimeSec, "runtimeSec", 10_000_000),
  };
}

function parseHelpers(value: unknown): SessionHelper[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw bad('"helpers" must be an array');
  if (value.length > LIMITS.maxHelpers) throw bad(`At most ${LIMITS.maxHelpers} helpers`);
  return value.map((item, index) => parseHelper(item, index));
}

function parseCi(value: unknown): SessionCi | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw bad('"ci" must be an object');
  const obj = value as Record<string, unknown>;
  onlyFields(obj, CI_FIELDS, "ci");
  const state = publicLine(requireString(obj, "state"), LIMITS.sessionFieldChars, "state");
  if (state.length === 0) throw bad('"ci.state" must not be empty');
  return { state, url: optionalHttps(obj, "url") };
}

function parseSession(raw: unknown, index: number): CodingSession {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw bad(`sessions[${index}] must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  onlyFields(obj, SESSION_FIELDS, `sessions[${index}]`);
  const id = exactId(requireString(obj, "id"), LIMITS.sessionIdChars, "id");
  let tool: SessionTool | null = null;
  if (obj.tool !== undefined && obj.tool !== null) {
    const claimed = requireString(obj, "tool");
    if (!(SESSION_TOOLS as readonly string[]).includes(claimed)) {
      throw bad(`"tool" must be one of: ${SESSION_TOOLS.join(", ")}`);
    }
    tool = claimed as SessionTool;
  }
  const title = publicLine(requireString(obj, "title"), LIMITS.sessionTitleChars, "title");
  if (title.length === 0) throw bad('"title" must not be empty');
  const startedAt = timestamp(obj.startedAt, "startedAt", true);
  const updatedAt = timestamp(obj.updatedAt, "updatedAt", true);
  const lastSeenAt = timestamp(obj.lastSeenAt, "lastSeenAt", true);
  if (startedAt === null || updatedAt === null || lastSeenAt === null) {
    throw bad('"startedAt", "updatedAt" and "lastSeenAt" are required');
  }
  const alive = flag(obj.alive, "alive", true);
  if (alive === null) throw bad('"alive" must be a boolean');

  let ownerBotId: string | null = null;
  if (obj.ownerBotId !== undefined && obj.ownerBotId !== null) {
    ownerBotId = exactId(requireString(obj, "ownerBotId"), LIMITS.botIdChars, "ownerBotId");
  }
  let attentionReason: AttentionReason | null = null;
  if (obj.attentionReason !== undefined && obj.attentionReason !== null) {
    const reason = requireString(obj, "attentionReason");
    if (!(ATTENTION_REASONS as readonly string[]).includes(reason)) {
      throw bad(`"attentionReason" must be one of: ${ATTENTION_REASONS.join(", ")}`);
    }
    attentionReason = reason as AttentionReason;
  }
  return {
    id,
    tool,
    title,
    status: reportedStatus(obj.status, "status"),
    step: optionalCount(obj, "step", 100_000),
    steps: optionalCount(obj, "steps", 100_000),
    helpers: parseHelpers(obj.helpers),
    startedAt,
    updatedAt,
    finishedAt: timestamp(obj.finishedAt, "finishedAt", false),
    limitReset: timestamp(obj.limitReset, "limitReset", false),
    ownerBotId,
    ownerName: optionalText(obj, "ownerName", LIMITS.nameChars),
    account: sourceId(requireString(obj, "account"), LIMITS.poolIdChars, "account"),
    prUrl: optionalHttps(obj, "prUrl"),
    ci: parseCi(obj.ci),
    repo: optionalText(obj, "repo", LIMITS.sessionFieldChars),
    branch: optionalText(obj, "branch", LIMITS.sessionFieldChars),
    agentUrl: optionalHttps(obj, "agentUrl"),
    model: optionalText(obj, "model", LIMITS.sessionFieldChars),
    effort: optionalText(obj, "effort", LIMITS.sessionFieldChars),
    alive,
    lastSeenAt,
    attentionReason,
  };
}

export function parseSessionsPayload(raw: unknown): SessionsPayload {
  const obj = objectBody(raw);
  onlyFields(obj, ["sessions"], "sessions");
  if (!Array.isArray(obj.sessions)) throw bad('"sessions" must be an array');
  if (obj.sessions.length > LIMITS.maxSessions) {
    throw bad(`At most ${LIMITS.maxSessions} sessions in one snapshot`);
  }
  const sessions = obj.sessions.map((item, index) => parseSession(item, index));
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) throw bad(`Duplicate session id "${session.id}"`);
    seen.add(session.id);
  }
  return { sessions };
}

function parseMeter(raw: unknown, index: number): UsageMeter {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad(`meters[${index}] must be an object`);
  const obj = raw as Record<string, unknown>;
  onlyFields(obj, METER_FIELDS, `meters[${index}]`);
  const id = exactId(requireString(obj, "id"), LIMITS.poolIdChars, "id");
  const label = publicLine(requireString(obj, "label"), LIMITS.poolLabelChars, "label");
  if (label.length === 0) throw bad('"label" must not be empty');
  let state: MeterState = "ok";
  if (obj.state !== undefined && obj.state !== null) {
    const claimed = requireString(obj, "state");
    if (!(METER_STATES as readonly string[]).includes(claimed)) {
      throw bad(`"state" must be one of: ${METER_STATES.join(", ")}`);
    }
    state = claimed as MeterState;
  }
  return {
    id,
    label,
    pctUsed: optionalPercent(obj, "pctUsed"),
    resetAt: timestamp(obj.resetAt, "resetAt", false),
    state,
  };
}

function parseUsageAccount(raw: unknown, index: number): Omit<UsageAccount, "reportedAt"> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad(`accounts[${index}] must be an object`);
  const obj = raw as Record<string, unknown>;
  onlyFields(obj, ACCOUNT_FIELDS, `accounts[${index}]`);
  const id = sourceId(requireString(obj, "id"), LIMITS.poolIdChars, "id");
  const label = publicLine(requireString(obj, "label"), LIMITS.poolLabelChars, "label");
  if (label.length === 0) throw bad('"label" must not be empty');
  const group = requireString(obj, "group");
  if (!(POOL_GROUPS as readonly string[]).includes(group)) {
    throw bad(`"group" must be one of: ${POOL_GROUPS.join(", ")}`);
  }
  if (!Array.isArray(obj.meters)) throw bad('"meters" must be an array');
  if (obj.meters.length > LIMITS.maxMeters) throw bad(`At most ${LIMITS.maxMeters} meters`);
  const meters = obj.meters.map((item, meterIndex) => parseMeter(item, meterIndex));
  const seen = new Set<string>();
  for (const meter of meters) {
    if (seen.has(meter.id)) throw bad(`Duplicate meter id "${meter.id}"`);
    seen.add(meter.id);
  }
  let verified: UsageVerified | null = null;
  if (obj.verified !== undefined && obj.verified !== null) {
    const claimed = requireString(obj, "verified");
    if (!(USAGE_VERIFIED as readonly string[]).includes(claimed)) {
      throw bad(`"verified" must be one of: ${USAGE_VERIFIED.join(", ")}`);
    }
    verified = claimed as UsageVerified;
  }
  return {
    id,
    label,
    group: group as PoolGroup,
    parentId: obj.parentId === undefined || obj.parentId === null ? null : sourceId(requireString(obj, "parentId"), LIMITS.poolIdChars, "parentId"),
    meters,
    spend: money(obj.spend, "spend"),
    remaining: money(obj.remaining, "remaining"),
    granted: money(obj.granted, "granted"),
    expiresAt: timestamp(obj.expiresAt, "expiresAt", false),
    verified,
    routingVerified: flag(obj.routingVerified, "routingVerified", false),
    note: optionalText(obj, "note", LIMITS.sessionFieldChars),
  };
}

export function parseUsagePayload(raw: unknown): UsagePayload {
  const obj = objectBody(raw);
  onlyFields(obj, ["accounts"], "usage");
  if (!Array.isArray(obj.accounts)) throw bad('"accounts" must be an array');
  if (obj.accounts.length > LIMITS.maxUsageAccounts) throw bad(`At most ${LIMITS.maxUsageAccounts} accounts`);
  const accounts = obj.accounts.map((item, index) => parseUsageAccount(item, index));
  const ids = new Set(accounts.map((account) => account.id));
  if (ids.size !== accounts.length) throw bad("Duplicate usage account id");
  for (const account of accounts) {
    if (account.parentId !== null && !ids.has(account.parentId)) {
      throw bad(`"parentId" ${account.parentId} is not in this snapshot`);
    }
    if (account.parentId === account.id) throw bad('"parentId" cannot point at itself');
  }
  return { accounts };
}

function parseGrokBot(raw: unknown, index: number): GrokBotUsage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad(`bots[${index}] must be an object`);
  const obj = raw as Record<string, unknown>;
  onlyFields(obj, GROK_BOT_FIELDS, `bots[${index}]`);
  const botId = exactId(requireString(obj, "botId"), LIMITS.botIdChars, "botId");
  const name = publicLine(requireString(obj, "name"), LIMITS.nameChars, "name");
  if (name.length === 0) throw bad('"name" must not be empty');
  return {
    botId,
    name,
    share: percent(obj.share, "share"),
    routinesShare: optionalPercent(obj, "routinesShare"),
  };
}

export function parseGrokUsagePayload(raw: unknown, account: Account): GrokUsagePayload {
  const obj = objectBody(raw);
  onlyFields(obj, ["account", "pctUsed", "resetAt", "asOf", "bots"], "grok-usage");
  if (!("resetAt" in obj)) throw bad('"resetAt" is required');
  const claimed = optionalString(obj, "account");
  if (claimed === undefined) throw bad('"account" is required');
  if (claimed !== account) {
    throw new ClientError(403, "account_mismatch", "This write key cannot write to that account");
  }
  if (!Array.isArray(obj.bots)) throw bad('"bots" must be an array');
  if (obj.bots.length > LIMITS.maxGrokBots) throw bad(`At most ${LIMITS.maxGrokBots} bots`);
  const bots = obj.bots.map((item, index) => parseGrokBot(item, index));
  const seen = new Set<string>();
  for (const bot of bots) {
    if (seen.has(bot.botId)) throw bad(`Duplicate bot id "${bot.botId}"`);
    seen.add(bot.botId);
  }
  bots.sort((a, b) => b.share - a.share || a.name.localeCompare(b.name, "en"));
  const payload: GrokUsagePayload = {
    account,
    pctUsed: percent(obj.pctUsed, "pctUsed"),
    resetAt: timestamp(obj.resetAt, "resetAt", false),
    asOf: timestamp(obj.asOf, "asOf", false),
    bots,
  };
  return payload;
}
