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
}

function usableKey(value: string | undefined): string | null {
  const key = value?.trim();
  return key && key.length >= MIN_KEY_CHARS ? key : null;
}

/**
 * Maps a presented write key to its account. Both comparisons always run, in
 * constant time. If the two configured keys are identical the setup is unsafe
 * (a key would match both accounts), so every key is rejected.
 */
export async function accountForKey(presented: string | null, env: KeyEnv): Promise<Account | null> {
  const work = usableKey(env.INGEST_KEY_WORK);
  const leaf = usableKey(env.INGEST_KEY_LEAF);
  if (!presented || presented.length > 512) return null;
  if (work !== null && work === leaf) return null;

  const presentedDigest = await sha256(presented);
  const workMatch = work !== null && timingSafeEqual(presentedDigest, await sha256(work));
  const leafMatch = leaf !== null && timingSafeEqual(presentedDigest, await sha256(leaf));
  if (workMatch && !leafMatch) return "work";
  if (leafMatch && !workMatch) return "leaf";
  return null;
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
