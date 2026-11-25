// Text cleanup for everything bots push. Output is always rendered with textContent
// in the browser, so this is about readability and safety, not HTML escaping.

// C0/C1 control characters except \n (U+000A) and \t (U+0009).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Zero-width space, bidi embedding/override/isolate controls, word joiners and BOM
// (spoofing / invisible text). ZWJ/ZWNJ (emoji, Indic and Persian text) and the
// LRM/RLM marks (U+200C-U+200F) are legitimate and kept.
const INVISIBLE_CHARS = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

// Obvious credentials. Bots are told never to send secrets; this is a backstop so a
// slip does not end up on the dashboard or in storage.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bbf[wl]_[A-Za-z0-9_-]{20,}\b/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

export const REDACTED = "[redacted]";

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, bearer?: string) =>
      typeof bearer === "string" && /^bearer$/i.test(bearer) ? `${bearer} ${REDACTED}` : REDACTED,
    );
  }
  return out;
}

/** Truncate to at most `max` code points, ending with "…" when cut. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

function baseClean(input: string): string {
  return input
    .toWellFormed()
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "");
}

/** One line: names, steps, event details. Collapses all whitespace. */
export function cleanLine(input: string, max: number): string {
  const text = redactSecrets(baseClean(input).replace(/\s+/g, " ").trim());
  return truncate(text, max);
}

/** Multi-line text: summaries and message copies. Keeps indentation and single blank lines. */
export function cleanBlock(input: string, max: number): string {
  const text = redactSecrets(
    baseClean(input)
      .split("\n")
      .map((line) => {
        const indent = /^ */.exec(line)?.[0] ?? "";
        return indent + line.slice(indent.length).replace(/[^\S\n]+/g, " ").trimEnd();
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  return truncate(text, max);
}
