// Types for scripts/lib/grok-usage.mjs (used by the tests).

export interface GrokBotRow {
  botId: string;
  name: string;
  share: number;
  routinesShare?: number;
}
export interface GrokUsageBody {
  account: "work" | "leaf";
  pctUsed: number;
  resetAt: number | null;
  asOf?: number;
  bots: GrokBotRow[];
}
export interface RosterEntry {
  id: string;
  name: string;
}

export const MAX_GROK_BOTS: number;
export const NAME_CHARS: number;
export const OTHER_ID: string;
export const OTHER_NAME: string;
export class SnapshotError extends Error {}
export function normalizeName(name: string): string;
export function toMillis(value: unknown, field: string): number | null;
export function rosterIndex(
  bots: unknown[],
  account: string,
): { byId: Map<string, RosterEntry>; byName: Map<string, RosterEntry | null> };
export function buildGrokUsage(snapshot: unknown, rosterBots: unknown[]): { body: GrokUsageBody; notes: string[] };
