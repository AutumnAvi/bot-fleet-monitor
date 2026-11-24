#!/usr/bin/env node
// Hashes a dashboard password for the DASHBOARD_PASSWORD_HASH Worker secret.
// Reads the password from stdin (never from argv, which other users can see in `ps`)
// and writes the hash to stdout, so it can be piped straight into wrangler:
//
//   node scripts/hash-password.mjs < password-file | npx wrangler secret put DASHBOARD_PASSWORD_HASH
//
// Options: --iterations N (default 25000, max 100000).

import { DEFAULT_ITERATIONS, hashPassword } from "./secrets-lib.mjs";

const i = process.argv.indexOf("--iterations");
const iterations = i === -1 ? DEFAULT_ITERATIONS : Number(process.argv[i + 1]);

if (process.stdin.isTTY) {
  console.error("Pipe the password on stdin, e.g. node scripts/hash-password.mjs < password-file");
  process.exit(2);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, "");
if (password.length < 12 || password.length > 256) {
  console.error("Password must be 12-256 characters.");
  process.exit(2);
}
process.stdout.write(hashPassword(password, iterations));
