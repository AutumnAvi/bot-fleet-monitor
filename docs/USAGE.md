# Usage and cost: why Bot Fleet stays cheap

The monitor is **push-only**. It never asks a bot anything, so it can never cost a bot turn.

## Why it is cheap

1. **No bot turns are ever started by the dashboard.** Bots post a report as part of a turn
   they are already running (first and last action, plus summary/message copies). There is no
   "refresh by asking every bot", no ping, no routine, and nothing in the UI that sends a
   message, approves, starts or stops anything. The dashboard is read-only.
2. **The Worker makes no outbound calls.** `src/worker.ts` and `src/fleet-store.ts` only answer
   requests. They never call `fetch()` to any other host, and the Worker has no cron trigger
   (`"triggers": { "crons": [] }` in `wrangler.jsonc`). The Durable Object sets no alarms.
3. **Payloads are tiny.** A status report is ~100 bytes of JSON (bot id, status, ≤80-char
   step). Summaries are capped at 600 characters, message copies at 2000, and any body over
   16 KB is rejected. Responses are a few dozen bytes.
4. **Bounded storage.** One SQLite Durable Object holds the roster (≤200 bots per account), the
   last status per bot, ≤30 message copies per bot (cleared when Avi replies) and the latest
   1000 activity events.
5. **Bounded abuse.** Bad write keys are rejected in the Worker before any storage is touched.
   Good keys are rate-limited (120/min per key, 30/min per bot); login is limited to 10
   attempts per IP per 15 minutes.
6. **The page refreshes from the Worker, not from bots.** While the tab is visible the browser
   re-reads `/api/v1/state` every 30 seconds, plus the open Focus bot's detail. Hidden tabs do
   not refresh. The Mac menu bar reads the same endpoint with the read-only key. This reads
   stored data only and never reaches a bot.

Rough scale: 35 bots × ~4 reports per turn × a few dozen turns a day is a few thousand small
requests per day, far inside the Workers / Durable Objects free allowances.

## Grok plan usage: who pushes it, and when

The Grok bar (`grok[]` in `/api/v1/state`) stays empty until someone pushes
`POST /ingest/v1/grok-usage`. Only a bot can read Grok Bot's own usage report (plan % used,
reset time, each bot's share, the routines part), so the push rides on a turn that bot is
already running. Nothing in this repo schedules it, and no routine exists just to push it.

1. **During a normal turn** (for example the morning rollup, or any turn that already opens the
   usage report), the bot writes what the report shows to a snapshot file outside the repo:

   ```json
   {
     "account": "work",
     "pctUsed": 41,
     "resetAt": "2026-11-29T00:00:00Z",
     "asOf": "2026-11-26T09:05:00Z",
     "bots": [
       { "name": "Chief", "share": 22, "routinesShare": 4 },
       { "name": "Session Monitor", "share": 9 }
     ]
   }
   ```

   `pctUsed`, `share` and `routinesShare` are percent (0–100); `routinesShare` is the routines
   part of that bot's share. `resetAt` and `asOf` are ms, seconds or ISO-8601; `resetAt` may be
   null. `asOf` is when the report was read. Use the bot names exactly as the report shows
   them; `botId` instead of `name` also works.
2. **Then it runs the pusher once** (one POST, no retry; a `429` waits for a later turn):

   ```sh
   node scripts/push-grok-usage.mjs /path/to/grok-usage.json --dry-run   # check the mapping
   BOT_FLEET_URL=https://bot-fleet-monitor.<subdomain>.workers.dev \
   BOT_FLEET_KEY_FILE=/path/to/that-account-key-file \
     node scripts/push-grok-usage.mjs /path/to/grok-usage.json
   ```

   Names map to bot ids from `docs/roster-seed.json` (full name, or the part before " · ",
   any case) plus an optional `--roster file.json` (`{"bots":[{"id","name"}]}`). Names it cannot
   match are summed into one **Other** row and listed on stderr, so the roster can be fixed.
   Exit `0` sent, `1` the Worker refused it (prints only `HTTP <status>`), `2` bad input.

Who does it:

| Side | Bot | `account` | Key file (`BOT_FLEET_KEY_FILE`) | Roster |
| --- | --- | --- | --- | --- |
| Avi's Work | Session Monitor, on this box | `work` | `/workspace/bot-fleet-monitor-secrets/ingest-key-work` | `docs/roster-seed.json` |
| Admin | Leaf bot, on its own machine | `leaf` | that machine's copy of `ingest-key-leaf` | `--roster` with the Admin bots (they are not in the seed) |

The key file is a path; the pusher reads it and never prints it. Never paste a key into a
snapshot file, a chat or a command line. The bar shows "as of <time>" from `asOf`, so a stale
push is obvious rather than silently wrong.

## How to confirm there is no polling

Run these from the repo root. Each should print nothing (or only the comments shown):

```sh
# 1. No outbound fetch from server code. Expect exactly two hits: the Worker's own
#    `async fetch(request, env)` handler and `env.ASSETS.fetch` (static files, same Worker).
grep -rnE "\bfetch\(" src/
# 2. No cron triggers, alarms or scheduled handlers.
grep -n '"crons"' wrangler.jsonc                       # shows: "triggers": { "crons": [] }
grep -rnE "setAlarm|alarm\(|scheduled\(" src/          # prints nothing
# 3. The grokbot:// deep link is only built for the Open button (a link Avi clicks);
#    the server never calls it. Expect hits only in src/shared/fleet-view.ts.
grep -rn "grokbot" src/
# 4. The browser may only talk to its own origin (CSP connect-src 'self'), and the client's
#    only requests are GET /api/v1/state, /api/activity and /api/bots/… (client/api.ts).
grep -n "connect-src" src/lib/http.ts
grep -n "fetch(" client/*.ts
```

On the bot side, confirm that no routine or cron exists whose only job is reporting or
reading the dashboard. The rule in `docs/BOT-RULE.md` forbids it; Chief/Session Monitor can
grep bot instructions and schedules for `BOT_FLEET_` / `report.sh` and check every hit sits
inside normal work.

In the Cloudflare dashboard (Workers → bot-fleet-monitor → Settings → Triggers) there should be
no Cron Triggers.

## How to measure ingest volume (without printing secrets)

Every request to `/ingest/v1/<kind>` writes one JSON log line, with no keys, passwords, cookies
or bot text:

```json
{"evt":"ingest","account":"work","kind":"status","bot":"b0642d5e-…","bytes":96,"result":"ok","status":200}
```

Rejected requests log `result` = `unauthorized`, `rate_limited`, `invalid_json`, etc. Logins log
`{"evt":"login","result":"ok|wrong_password|rate_limited|cross_origin"}`. Invocation logs
(which carry request headers) are turned off in `wrangler.jsonc`, so the `Authorization` header
is never stored.

Ways to measure:

- **Workers Logs** (Cloudflare dashboard → Workers → bot-fleet-monitor → Logs): filter
  `evt = "ingest"`, then group by `account`, `kind` or `bot`, and sum `bytes`. This gives
  requests per day, per bot and total payload size.
- **Live tail:** `npx wrangler tail bot-fleet-monitor --format json --search '"evt":"ingest"'`
  shows the same lines as they arrive. Nothing secret is in them.
- **Workers analytics** (dashboard → Metrics, or the GraphQL Analytics API dataset
  `workersInvocationsAdaptive`): total requests, errors and CPU time per day for the Worker,
  no logging needed. Path-level counts for `/ingest/v1/*` vs `/api/*` come from the log lines.
- **Durable Object metrics** (dashboard → Durable Objects → FleetStore): requests, rows
  read/written and storage size.

When sharing numbers, share counts and byte totals only. Never paste raw request headers.
