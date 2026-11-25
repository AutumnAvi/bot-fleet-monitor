import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../src/shared/model";
import { LEAF_KEY } from "./fixtures";
import { CHIEF, INTERNAL_DAM, call, detail, findBot, fleet, freshStore, ingest, sessionCookie, sql } from "./helpers";

beforeEach(freshStore);

describe("messages since Avi's last reply", () => {
  it("is empty (never invented) until a bot pushes a copy", async () => {
    const cookie = await sessionCookie();
    const d = await detail(cookie, "work", CHIEF);
    expect(d.messages).toEqual([]);
    expect(d.summary).toBeNull();
    expect(d.bot.unread).toBe(0);
    expect(d.bot.lastAviReplyAt).toBeNull();
  });

  it("lists pushed copies oldest first and counts them as unread", async () => {
    for (const text of ["one", "two", "three"]) expect((await ingest("message", { botId: CHIEF, text })).status).toBe(200);
    const cookie = await sessionCookie();
    const d = await detail(cookie, "work", CHIEF);
    expect(d.messages.map((m) => m.text)).toEqual(["one", "two", "three"]);
    expect(findBot(await fleet(cookie), "work", CHIEF)?.unread).toBe(3);
    expect(findBot(await fleet(cookie), "work", INTERNAL_DAM)?.unread).toBe(0);
  });

  it("an 'Avi replied' mark clears the list and rolls it forward", async () => {
    await ingest("message", { botId: CHIEF, text: "before reply 1" });
    await ingest("message", { botId: CHIEF, text: "before reply 2" });
    const before = Date.now();
    expect((await ingest("avi-replied", { botId: CHIEF })).status).toBe(200);

    const cookie = await sessionCookie();
    let d = await detail(cookie, "work", CHIEF);
    expect(d.messages).toEqual([]);
    expect(d.bot.unread).toBe(0);
    expect(d.bot.lastAviReplyAt).toBeGreaterThanOrEqual(before);

    await ingest("message", { botId: CHIEF, text: "after reply" });
    d = await detail(cookie, "work", CHIEF);
    expect(d.messages.map((m) => m.text)).toEqual(["after reply"]);
    expect(d.bot.unread).toBe(1);
  });

  it("only clears the bot that got the reply", async () => {
    await ingest("message", { botId: CHIEF, text: "chief msg" });
    await ingest("message", { botId: INTERNAL_DAM, text: "dam msg" });
    await ingest("avi-replied", { botId: CHIEF });
    const cookie = await sessionCookie();
    expect((await detail(cookie, "work", CHIEF)).messages).toEqual([]);
    expect((await detail(cookie, "work", INTERNAL_DAM)).messages.map((m) => m.text)).toEqual(["dam msg"]);
  });

  it("keeps at most the newest N copies per bot", async () => {
    const total = LIMITS.messagesPerBot + 5;
    for (let i = 0; i < total; i++) {
      if (i > 0 && i % 25 === 0) await sql("DELETE FROM rate_limits");
      expect((await ingest("message", { botId: CHIEF, text: `m${i}` })).status).toBe(200);
    }
    const d = await detail(await sessionCookie(), "work", CHIEF);
    expect(d.messages).toHaveLength(LIMITS.messagesPerBot);
    expect(d.messages[0]?.text).toBe("m5");
    expect(d.messages.at(-1)?.text).toBe(`m${total - 1}`);
  });

  it("caps message length, keeps line breaks, and rejects empty messages", async () => {
    await ingest("message", { botId: CHIEF, text: `Line 1\nLine 2\n${"x".repeat(3000)}` });
    const d = await detail(await sessionCookie(), "work", CHIEF);
    const text = d.messages[0]?.text ?? "";
    expect(text.startsWith("Line 1\nLine 2\n")).toBe(true);
    expect(Array.from(text)).toHaveLength(LIMITS.messageChars);
    expect(text.endsWith("…")).toBe(true);
    expect((await ingest("message", { botId: CHIEF, text: "   " })).status).toBe(400);
    expect((await ingest("message", { botId: CHIEF })).status).toBe(400);
  });

  it("works for Leaf bots too, created on first push", async () => {
    expect((await ingest("message", { botId: "leaf-a", name: "Leaf A", text: "hi Avi" }, LEAF_KEY)).status).toBe(201);
    const cookie = await sessionCookie();
    expect((await detail(cookie, "leaf", "leaf-a")).messages.map((m) => m.text)).toEqual(["hi Avi"]);
    await ingest("avi-replied", { botId: "leaf-a" }, LEAF_KEY);
    expect((await detail(cookie, "leaf", "leaf-a")).messages).toEqual([]);
  });

  it("detail returns 404 for unknown bots and bad accounts", async () => {
    const cookie = await sessionCookie();
    for (const path of ["/api/bots/work/nope", "/api/bots/leaf/" + CHIEF, "/api/bots/other/" + CHIEF, "/api/bots/work/%E0%A4%A"]) {
      const res = await call(path, { headers: { Cookie: cookie } });
      expect([400, 404]).toContain(res.status);
    }
  });
});
