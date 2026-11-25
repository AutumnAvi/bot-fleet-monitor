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
   re-reads `/api/fleet` every 30 seconds: two Durable Object calls (session check + fleet read),
   plus two more for an open bot detail. Hidden tabs do not refresh. This reads stored data only
   and never reaches a bot.

Rough scale: 35 bots × ~4 reports per turn × a few dozen turns a day is a few thousand small
requests per day, far inside the Workers / Durable Objects free allowances.

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
#    only requests are GET /api/fleet, /api/activity and /api/bots/… (client/api.ts).
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
