# Bot Fleet monitor

Read-only status dashboard for Avi Weinreb's Grok Bots across two accounts (work + Leaf).
Avi only, behind a password. Bots **push** short reports while they are already working; the
dashboard never polls, pings or wakes a bot.

- Light list UI (primary): `docs/mockups/bot-fleet-light.jpg`
- Activity feed reference: `docs/mockups/bot-fleet-dark-feed.jpg` (rendered in the light theme,
  right column on wide screens, below the list on narrow ones)
- Work-account roster seed: `docs/roster-seed.json`

## What's here

| Path | What |
| --- | --- |
| `src/worker.ts` | Worker: routing, password sign-in, write-key ingest, read API. No outbound calls, no cron. |
| `src/fleet-store.ts` | `FleetStore` Durable Object (SQLite): roster, statuses, summaries, message copies, activity, sessions, rate limits. |
| `src/lib/` | Auth (PBKDF2, constant-time compares, cookies), payload validation, sanitization, HTTP helpers, HTML pages. |
| `src/shared/` | Types, limits, status model (stale timer), view model and Asia/Hebron time formatting, shared with the client. |
| `client/` | Browser UI (vanilla TypeScript + CSS, bundled with esbuild into `dist/client/assets`). |
| `test/` | Vitest suites running inside the Workers runtime (`@cloudflare/vitest-plugin`). |
| `docs/report.sh` | Reporting script for bots (reads URL/key from env). |
| `docs/BOT-RULE.md` | The instruction text to add to each bot. |
| `docs/USAGE.md` | Why this stays cheap, how to confirm no polling, how to measure ingest volume. |
| `docs/DEPLOY.md` | Deploy, secrets, seeding, local dev. |
| `scripts/` | `gen-secrets.mjs` (password + keys into a private dir), `hash-password.mjs`, client build. |

## Dashboard

- Title, search, filter chips (All / Needs me / Working / Idle / Stuck), account switcher
  (Work | Leaf, Work, Leaf).
- Count tiles: Needs me (amber), Working (green), Idle (gray), Stuck (red). Clicking a tile filters.
- Pinned **Needs me** section, then collapsible groups in this order: Main, PMs, Asana,
  Sub-Bots, Unassigned (only when it has bots), Leaf account.
- Each row: status dot, name, one-line current step, relative time, **Open**.
  Open is `grokbot://app/v1/prompt?id=<bot-id>` for work-account bots; it is disabled on Leaf
  rows (those ids belong to a different Grok Bot login). An amber dot after a name means the bot
  has sent Avi messages since his last reply.
- Clicking a row opens the detail view: the bot's own "what you need to know" summary and every
  message it sent Avi since his last reply. Empty states when nothing was pushed; nothing is
  ever invented.
- Activity feed derived from ingest events (status changes, waiting, errors, done, summaries,
  messages, replies), with "View older activity…".
- All wall-clock times are shown in Asia/Hebron.
- No actions: no send-to-bot, approvals, start/stop or edit.

### Status model

| Reported | Shown as | Tile |
| --- | --- | --- |
| `waiting_user` | Needs me | Needs me |
| `working` | Working | Working |
| `working`, no report of any kind for 10 min | Stale ("No update for 14m · …") | Stuck |
| `error` | Stuck | Stuck |
| `idle` | Idle | Idle |
| `done` | Recorded in the feed as "Finished", then Idle | Idle |
| never reported | "No report yet" (hollow dot) | Idle |

## Ingest API

`POST /ingest/v1/<kind>` with `Authorization: Bearer <write key>` and
`Content-Type: application/json`. The key decides the account: the work key can only write
work-account bots, the Leaf key only Leaf-account bots (an `account` field that disagrees is
refused with 403).

Every body has `botId` (1–64 of `A-Z a-z 0-9 . _ : -`) and may carry `name` (≤60) and `group`
to register or update the bot. Unknown bots need `name` (Leaf bots always start this way);
work groups are Main, PMs, Asana, Sub-Bots, Unassigned; Leaf bots are always "Leaf account".

| Kind | Fields | Effect |
| --- | --- | --- |
| `status` | `status` (`waiting_user`, `working`, `idle`, `error`, `done`), optional `step` (≤80) | Sets the current state. |
| `summary` | `summary` (≤600, `""` clears) | The "what you need to know" text. |
| `message` | `text` (≤2000) | Copy of a message the bot sent Avi. Newest 30 kept. |
| `avi-replied` | — | Avi replied: clears the message copies, records the time. |

Responses: `200 {"ok":true,"created":false}`, `201` when the bot was registered, `400`
invalid payload/JSON, `401` bad key, `403` account mismatch, `404` unknown bot without a name,
`409` bot limit, `413` body over 16 KB, `415` not JSON, `429` rate limited (120/min per key,
30/min per bot; `Retry-After` set). Long text is cut with "…", control/invisible characters are
removed and obvious credentials are replaced with `[redacted]`. Error bodies never echo keys.

Read API (session cookie required): `GET /api/fleet[?account=work|leaf]`,
`GET /api/activity?before=<seq>[&account=work|leaf]`, `GET /api/bots/<work|leaf>/<id>`.
The optional `account` narrows the activity feed; the bot list always has both accounts.

## Security notes

- Password: only a PBKDF2-SHA256 hash is stored (Worker secret `DASHBOARD_PASSWORD_HASH`),
  compared in constant time. The generated password is ~138 random bits.
- Session: random 256-bit token in `__Host-bf_session` (HttpOnly, Secure, SameSite=Lax, 14 days);
  only its SHA-256 is stored, and it is bound to the current password hash (changing the
  password signs everyone out). Sign-in and sign-out POSTs must be same-origin.
- Login is limited to 10 attempts per IP per 15 minutes.
- Strict CSP (`default-src 'none'`, scripts/styles from self only), no inline script, all bot text
  rendered with `textContent`.
- Logs are one JSON line per request with no keys, passwords, cookies or bot text; invocation
  logs (which include headers) are off.

## Develop

```sh
npm ci
npm run check        # the CI steps: lint, typecheck, types check, tests, dry-run build, script syntax
npm run dev          # local Worker on :8787 (needs .dev.vars, see docs/DEPLOY.md)
```
