// Time formatting. All wall-clock times in the UI are shown in Asia/Hebron.

export const DISPLAY_TIME_ZONE = "Asia/Hebron";

const clockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const shortDateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
});
const fullFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

export function isSameDay(a: number, b: number): boolean {
  return dayKeyFmt.format(a) === dayKeyFmt.format(b);
}

/** "8:02 PM" today (Hebron), otherwise "Nov 23, 8:02 PM". */
export function formatClock(at: number, now: number): string {
  const clock = clockFmt.format(at);
  if (dayKeyFmt.format(at) === dayKeyFmt.format(now)) return clock;
  return `${shortDateFmt.format(at)}, ${clock}`;
}

/** "Tue, Nov 24, 8:02 PM GMT+2" in Asia/Hebron. */
export function formatFull(at: number): string {
  return fullFmt.format(at);
}

/** "just now", "4m ago", "3h ago", "2d ago". Future times (clock skew) read as "just now". */
export function formatRelative(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "now", "14m", "3h", "2d". Future times read as "now". */
export function formatShortAge(at: number, now: number): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const weekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "short",
});

/** Reset label: a clock today, a weekday within a week, otherwise "Dec 1". */
export function formatReset(at: number, now: number): string {
  if (dayKeyFmt.format(at) === dayKeyFmt.format(now)) return clockFmt.format(at);
  const days = Math.round((at - now) / 86_400_000);
  if (days >= -1 && days <= 6) return weekdayFmt.format(at);
  return shortDateFmt.format(at);
}

/** "12:49 PM (Hebron)". */
export function formatHeaderClock(now: number): string {
  return `${clockFmt.format(now)} (Hebron)`;
}

/** "14m" style duration for stale copy. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
