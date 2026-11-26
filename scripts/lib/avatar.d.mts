// Types for scripts/lib/avatar.mjs (used by the tests).

export interface Avatar {
  shape: string;
  color: string;
}
export interface RosterBot {
  id: string;
  name: string;
}
export interface PlanRow extends RosterBot {
  body: { botId: string; avatar: Avatar } | null;
  reason: string | null;
}

export const AVATAR_SHAPES: string[];
export const AVATAR_COLORS: string[];
export const BOT_ID: RegExp;
export function avatarFromProfile(profile: unknown): Avatar | null;
export function rosterFor(bots: unknown[], account: string): RosterBot[];
export function backfillPlan(roster: RosterBot[], profiles: Map<string, unknown>): PlanRow[];
