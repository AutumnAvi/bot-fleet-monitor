import { STALE_AFTER_MS, type StoredStatus } from "./model";

/** What the UI shows for a bot. `unknown` = never reported; `stale` = working but silent too long. */
export type DisplayState = StoredStatus | "unknown" | "stale";

/** The four count tiles / filter chips. */
export type Bucket = "needs_me" | "working" | "idle" | "stuck";

/** Most recent sign of life: the status report or any later summary/message/reply push. */
export function lastSeenAt(bot: { statusAt: number | null; lastReportAt?: number | null }): number | null {
  if (bot.statusAt === null) return null;
  return Math.max(bot.statusAt, bot.lastReportAt ?? 0);
}

export function displayState(
  bot: { status: StoredStatus | null; statusAt: number | null; lastReportAt?: number | null },
  now: number,
): DisplayState {
  const seen = lastSeenAt(bot);
  if (bot.status === null || seen === null) return "unknown";
  if (bot.status === "working" && now - seen >= STALE_AFTER_MS) return "stale";
  return bot.status;
}

export function bucketOf(state: DisplayState): Bucket {
  switch (state) {
    case "waiting_user":
      return "needs_me";
    case "working":
      return "working";
    case "error":
    case "stale":
      return "stuck";
    case "idle":
    case "unknown":
      return "idle";
  }
}

export const STATE_LABEL: Record<DisplayState, string> = {
  waiting_user: "Needs me",
  working: "Working",
  idle: "Idle",
  unknown: "No report yet",
  error: "Stuck",
  stale: "Stale",
};
