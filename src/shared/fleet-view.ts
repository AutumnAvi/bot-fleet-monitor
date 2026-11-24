// Pure view-model logic for the dashboard: filtering, grouping, counts and copy.
// Lives in shared code so it is unit-tested in the Workers test pool.

import { GROUP_ORDER, LEAF_GROUP, type ActivityItem, type BotView } from "./model";
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
  /** grokbot:// prefill link; null for Leaf-account bots (different Grok Bot login). */
  openUrl: string | null;
}

export interface GroupView {
  name: string;
  rows: BotRowView[];
  /** Shown when `rows` is empty. */
  emptyText: string | null;
}

export interface FleetView {
  counts: Record<Bucket, number>;
  /** Pinned "Needs me" rows; null when the section is hidden by the status filter. */
  needsMe: BotRowView[] | null;
  groups: GroupView[];
  /** Rows shown in total (Needs me + groups). */
  shown: number;
}

export function openUrl(bot: Pick<BotView, "account" | "id">): string | null {
  if (bot.account !== "work") return null;
  return `grokbot://app/v1/prompt?id=${encodeURIComponent(bot.id)}`;
}

export function stepText(bot: BotView, state: DisplayState, now: number): string {
  switch (state) {
    case "unknown":
      return "No report yet";
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

  const showNeedsMe = options.filter === "all" || options.filter === "needs_me";
  const needsMe = showNeedsMe
    ? visible
        .filter((row) => row.bucket === "needs_me")
        .sort((a, b) => (b.bot.statusAt ?? 0) - (a.bot.statusAt ?? 0) || byOrder(a, b))
    : null;

  const groups: GroupView[] = [];
  if (options.filter !== "needs_me") {
    for (const name of GROUP_ORDER) {
      const isLeaf = name === LEAF_GROUP;
      if (isLeaf && options.account === "work") continue;
      if (!isLeaf && options.account === "leaf") continue;
      const all = inAccount.filter((row) => row.bot.group === name);
      const rows = visible.filter((row) => row.bot.group === name && row.bucket !== "needs_me").sort(byOrder);
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
          emptyText = "Everything here is in Needs me above.";
        }
      }
      groups.push({ name, rows, emptyText });
    }
    // Bots whose group is not in GROUP_ORDER (should not happen) still get shown.
    const stray = visible.filter((row) => !GROUP_ORDER.includes(row.bot.group) && row.bucket !== "needs_me");
    if (stray.length > 0) groups.push({ name: "Other", rows: stray.sort(byOrder), emptyText: null });
  }

  const shown = (needsMe?.length ?? 0) + groups.reduce((sum, g) => sum + g.rows.length, 0);
  return { counts, needsMe, groups, shown };
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
      return "blue";
    case "idle":
    case "done":
      return "gray";
  }
}
