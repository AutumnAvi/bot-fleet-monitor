// A symbol per bot: optional avatar {shape, color} on /ingest/v1/status.

import { abortAllDurableObjects } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAvatar, parseIngestPayload } from "../src/lib/validate";
import { AVATAR_COLORS, AVATAR_SHAPES, type StateResponse } from "../src/shared/model";
import { LEAF_KEY, READ_KEY } from "./fixtures";
import { CHIEF, call, findBot, fleet, freshStore, ingest, sessionCookie, sql } from "./helpers";

beforeEach(freshStore);

async function state(): Promise<StateResponse> {
  const res = await call("/api/v1/state", { headers: { Authorization: `Bearer ${READ_KEY}` } });
  expect(res.status).toBe(200);
  return res.json<StateResponse>();
}

describe("avatar validation", () => {
  it("accepts every listed shape and color, case-insensitively", () => {
    for (const shape of AVATAR_SHAPES) {
      for (const color of AVATAR_COLORS) expect(parseAvatar({ shape, color })).toEqual({ shape, color });
    }
    expect(parseAvatar({ shape: " Blob ", color: "BLACK" })).toEqual({ shape: "blob", color: "black" });
  });

  it("ignores unknown or malformed values instead of failing", () => {
    for (const value of [
      undefined,
      null,
      "blob:black",
      ["blob", "black"],
      {},
      { shape: "blob" },
      { color: "black" },
      { shape: "triangle", color: "black" },
      { shape: "blob", color: "magenta" },
      { shape: 1, color: "black" },
    ]) {
      expect(parseAvatar(value)).toBeNull();
    }
    // Extra keys inside the object are ignored, the known ones still count.
    expect(parseAvatar({ shape: "star", color: "blue", size: 3 })).toEqual({ shape: "star", color: "blue" });
  });

  it("a status report with an unknown avatar is still a valid status report", () => {
    const payload = parseIngestPayload("status", "work", {
      botId: CHIEF,
      status: "working",
      avatar: { shape: "triangle", color: "black" },
    });
    expect(payload).toMatchObject({ kind: "status", status: "working", avatar: null });
  });

  it("only the status report takes an avatar", () => {
    expect(() => parseIngestPayload("summary", "work", { botId: CHIEF, summary: "x", avatar: { shape: "blob", color: "red" } })).toThrow(
      /Unknown field "avatar"/,
    );
  });

  it("an avatar-only report needs a valid avatar and no step", () => {
    expect(parseIngestPayload("status", "work", { botId: CHIEF, avatar: { shape: "hex", color: "cyan" } })).toMatchObject({
      status: null,
      avatar: { shape: "hex", color: "cyan" },
    });
    expect(() => parseIngestPayload("status", "work", { botId: CHIEF, avatar: { shape: "nope", color: "cyan" } })).toThrow(/"status"/);
    expect(() => parseIngestPayload("status", "work", { botId: CHIEF, step: "x", avatar: { shape: "hex", color: "cyan" } })).toThrow(
      /"status"/,
    );
  });
});

describe("avatar storage and state", () => {
  it("is null until set, then persisted and returned in /api/v1/state and /api/fleet", async () => {
    expect(findBot(await state(), "work", CHIEF)?.avatar).toBeNull();
    const res = await ingest("status", { botId: CHIEF, status: "working", step: "Go", avatar: { shape: "blob", color: "black" } });
    expect(res.status).toBe(200);
    expect(findBot(await state(), "work", CHIEF)).toMatchObject({ status: "working", avatar: { shape: "blob", color: "black" } });
    expect(findBot(await fleet(await sessionCookie()), "work", CHIEF)?.avatar).toEqual({ shape: "blob", color: "black" });
  });

  it("a report without an avatar, or with an unknown one, keeps the stored avatar", async () => {
    await ingest("status", { botId: CHIEF, status: "working", avatar: { shape: "star", color: "yellow" } });
    await ingest("status", { botId: CHIEF, status: "idle" });
    await ingest("status", { botId: CHIEF, status: "idle", avatar: { shape: "star", color: "ultraviolet" } });
    await ingest("summary", { botId: CHIEF, summary: "Halfway" });
    expect(findBot(await state(), "work", CHIEF)?.avatar).toEqual({ shape: "star", color: "yellow" });
    await ingest("status", { botId: CHIEF, status: "idle", avatar: { shape: "cloud", color: "purple" } });
    expect(findBot(await state(), "work", CHIEF)?.avatar).toEqual({ shape: "cloud", color: "purple" });
  });

  it("survives a restart and a store created before the columns existed", async () => {
    await ingest("status", { botId: CHIEF, status: "idle", avatar: { shape: "pebble", color: "gray" } });
    await abortAllDurableObjects();
    expect(findBot(await state(), "work", CHIEF)?.avatar).toEqual({ shape: "pebble", color: "gray" });
    await sql("ALTER TABLE bots DROP COLUMN avatar_shape");
    await sql("ALTER TABLE bots DROP COLUMN avatar_color");
    await abortAllDurableObjects();
    expect(findBot(await state(), "work", CHIEF)).toMatchObject({ status: "idle", avatar: null });
  });

  it("an avatar-only report changes nothing but the avatar", async () => {
    await ingest("status", { botId: CHIEF, status: "waiting_user", step: "Need your OK" });
    await ingest("save-for-later", { botId: CHIEF });
    const before = findBot(await state(), "work", CHIEF);
    const eventsBefore = (await state()).activity.items.length;
    const res = await ingest("status", { botId: CHIEF, avatar: { shape: "teardrop", color: "orange" } });
    expect(res.status).toBe(200);
    const after = await state();
    expect(findBot(after, "work", CHIEF)).toEqual({ ...before, avatar: { shape: "teardrop", color: "orange" } });
    expect(after.activity.items.length).toBe(eventsBefore);
  });

  it("an avatar-only report for an unknown bot is 404 (it does not register one)", async () => {
    expect((await ingest("status", { botId: "nobody", avatar: { shape: "hex", color: "red" } })).status).toBe(404);
  });

  it("without a status, name/group/status:null are refused, so it cannot register, rename or regroup", async () => {
    const avatar = { shape: "hex", color: "red" };
    expect((await ingest("status", { botId: "nobody", name: "New", avatar })).status).toBe(400);
    expect((await ingest("status", { botId: CHIEF, name: "Renamed", avatar })).status).toBe(400);
    expect((await ingest("status", { botId: CHIEF, group: "PMs", avatar })).status).toBe(400);
    expect((await ingest("status", { botId: CHIEF, status: null, avatar })).status).toBe(400);
    expect((await ingest("status", { botId: CHIEF, name: null, avatar })).status).toBe(400);
    const st = await state();
    expect(findBot(st, "work", "nobody")).toBeUndefined();
    expect(findBot(st, "work", CHIEF)).toMatchObject({ group: "Main", avatar: null });
    expect(findBot(st, "work", CHIEF)?.name).not.toBe("Renamed");
  });

  it("works for Leaf bots, registered with a name", async () => {
    const res = await ingest("status", { botId: "leaf-1", name: "Leaf Helper", status: "idle", avatar: { shape: "wedge", color: "green" } }, LEAF_KEY);
    expect(res.status).toBe(201);
    expect(findBot(await state(), "leaf", "leaf-1")?.avatar).toEqual({ shape: "wedge", color: "green" });
  });
});
