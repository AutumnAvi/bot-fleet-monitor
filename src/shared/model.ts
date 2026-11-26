// Types and limits shared by the Worker, the Durable Object and the browser client.

export const ACCOUNTS = ["work", "leaf"] as const;
export type Account = (typeof ACCOUNTS)[number];

/** Names shown in the UI. Internal ids stay `work` and `leaf`. */
export const ACCOUNT_LABEL: Record<Account, string> = {
  work: "Avi's Work",
  leaf: "Admin",
};

export function accountLabel(account: Account): string {
  return ACCOUNT_LABEL[account];
}

/** Statuses a bot may report. `done` is recorded as an activity event, then stored as `idle`. */
export const INGEST_STATUSES = ["waiting_user", "working", "idle", "error", "done"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];
export type StoredStatus = Exclude<IngestStatus, "done">;

export const WORK_GROUPS = ["Main", "PMs", "Asana", "Sub-Bots", "Unassigned"] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];
export const LEAF_GROUP = "Leaf account";
/** Display order of the groups. "Unassigned" is only shown when it has bots. */
export const GROUP_ORDER: readonly string[] = [...WORK_GROUPS, LEAF_GROUP];

/** A `working` report older than this is shown as stale and counted under Stuck. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export const LIMITS = {
  /** Max request body for any ingest call (fits a 2000-char message in any script). Larger bodies get 413. */
  ingestBodyBytes: 16 * 1024,
  /** Max login form body. */
  loginBodyBytes: 1024,
  botIdChars: 64,
  nameChars: 60,
  stepChars: 80,
  summaryChars: 600,
  messageChars: 2000,
  /** Message copies kept per bot (since Avi's last reply); oldest are dropped first. */
  messagesPerBot: 30,
  /** Bots per account, including the seed. Stops a leaked key from growing storage without bound. */
  botsPerAccount: 200,
  /** Activity events kept per account. */
  eventsRetained: 1000,
  eventDetailChars: 80,
  activityPageSize: 40,
  /** Full session snapshot from the box collector. Larger than a bot report, still bounded. */
  sessionsBodyBytes: 256 * 1024,
  /** Usage and Grok-plan snapshots. */
  usageBodyBytes: 64 * 1024,
  maxSessions: 200,
  maxUsageAccounts: 24,
  maxGrokBots: 200,
  sessionIdChars: 80,
  sessionTitleChars: 120,
  sessionFieldChars: 80,
  poolIdChars: 40,
  poolLabelChars: 40,
  maxHelpers: 20,
  maxMeters: 8,
  /** Snapshot posts per minute for the sessions key (sessions and usage, separately). */
  snapshotsPerMinute: 30,
  /** Grok-plan posts per account per minute. Does not spend the bot-report budget. */
  grokUsagePerMinute: 12,
} as const;

export const SESSION_TOOLS = ["claude", "t3", "cursor", "cursor-cloud"] as const;
export type SessionTool = (typeof SESSION_TOOLS)[number];

/** Statuses the collector may send. `stalled` is not one of them; it is derived from `alive`. */
export const REPORTED_SESSION_STATUSES = [
  "running",
  "paused_limit",
  "finished",
  "failed",
  "aborted",
  "stopped",
  "in_review",
] as const;
export type ReportedSessionStatus = (typeof REPORTED_SESSION_STATUSES)[number];
export type DisplaySessionStatus = ReportedSessionStatus | "stalled";

export const ATTENTION_REASONS = ["paused_limit", "stalled", "pr_ready"] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const POOL_GROUPS = ["claude", "cursor", "codex", "api"] as const;
export type PoolGroup = (typeof POOL_GROUPS)[number];

export const METER_STATES = ["ok", "no_limit"] as const;
export type MeterState = (typeof METER_STATES)[number];

export const USAGE_VERIFIED = ["assumed", "console"] as const;
export type UsageVerified = (typeof USAGE_VERIFIED)[number];

export interface SessionHelper {
  name: string;
  status: ReportedSessionStatus;
  step: number | null;
  steps: number | null;
  runtimeSec: number;
}

export interface SessionCi {
  state: string;
  url: string | null;
}

/**
 * One coding session from the box collector. `account` is the tool source
 * (claudeMax, claudeAdmin, cursor, …), not the Grok bot account. Never a bot,
 * and never a Needs-my-attention item — `attentionReason` is an FYI badge only.
 */
export interface CodingSession {
  id: string;
  tool: SessionTool | null;
  title: string;
  status: ReportedSessionStatus;
  step: number | null;
  steps: number | null;
  helpers: SessionHelper[];
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** When a paused_limit session expects to resume. */
  limitReset: number | null;
  ownerBotId: string | null;
  ownerName: string | null;
  /** Source id: claudeMax, claudeAdmin, cursor, cursor-cloud, codex, claudeApi, … */
  account: string;
  prUrl: string | null;
  ci: SessionCi | null;
  repo: string | null;
  branch: string | null;
  agentUrl: string | null;
  model: string | null;
  effort: string | null;
  alive: boolean;
  lastSeenAt: number;
  attentionReason: AttentionReason | null;
}

export interface UsageMeter {
  id: string;
  label: string;
  pctUsed: number | null;
  resetAt: number | null;
  state: MeterState;
}

/** A number of dollars, or a short string the collector already formatted. */
export type MoneyValue = { amount: number } | { text: string };

/**
 * One usage account (Claude, Cursor, Codex, or an API pool). API pools set
 * `parentId` to the Claude account they hang under.
 */
export interface UsageAccount {
  id: string;
  label: string;
  group: PoolGroup;
  parentId: string | null;
  meters: UsageMeter[];
  spend: MoneyValue | null;
  remaining: MoneyValue | null;
  granted: MoneyValue | null;
  expiresAt: number | null;
  verified: UsageVerified | null;
  routingVerified: boolean | null;
  note: string | null;
  reportedAt: number;
}

export interface GrokBotUsage {
  botId: string;
  name: string;
  /** Share of this account's Grok usage, 0–100. */
  share: number;
  /** Portion of that share that is routines, 0–100, or null when the collector didn't say. */
  routinesShare: number | null;
}

export interface GrokUsage {
  account: Account;
  pctUsed: number;
  resetAt: number | null;
  reportedAt: number;
  bots: GrokBotUsage[];
}

/** One bot that currently needs Avi. Coding sessions are never in this list. */
export interface AttentionItem {
  account: Account;
  accountLabel: string;
  id: string;
  name: string;
  group: string;
  state: "waiting_user" | "error" | "stale";
  step: string | null;
  statusAt: number | null;
}

export const RATE_LIMITS = {
  /** Requests per write key per minute. */
  ingestPerKeyPerMinute: 120,
  /** Requests per bot per minute. */
  ingestPerBotPerMinute: 30,
  /** Login attempts per client IP per 15 minutes. */
  loginPerIpPer15Min: 10,
  /** Save-for-later changes per minute from the Mac app (control key). */
  controlSavedPerMinute: 30,
} as const;

export type EventKind =
  | "working"
  | "waiting_user"
  | "error"
  | "idle"
  | "done"
  | "summary"
  | "message"
  | "avi_replied"
  /** Parked in "Save for later" (by Avi on the dashboard, or by the bot when Avi said "later"). */
  | "saved"
  /** Back out of "Save for later": Avi un-saved it, replied, or the bot needs him again. */
  | "unsaved";

export interface BotView {
  account: Account;
  id: string;
  name: string;
  group: string;
  sortIndex: number;
  /** Last reported status, or null if the bot has never reported. */
  status: StoredStatus | null;
  step: string | null;
  /** Server time (ms) of the last status report. */
  statusAt: number | null;
  summaryAt: number | null;
  /** Message copies received since Avi's last reply. */
  unread: number;
  lastAviReplyAt: number | null;
  /** Server time (ms) of the last accepted report of any kind (status, summary, message, reply mark). */
  lastReportAt: number | null;
  /** Server time (ms) the bot was put in "Save for later"; null when it is not saved. */
  savedAt: number | null;
}

export interface ActivityItem {
  seq: number;
  at: number;
  account: Account;
  botId: string;
  botName: string;
  kind: EventKind;
  detail: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `before` to load older items; null when there are none. */
  nextBefore: number | null;
}

export interface FleetResponse {
  /** Server clock (ms) when the response was built. */
  now: number;
  staleAfterMs: number;
  bots: BotView[];
  activity: ActivityPage;
}

/** GET /api/v1/state. Cookie session or the read-only key. */
export interface StateResponse extends FleetResponse {
  version: 2;
  sessions: CodingSession[];
  accounts: UsageAccount[];
  grok: GrokUsage[];
  /** Needs-my-attention bots across both accounts. Saved bots are excluded. Sessions are never included. */
  attention: AttentionItem[];
}

export interface MessageCopy {
  seq: number;
  at: number;
  text: string;
}

export interface BotDetail {
  now: number;
  bot: BotView;
  summary: string | null;
  /** Oldest first. Only messages since Avi's last reply. */
  messages: MessageCopy[];
}
