// Calls to this dashboard's own Worker. Nothing here talks to a bot: the only
// write is the dashboard's own "Save for later" flag.

import type { AccountFilter } from "../src/shared/fleet-view";
import type { ActivityPage, BotDetail, FleetResponse } from "../src/shared/model";

const TIMEOUT_MS = 15_000;

export class SignedOutError extends Error {}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    // A hung request must not freeze the refresh loop.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new SignedOutError("signed out");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

export function fetchFleet(account: AccountFilter): Promise<FleetResponse> {
  return getJson<FleetResponse>(`/api/fleet?account=${account}`);
}

export function fetchActivity(before: number, account: AccountFilter): Promise<ActivityPage> {
  return getJson<ActivityPage>(`/api/activity?before=${before}&account=${account}`);
}

export async function fetchBot(account: string, id: string): Promise<BotDetail | null> {
  try {
    return await getJson<BotDetail>(`/api/bots/${encodeURIComponent(account)}/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("(404)")) return null;
    throw err;
  }
}

/** Dashboard "Save for later" (true) or "Move back" (false). */
export async function setSaved(account: string, id: string, saved: boolean): Promise<void> {
  const res = await fetch(`/api/bots/${encodeURIComponent(account)}/${encodeURIComponent(id)}/saved`, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ saved }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401) throw new SignedOutError("signed out");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}
