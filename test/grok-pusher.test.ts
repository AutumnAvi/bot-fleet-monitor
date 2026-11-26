// scripts/lib/grok-usage.mjs: the mapping and validation behind scripts/push-grok-usage.mjs.

import { describe, expect, it } from "vitest";
import seed from "../docs/roster-seed.json";
import {
  MAX_GROK_BOTS,
  NAME_CHARS,
  OTHER_ID,
  SnapshotError,
  buildGrokUsage,
  rosterIndex,
  toMillis,
} from "../scripts/lib/grok-usage.mjs";
import { parseGrokUsagePayload } from "../src/lib/validate";
import { LIMITS } from "../src/shared/model";
import { CHIEF, DISK_SAVER, INTERNAL_DAM } from "./helpers";

const ROSTER = (seed as { bots: unknown[] }).bots;

function snapshot(bots: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { account: "work", pctUsed: 41, resetAt: null, asOf: "2026-11-26T09:00:00Z", bots, ...extra };
}

describe("Grok usage pusher", () => {
  it("matches the Worker's limits", () => {
    expect(MAX_GROK_BOTS).toBe(LIMITS.maxGrokBots);
    expect(NAME_CHARS).toBe(LIMITS.nameChars);
  });

  it("maps names (full, short, any case) and ids to roster bots", () => {
    const { body, notes } = buildGrokUsage(
      snapshot([
        { name: "chief", share: 22, routinesShare: 4 },
        { name: "  Internal   DAM ", share: 10 },
        { botId: DISK_SAVER, share: 3 },
      ]),
      ROSTER,
    );
    expect(notes).toEqual([]);
    expect(body.bots.map((b) => [b.botId, b.share, b.routinesShare])).toEqual([
      [CHIEF, 22, 4],
      [INTERNAL_DAM, 10, undefined],
      [DISK_SAVER, 3, undefined],
    ]);
    expect(body.bots[0]?.name).toBe("Chief · Chief of Staff");
  });

  it("sums unknown names into one Other row and reports them", () => {
    const { body, notes } = buildGrokUsage(
      snapshot([
        { name: "Chief", share: 20 },
        { name: "Mystery", share: 4, routinesShare: 1 },
        { name: "Ghost", share: 2 },
        { botId: "not-on-roster", share: 1 },
      ]),
      ROSTER,
    );
    const other = body.bots.find((b) => b.botId === OTHER_ID);
    expect(other).toEqual({ botId: OTHER_ID, name: "Other", share: 7, routinesShare: 1 });
    expect(body.bots[body.bots.length - 1]).toBe(other);
    expect(notes.join(" ")).toMatch(/3 unknown bot\(s\).*Mystery, Ghost/);
  });

  it("only uses the roster for the snapshot's account, plus an extra roster", () => {
    const leafRoster = [{ id: "leaf-1", name: "Leaf Helper", account: "leaf" }, { id: "leaf-2", name: "Inbox" }];
    const { body } = buildGrokUsage(
      snapshot([{ name: "Chief", share: 5 }, { name: "Leaf Helper", share: 9 }, { name: "inbox", share: 3 }], { account: "leaf" }),
      [...ROSTER, ...leafRoster],
    );
    expect(body.bots.map((b) => b.botId)).toEqual(["leaf-1", "leaf-2", OTHER_ID]);
  });

  it("treats a name two roster bots share as unknown", () => {
    const index = rosterIndex(
      [
        { id: "a", name: "Helper · One", account: "work" },
        { id: "b", name: "Helper · Two", account: "work" },
      ],
      "work",
    );
    expect(index.byName.get("helper")).toBeNull();
    const { body } = buildGrokUsage(snapshot([{ name: "Helper", share: 5 }, { name: "Helper · Two", share: 1 }]), [
      { id: "a", name: "Helper · One", account: "work" },
      { id: "b", name: "Helper · Two", account: "work" },
    ]);
    // "Helper" is ambiguous (Other); the full name still matches. Other is always last.
    expect(body.bots.map((b) => b.botId)).toEqual(["b", OTHER_ID]);
  });

  it("merges rows that map to the same bot", () => {
    const { body } = buildGrokUsage(snapshot([{ name: "Chief", share: 10, routinesShare: 2 }, { botId: CHIEF, share: 5, routinesShare: 1 }]), ROSTER);
    expect(body.bots).toEqual([{ botId: CHIEF, name: "Chief · Chief of Staff", share: 15, routinesShare: 3 }]);
  });

  it("clamps percentages and keeps routinesShare within share", () => {
    const { body } = buildGrokUsage(
      snapshot([{ name: "Chief", share: 140, routinesShare: 200 }, { name: "Disk Saver", share: -3, routinesShare: 2 }], { pctUsed: 123.456 }),
      ROSTER,
    );
    expect(body.pctUsed).toBe(100);
    expect(body.bots[0]).toMatchObject({ botId: CHIEF, share: 100, routinesShare: 100 });
    expect(body.bots[1]).toMatchObject({ botId: DISK_SAVER, share: 0, routinesShare: 0 });
  });

  it("drops bad bot rows with a note instead of failing the push", () => {
    const { body, notes } = buildGrokUsage(snapshot([null, { name: "Chief" }, { name: "Chief", share: "12" }, { name: "Chief", share: 1 }]), ROSTER);
    expect(body.bots).toHaveLength(1);
    expect(notes).toHaveLength(3);
  });

  it("refuses an unusable snapshot", () => {
    for (const bad of [
      null,
      [],
      snapshot([], { account: "both" }),
      snapshot([], { pctUsed: "41" }),
      snapshot([], { resetAt: "soon" }),
      snapshot([], { asOf: 12 }),
      { account: "work", pctUsed: 1, resetAt: null, bots: {} },
    ]) {
      expect(() => buildGrokUsage(bad, ROSTER)).toThrow(SnapshotError);
    }
  });

  it("normalizes timestamps to ms and omits a missing asOf", () => {
    expect(toMillis(1_764_300_000, "x")).toBe(1_764_300_000_000);
    expect(toMillis(1_764_300_000_000, "x")).toBe(1_764_300_000_000);
    expect(toMillis("2026-11-26T09:00:00Z", "x")).toBe(Date.parse("2026-11-26T09:00:00Z"));
    expect(toMillis(null, "x")).toBeNull();
    const { body } = buildGrokUsage({ account: "leaf", pctUsed: 3, resetAt: 1_764_300_000, bots: [] }, ROSTER);
    expect(body).toEqual({ account: "leaf", pctUsed: 3, resetAt: 1_764_300_000_000, bots: [] });
  });

  it("stays under the Worker's bot cap, folding the smallest into Other", () => {
    const roster = Array.from({ length: 250 }, (_, i) => ({ id: `bot-${i}`, name: `Bot ${i}`, account: "work" }));
    const rows = roster.map((bot, i) => ({ botId: bot.id, share: (250 - i) / 100 }));
    const { body, notes } = buildGrokUsage(snapshot(rows), roster);
    expect(body.bots).toHaveLength(MAX_GROK_BOTS);
    expect(body.bots[body.bots.length - 1]?.botId).toBe(OTHER_ID);
    expect(notes.some((n) => n.includes("folded"))).toBe(true);
  });

  it("truncates long roster names to the Worker's limit", () => {
    const long = "N".repeat(80);
    const { body } = buildGrokUsage(snapshot([{ botId: "x1", share: 1 }]), [{ id: "x1", name: long, account: "work" }]);
    expect(Array.from(body.bots[0]?.name ?? "")).toHaveLength(NAME_CHARS);
  });

  it("produces a body the Worker accepts unchanged", () => {
    const { body } = buildGrokUsage(
      snapshot([{ name: "Chief", share: 22, routinesShare: 4 }, { name: "Unknown", share: 1 }], { resetAt: "2026-11-29T00:00:00Z" }),
      ROSTER,
    );
    const parsed = parseGrokUsagePayload(JSON.parse(JSON.stringify(body)), "work");
    expect(parsed.bots.map((b) => b.botId)).toEqual([CHIEF, OTHER_ID]);
    expect(parsed.asOf).toBe(Date.parse("2026-11-26T09:00:00Z"));
    expect(parsed.resetAt).toBe(Date.parse("2026-11-29T00:00:00Z"));
  });
});
