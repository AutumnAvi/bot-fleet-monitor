#!/usr/bin/env node
// Generates the dashboard password (+ its PBKDF2 hash) and the two ingest write keys
// into a private directory OUTSIDE the repo. Files are mode 600. Values are never
// printed; only file names are.
//
//   node scripts/gen-secrets.mjs --dir /path/outside/repo [--force] [--iterations 25000]

import { realpathSync } from "node:fs";
import { chmod, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ITERATIONS, generateKey, generatePassword, hashPassword } from "./secrets-lib.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dir = arg("--dir");
const force = process.argv.includes("--force");
const iterations = Number(arg("--iterations") ?? DEFAULT_ITERATIONS);

if (!dir) {
  console.error("usage: node scripts/gen-secrets.mjs --dir <private dir outside the repo> [--force] [--iterations N]");
  process.exit(2);
}
const info = await stat(resolve(dir)).catch(() => null);
if (!info?.isDirectory()) {
  console.error(`${resolve(dir)} must be an existing directory (create it with mode 700 first).`);
  process.exit(2);
}
// Refuse any directory inside this checkout (compared by real path, not string prefix,
// so symlinks, subdirectories and sibling folders like ../repo-secrets are handled).
const repoRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const target = realpathSync(resolve(dir));
const rel = relative(repoRoot, target);
if (rel === "" || (!isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..")) {
  console.error("Refusing to write secrets inside the repository. Pick a directory outside it.");
  process.exit(2);
}

const password = generatePassword();
const files = {
  "dashboard-password": password,
  "dashboard-password.hash": hashPassword(password, iterations),
  "ingest-key-work": generateKey("bfw"),
  "ingest-key-leaf": generateKey("bfl"),
};

for (const [name, value] of Object.entries(files)) {
  const path = join(target, name);
  try {
    await writeFile(path, `${value}\n`, { mode: 0o600, flag: force ? "w" : "wx" });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      console.error(`${path} already exists; not overwriting (use --force to rotate everything).`);
      process.exit(1);
    }
    throw err;
  }
  await chmod(path, 0o600);
  console.log(`wrote ${path} (mode 600)`);
}
