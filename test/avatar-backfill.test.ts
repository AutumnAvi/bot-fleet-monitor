// scripts/lib/avatar.mjs: the pure part of scripts/avatar-backfill.mjs.

import { describe, expect, it } from "vitest";
import seed from "../docs/roster-seed.json";
import { AVATAR_COLORS, AVATAR_SHAPES, BOT_ID, avatarFromProfile, backfillPlan, rosterFor } from "../scripts/lib/avatar.mjs";
import { parseIngestPayload } from "../src/lib/validate";
import * as model from "../src/shared/model";

describe("avatar backfill", () => {
  it("uses the Worker's shape and color lists", () => {
    expect(AVATAR_SHAPES).toEqual([...model.AVATAR_SHAPES]);
    expect(AVATAR_COLORS).toEqual([...model.AVATAR_COLORS]);
  });

  it("reads avatarShape / avatarColor and skips unset or unknown looks", () => {
    expect(avatarFromProfile({ avatarShape: "blob", avatarColor: "black", name: "Chief" })).toEqual({ shape: "blob", color: "black" });
    expect(avatarFromProfile({ avatarShape: "Star", avatarColor: " Blue " })).toEqual({ shape: "star", color: "blue" });
    expect(avatarFromProfile({ avatarShape: "", avatarColor: "" })).toBeNull();
    expect(avatarFromProfile({ avatarShape: "blob" })).toBeNull();
    expect(avatarFromProfile({ avatarShape: "moon", avatarColor: "black" })).toBeNull();
    expect(avatarFromProfile(null)).toBeNull();
    expect(avatarFromProfile("blob:black")).toBeNull();
  });

  it("takes roster bots for one account, valid ids only, once each", () => {
    const roster = rosterFor(
      [
        { id: "a", name: "A", account: "work" },
        { id: "a", name: "A again", account: "work" },
        { id: "../etc", name: "Escape", account: "work" },
        { id: "l1", name: "Leaf", account: "leaf" },
        { id: "x1" },
        "junk",
      ],
      "work",
    );
    expect(roster).toEqual([
      { id: "a", name: "A" },
      { id: "x1", name: "x1" },
    ]);
    expect(rosterFor([{ id: "l1", name: "Leaf", account: "leaf" }], "leaf")).toEqual([{ id: "l1", name: "Leaf" }]);
    expect(BOT_ID.test("../x")).toBe(false);
  });

  it("plans avatar-only status reports the Worker accepts", () => {
    const roster = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ];
    const plan = backfillPlan(
      roster,
      new Map<string, unknown>([
        ["a", { avatarShape: "hex", avatarColor: "cyan" }],
        ["b", { avatarShape: "", avatarColor: "" }],
      ]),
    );
    expect(plan.map((row) => row.reason)).toEqual([null, "no avatar set (app default)", "no profile.json"]);
    const body = plan[0]?.body;
    expect(body).toEqual({ botId: "a", avatar: { shape: "hex", color: "cyan" } });
    // The body is an avatar-only status report: no status, no step.
    expect(parseIngestPayload("status", "work", body)).toMatchObject({ status: null, step: null, avatar: { shape: "hex", color: "cyan" } });
  });

  it("covers every work bot in the roster seed", () => {
    const roster = rosterFor((seed as { bots: unknown[] }).bots, "work");
    expect(roster.length).toBe((seed as { bots: unknown[] }).bots.length);
    expect(rosterFor((seed as { bots: unknown[] }).bots, "leaf")).toEqual([]);
  });
});
