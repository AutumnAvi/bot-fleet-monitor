// Pure avatar backfill logic (no I/O), shared by scripts/avatar-backfill.mjs and the tests.
// The lists must match AVATAR_SHAPES / AVATAR_COLORS in src/shared/model.ts (a test checks).

export const AVATAR_SHAPES = ["blob", "wedge", "cloud", "hex", "tablet", "teardrop", "pebble", "star"];
export const AVATAR_COLORS = [
  "red",
  "yellow",
  "orange",
  "cyan",
  "brown",
  "black",
  "blue",
  "green",
  "purple",
  "pink",
  "gray",
];

/** Same id rule as the Worker. Also keeps an id from escaping the agents directory. */
export const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** {shape, color} from a Grok Bot profile.json, or null when unset or not one we know. */
export function avatarFromProfile(profile) {
  if (typeof profile !== "object" || profile === null) return null;
  const shape = typeof profile.avatarShape === "string" ? profile.avatarShape.trim().toLowerCase() : "";
  const color = typeof profile.avatarColor === "string" ? profile.avatarColor.trim().toLowerCase() : "";
  if (!AVATAR_SHAPES.includes(shape) || !AVATAR_COLORS.includes(color)) return null;
  return { shape, color };
}

/** Roster bots for one account, deduplicated by id, with valid ids only. */
export function rosterFor(bots, account) {
  const seen = new Set();
  const out = [];
  for (const bot of bots) {
    if (typeof bot !== "object" || bot === null) continue;
    const id = typeof bot.id === "string" ? bot.id.trim() : "";
    // A bot without "account" (an extra roster file kept on one machine) counts for any.
    if ((bot.account ?? account) !== account || !BOT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof bot.name === "string" && bot.name.trim() ? bot.name.trim() : id });
  }
  return out;
}

/**
 * One plan row per roster bot. `profiles` maps bot id to the parsed profile.json
 * (or undefined when the file is missing/unreadable). A row with a body is an
 * avatar-only status report: it sets the symbol and changes nothing else.
 */
export function backfillPlan(roster, profiles) {
  return roster.map((bot) => {
    const profile = profiles.get(bot.id);
    if (profile === undefined) return { ...bot, body: null, reason: "no profile.json" };
    const avatar = avatarFromProfile(profile);
    if (avatar === null) return { ...bot, body: null, reason: "no avatar set (app default)" };
    return { ...bot, body: { botId: bot.id, avatar }, reason: null };
  });
}
