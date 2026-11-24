// Types and limits shared by the Worker, the Durable Object and the browser client.

export const ACCOUNTS = ["work", "leaf"] as const;
export type Account = (typeof ACCOUNTS)[number];

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
  /** Activity events kept in total. */
  eventsRetained: 1000,
  eventDetailChars: 80,
  activityPageSize: 40,
} as const;

export const RATE_LIMITS = {
  /** Requests per write key per minute. */
  ingestPerKeyPerMinute: 120,
  /** Requests per bot per minute. */
  ingestPerBotPerMinute: 30,
  /** Login attempts per client IP per 15 minutes. */
  loginPerIpPer15Min: 10,
} as const;

export type EventKind =
  | "working"
  | "waiting_user"
  | "error"
  | "idle"
  | "done"
  | "summary"
  | "message"
  | "avi_replied";

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
