import { describe, expect, it } from "vitest";
import { REDACTED, cleanBlock, cleanLine, redactSecrets, truncate } from "../src/lib/sanitize";
import { ClientError, parseIngestPayload } from "../src/lib/validate";
import { activityDetail, activityLabel, buildFleetView, openUrl, stepText, visibleActivity } from "../src/shared/fleet-view";
import { STALE_AFTER_MS, type ActivityItem, type BotView } from "../src/shared/model";
import { bucketOf, displayState, lastSeenAt } from "../src/shared/status";
import { formatClock, formatFull, formatRelative } from "../src/shared/time";

const NOW = Date.UTC(2026, 10, 24, 18, 30, 0); // 8:30 PM in Asia/Hebron (UTC+2)

function bot(partial: Partial<BotView> & Pick<BotView, "id">): BotView {
  return {
    account: "work",
    name: partial.id,
    group: "Main",
    sortIndex: 0,
    status: null,
    step: null,
    statusAt: null,
    summaryAt: null,
    unread: 0,
    lastAviReplyAt: null,
    lastReportAt: null,
    savedAt: null,
    avatar: null,
    ...partial,
  };
}

describe("displayState / stale timer", () => {
  it("never-reported bots are unknown and count as idle (no fake working)", () => {
    expect(displayState({ status: null, statusAt: null }, NOW)).toBe("unknown");
    expect(bucketOf("unknown")).toBe("idle");
  });

  it("working stays working until exactly 10 minutes, then is stale/stuck", () => {
    expect(displayState({ status: "working", statusAt: NOW - STALE_AFTER_MS + 1 }, NOW)).toBe("working");
    expect(displayState({ status: "working", statusAt: NOW - STALE_AFTER_MS }, NOW)).toBe("stale");
    expect(bucketOf("stale")).toBe("stuck");
  });

  it("last seen is the newest report of any kind", () => {
    expect(lastSeenAt({ statusAt: null, lastReportAt: null })).toBeNull();
    expect(lastSeenAt({ statusAt: null, lastReportAt: 5 })).toBe(5); // message-only bot
    expect(lastSeenAt({ statusAt: 9, lastReportAt: 5 })).toBe(9);
    expect(lastSeenAt({ statusAt: 3, lastReportAt: 5 })).toBe(5);
  });

  it("any later report counts as a sign of life", () => {
    const old = NOW - STALE_AFTER_MS - 60_000;
    expect(displayState({ status: "working", statusAt: old, lastReportAt: old }, NOW)).toBe("stale");
    expect(displayState({ status: "working", statusAt: old, lastReportAt: NOW - 60_000 }, NOW)).toBe("working");
    expect(displayState({ status: null, statusAt: null, lastReportAt: NOW }, NOW)).toBe("unknown");
  });

  it("maps statuses to the four tiles; idle is not an error", () => {
    expect(bucketOf("waiting_user")).toBe("needs_me");
    expect(bucketOf("working")).toBe("working");
    expect(bucketOf("idle")).toBe("idle");
    expect(bucketOf("error")).toBe("stuck");
    expect(displayState({ status: "idle", statusAt: NOW - 86_400_000 }, NOW)).toBe("idle");
    expect(displayState({ status: "error", statusAt: NOW - 86_400_000 }, NOW)).toBe("error");
  });
});

describe("fleet view", () => {
  const bots: BotView[] = [
    bot({ id: "chief", name: "Chief", group: "Main", status: "waiting_user", step: "Approve merge", statusAt: NOW - 60_000 }),
    bot({ id: "dam", name: "Internal DAM", group: "PMs", status: "waiting_user", step: "Review access", statusAt: NOW - 180_000 }),
    bot({ id: "copy", name: "Copy Library PM", group: "PMs", sortIndex: 1, status: "working", step: "Phase 3", statusAt: NOW - 60_000 }),
    bot({ id: "stale", name: "Stale One", group: "Asana", status: "working", step: "Syncing", statusAt: NOW - STALE_AFTER_MS - 1 }),
    bot({ id: "err", name: "Broken", group: "Sub-Bots", status: "error", step: "Token expired", statusAt: NOW }),
    bot({ id: "quiet", name: "Quiet", group: "Main", sortIndex: 2 }),
    bot({ id: "leafy", account: "leaf", name: "Leaf Reports", group: "Leaf account", status: "working", step: "Report", statusAt: NOW }),
  ];
  const view = (o: Partial<Parameters<typeof buildFleetView>[1]> = {}) =>
    buildFleetView(bots, { account: "both", filter: "all", query: "", now: NOW, ...o });

  it("counts tiles over the selected accounts", () => {
    expect(view().counts).toEqual({ needs_me: 2, working: 2, idle: 1, stuck: 2 });
    expect(view({ account: "work" }).counts).toEqual({ needs_me: 2, working: 1, idle: 1, stuck: 2 });
    expect(view({ account: "leaf" }).counts).toEqual({ needs_me: 0, working: 1, idle: 0, stuck: 0 });
  });

  it("pins Needs me and Stuck (incl. stale) on top, newest first, and keeps them out of their groups", () => {
    const v = view();
    expect(v.attention?.map((r) => r.bot.id)).toEqual(["err", "chief", "dam", "stale"]);
    expect(v.groups.map((g) => g.name)).toEqual(["Main", "PMs", "Asana", "Sub-Bots", "Leaf account"]);
    expect(v.groups.find((g) => g.name === "Asana")?.emptyText).toMatch(/Needs my attention or Save for later/);
    expect(v.groups.find((g) => g.name === "Main")?.rows.map((r) => r.bot.id)).toEqual(["quiet"]);
    expect(v.groups.find((g) => g.name === "PMs")?.rows.map((r) => r.bot.id)).toEqual(["copy"]);
  });

  it("shows Unassigned only when it has bots, and an empty Leaf group with a note", () => {
    const withUnassigned = buildFleetView([...bots, bot({ id: "u", group: "Unassigned" })], {
      account: "both",
      filter: "all",
      query: "",
      now: NOW,
    });
    expect(withUnassigned.groups.map((g) => g.name)).toContain("Unassigned");
    const noLeaf = buildFleetView(bots.filter((b) => b.account === "work"), { account: "both", filter: "all", query: "", now: NOW });
    const leafGroup = noLeaf.groups.find((g) => g.name === "Leaf account");
    expect(leafGroup?.rows).toEqual([]);
    expect(leafGroup?.emptyText).toMatch(/No Leaf-account bots yet/);
  });

  it("filters by status chip, search text and account", () => {
    expect(view({ filter: "stuck" }).attention?.map((r) => r.bot.id)).toEqual(["err", "stale"]);
    expect(view({ filter: "stuck" }).groups).toEqual([]);
    expect(view({ filter: "needs_me" }).attention?.map((r) => r.bot.id)).toEqual(["chief", "dam"]);
    expect(view({ filter: "needs_me" }).groups).toEqual([]);
    expect(view({ filter: "working" }).attention).toBeNull();
    expect(view({ query: "library" }).groups.flatMap((g) => g.rows.map((r) => r.bot.id))).toEqual(["copy"]);
    expect(view({ query: "approve" }).attention?.map((r) => r.bot.id)).toEqual(["chief"]);
    expect(view({ account: "work" }).groups.map((g) => g.name)).not.toContain("Leaf account");
    expect(view({ account: "leaf" }).groups.map((g) => g.name)).toEqual(["Leaf account"]);
    expect(view({ query: "zzz" }).shown).toBe(0);
  });

  it("Save for later holds saved bots (newest save first) out of attention and groups", () => {
    const saved = bots.map((b) =>
      b.id === "dam" ? { ...b, savedAt: NOW - 1000 } : b.id === "quiet" ? { ...b, savedAt: NOW - 5000 } : b,
    );
    const v = buildFleetView(saved, { account: "both", filter: "all", query: "", now: NOW });
    expect(v.saved.map((r) => r.bot.id)).toEqual(["dam", "quiet"]);
    expect(v.savedCount).toBe(2);
    expect(v.attention?.map((r) => r.bot.id)).toEqual(["err", "chief", "stale"]);
    expect(v.groups.find((g) => g.name === "Main")?.rows).toEqual([]);
    expect(v.counts.needs_me).toBe(2); // tiles still count saved bots by status
    expect(v.shown).toBe(saved.length);
    const filtered = buildFleetView(saved, { account: "both", filter: "needs_me", query: "", now: NOW });
    expect(filtered.saved.map((r) => r.bot.id)).toEqual(["dam"]);
    expect(filtered.attention?.map((r) => r.bot.id)).toEqual(["chief"]);
  });

  it("Open deep link is the agent URL for both accounts and encodes the id", () => {
    expect(openUrl({ id: "b0642d5e-4aaf" })).toBe("grokbot://app/v1/agent?id=b0642d5e-4aaf");
    expect(openUrl({ id: "a:b" })).toBe("grokbot://app/v1/agent?id=a%3Ab");
    expect(openUrl({ id: "x" })).toBe("grokbot://app/v1/agent?id=x");
    expect(view().groups.find((g) => g.name === "Leaf account")?.rows[0]?.openUrl).toBe("grokbot://app/v1/agent?id=leafy");
  });

  it("uses honest copy for unknown and stale bots", () => {
    expect(stepText(bot({ id: "x" }), "unknown", NOW)).toBe("No status yet");
    expect(stepText(bot({ id: "x", step: "Syncing", statusAt: NOW - 14 * 60_000 }), "stale", NOW)).toBe(
      "No update for 14m · Syncing",
    );
    expect([activityLabel("done"), activityDetail({ kind: "done", detail: "Build" })]).toEqual(["Done", "Build"]);
    expect(activityDetail({ kind: "avi_replied", detail: null })).toBeNull();
  });
});

describe("activity wording", () => {
  const item = (seq: number, kind: ActivityItem["kind"], detail: string | null, botId = "a"): ActivityItem => ({
    seq,
    at: seq * 1000,
    account: "work",
    botId,
    botName: botId.toUpperCase(),
    kind,
    detail,
  });

  it("uses short labels with the detail after, no prefixes", () => {
    const kinds: ActivityItem["kind"][] = ["working", "waiting_user", "error", "idle", "done", "message", "avi_replied", "saved", "unsaved"];
    expect(kinds.map(activityLabel)).toEqual([
      "Working",
      "Needs you",
      "Stuck",
      "Idle",
      "Done",
      "Sent you",
      "You replied",
      "Saved",
      "Unsaved",
    ]);
    expect(activityDetail({ kind: "waiting_user", detail: "Approve cleanup" })).toBe("Approve cleanup");
    expect(activityDetail({ kind: "message", detail: "Done, see the PR" })).toBe("“Done, see the PR”");
    expect(activityDetail({ kind: "error", detail: null })).toBeNull();
    expect(activityDetail({ kind: "summary", detail: "Long need-to-know" })).toBeNull();
  });

  it("hides summary events", () => {
    const out = visibleActivity([item(3, "summary", "x"), item(2, "working", "Go"), item(1, "summary", "y")]);
    expect(out.map((e) => e.seq)).toEqual([2]);
  });

  it("collapses back-to-back same-bot same-text events, keeping the one that asks more", () => {
    const out = visibleActivity([
      item(6, "message", "Need your OK"),
      item(5, "waiting_user", "Need your OK"),
      item(4, "summary", "between"),
      item(3, "waiting_user", "Need your OK", "b"),
      item(2, "avi_replied", null),
      item(1, "avi_replied", null),
    ]);
    expect(out.map((e) => [e.seq, e.kind])).toEqual([
      [5, "waiting_user"],
      [3, "waiting_user"],
      [2, "avi_replied"],
    ]);
  });

  it("keeps the newer row when it is not a message repeating a status", () => {
    const out = visibleActivity([item(3, "done", "PR #42"), item(2, "waiting_user", "PR #42"), item(1, "error", "PR #42")]);
    expect(out.map((e) => [e.seq, e.kind])).toEqual([[3, "done"]]);
    const repeat = visibleActivity([item(2, "waiting_user", "OK?"), item(1, "message", "OK?")]);
    expect(repeat.map((e) => e.kind)).toEqual(["waiting_user"]);
  });

  it("does not collapse different text, different bots, or non-adjacent repeats", () => {
    const out = visibleActivity([
      item(4, "working", "Step 2"),
      item(3, "working", "Step 1"),
      item(2, "working", "Step 2"),
      item(1, "idle", null),
    ]);
    expect(out).toHaveLength(4);
    expect(visibleActivity([item(2, "saved", null), item(1, "unsaved", null)])).toHaveLength(2);
  });
});

describe("Asia/Hebron time formatting", () => {
  it("shows clock times in Hebron (UTC+2 in November)", () => {
    expect(formatClock(Date.UTC(2026, 10, 24, 18, 2), NOW)).toBe("8:02 PM");
    expect(formatClock(Date.UTC(2026, 10, 23, 18, 2), NOW)).toBe("Nov 23, 8:02 PM");
    // 23:30 UTC is already the next day in Hebron.
    expect(formatClock(Date.UTC(2026, 10, 24, 23, 30), Date.UTC(2026, 10, 25, 6, 0))).toBe("1:30 AM");
    expect(formatFull(Date.UTC(2026, 10, 24, 18, 2))).toMatch(/Tue, Nov 24, 8:02\sPM GMT\+2/);
  });

  it("formats relative times", () => {
    expect(formatRelative(NOW - 10_000, NOW)).toBe("just now");
    expect(formatRelative(NOW + 60_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
  });
});

describe("sanitize", () => {
  it("cleans single lines", () => {
    expect(cleanLine("  a\tb\n\nc\u0007‮d​  ", 80)).toBe("a b cd");
    expect(cleanLine("\uD800bad", 80)).toBe("�bad");
  });

  it("cleans blocks but keeps paragraphs and indentation", () => {
    expect(cleanBlock("a\r\nb\n\n\n\nc  \n", 100)).toBe("a\nb\n\nc");
    expect(cleanBlock("List:\n  - one   two\n\t- three", 100)).toBe("List:\n  - one two\n - three");
  });

  it("keeps joiners and direction marks that real text needs", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(cleanLine(`Hi ${family}`, 80)).toBe(`Hi ${family}`);
    expect(cleanLine("می\u200Cخواهم", 80)).toBe("می\u200Cخواهم");
    expect(cleanLine("a\u200Eb", 80)).toBe("a\u200Eb");
  });

  it("truncates by code point with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("😀😀😀", 2)).toBe("😀…");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("redacts credential-looking strings", () => {
    const samples = [
      "ghp_0123456789abcdefghijABCDEFGHIJ",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdefghij",
      "AKIAABCDEFGHIJKLMNOP",
      "bfw_abcdefghijklmnopqrstuvwxyz012345",
      "bfs_abcdefghijklmnopqrstuvwxyz012345",
      "bfr_abcdefghijklmnopqrstuvwxyz012345",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ];
    for (const s of samples) expect(redactSecrets(`x ${s} y`)).toBe(`x ${REDACTED} y`);
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop1234")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets("plain words stay")).toBe("plain words stay");
  });
});

describe("payload validation", () => {
  it("returns typed, cleaned payloads", () => {
    expect(parseIngestPayload("status", "work", { botId: " abc ", status: "done", step: " Shipped " })).toEqual({
      kind: "status",
      botId: "abc",
      status: "done",
      step: "Shipped",
      avatar: null,
    });
    expect(parseIngestPayload("avi-replied", "leaf", { botId: "x", group: "Leaf account" })).toEqual({
      kind: "avi-replied",
      botId: "x",
      group: "Leaf account",
    });
  });

  it("throws ClientError with a status code", () => {
    const err = (() => {
      try {
        parseIngestPayload("status", "leaf", { botId: "x", status: "idle", account: "work" });
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(403);
    expect(() => parseIngestPayload("status", "work", { botId: "x", status: "idle", name: "   " })).toThrow(ClientError);
  });
});
