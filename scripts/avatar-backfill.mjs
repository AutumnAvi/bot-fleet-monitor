#!/usr/bin/env node
// One-time avatar backfill. Reads each roster bot's Grok Bot profile.json
// (avatarShape / avatarColor) and builds one avatar-only status report per bot:
// {"botId": ..., "avatar": {shape, color}}. That report sets the symbol and nothing
// else (status, Save for later, the feed and the stale timer are untouched).
//
// Dry run by default: prints the reports it would send and sends nothing.
//
//   node scripts/avatar-backfill.mjs [--account work|leaf] [--roster extra.json]
//        [--agents-dir /home/box/agent-data/agents] [--send]
//
// --send also needs BOT_FLEET_URL and BOT_FLEET_KEY_FILE (a PATH to the account's
// write key file; the key itself is never printed). Prints HTTP status codes only.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillPlan, rosterFor } from "./lib/avatar.mjs";
import { argValue, loadRoster, postJson, readKeyFile, workerUrl } from "./lib/push.mjs";

const SEED = fileURLToPath(new URL("../docs/roster-seed.json", import.meta.url));
const DEFAULT_AGENTS_DIR = "/home/box/agent-data/agents";

async function main(argv) {
  const send = argv.includes("--send");
  const account = argValue(argv, "--account") ?? "work";
  if (account !== "work" && account !== "leaf") throw new Error("--account must be work or leaf");
  const agentsDir = argValue(argv, "--agents-dir") ?? DEFAULT_AGENTS_DIR;
  const roster = rosterFor(await loadRoster(SEED, argValue(argv, "--roster")), account);

  const profiles = new Map();
  for (const bot of roster) {
    try {
      profiles.set(bot.id, JSON.parse(await readFile(join(agentsDir, bot.id, "profile.json"), "utf8")));
    } catch {
      // Missing or unreadable profile: reported as skipped below.
    }
  }
  const plan = backfillPlan(roster, profiles);
  const toSend = plan.filter((row) => row.body !== null);

  console.log(`${send ? "Sending" : "Dry run:"} ${toSend.length} avatar report(s) for ${account}; ${plan.length - toSend.length} skipped.`);
  for (const row of plan) {
    if (row.body === null) console.log(`  skip  ${row.name} (${row.id}): ${row.reason}`);
    else console.log(`  POST /ingest/v1/status ${JSON.stringify(row.body)}   # ${row.name}`);
  }
  if (!send) {
    console.log("Nothing sent. Add --send (with BOT_FLEET_URL and BOT_FLEET_KEY_FILE) to post these.");
    return 0;
  }

  const url = `${workerUrl()}/ingest/v1/status`;
  const key = await readKeyFile();
  let failed = 0;
  for (const row of toSend) {
    let status;
    try {
      status = await postJson(url, key, row.body);
    } catch {
      status = "network error";
    }
    const ok = status === 200 || status === 201;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${row.name}: HTTP ${status}`);
    if (status === 429) {
      console.log("Rate limited; stopping. Run again in a minute (already-sent bots are fine to resend).");
      return 1;
    }
  }
  return failed === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`avatar-backfill: ${err instanceof Error ? err.message : "failed"}`);
    process.exit(2);
  },
);
