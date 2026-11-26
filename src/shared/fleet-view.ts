// Pure view-model logic for the dashboard: filtering, grouping, counts and copy.
// Lives in shared code so it is unit-tested in the Workers test pool.

import { ACCOUNT_LABEL, GROUP_ORDER, LEAF_GROUP, type Account, type ActivityItem, type BotView } from "./model";
import { bucketOf, displayState, lastSeenAt, type Bucket, type DisplayState } from "./status";
import { formatDuration } from "./time";

export type AccountFilter = "both" | "work" | "leaf";
export type StatusFilter = "all" | Bucket;

export interface ViewOptions {
  account: AccountFilter;
  filter: StatusFilter;
  query: string;
  now: number;
}

export interface BotRowView {
  bot: BotView;
  state: DisplayState;
  bucket: Bucket;
  stepText: string;
  /** grokbot:// link. Opens whichever Grok Bot account the app is signed into, so the label names the account. */
  openUrl: string;
}

export interface GroupView {
  name: string;
  rows: BotRowView[];
  /** Shown when `rows` is empty. */
  emptyText: string | null;
}

export interface FleetView {
  counts: Record<Bucket, number>;
  /**
   * "Needs my attention": every Needs me or Stuck bot (including stale) that is not
   * saved for later, newest status first. Null when the status filter hides it.
   */
  attention: BotRowView[] | null;
  /** "Save for later": saved bots that pass the filters, most recently saved first. */
  saved: BotRowView[];
  /** How many bots in the selected accounts are saved, ignoring filters. */
  savedCount: number;
  /** The usual groups, without the bots shown in the two sections above. */
  groups: GroupView[];
  /** Rows shown in total (attention + saved + groups). */
  shown: number;
}

/** Buckets that pull a bot into "Needs my attention". */
export function needsAttention(bucket: Bucket): boolean {
  return bucket === "needs_me" || bucket === "stuck";
}

/** Deep link Avi clicks. The server never calls it. Both accounts use it; the label says which login. */
export function openUrl(bot: Pick<BotView, "id">): string {
  return `grokbot://app/v1/agent?id=${encodeURIComponent(bot.id)}`;
}

export function openLabel(account: Account): string {
  return account === "leaf" ? "Open in Admin" : `Open in ${ACCOUNT_LABEL.work}`;
}

export function stepText(bot: BotView, state: DisplayState, now: number): string {
  switch (state) {
    case "unknown":
      return "No status yet";
    case "stale": {
      const silent = `No update for ${formatDuration(now - (lastSeenAt(bot) ?? now))}`;
      return bot.step ? `${silent} · ${bot.step}` : silent;
    }
    case "idle":
      return bot.step ?? "Idle";
    case "working":
      return bot.step ?? "Working";
    case "waiting_user":
      return bot.step ?? "Waiting on you";
    case "error":
      return bot.step ?? "Stuck";
  }
}

export function accountMatches(account: BotView["account"], filter: AccountFilter): boolean {
  return filter === "both" || filter === account;
}

function matchesQuery(row: BotRowView, query: string): boolean {
  if (query === "") return true;
  return (
    row.bot.name.toLowerCase().includes(query) ||
    row.stepText.toLowerCase().includes(query) ||
    row.bot.group.toLowerCase().includes(query)
  );
}

function byOrder(a: BotRowView, b: BotRowView): number {
  return (
    a.bot.sortIndex - b.bot.sortIndex ||
    a.bot.name.localeCompare(b.bot.name, "en", { sensitivity: "base" }) ||
    a.bot.id.localeCompare(b.bot.id)
  );
}

export function toRow(bot: BotView, now: number): BotRowView {
  const state = displayState(bot, now);
  return { bot, state, bucket: bucketOf(state), stepText: stepText(bot, state, now), openUrl: openUrl(bot) };
}

export function buildFleetView(bots: readonly BotView[], options: ViewOptions): FleetView {
  const query = options.query.trim().toLowerCase();
  const inAccount = bots.filter((bot) => accountMatches(bot.account, options.account)).map((bot) => toRow(bot, options.now));

  const counts: Record<Bucket, number> = { needs_me: 0, working: 0, idle: 0, stuck: 0 };
  for (const row of inAccount) counts[row.bucket] += 1;

  const filtering = query !== "" || options.filter !== "all";
  const visible = inAccount.filter(
    (row) => matchesQuery(row, query) && (options.filter === "all" || row.bucket === options.filter),
  );

  const isSaved = (row: BotRowView): boolean => row.bot.savedAt !== null;
  const savedCount = inAccount.filter(isSaved).length;
  const saved = visible
    .filter(isSaved)
    .sort((a, b) => (b.bot.savedAt ?? 0) - (a.bot.savedAt ?? 0) || byOrder(a, b));

  const showAttention = options.filter === "all" || needsAttention(options.filter);
  const attention = showAttention
    ? visible
        .filter((row) => !isSaved(row) && needsAttention(row.bucket))
        .sort((a, b) => (b.bot.statusAt ?? 0) - (a.bot.statusAt ?? 0) || byOrder(a, b))
    : null;
  const inGroups = (row: BotRowView): boolean => !isSaved(row) && !needsAttention(row.bucket);

  const groups: GroupView[] = [];
  if (options.filter === "all" || !needsAttention(options.filter)) {
    for (const name of GROUP_ORDER) {
      const isLeaf = name === LEAF_GROUP;
      if (isLeaf && options.account === "work") continue;
      if (!isLeaf && options.account === "leaf") continue;
      const all = inAccount.filter((row) => row.bot.group === name);
      const rows = visible.filter((row) => row.bot.group === name && inGroups(row)).sort(byOrder);
      if (rows.length === 0) {
        if (filtering) continue;
        if (name === "Unassigned" && all.length === 0) continue;
      }
      let emptyText: string | null = null;
      if (rows.length === 0) {
        if (all.length === 0) {
          emptyText = isLeaf
            ? "No Leaf-account bots yet. They appear here after their first report."
            : "No bots in this group.";
        } else {
          emptyText = "Everything here is in Needs my attention or Save for later above.";
        }
      }
      groups.push({ name, rows, emptyText });
    }
    // Bots whose group is not in GROUP_ORDER (should not happen) still get shown.
    const stray = visible.filter((row) => !GROUP_ORDER.includes(row.bot.group) && inGroups(row));
    if (stray.length > 0) groups.push({ name: "Other", rows: stray.sort(byOrder), emptyText: null });
  }

  const shown = (attention?.length ?? 0) + saved.length + groups.reduce((sum, g) => sum + g.rows.length, 0);
  return { counts, attention, saved, savedCount, groups, shown };
}

/** Short label for an activity kind (the feed's badge). */
export function activityLabel(kind: ActivityItem["kind"]): string {
  switch (kind) {
    case "working":
      return "Working";
    case "waiting_user":
      return "Needs you";
    case "error":
      return "Stuck";
    case "idle":
      return "Idle";
    case "done":
      return "Done";
    case "summary":
      return "Summary";
    case "message":
      return "Sent you";
    case "avi_replied":
      return "You replied";
    case "saved":
      return "Saved";
    case "unsaved":
      return "Unsaved";
  }
}

/** What comes after the label: the step, the message text (quoted), or null. */
export function activityDetail(item: Pick<ActivityItem, "kind" | "detail">): string | null {
  if (item.detail === null || item.kind === "summary") return null;
  return item.kind === "message" ? `“${item.detail}”` : item.detail;
}

/** One-line feed copy without the bot name: "Needs you · Approve cleanup". */
export function activityText(item: Pick<ActivityItem, "kind" | "detail">): string {
  const detail = activityDetail(item);
  return detail === null ? activityLabel(item.kind) : `${activityLabel(item.kind)} · ${detail}`;
}

/** Which of two collapsed rows to keep: the one that asks more of Avi, then the newer. */
const KEEP_RANK: Partial<Record<ActivityItem["kind"], number>> = { error: 3, waiting_user: 2, message: 1 };

/**
 * Activity as lists show it (newest first in, newest first out). `summary` events are
 * hidden: the latest summary is already the bot's "What's happening" line. Back-to-back
 * events from the same bot with the same text (a Needs-you status and the message copy
 * that repeats it) become one row.
 */
export function visibleActivity<T extends ActivityItem>(items: readonly T[]): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (item.kind === "summary") continue;
    const prev = out[out.length - 1];
    const same =
      prev !== undefined &&
      prev.account === item.account &&
      prev.botId === item.botId &&
      (item.detail !== null ? prev.detail === item.detail : prev.detail === null && prev.kind === item.kind);
    if (!same) {
      out.push(item);
    } else if ((KEEP_RANK[item.kind] ?? 0) > (KEEP_RANK[prev.kind] ?? 0)) {
      out[out.length - 1] = item;
    }
  }
  return out;
}

/** Status color for an activity item's dot. */
export function activityTone(kind: ActivityItem["kind"]): "amber" | "green" | "gray" | "red" | "blue" {
  switch (kind) {
    case "waiting_user":
    case "message":
      return "amber";
    case "working":
      return "green";
    case "error":
      return "red";
    case "summary":
    case "avi_replied":
    case "saved":
    case "unsaved":
      return "blue";
    case "idle":
    case "done":
      return "gray";
  }
}
