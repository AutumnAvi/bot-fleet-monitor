// Response helpers and request-body reading with a hard size cap.

import { ClientError } from "./validate";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function securityHeaders(headers: Headers = new Headers()): Headers {
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  // same-origin (not no-referrer): with no-referrer, browsers send "Origin: null" on form posts.
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return headers;
}

export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = securityHeaders(new Headers(extra));
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiError(status: number, code: string, message: string, extra?: HeadersInit): Response {
  return json({ ok: false, error: code, message }, status, extra);
}

export function html(body: string, status = 200, extra?: HeadersInit): Response {
  const headers = securityHeaders(new Headers(extra));
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
}

export function redirect(location: string, extra?: HeadersInit): Response {
  const headers = securityHeaders(new Headers(extra));
  headers.set("Location", location);
  return new Response(null, { status: 303, headers });
}

export function text(body: string, status = 200): Response {
  const headers = securityHeaders();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(body, { status, headers });
}

/**
 * Reads the body as UTF-8, refusing anything over `maxBytes` (413) whether or not
 * Content-Length is present or honest.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new ClientError(413, "payload_too_large", `Body must be at most ${maxBytes} bytes`);
  }
  if (!request.body) return "";
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ClientError(413, "payload_too_large", `Body must be at most ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ClientError(400, "invalid_encoding", "Body must be UTF-8");
  }
}

export function isJsonContentType(request: Request): boolean {
  const type = request.headers.get("Content-Type") ?? "";
  return /^application\/json\s*(;|$)/i.test(type);
}
