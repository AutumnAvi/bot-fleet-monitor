import { STALE_AFTER_MS, type StoredStatus } from "./model";

/** What the UI shows for a bot. `unknown` = never reported; `stale` = working but silent too long. */
export type DisplayState = StoredStatus | "unknown" | "stale";

/** The four count tiles / filter chips. */
export type Bucket = "needs_me" | "working" | "idle" | "stuck";

export function displayState(
  bot: { status: StoredStatus | null; statusAt: number | null },
  now: number,
): DisplayState {
  if (bot.status === null || bot.statusAt === null) return "unknown";
  if (bot.status === "working" && now - bot.statusAt >= STALE_AFTER_MS) return "stale";
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
