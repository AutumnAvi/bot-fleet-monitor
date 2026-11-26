import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { accountForKey, classifyKey, parsePasswordHash, sha256Hex, verifyPassword } from "../src/lib/auth";
import { BASE, CONTROL_KEY, LEAF_KEY, READ_KEY, SESSIONS_KEY, TEST_PASSWORD, WORK_KEY } from "./fixtures";
import { CHIEF, call, detail, findBot, fleet, freshStore, ingest, login, nextIp, sessionCookie, sql } from "./helpers";

beforeEach(freshStore);

describe("dashboard password", () => {
  it("redirects to /login and refuses the API without a session", async () => {
    const page = await call("/");
    expect(page.status).toBe(303);
    expect(page.headers.get("Location")).toBe("/login");

    const api = await call("/api/fleet");
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ ok: false, error: "unauthorized" });
  });

  it("rejects a wrong password without setting a cookie", async () => {
    for (const attempt of ["wrong", "", `${TEST_PASSWORD} `, TEST_PASSWORD.toUpperCase()]) {
      const res = await login(attempt);
      expect(res.status).toBe(401);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      const body = await res.text();
      expect(body).toContain("Wrong password.");
      expect(body).not.toContain(TEST_PASSWORD);
    }
  });

  it("sets a secure HttpOnly SameSite session cookie on the right password", async () => {
    const res = await login();
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(/^__Host-bf_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("accepts the session on the app and API, and stores only a hash of the token", async () => {
    const cookie = await sessionCookie();
    expect((await call("/", { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await call("/api/fleet", { headers: { Cookie: cookie } })).status).toBe(200);

    const token = cookie.split("=")[1] ?? "";
    const rows = await sql<{ token_hash: string }>("SELECT token_hash FROM sessions");
    expect(rows.map((r) => r.token_hash)).toEqual([await sha256Hex(token)]);
    expect(rows[0]?.token_hash).not.toContain(token);
  });

  it("rejects forged, malformed and expired session cookies", async () => {
    const forged = `__Host-bf_session=${"A".repeat(43)}`;
    expect((await call("/api/fleet", { headers: { Cookie: forged } })).status).toBe(401);
    expect((await call("/api/fleet", { headers: { Cookie: "__Host-bf_session=../../etc" } })).status).toBe(401);

    const cookie = await sessionCookie();
    await sql("UPDATE sessions SET expires_at = ?", Date.now() - 1);
    expect((await call("/api/fleet", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("ends existing sessions when the password hash changes", async () => {
    const cookie = await sessionCookie();
    expect((await call("/api/fleet", { headers: { Cookie: cookie } })).status).toBe(200);
    // Simulate a session issued under a previous DASHBOARD_PASSWORD_HASH.
    await sql("UPDATE sessions SET password_fp = 'fingerprint-of-old-password'");
    expect((await call("/api/fleet", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("redirects GET /login to the app when already signed in", async () => {
    const cookie = await sessionCookie();
    const res = await call("/login", { headers: { Cookie: cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("refuses cross-site login posts (CSRF)", async () => {
    const evil = await login(TEST_PASSWORD, { headers: { Origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("Set-Cookie")).toBeNull();

    const noOrigin = await call("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": nextIp() },
      body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
    });
    expect(noOrigin.status).toBe(403);

    const fetchMeta = await call("/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Site": "same-origin",
        "CF-Connecting-IP": nextIp(),
      },
      body: `password=${encodeURIComponent(TEST_PASSWORD)}`,
    });
    expect(fetchMeta.status).toBe(303);

    // Origin "null" (opaque) is only accepted with Sec-Fetch-Site: same-origin.
    const nullOrigin = await login(TEST_PASSWORD, { headers: { Origin: "null" } });
    expect(nullOrigin.status).toBe(403);
    const nullOriginSameSite = await login(TEST_PASSWORD, {
      headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    });
    expect(nullOriginSameSite.status).toBe(303);
    const nullOriginCrossSite = await login(TEST_PASSWORD, {
      headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" },
    });
    expect(nullOriginCrossSite.status).toBe(403);
  });

  it("rate-limits login attempts per IP, even with the right password", async () => {
    const ip = "203.0.113.77";
    for (let i = 0; i < 10; i++) expect((await login("nope", { ip })).status).toBe(401);
    const blocked = await login(TEST_PASSWORD, { ip });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(blocked.headers.get("Set-Cookie")).toBeNull();
    // A different IP is unaffected.
    expect((await login(TEST_PASSWORD, { ip: "203.0.113.78" })).status).toBe(303);
  });

  it("rejects oversized login bodies", async () => {
    const res = await login("x".repeat(5000));
    expect(res.status).toBe(413);
  });

  it("logs out: deletes the session server-side and clears the cookie", async () => {
    const cookie = await sessionCookie();
    const crossSite = await call("/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    expect((await call("/api/fleet", { headers: { Cookie: cookie } })).status).toBe(200);

    const res = await call("/logout", { method: "POST", headers: { Cookie: cookie, Origin: BASE } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("/api/fleet", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("verifyPassword fails closed on a missing or malformed hash", async () => {
    expect(await verifyPassword(TEST_PASSWORD, env.DASHBOARD_PASSWORD_HASH)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, undefined)).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, "")).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, "plaintext-password")).toBe(false);
    expect(await verifyPassword(TEST_PASSWORD, "pbkdf2-sha256:0:AAAA:AAAA")).toBe(false);
    expect(parsePasswordHash("pbkdf2-sha256:200000:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBeNull();
    expect(await verifyPassword("x".repeat(300), env.DASHBOARD_PASSWORD_HASH)).toBe(false);
  });
});

describe("ingest write keys", () => {
  const status = { botId: CHIEF, status: "working", step: "Building" };

  it("rejects missing, wrong and malformed keys without echoing them", async () => {
    const attempts: (string | null)[] = [null, "wrong-key", `${WORK_KEY}x`, WORK_KEY.slice(0, -1), ""];
    for (const key of attempts) {
      const res = await ingest("status", status, key);
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).toContain("unauthorized");
      if (key) expect(body).not.toContain(key);
    }
    const basic = await ingest("status", status, null, { Authorization: `Basic ${btoa(`x:${WORK_KEY}`)}` });
    expect(basic.status).toBe(401);
  });

  it("accepts the right key", async () => {
    expect((await ingest("status", status, WORK_KEY)).status).toBe(200);
  });

  it("maps keys to accounts and fails closed on unsafe configuration", async () => {
    expect(await accountForKey(WORK_KEY, env)).toBe("work");
    expect(await accountForKey(LEAF_KEY, env)).toBe("leaf");
    expect(await accountForKey(WORK_KEY, { INGEST_KEY_WORK: WORK_KEY, INGEST_KEY_LEAF: WORK_KEY })).toBeNull();
    expect(await accountForKey("short", { INGEST_KEY_WORK: "short", INGEST_KEY_LEAF: LEAF_KEY })).toBeNull();
    expect(await accountForKey(WORK_KEY, {})).toBeNull();
    expect(await accountForKey(null, env)).toBeNull();
    expect(await classifyKey(SESSIONS_KEY, env)).toBe("sessions");
    expect(await classifyKey(READ_KEY, env)).toBe("read");
    expect(await accountForKey(SESSIONS_KEY, env)).toBeNull();
    expect(await accountForKey(READ_KEY, env)).toBeNull();
    expect(
      await classifyKey(WORK_KEY, { INGEST_KEY_WORK: WORK_KEY, INGEST_KEY_LEAF: LEAF_KEY, INGEST_KEY_SESSIONS: WORK_KEY }),
    ).toBeNull();
    expect(
      await accountForKey(LEAF_KEY, { INGEST_KEY_WORK: WORK_KEY, INGEST_KEY_LEAF: LEAF_KEY, READ_KEY: LEAF_KEY }),
    ).toBeNull();
  });

  it("the control key is its own role and never an account", async () => {
    expect(await classifyKey(CONTROL_KEY, env)).toBe("control");
    expect(await accountForKey(CONTROL_KEY, env)).toBeNull();
    // Missing or short control key: the role does not exist, nothing else changes.
    expect(await classifyKey(CONTROL_KEY, { ...env, CONTROL_KEY: undefined })).toBeNull();
    expect(await classifyKey(READ_KEY, { ...env, CONTROL_KEY: undefined })).toBe("read");
    expect(await classifyKey("bfc_short", { ...env, CONTROL_KEY: "bfc_short" })).toBeNull();
  });

  it("a control key equal to any other key rejects every key", async () => {
    const others = { INGEST_KEY_WORK: WORK_KEY, INGEST_KEY_LEAF: LEAF_KEY, INGEST_KEY_SESSIONS: SESSIONS_KEY, READ_KEY };
    for (const [name, value] of Object.entries(others)) {
      const config = { ...others, CONTROL_KEY: value };
      for (const key of [...Object.values(others), CONTROL_KEY]) {
        expect(await classifyKey(key, config), `${name} == CONTROL_KEY, presenting ${key.slice(0, 4)}`).toBeNull();
      }
    }
    // Same check with surrounding whitespace (secrets are trimmed before comparing).
    expect(await classifyKey(READ_KEY, { ...others, CONTROL_KEY: ` ${READ_KEY}\n` })).toBeNull();
  });
});

describe("cross-account isolation", () => {
  it("a Leaf key cannot update a work-account bot", async () => {
    const res = await ingest("status", { botId: CHIEF, status: "error", step: "Hijacked" }, LEAF_KEY);
    expect(res.status).toBe(404);
    const cookie = await sessionCookie();
    const chief = findBot(await fleet(cookie), "work", CHIEF);
    expect(chief?.status).toBeNull();
    expect(chief?.step).toBeNull();
  });

  it("a Leaf key reusing a work bot's id creates a separate Leaf bot, never touching the work row", async () => {
    await ingest("status", { botId: CHIEF, status: "working", step: "Real work" }, WORK_KEY);
    const res = await ingest("status", { botId: CHIEF, name: "Impostor", status: "error", step: "Leaf thing" }, LEAF_KEY);
    expect(res.status).toBe(201);

    const data = await fleet(await sessionCookie());
    const work = findBot(data, "work", CHIEF);
    const leaf = findBot(data, "leaf", CHIEF);
    expect(work).toMatchObject({ name: "Chief · Chief of Staff", group: "Main", status: "working", step: "Real work" });
    expect(leaf).toMatchObject({ name: "Impostor", group: "Leaf account", status: "error", step: "Leaf thing" });
  });

  it("claiming the other account in the body is refused", async () => {
    const a = await ingest("status", { botId: CHIEF, status: "idle", account: "work" }, LEAF_KEY);
    expect(a.status).toBe(403);
    expect(await a.json()).toMatchObject({ error: "account_mismatch" });
    const b = await ingest("status", { botId: CHIEF, status: "idle", account: "leaf" }, WORK_KEY);
    expect(b.status).toBe(403);
    expect((await ingest("status", { botId: CHIEF, status: "idle", account: "work" }, WORK_KEY)).status).toBe(200);
  });

  it("a Leaf key cannot move a bot into a work group", async () => {
    const res = await ingest("status", { botId: "leaf-1", name: "Leaf Reports", group: "Main", status: "idle" }, LEAF_KEY);
    expect(res.status).toBe(400);
  });

  it("a Leaf 'Avi replied' mark never clears a work bot's messages", async () => {
    await ingest("message", { botId: CHIEF, text: "Please approve the merge" }, WORK_KEY);
    await ingest("message", { botId: CHIEF, name: "Leaf twin", text: "leaf msg" }, LEAF_KEY);
    await ingest("avi-replied", { botId: CHIEF }, LEAF_KEY);
    const cookie = await sessionCookie();
    expect((await detail(cookie, "work", CHIEF)).messages.map((m) => m.text)).toEqual(["Please approve the merge"]);
    expect((await detail(cookie, "leaf", CHIEF)).messages).toEqual([]);
  });
});
