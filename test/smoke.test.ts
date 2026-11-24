import { beforeEach, describe, expect, it } from "vitest";
import { call, freshStore, sessionCookie } from "./helpers";

beforeEach(freshStore);

describe("routing and headers", () => {
  it("serves a data-free health check", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("returns 404 for unknown paths and 405 for wrong methods", async () => {
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/ingest/v1/status")).status).toBe(405);
    expect((await call("/ingest/v1/bogus", { method: "POST" })).status).toBe(404);
    expect((await call("/logout")).status).toBe(405);
  });

  it("sends security headers and no-store on HTML and API responses", async () => {
    const cookie = await sessionCookie();
    for (const path of ["/", "/api/fleet", "/login"]) {
      const res = await call(path, { headers: { Cookie: cookie } });
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("the app shell has no inline script or embedded data", async () => {
    const cookie = await sessionCookie();
    const res = await call("/", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<script type="module" src="/assets/app.js"></script>');
    expect(body).not.toMatch(/<script>(?!<\/script>)/);
    expect(body).not.toContain("Chief");
  });
});
