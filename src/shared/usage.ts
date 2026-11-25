// Usage accounts from the box collector. Several meters per account.
// API pools hang under a Claude account via parentId but still render as their own card.

import type { UsageAccount, UsageMeter } from "./model";

export const WEEKLY_RESET_WINDOW_MS = 48 * 60 * 60 * 1000;

const DISPLAY_ORDER = ["claudeMax", "claudeAdmin", "cursor", "codex"];

/** Names the top row uses. Other ids keep the collector's label. */
export function usageDisplayName(account: Pick<UsageAccount, "id" | "label">): string {
  switch (account.id) {
    case "claudeMax":
      return "Avi's Work";
    case "claudeAdmin":
      return "Admin";
    case "cursor":
      return "Cursor";
    case "codex":
      return "Codex";
    default:
      return account.label;
  }
}

export function sortUsageAccounts(accounts: readonly UsageAccount[]): UsageAccount[] {
  const rank = (account: UsageAccount): number => {
    const known = DISPLAY_ORDER.indexOf(account.id);
    if (known !== -1) return known;
    return account.group === "api" ? 100 : 50;
  };
  return [...accounts].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, "en") || a.id.localeCompare(b.id));
}

export function isWeeklyMeter(meter: UsageMeter): boolean {
  return /week/i.test(`${meter.id} ${meter.label}`);
}

export function isFiveHourMeter(meter: UsageMeter): boolean {
  return /(?:^|[^a-z0-9])5\s*-?\s*h(?:our)?s?\b|five[ -]?hour/i.test(`${meter.id} ${meter.label}`);
}

/** The meter that drives the big number: the 5-hour window, else the first non-weekly meter. */
export function primaryMeter(account: UsageAccount): UsageMeter | null {
  return account.meters.find(isFiveHourMeter) ?? account.meters.find((meter) => !isWeeklyMeter(meter)) ?? account.meters[0] ?? null;
}

/** How much of the meter is left, 0–100. Null when the meter has no percentage or no limit. */
export function meterRemaining(meter: UsageMeter): number | null {
  if (meter.state === "no_limit" || meter.pctUsed === null) return null;
  return Math.max(0, Math.min(100, Math.round((100 - meter.pctUsed) * 10) / 10));
}

/** The weekly meter's reset, only when it is still ahead and inside 48 hours. */
export function weeklyResetMeter(account: UsageAccount, now: number): UsageMeter | null {
  const weekly = account.meters.find(isWeeklyMeter);
  if (!weekly || weekly.resetAt === null) return null;
  const delta = weekly.resetAt - now;
  if (delta < 0 || delta > WEEKLY_RESET_WINDOW_MS) return null;
  return weekly;
}

export function formatMoney(value: UsageAccount["spend"]): string | null {
  if (!value) return null;
  if ("text" in value) return value.text;
  const rounded = Math.round(value.amount * 100) / 100;
  const [whole, frac] = rounded.toFixed(2).split(".");
  const commas = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === "00" ? `$${commas}` : `$${commas}.${frac ?? "00"}`;
}

export function apiRemainingRatio(account: UsageAccount): number | null {
  const remaining = account.remaining && "amount" in account.remaining ? account.remaining.amount : null;
  const granted = account.granted && "amount" in account.granted ? account.granted.amount : null;
  if (remaining === null || granted === null || granted <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((remaining / granted) * 100)));
}
