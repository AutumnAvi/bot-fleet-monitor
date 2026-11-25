// Password check, write-key check, session cookie helpers.

import type { Account } from "../shared/model";

const encoder = new TextEncoder();

export const SESSION_COOKIE = "__Host-bf_session";
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Configured write keys shorter than this are treated as missing (fail closed). */
export const MIN_KEY_CHARS = 32;
/** Workers caps PBKDF2 at 100k iterations. */
const MAX_PBKDF2_ITERATIONS = 100_000;
const MAX_PASSWORD_CHARS = 256;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

export async function sha256Hex(data: string): Promise<string> {
  const bytes = await sha256(data);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison. Different lengths return false (length is not secret here). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/**
 * Format: pbkdf2-sha256:<iterations>:<salt base64url>:<hash base64url>
 * (":" not "$", because wrangler expands "$NAME" in .dev.vars and would corrupt it).
 */
export function parsePasswordHash(stored: string | undefined): ParsedHash | null {
  if (!stored) return null;
  const parts = stored.trim().split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) {
    return null;
  }
  const salt = base64UrlDecode(parts[2] ?? "");
  const hash = base64UrlDecode(parts[3] ?? "");
  if (!salt || !hash || salt.byteLength < 16 || hash.byteLength !== 32) return null;
  return { iterations, salt, hash };
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Checks a login attempt against the stored PBKDF2 hash. A missing or malformed hash
 * fails closed (no password works).
 */
export async function verifyPassword(attempt: string, stored: string | undefined): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed || attempt.length === 0 || attempt.length > MAX_PASSWORD_CHARS) return false;
  const derived = await pbkdf2(attempt, parsed.salt, parsed.iterations);
  return timingSafeEqual(derived, parsed.hash);
}

export interface KeyEnv {
  INGEST_KEY_WORK?: string;
  INGEST_KEY_LEAF?: string;
  INGEST_KEY_SESSIONS?: string;
  READ_KEY?: string;
}

export type KeyRole = "work" | "leaf" | "sessions" | "read";

function usableKey(value: string | undefined): string | null {
  const key = value?.trim();
  return key && key.length >= MIN_KEY_CHARS ? key : null;
}

function configuredSecrets(env: KeyEnv): string[] {
  return [env.INGEST_KEY_WORK, env.INGEST_KEY_LEAF, env.INGEST_KEY_SESSIONS, env.READ_KEY]
    .map(usableKey)
    .filter((key): key is string => key !== null);
}

/**
 * True when two configured secrets are the same string. A key that opened more
 * than one role would be able to write and read, or write both accounts, so
 * every presented key is rejected until the secrets differ.
 */
export function keysCollide(env: KeyEnv): boolean {
  const values = configuredSecrets(env);
  return new Set(values).size !== values.length;
}

/**
 * Maps a presented bearer token to exactly one role. Every configured secret
 * is hashed and compared. Zero matches, two matches, or a colliding
 * configuration all return null.
 */
export async function classifyKey(presented: string | null, env: KeyEnv): Promise<KeyRole | null> {
  if (keysCollide(env)) return null;
  if (!presented || presented.length > 512) return null;
  const work = usableKey(env.INGEST_KEY_WORK);
  const leaf = usableKey(env.INGEST_KEY_LEAF);
  const sessions = usableKey(env.INGEST_KEY_SESSIONS);
  const read = usableKey(env.READ_KEY);
  const digest = await sha256(presented);
  const workMatch = work !== null && timingSafeEqual(digest, await sha256(work));
  const leafMatch = leaf !== null && timingSafeEqual(digest, await sha256(leaf));
  const sessionsMatch = sessions !== null && timingSafeEqual(digest, await sha256(sessions));
  const readMatch = read !== null && timingSafeEqual(digest, await sha256(read));
  const hits = [workMatch, leafMatch, sessionsMatch, readMatch].filter(Boolean).length;
  if (hits !== 1) return null;
  if (workMatch) return "work";
  if (leafMatch) return "leaf";
  if (sessionsMatch) return "sessions";
  return "read";
}

/**
 * Maps a presented write key to its account. The sessions key and the read key
 * are not accounts. If any two configured secrets are identical, every key is
 * rejected.
 */
export async function accountForKey(presented: string | null, env: KeyEnv): Promise<Account | null> {
  const role = await classifyKey(presented, env);
  return role === "work" || role === "leaf" ? role : null;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function newSessionToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** Session tokens are 32 random bytes, base64url (43 chars). Anything else is ignored. */
export function isWellFormedSessionToken(token: string | null): token is string {
  return token !== null && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function sessionCookie(token: string, maxAgeMs: number = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * CSRF check for browser POSTs (login, logout): the request must come from this
 * origin. A real Origin must match exactly. When Origin is absent or "null" (privacy
 * settings can do that), Sec-Fetch-Site must say "same-origin". Anything else is refused.
 */
export function isSameOriginPost(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== "null") return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}
