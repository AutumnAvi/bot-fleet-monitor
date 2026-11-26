# Bot Fleet monitor

Read-only dashboard for Avi Weinreb's Grok Bots on two accounts, shown as **Avi's Work**
and **Admin** (internal ids stay `work` and `leaf`). Avi only, behind a password. Bots
**push** short reports while they are already working. A box collector pushes coding
sessions and usage. The dashboard never polls, pings or wakes a bot.

- v2 layout (Focus, Board, Feed): the option 8 mockups
- Work-account roster seed: `docs/roster-seed.json`
- Session, usage and read-key contract: `docs/SESSIONS-API.md`
- macOS menu-bar app: `docs/MACOS.md`

## What's here

| Path | What |
| --- | --- |
| `src/worker.ts` | Worker: routing, password sign-in, write-key ingest, read API. No outbound calls, no cron. |
| `src/fleet-store.ts` | `FleetStore` Durable Object (SQLite): roster, statuses, summaries, message copies, activity, sessions, rate limits. |
| `src/lib/` | Auth (PBKDF2, constant-time compares, cookies), payload validation, sanitization, HTTP helpers, HTML pages. |
| `src/shared/` | Types, limits, status model (stale timer), view model and Asia/Hebron time formatting, shared with the client. |
| `client/` | Browser UI (vanilla TypeScript + CSS, bundled with esbuild into `dist/client/assets`). |
| `macos/` | SwiftUI menu-bar app. A native window (Focus, Board, Feed) over `GET /api/v1/state`, no web view; the menu counts Needs my attention. |
| `test/` | Vitest suites running inside the Workers runtime (`@cloudflare/vitest-plugin`). |
| `docs/report.sh` | Reporting script for bots (reads URL/key from env). |
| `docs/BOT-RULE.md` | The instruction text to add to each bot. |
| `docs/USAGE.md` | Why this stays cheap, how to confirm no polling, how to measure ingest volume. |
| `docs/DEPLOY.md` | Deploy, secrets, seeding, local dev. |
| `scripts/` | `gen-secrets.mjs` (password + keys into a private dir), `hash-password.mjs`, client build. |

## Dashboard

Three tabs, one account filter (All / Avi's Work / Admin). Every attention item has a colored
account tag: indigo for Avi's Work, green for Admin. A wide-short window (aspect wider than
2:1) and a tall-narrow window (under 760px) reflow; a normal window is the three-column Focus
layout. All wall-clock times are Asia/Hebron and labeled.

- **Focus** walks the attention queue one bot at a time (Next, Skip, press N). The card shows
  the need-to-know summary and messages since Avi's last reply — only text the bot pushed.
  Up next, Saved for later, and everyone else grouped by account sit beside it.
- **Board** is Needs me / Working / Saved for later / Idle & done.
- **Feed** pins attention, shows a saved strip, and lists the activity timeline.
- **Needs my attention** is Grok bots only: `waiting_user`, `error`, and `working` with no
  report of any kind for 10 minutes (stale). Coding sessions never enter it.
- **Save for later** is unchanged: the button, or the bot's `save-for-later` report. A saved
  bot returns on a new `waiting_user` or `error`, or on `avi-replied`.
- **Coding sessions** (Claude Code CLI, T3 threads, Cursor local and cloud) are a small
  "started by bots · FYI only" list: tool, title, live / paused at limit / stalled / finished /
  failed / aborted / stopped / in review, plus stalled when the process is not alive. Helpers
  are their own rows. `ownerBotId` links the Grok bot; a null owner is Unassigned. A session
  `attentionReason` is only an FYI badge. A working bot card just notes "⌨ N coding sessions".
- **Usage row**: one card per collector account (5-hour and weekly meters, Cursor's three
  meters, API spend). `claudeMax` is labeled Avi's Work and `claudeAdmin` is labeled Admin.
  Plus "Grok · Avi's Work" and "Grok · Admin".
  Per-bot Grok share is hidden until the bar is hovered or tapped.
- **Open chat** is `grokbot://app/v1/agent?id=<bot-id>`, labeled "Open in Avi's Work" or
  "Open in Admin", because the Grok Bot app may be signed into the other account.
- The only write is Save for later / Move back. No send-to-bot, approvals, start/stop or edit.

### Status model

| Reported | Shown as | Tile |
| --- | --- | --- |
| `waiting_user` | Needs me | Needs me |
| `working` | Working | Working |
| `working`, no report of any kind for 10 min | Stale ("No update for 14m · …") | Stuck |
| `error` | Stuck | Stuck |
| `idle` | Idle | Idle |
| `done` | Recorded in the feed as "Finished", then Idle | Idle |
| no status reported yet | "No status yet" (hollow dot) | Idle |

## Ingest API

`POST /ingest/v1/<kind>` with `Authorization: Bearer <write key>` and
`Content-Type: application/json`. The key decides the account: the work key can only write
Avi's Work bots (`account: "work"`), the Admin key only Admin bots (`account: "leaf"`). An
`account` field that disagrees is refused with 403. The UI never says "work" or "leaf".

Every body has `botId` (1–64 of `A-Z a-z 0-9 . _ : -`) and may carry `name` (≤60) and `group`
to register or update the bot. Unknown bots need `name` (Leaf bots always start this way);
work groups are Main, PMs, Asana, Sub-Bots, Unassigned; Leaf bots are always "Leaf account".

| Kind | Fields | Effect |
| --- | --- | --- |
| `status` | `status` (`waiting_user`, `working`, `idle`, `error`, `done`), optional `step` (≤80), optional `avatar` | Sets the current state (and the bot's symbol; see `docs/SESSIONS-API.md`). |
| `summary` | `summary` (≤600, `""` clears) | The "what you need to know" text. |
| `message` | `text` (≤2000) | Copy of a message the bot sent Avi. Newest 30 kept. |
| `avi-replied` | — | Avi replied: clears the message copies, records the time, takes the bot out of Save for later. |
| `save-for-later` | — | Avi said he'll come back to it: moves the bot to Save for later until it reports `waiting_user`/`error` or `avi-replied`. |

Responses: `200 {"ok":true,"created":false}`, `201` when the bot was registered, `400`
invalid payload/JSON, `401` bad key, `403` account mismatch, `404` unknown bot without a name,
`409` bot limit, `413` body over 16 KB, `415` not JSON, `429` rate limited (120/min per key,
30/min per bot; `Retry-After` set). Long text is cut with "…", control/invisible characters are
removed and obvious credentials are replaced with `[redacted]`. Error bodies never echo keys.

Clients must send a `User-Agent` header. Cloudflare refuses requests with none or with
Python's default `Python-urllib/x.y` (403, "error code: 1010") before they reach the Worker.
curl and `docs/report.sh` are fine; in Python set e.g. `"User-Agent": "bot-fleet-report/1.0"`.

Dashboard write (session cookie + same-origin required): `POST /api/bots/<work|leaf>/<id>/saved`
with `{"saved": true|false}`. The Mac app's equivalent is `POST /api/v1/bots/<work|leaf>/<id>/saved`
with the control key (`docs/SESSIONS-API.md`).

Collector endpoints (a separate sessions key, not a bot key) and the read-only key are
specified in `docs/SESSIONS-API.md`: `POST /ingest/v1/sessions`, `POST /ingest/v1/usage`,
`POST /ingest/v1/grok-usage` (the account's existing bot key), and `GET /api/v1/state`.

Read API for the browser (session cookie required): `GET /api/v1/state[?account=work|leaf]`,
`GET /api/fleet[?account=work|leaf]`, `GET /api/activity?before=<seq>[&account=work|leaf]`,
`GET /api/bots/<work|leaf>/<id>`. The optional `account` narrows the activity feed; the bot
list always has both accounts. `GET /api/v1/state` is also readable with the read-only key.
That key cannot write and cannot call the other routes.

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
