import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { FleetStore } from "../src/fleet-store";
import type { BotDetail, BotView, FleetResponse } from "../src/shared/model";
import { BASE, TEST_PASSWORD, WORK_KEY } from "./fixtures";

export const CHIEF = "b0642d5e-4aaf-41e7-9c15-637f06e15398";
export const INTERNAL_DAM = "5fb801a1-82ea-4043-96da-756990389d89";
export const DISK_SAVER = "2714e293-5a0e-439a-89af-ebe0970b8077";

/** Wipes all Durable Object storage and restarts it, so the seed runs again. */
export async function freshStore(): Promise<void> {
  await reset();
  await abortAllDurableObjects();
}

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, { redirect: "manual", ...init }));
}

export function ingest(
  kind: string,
  body: unknown,
  key: string | null = WORK_KEY,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  if (key !== null) h.Authorization = `Bearer ${key}`;
  return call(`/ingest/v1/${kind}`, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let ipCounter = 0;
/** A fresh client IP per call so login rate limits don't leak between tests. */
export function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

export function login(
  password: string = TEST_PASSWORD,
  options: { ip?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return call("/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: BASE,
      "CF-Connecting-IP": options.ip ?? nextIp(),
      ...options.headers,
    },
    body: new URLSearchParams({ password }).toString(),
  });
}

/** Logs in and returns the "name=value" cookie pair to send back. */
export async function sessionCookie(): Promise<string> {
  const res = await login();
  const setCookie = res.headers.get("Set-Cookie");
  if (res.status !== 303 || !setCookie) throw new Error(`login failed: ${res.status}`);
  return setCookie.split(";")[0] ?? "";
}

export async function getJson<T>(path: string, cookie: string): Promise<T> {
  const res = await call(path, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json<T>();
}

export function fleet(cookie: string): Promise<FleetResponse> {
  return getJson<FleetResponse>("/api/fleet", cookie);
}

export function detail(cookie: string, account: string, id: string): Promise<BotDetail> {
  return getJson<BotDetail>(`/api/bots/${account}/${encodeURIComponent(id)}`, cookie);
}

export function findBot(data: FleetResponse, account: string, id: string): BotView | undefined {
  return data.bots.find((b) => b.account === account && b.id === id);
}

export function storeStub(): DurableObjectStub<FleetStore> {
  return env.FLEET.get(env.FLEET.idFromName("fleet"));
}

/** Runs raw SQL inside the Durable Object (test setup only). */
export function sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): Promise<T[]> {
  return runInDurableObject(storeStub(), (_instance, state) => state.storage.sql.exec<T>(query, ...bindings).toArray());
}
