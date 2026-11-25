// Shared helpers for the secret scripts. Nothing here prints secret values.
import { pbkdf2Sync, randomBytes, randomInt } from "node:crypto";

/**
 * Workers caps PBKDF2 at 100k iterations, and 100k costs ~17 ms CPU, above the
 * Workers Free per-request CPU budget. The generated password is ~138 random bits,
 * so the KDF cost is not what protects it; 25k keeps login well inside the budget.
 * On Workers Paid you may raise this to 100000 and re-hash.
 */
export const DEFAULT_ITERATIONS = 25_000;

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 4 groups of 6 unambiguous characters, e.g. "abcDEF-23gHjk-…" (~138 bits). */
export function generatePassword() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let group = "";
    for (let i = 0; i < 6; i++) group += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}

/** Write key: prefix + 32 random bytes, base64url. */
export function generateKey(prefix) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** pbkdf2-sha256:<iterations>:<salt b64url>:<hash b64url>, as checked by src/lib/auth.ts. */
export function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000) {
    throw new Error("iterations must be an integer between 1 and 100000 (Workers limit)");
  }
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return ["pbkdf2-sha256", String(iterations), salt.toString("base64url"), hash.toString("base64url")].join(":");
}
