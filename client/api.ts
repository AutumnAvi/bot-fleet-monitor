// Read-only calls to this dashboard's own Worker. Nothing here talks to a bot.

import type { ActivityPage, BotDetail, FleetResponse } from "../src/shared/model";

export class SignedOutError extends Error {}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (res.status === 401) throw new SignedOutError("signed out");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export function fetchFleet(): Promise<FleetResponse> {
  return getJson<FleetResponse>("/api/fleet");
}

export function fetchActivity(before: number): Promise<ActivityPage> {
  return getJson<ActivityPage>(`/api/activity?before=${before}`);
}

export async function fetchBot(account: string, id: string): Promise<BotDetail | null> {
  try {
    return await getJson<BotDetail>(`/api/bots/${encodeURIComponent(account)}/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("(404)")) return null;
    throw err;
  }
}
