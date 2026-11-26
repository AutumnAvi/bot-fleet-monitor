// Pure logic for scripts/push-grok-usage.mjs (no I/O): turns a Grok usage snapshot
// into a POST /ingest/v1/grok-usage body. Bot names map to ids from local roster
// data only; anything unknown goes into one "Other" row. Limits match the Worker
// (src/lib/validate.ts parseGrokUsagePayload and LIMITS in src/shared/model.ts).

export const MAX_GROK_BOTS = 200;
export const NAME_CHARS = 60;
export const OTHER_ID = "other";
export const OTHER_NAME = "Other";
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export class SnapshotError extends Error {}

function bad(message) {
  return new SnapshotError(message);
}

/** Lowercase, trimmed, single-spaced. */
export function normalizeName(name) {
  return String(name).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function clampPct(value) {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function shortName(name) {
  const chars = Array.from(name.trim());
  return chars.length <= NAME_CHARS ? chars.join("") : `${chars.slice(0, NAME_CHARS - 1).join("")}…`;
}

/** ms since epoch from ms, unix seconds or ISO-8601; null stays null. Same rules as the Worker. */
export function toMillis(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1e12 && value <= 1e13) return Math.round(value);
    if (value >= 1e9 && value <= 1e10) return Math.round(value * 1000);
  }
  if (typeof value === "string" && value.length <= 40) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  throw bad(`"${field}" must be a timestamp in ms, seconds or ISO-8601 (or null)`);
}

/**
 * Index of roster bots for one account: by exact id, by full name, and by the short
 * name before " · " (e.g. "Chief" for "Chief · Chief of Staff"). A name that two
 * bots share is ambiguous and maps to nobody.
 */
export function rosterIndex(bots, account) {
  const byId = new Map();
  const byName = new Map();
  const add = (key, bot) => {
    if (key === "") return;
    const prev = byName.get(key);
    byName.set(key, prev === undefined || prev?.id === bot.id ? bot : null);
  };
  for (const raw of bots) {
    if (typeof raw !== "object" || raw === null) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if ((raw.account ?? account) !== account || !BOT_ID.test(id) || byId.has(id)) continue;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
    const bot = { id, name };
    byId.set(id, bot);
    add(normalizeName(name), bot);
    const short = name.split(" · ")[0] ?? "";
    if (short !== name) add(normalizeName(short), bot);
  }
  return { byId, byName };
}

function resolve(entry, index) {
  const id = typeof entry.botId === "string" ? entry.botId.trim() : "";
  if (id && index.byId.has(id)) return index.byId.get(id);
  if (typeof entry.name === "string") {
    const hit = index.byName.get(normalizeName(entry.name));
    if (hit) return hit;
  }
  return null;
}

/**
 * Snapshot -> { body, notes }. Throws SnapshotError when the snapshot itself is
 * unusable (account, pctUsed, timestamps, bots not a list). Bad bot rows are
 * dropped with a note; unknown bots are summed into "Other".
 */
export function buildGrokUsage(snapshot, rosterBots) {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) throw bad("Snapshot must be a JSON object");
  const { account } = snapshot;
  if (account !== "work" && account !== "leaf") throw bad('"account" must be "work" or "leaf"');
  if (typeof snapshot.pctUsed !== "number" || !Number.isFinite(snapshot.pctUsed)) throw bad('"pctUsed" must be a number');
  if (!Array.isArray(snapshot.bots)) throw bad('"bots" must be an array');
  const resetAt = toMillis(snapshot.resetAt, "resetAt");
  const asOf = toMillis(snapshot.asOf, "asOf");

  const index = rosterIndex(rosterBots, account);
  const notes = [];
  const rows = new Map(); // id -> { botId, name, share, routinesShare }
  const unknown = [];
  let other = null;

  snapshot.bots.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      notes.push(`bots[${i}] dropped: not an object`);
      return;
    }
    if (typeof entry.share !== "number" || !Number.isFinite(entry.share)) {
      notes.push(`bots[${i}] dropped: "share" is not a number`);
      return;
    }
    const routines =
      typeof entry.routinesShare === "number" && Number.isFinite(entry.routinesShare) ? entry.routinesShare : null;
    const bot = resolve(entry, index);
    if (bot === null) {
      unknown.push(typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `bots[${i}]`);
      other ??= { botId: OTHER_ID, name: OTHER_NAME, share: 0, routinesShare: null };
      other.share += entry.share;
      if (routines !== null) other.routinesShare = (other.routinesShare ?? 0) + routines;
      return;
    }
    const row = rows.get(bot.id) ?? { botId: bot.id, name: shortName(bot.name), share: 0, routinesShare: null };
    row.share += entry.share;
    if (routines !== null) row.routinesShare = (row.routinesShare ?? 0) + routines;
    rows.set(bot.id, row);
  });
  if (snapshot.bots.length > 0 && rows.size === 0 && other === null) {
    // Sending bots: [] would wipe the stored per-bot breakdown.
    throw bad("Every bot row was invalid; nothing sent");
  }
  if (unknown.length > 0) notes.push(`${unknown.length} unknown bot(s) summed into "${OTHER_NAME}": ${unknown.join(", ")}`);

  let list = [...rows.values()].sort((a, b) => b.share - a.share || a.name.localeCompare(b.name, "en"));
  // Past the Worker's cap, fold the smallest named rows into "Other" (which takes one slot).
  if (list.length + (other === null ? 0 : 1) > MAX_GROK_BOTS) {
    const room = MAX_GROK_BOTS - 1;
    const folded = list.slice(room);
    list = list.slice(0, room);
    other ??= { botId: OTHER_ID, name: OTHER_NAME, share: 0, routinesShare: null };
    for (const row of folded) {
      other.share += row.share;
      if (row.routinesShare !== null) other.routinesShare = (other.routinesShare ?? 0) + row.routinesShare;
    }
    notes.push(`${folded.length} smallest bot(s) folded into "${OTHER_NAME}" (limit ${MAX_GROK_BOTS})`);
  }
  if (other !== null) {
    if (rows.has(OTHER_ID)) throw bad(`A roster bot uses the reserved id "${OTHER_ID}"`);
    list.push(other);
  }

  const bots = list.map((row) => {
    const share = clampPct(row.share);
    const out = { botId: row.botId, name: row.name, share };
    // routinesShare is the routines part of the share, so never above it.
    if (row.routinesShare !== null) out.routinesShare = Math.min(share, clampPct(row.routinesShare));
    return out;
  });

  const body = { account, pctUsed: clampPct(snapshot.pctUsed), resetAt, bots };
  if (asOf !== null) body.asOf = asOf;
  return { body, notes };
}
