// Shared helpers for the box-side pushers. Keys are read from a file and never printed.

import { readFile, stat } from "node:fs/promises";

export const USER_AGENT = "bot-fleet-pusher/1.0";

/** The Worker URL from BOT_FLEET_URL: https, or http only for a local dev server. */
export function workerUrl(env = process.env) {
  const raw = (env.BOT_FLEET_URL ?? "").trim();
  if (raw === "") throw new Error("BOT_FLEET_URL is not set");
  if (!/^https:\/\//.test(raw) && !/^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]+)?(\/|$)/.test(raw)) {
    throw new Error("BOT_FLEET_URL must be https");
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Reads the key from the file named by BOT_FLEET_KEY_FILE. Error messages name the
 * problem, never the file's contents.
 */
export async function readKeyFile(env = process.env) {
  const path = (env.BOT_FLEET_KEY_FILE ?? "").trim();
  if (path === "") throw new Error("BOT_FLEET_KEY_FILE is not set (a path to the key file, not the key)");
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error("BOT_FLEET_KEY_FILE does not point to a readable file");
  if (info.size > 1024) throw new Error("BOT_FLEET_KEY_FILE is too large to be a key file");
  const key = (await readFile(path, "utf8")).trim();
  if (key.length < 32 || /\s/.test(key)) throw new Error("BOT_FLEET_KEY_FILE does not hold a single key");
  return key;
}

/** POSTs JSON and returns the HTTP status only (the body is not read or printed). */
export async function postJson(url, key, body, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await res.body?.cancel();
  return res.status;
}

/** Bots from docs/roster-seed.json, plus an optional extra roster file of the same shape. */
export async function loadRoster(seedPath, extraPath) {
  const bots = [];
  for (const path of [seedPath, extraPath]) {
    if (!path) continue;
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.bots;
    if (!Array.isArray(list)) throw new Error(`${path}: expected {"bots": [...]} or an array`);
    bots.push(...list);
  }
  return bots;
}

/** Minimal --flag / --flag value parser. */
export function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}
