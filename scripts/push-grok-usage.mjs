#!/usr/bin/env node
// Pushes one Grok plan-usage snapshot to POST /ingest/v1/grok-usage.
//
// The snapshot is a JSON file the bot writes from Grok Bot's own usage report:
//   {"account":"work"|"leaf", "pctUsed": 41, "resetAt": <ms | ISO | null>,
//    "asOf": <ms | ISO>, "bots": [{"name": "Chief", "share": 22, "routinesShare": 4}, ...]}
// Each bot row may use "botId" instead of (or with) "name". Names map to bot ids from
// docs/roster-seed.json plus an optional --roster file only (no network lookups).
// Unknown names are summed into one "Other" row.
//
//   node scripts/push-grok-usage.mjs <snapshot.json> [--roster extra.json] [--dry-run]
//
// Sending needs BOT_FLEET_URL and BOT_FLEET_KEY_FILE (a PATH to that account's write
// key file: ingest-key-work for "work", ingest-key-leaf for "leaf"). The key is never
// printed. --dry-run prints the payload and sends nothing. Exit codes: 0 sent (or dry
// run), 1 the Worker refused it (HTTP status printed, nothing else), 2 bad input.
// One POST, no retries: a 429 means wait for the next turn.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SnapshotError, buildGrokUsage } from "./lib/grok-usage.mjs";
import { argValue, loadRoster, postJson, readKeyFile, workerUrl } from "./lib/push.mjs";

const SEED = fileURLToPath(new URL("../docs/roster-seed.json", import.meta.url));

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const rosterPath = argValue(argv, "--roster");
  const snapshotPath = argv.find((arg, i) => !arg.startsWith("--") && argv[i - 1] !== "--roster");
  if (!snapshotPath) throw new SnapshotError("usage: push-grok-usage.mjs <snapshot.json> [--roster extra.json] [--dry-run]");

  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch {
    throw new SnapshotError(`${snapshotPath}: not a readable JSON file`);
  }
  const { body, notes } = buildGrokUsage(snapshot, await loadRoster(SEED, rosterPath));
  for (const note of notes) console.error(`push-grok-usage: ${note}`);

  if (dryRun) {
    console.log(JSON.stringify(body, null, 2));
    console.error(`push-grok-usage: dry run, nothing sent (${body.bots.length} bot row(s) for ${body.account})`);
    return 0;
  }

  const url = `${workerUrl()}/ingest/v1/grok-usage`;
  const key = await readKeyFile();
  let status;
  try {
    status = await postJson(url, key, body);
  } catch {
    console.error("push-grok-usage: network error, not sent");
    return 1;
  }
  if (status >= 200 && status < 300) {
    console.log(`push-grok-usage: sent ${body.account} (${body.bots.length} bot row(s)), HTTP ${status}`);
    return 0;
  }
  console.error(`push-grok-usage: HTTP ${status}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`push-grok-usage: ${err instanceof Error ? err.message : "failed"}`);
    process.exit(2);
  },
);
