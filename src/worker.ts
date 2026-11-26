// Bot Fleet monitor Worker: routing, password sessions and write-key ingest.
//
// Push-only by design: this Worker has no cron trigger and makes no outbound
// requests. Bots post to /ingest/v1/* during work they are already doing; the
// dashboard reads what they pushed. Nothing here can message, wake or poll a bot.

import { FleetStore } from "./fleet-store";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  bearerToken,
  classifyKey,
  clearSessionCookie,
  isSameOriginPost,
  isWellFormedSessionToken,
  newSessionToken,
  readCookie,
  sessionCookie,
  sha256Hex,
  verifyPassword,
} from "./lib/auth";
import { apiError, html, isJsonContentType, json, readBodyCapped, redirect, text } from "./lib/http";
import { appShell, loginPage } from "./lib/pages";
import {
  ClientError,
  isBotKind,
  isIngestKind,
  parseGrokUsagePayload,
  parseIngestPayload,
  parseSessionsPayload,
  parseUsagePayload,
} from "./lib/validate";
import { ACCOUNTS, LIMITS, RATE_LIMITS, type Account } from "./shared/model";

export { FleetStore };

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function store(env: Env): DurableObjectStub<FleetStore> {
  return env.FLEET.get(env.FLEET.idFromName("fleet"));
}

/** One JSON line per event. Never includes keys, passwords, cookies or bot text. */
function log(fields: Record<string, string | number | boolean | null>): void {
  console.log(JSON.stringify(fields));
}

async function sessionHash(request: Request): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!isWellFormedSessionToken(token)) return null;
  return sha256Hex(token);
}

/** Fingerprint of the configured password hash, so a password change ends all sessions. */
function passwordFingerprint(env: Env): Promise<string> {
  return sha256Hex(`session-v1:${env.DASHBOARD_PASSWORD_HASH ?? ""}`);
}

async function hasSession(request: Request, env: Env): Promise<boolean> {
  const hash = await sessionHash(request);
  return hash !== null && (await store(env).isSessionValid(hash, await passwordFingerprint(env)));
}

function methodNotAllowed(allow: string): Response {
  return apiError(405, "method_not_allowed", `Use ${allow}`, { Allow: allow });
}

// ------------------------------------------------------------------ login

async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    if (await hasSession(request, env)) return redirect("/");
    return html(loginPage());
  }
  if (request.method !== "POST") return methodNotAllowed("GET, POST");

  if (!isSameOriginPost(request)) {
    log({ evt: "login", result: "cross_origin" });
    return html(loginPage("Sign-in must come from this page."), 403);
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const limit = await store(env).hitRateLimit(`login:${ip}`, RATE_LIMITS.loginPerIpPer15Min, LOGIN_WINDOW_MS);
  if (!limit.ok) {
    log({ evt: "login", result: "rate_limited" });
    const minutes = Math.ceil(limit.retryAfterSec / 60);
    return html(loginPage(`Too many attempts. Try again in ${minutes} min.`), 429, {
      "Retry-After": String(limit.retryAfterSec),
    });
  }
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) {
    return html(loginPage("Sign in with the form."), 415);
  }
  let password: string;
  try {
    password = new URLSearchParams(await readBodyCapped(request, LIMITS.loginBodyBytes)).get("password") ?? "";
  } catch (err) {
    if (err instanceof ClientError) return html(loginPage("Sign in with the form."), err.status);
    throw err;
  }
  if (!(await verifyPassword(password, env.DASHBOARD_PASSWORD_HASH))) {
    log({ evt: "login", result: "wrong_password" });
    return html(loginPage("Wrong password."), 401);
  }
  const token = newSessionToken();
  await store(env).createSession(await sha256Hex(token), await passwordFingerprint(env), SESSION_TTL_MS);
  log({ evt: "login", result: "ok" });
  return redirect("/", { "Set-Cookie": sessionCookie(token) });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOriginPost(request)) return text("Forbidden", 403);
  const hash = await sessionHash(request);
  if (hash !== null) await store(env).deleteSession(hash);
  return redirect("/login", { "Set-Cookie": clearSessionCookie() });
}

// ------------------------------------------------------------------ ingest

function snapshotLimited(account: string, bytes: number, retryAfterSec: number): Response {
  log({ evt: "ingest", account, kind: "snapshot", bytes, result: "rate_limited", status: 429 });
  return apiError(429, "rate_limited", "Too many reports; this one was dropped. Do not retry in a loop.", {
    "Retry-After": String(retryAfterSec),
  });
}

function bodyLimit(kind: string): number {
  if (kind === "sessions") return LIMITS.sessionsBodyBytes;
  if (kind === "usage" || kind === "grok-usage") return LIMITS.usageBodyBytes;
  return LIMITS.ingestBodyBytes;
}

async function readJson(request: Request, maxBytes: number): Promise<{ raw: unknown; bytes: number }> {
  if (!isJsonContentType(request)) {
    throw new ClientError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const body = await readBodyCapped(request, maxBytes);
  const bytes = new TextEncoder().encode(body).byteLength;
  try {
    return { raw: JSON.parse(body) as unknown, bytes };
  } catch {
    throw new ClientError(400, "invalid_json", "Body is not valid JSON");
  }
}

async function handleIngest(request: Request, env: Env, kind: string): Promise<Response> {
  if (!isIngestKind(kind)) {
    log({ evt: "ingest", result: "unknown_kind", status: 404 });
    return apiError(404, "not_found", "Unknown report type");
  }
  if (request.method !== "POST") {
    log({ evt: "ingest", kind, result: "method_not_allowed", status: 405 });
    return methodNotAllowed("POST");
  }

  // The read key is not a write key. The sessions key is not an account key.
  const role = await classifyKey(bearerToken(request), env);
  const snapshot = kind === "sessions" || kind === "usage";
  const grok = kind === "grok-usage";
  const allowed = snapshot ? role === "sessions" : grok ? role === "work" || role === "leaf" : role === "work" || role === "leaf";
  if (!allowed || role === null || role === "read") {
    log({ evt: "ingest", kind, result: "unauthorized", status: 401 });
    return apiError(401, "unauthorized", "Missing or invalid write key", { "WWW-Authenticate": "Bearer" });
  }

  let bytes = 0;
  try {
    const parsed = await readJson(request, bodyLimit(kind));
    bytes = parsed.bytes;
    if (kind === "sessions") {
      const payload = parseSessionsPayload(parsed.raw);
      const saved = await store(env).replaceSessions(payload);
      if (!saved.ok) return snapshotLimited("sessions", bytes, saved.retryAfterSec);
      log({ evt: "ingest", account: "sessions", kind, bytes, count: payload.sessions.length, result: "ok", status: 200 });
      return json({ ok: true, count: payload.sessions.length });
    }
    if (kind === "usage") {
      const payload = parseUsagePayload(parsed.raw);
      const saved = await store(env).replacePools(payload);
      if (!saved.ok) return snapshotLimited("sessions", bytes, saved.retryAfterSec);
      log({ evt: "ingest", account: "sessions", kind, bytes, count: payload.accounts.length, result: "ok", status: 200 });
      return json({ ok: true, count: payload.accounts.length });
    }
    if (kind === "grok-usage") {
      const account = role === "leaf" ? "leaf" : "work";
      const payload = parseGrokUsagePayload(parsed.raw, account);
      const saved = await store(env).replaceGrokUsage(account, payload);
      if (!saved.ok) return snapshotLimited(account, bytes, saved.retryAfterSec);
      log({ evt: "ingest", account, kind, bytes, count: payload.bots.length, result: "ok", status: 200 });
      return json({ ok: true, count: payload.bots.length });
    }
    if (!isBotKind(kind) || (role !== "work" && role !== "leaf")) {
      log({ evt: "ingest", kind, result: "unauthorized", status: 401 });
      return apiError(401, "unauthorized", "Missing or invalid write key", { "WWW-Authenticate": "Bearer" });
    }
    const payload = parseIngestPayload(kind, role, parsed.raw);
    const result = await store(env).ingest(role, payload);
    if (!result.ok) {
      log({ evt: "ingest", account: role, kind, bot: payload.botId, bytes, result: result.error, status: result.status });
      const extra: HeadersInit | undefined =
        result.retryAfterSec !== undefined ? { "Retry-After": String(result.retryAfterSec) } : undefined;
      return apiError(result.status, result.error, result.message, extra);
    }
    const status = result.created ? 201 : 200;
    log({ evt: "ingest", account: role, kind, bot: payload.botId, bytes, result: "ok", status });
    return json({ ok: true, created: result.created }, status);
  } catch (err) {
    if (err instanceof ClientError) {
      log({ evt: "ingest", kind, bytes, result: err.code, status: err.status });
      return apiError(err.status, err.code, err.message);
    }
    throw err;
  }
}

// ------------------------------------------------------------------ dashboard API

const SAVED_PATH = /^\/api\/bots\/([^/]+)\/([^/]+)\/saved$/;

/** Splits /api/bots/<account>/<id>[/saved] parts; null when the account or id is not valid. */
function botRef(accountRaw: string | undefined, idRaw: string | undefined): { account: Account; id: string } | null {
  let id: string;
  try {
    id = decodeURIComponent(idRaw ?? "");
  } catch {
    return null;
  }
  const account = accountRaw ?? "";
  if (!(ACCOUNTS as readonly string[]).includes(account) || !BOT_ID.test(id)) return null;
  return { account: account as Account, id };
}

/**
 * POST /api/bots/<account>/<id>/saved with {"saved": true|false}: the dashboard's
 * "Save for later" / "Move back" button. Same-origin only; it changes the dashboard's
 * own state and never contacts the bot.
 */
async function handleSaved(request: Request, env: Env, match: RegExpExecArray): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOriginPost(request)) return apiError(403, "forbidden", "Cross-site request refused");
  if (!(await hasSession(request, env))) return apiError(401, "unauthorized", "Sign in first");
  if (!isJsonContentType(request)) {
    return apiError(415, "unsupported_media_type", "Send JSON");
  }
  const ref = botRef(match[1], match[2]);
  if (!ref) return apiError(404, "not_found", "No such bot");
  let saved: unknown;
  try {
    const body = JSON.parse(await readBodyCapped(request, 256)) as unknown;
    saved = typeof body === "object" && body !== null ? (body as { saved?: unknown }).saved : undefined;
  } catch {
    return apiError(400, "invalid_payload", 'Body must be {"saved": true} or {"saved": false}');
  }
  if (typeof saved !== "boolean") return apiError(400, "invalid_payload", '"saved" must be true or false');
  const found = await store(env).setSaved(ref.account, ref.id, saved);
  if (!found) return apiError(404, "not_found", "No such bot");
  log({ evt: "saved", account: ref.account, bot: ref.id, saved });
  return json({ ok: true, saved });
}

const APP_SAVED_PATH = /^\/api\/v1\/bots\/([^/]+)\/([^/]+)\/saved$/;
const APP_SAVED_BODY_BYTES = 256;

/**
 * POST /api/v1/bots/<account>/<id>/saved with {"saved": true|false}: the Mac app's
 * "Later" / "Move back" button. Bearer CONTROL_KEY only (no cookie, no other key).
 * It only flips Save for later through setSaved(); it never contacts the bot.
 */
async function handleAppSaved(request: Request, env: Env, match: RegExpExecArray): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const role = await classifyKey(bearerToken(request), env);
  if (role === null) {
    log({ evt: "saved", via: "app", result: "unauthorized", status: 401 });
    return apiError(401, "unauthorized", "Missing or invalid control key", { "WWW-Authenticate": "Bearer" });
  }
  if (role !== "control") {
    log({ evt: "saved", via: "app", result: "forbidden", status: 403 });
    return apiError(403, "forbidden", "This key cannot change Save for later");
  }
  const limit = await store(env).hitRateLimit("control:saved", RATE_LIMITS.controlSavedPerMinute, 60_000);
  if (!limit.ok) {
    log({ evt: "saved", via: "app", result: "rate_limited", status: 429 });
    return apiError(429, "rate_limited", "Too many changes; wait and try again.", {
      "Retry-After": String(limit.retryAfterSec),
    });
  }
  let saved: boolean;
  try {
    const { raw } = await readJson(request, APP_SAVED_BODY_BYTES);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ClientError(400, "invalid_payload", "Body must be a JSON object");
    const keys = Object.keys(raw);
    const value = (raw as { saved?: unknown }).saved;
    if (keys.length !== 1 || typeof value !== "boolean") {
      throw new ClientError(400, "invalid_payload", 'Body must be {"saved": true} or {"saved": false}');
    }
    saved = value;
  } catch (err) {
    if (err instanceof ClientError) {
      log({ evt: "saved", via: "app", result: err.code, status: err.status });
      return apiError(err.status, err.code, err.message);
    }
    throw err;
  }
  const ref = botRef(match[1], match[2]);
  const found = ref !== null && (await store(env).setSaved(ref.account, ref.id, saved, "app"));
  if (!ref || !found) {
    log({ evt: "saved", via: "app", result: "not_found", status: 404 });
    return apiError(404, "not_found", "No such bot");
  }
  log({ evt: "saved", via: "app", account: ref.account, bot: ref.id, saved });
  return json({ ok: true, saved });
}

function activityAccountOf(url: URL): Account | null | Response {
  const accountParam = url.searchParams.get("account");
  if (accountParam === null || accountParam === "both") return null;
  if (!(ACCOUNTS as readonly string[]).includes(accountParam)) {
    return apiError(400, "invalid_account", '"account" must be work, leaf or both');
  }
  return accountParam as Account;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const appSavedMatch = APP_SAVED_PATH.exec(url.pathname);
  if (appSavedMatch) return handleAppSaved(request, env, appSavedMatch);
  const savedMatch = SAVED_PATH.exec(url.pathname);
  if (savedMatch) return handleSaved(request, env, savedMatch);
  if (request.method !== "GET") return methodNotAllowed("GET");

  // The read key can only open this one endpoint. It cannot write, and it cannot
  // use the older dashboard routes. A dashboard cookie can open all of them.
  if (url.pathname === "/api/v1/state") {
    const role = await classifyKey(bearerToken(request), env);
    const allowed = role === "read" || (await hasSession(request, env));
    if (!allowed) return apiError(401, "unauthorized", "Sign in first");
    const activityAccount = activityAccountOf(url);
    if (activityAccount instanceof Response) return activityAccount;
    return json(await store(env).state(activityAccount));
  }

  if (!(await hasSession(request, env))) return apiError(401, "unauthorized", "Sign in first");

  // Optional ?account=work|leaf narrows the activity feed (the bot list always has both).
  const activityAccount = activityAccountOf(url);
  if (activityAccount instanceof Response) return activityAccount;

  if (url.pathname === "/api/fleet") return json(await store(env).fleet(activityAccount));

  if (url.pathname === "/api/activity") {
    const raw = url.searchParams.get("before");
    let before: number | null = null;
    if (raw !== null) {
      if (!/^[1-9][0-9]{0,15}$/.test(raw)) return apiError(400, "invalid_cursor", '"before" must be a positive integer');
      before = Number(raw);
    }
    return json(await store(env).activity(before, activityAccount));
  }

  const match = /^\/api\/bots\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const ref = botRef(match[1], match[2]);
    if (!ref) return apiError(404, "not_found", "No such bot");
    const detail = await store(env).botDetail(ref.account, ref.id);
    return detail ? json(detail) : apiError(404, "not_found", "No such bot");
  }

  return apiError(404, "not_found", "Not found");
}

// ------------------------------------------------------------------ router

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/healthz") return text("ok");

  const ingest = /^\/ingest\/v1\/([^/]*)$/.exec(path);
  if (ingest) return handleIngest(request, env, ingest[1] ?? "");

  if (path === "/login") return handleLogin(request, env);
  if (path === "/logout") return handleLogout(request, env);
  if (path.startsWith("/api/")) return handleApi(request, env, url);

  if (path === "/") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET");
    if (!(await hasSession(request, env))) return redirect("/login");
    return html(appShell());
  }

  // Static client files normally never reach the Worker (served by Workers Assets).
  if (path.startsWith("/assets/") && (request.method === "GET" || request.method === "HEAD")) {
    return env.ASSETS.fetch(request);
  }

  return text("Not found", 404);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof ClientError) return apiError(err.status, err.code, err.message);
      log({ evt: "error", name: err instanceof Error ? err.name : "unknown" });
      return apiError(500, "internal", "Internal error");
    }
  },
} satisfies ExportedHandler<Env>;
