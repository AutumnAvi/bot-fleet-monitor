import { pbkdf2Sync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { CONTROL_KEY, LEAF_KEY, READ_KEY, SESSIONS_KEY, TEST_ITERATIONS, TEST_PASSWORD, TEST_SALT_HEX, WORK_KEY } from "./test/fixtures.ts";

const b64url = (buf: Buffer): string => buf.toString("base64url");
const salt = Buffer.from(TEST_SALT_HEX, "hex");
const hash = pbkdf2Sync(TEST_PASSWORD, salt, TEST_ITERATIONS, 32, "sha256");

// Fake, test-only values (see test/fixtures.ts). Never real secrets.
const testSecrets = {
  DASHBOARD_PASSWORD_HASH: ["pbkdf2-sha256", String(TEST_ITERATIONS), b64url(salt), b64url(hash)].join(":"),
  INGEST_KEY_WORK: WORK_KEY,
  INGEST_KEY_LEAF: LEAF_KEY,
  INGEST_KEY_SESSIONS: SESSIONS_KEY,
  READ_KEY: READ_KEY,
  CONTROL_KEY: CONTROL_KEY,
};
// Also exported to the environment so wrangler's required-secrets check stays quiet.
Object.assign(process.env, testSecrets);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: testSecrets },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
