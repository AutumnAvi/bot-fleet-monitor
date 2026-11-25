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

/** Feed copy for one activity item (without the bot name). */
export function activityText(item: Pick<ActivityItem, "kind" | "detail">): string {
  const d = item.detail;
  switch (item.kind) {
    case "working":
      return d ?? "Started working";
    case "waiting_user":
      return d ? `Needs you: ${d}` : "Needs you";
    case "error":
      return d ? `Stuck: ${d}` : "Stuck";
    case "idle":
      return d ? `Idle · ${d}` : "Went idle";
    case "done":
      return d ? `Finished: ${d}` : "Finished";
    case "summary":
      return "Updated need-to-know";
    case "message":
      return d ? `Messaged you: “${d}”` : "Messaged you";
    case "avi_replied":
      return "You replied";
    case "saved":
      return d ? `Saved for later · ${d}` : "Saved for later";
    case "unsaved":
      return d ? `Back from Save for later · ${d}` : "Back from Save for later";
  }
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
