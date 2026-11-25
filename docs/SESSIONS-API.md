# Sessions, usage and the read key

Bots do not call these. `docs/BOT-RULE.md` is unchanged for bot reports. A collector on the
box pushes coding sessions and pool usage with its own key. Each Grok Bot account pushes its
own plan usage with the key it already has. The Mac app reads with a key that cannot write.

Nothing here wakes or messages a bot. The Worker still has no cron and makes no outbound calls.

## Keys

Generate all of them outside the repo (values are never printed):

```sh
mkdir -m 700 -p /workspace/bot-fleet-monitor-secrets
node scripts/gen-secrets.mjs --dir /workspace/bot-fleet-monitor-secrets
```

| File | Secret | Who presents it | Can do |
| --- | --- | --- | --- |
| `ingest-key-work` | `INGEST_KEY_WORK` | Avi's Work bots, and that account's Grok-usage push | Bot reports for `work`, `POST /ingest/v1/grok-usage` with `"account":"work"` |
| `ingest-key-leaf` | `INGEST_KEY_LEAF` | Admin bots, and that account's Grok-usage push | Bot reports for `leaf`, `POST /ingest/v1/grok-usage` with `"account":"leaf"` |
| `ingest-key-sessions` | `INGEST_KEY_SESSIONS` | The box collector | `POST /ingest/v1/sessions` and `POST /ingest/v1/usage` only |
| `read-key` | `READ_KEY` | The Mac app | `GET /api/v1/state` only |

Prefixes are `bfw_`, `bfl_`, `bfs_`, `bfr_` plus 32 random bytes. A key shorter than 32
characters is treated as missing. If any two configured secrets are the same string, every
bearer token is rejected. Comparison is SHA-256, constant time. Keys are never logged and
never stored in the Durable Object.

A wrong key is `401` and the body does not echo the token. A bot key cannot read state, post
sessions, or post usage. The sessions key cannot post a bot report or Grok usage. The read
key cannot post anything and cannot call `/api/fleet`, `/api/activity` or `/api/bots/…`.

Send a `User-Agent` header. Cloudflare blocks Python's default `Python-urllib` before the
Worker sees it.

## POST /ingest/v1/sessions

Full snapshot replace. The body is the complete list; sessions omitted from it are deleted.
`{"sessions":[]}` clears the list. An invalid body does not change the previous snapshot.

Auth: `Authorization: Bearer <INGEST_KEY_SESSIONS>`. Body cap 256 KB, at most 200 sessions.
30 requests per minute. `429` sets `Retry-After`. Do not retry in a loop.

```json
{
  "sessions": [
    {
      "id": "t3-reply-drafts",
      "tool": "t3",
      "title": "Reply drafts v3",
      "status": "running",
      "step": 4,
      "steps": 6,
      "helpers": [
        { "name": "lint", "status": "running", "step": 1, "steps": 2, "runtimeSec": 40 }
      ],
      "startedAt": 1764000000000,
      "updatedAt": 1764003600000,
      "finishedAt": null,
      "limitReset": null,
      "ownerBotId": "b0642d5e-4aaf-41e7-9c15-637f06e15398",
      "ownerName": "Comment Reply App",
      "account": "claudeMax",
      "prUrl": "https://github.com/org/repo/pull/31",
      "ci": { "state": "failing", "url": "https://github.com/org/repo/pull/31/checks" },
      "repo": "org/repo",
      "branch": "reply-drafts",
      "agentUrl": null,
      "model": "claude-opus",
      "effort": null,
      "alive": true,
      "lastSeenAt": 1764003600000,
      "attentionReason": "pr_ready"
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `id` | Required. 1–80 of `A-Z a-z 0-9 . _ : -`. Unique in the snapshot. Not truncated. |
| `tool` | Optional. `claude`, `t3`, `cursor`, `cursor-cloud`. The badge falls back to `account` when it is omitted. |
| `title` | Required, truncated to 120 characters. |
| `status` | `running`, `paused_limit`, `finished`, `failed`, `aborted`, `stopped`, `in_review`. Do not send `stalled`. |
| `alive` | Required boolean. A `running` session with `alive: false` is shown as stalled. That is process liveness, not a quiet timer. `paused_limit` and terminal statuses are not rewritten. |
| `lastSeenAt` | Required. Unix milliseconds (seconds and ISO-8601 also accepted). |
| `step`, `steps` | Optional integers 0–100000, or null. |
| `helpers` | Optional array, at most 20. Each row is `{name, status, step, steps, runtimeSec}`. `status` uses the same enum. `runtimeSec` is a non-negative integer. The UI shows the main session first and each helper as its own row, collapsed until opened. Omitted means `[]`. |
| `startedAt`, `updatedAt` | Required timestamps. |
| `finishedAt` | Optional timestamp. |
| `limitReset` | Optional timestamp. Shown on a `paused_limit` row (↻ time). |
| `ownerBotId` | Optional Grok bot UUID. This is how the row says "started by". `null` is Unassigned. |
| `ownerName` | Optional. Used when the id is not on the roster. |
| `account` | Required source id, not a Grok account: `claudeMax`, `claudeAdmin`, `cursor`, `cursor-cloud`, `codex`, `claudeApi`, and the same shape of id. 1–40 characters, starting with a letter. |
| `prUrl`, `agentUrl` | Optional `https` URL, no user/password, at most 300 characters. |
| `ci` | Optional `{state, url?}`. `url` is https. A string is rejected. |
| `repo`, `branch`, `model`, `effort` | Optional short text. `model` and `effort` may be null. |
| `attentionReason` | Optional `paused_limit`, `stalled`, or `pr_ready`. An FYI badge on the coding-session row only. It never puts a bot into Needs my attention. |

There is no `pool` field. Unknown fields are `400`. Anything that looks like a credential
(`ghp_`, `sk-`, `xoxb-`, `AKIA`, `bfw_`/`bfl_`/`bfs_`/`bfr_`, a private key, `Bearer` plus a
token) is `400` `secret_rejected`. The value is not stored and not echoed.

`200 {"ok":true,"count":N}`. These rows never change a bot's status, never write an activity
event, and never enter Needs my attention.

## POST /ingest/v1/usage

Same sessions key. Replaces every usage account. Body cap 64 KB, at most 24 accounts,
8 meters each, 30/min on its own counter. `{"accounts":[]}` clears them.

```json
{
  "accounts": [
    {
      "id": "claudeMax",
      "label": "Main Claude",
      "group": "claude",
      "meters": [
        { "id": "5h", "label": "5-hour", "pctUsed": 38, "resetAt": 1764200000000, "state": "ok" },
        { "id": "weekly", "label": "Weekly", "pctUsed": 29, "resetAt": 1764500000000 }
      ]
    },
    {
      "id": "claudeApi-main",
      "label": "API · Main",
      "group": "api",
      "parentId": "claudeMax",
      "meters": [],
      "spend": 41,
      "remaining": 209,
      "granted": 250,
      "expiresAt": 1765000000000,
      "verified": "assumed",
      "routingVerified": false
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `id` | Required source id. `claudeMax` and `claudeAdmin` are the Claude accounts; `cursor` and `codex` are those tools; API pools use ids such as `claudeApi-main` and `claudeApi-admin`. The top row renames `claudeMax` to "Avi's Work", `claudeAdmin` to "Admin", `cursor` to "Cursor", and `codex` to "Codex". Other ids keep `label`. |
| `group` | `claude`, `cursor`, `codex`, or `api`. |
| `parentId` | Optional. API pools hang under a Claude account in the same snapshot (`claudeApi-main` under `claudeMax`, `claudeApi-admin` under `claudeAdmin`). A missing parent is `400`. |
| `meters` | Required array. Each meter is `{id, label, pctUsed, resetAt, state?}`. `pctUsed` is 0–100 or null. `state` is `ok` (default) or `no_limit`. |
| `spend`, `remaining`, `granted` | Optional dollars as a number, or a short string. |
| `expiresAt` | Optional timestamp. |
| `verified` | Optional `assumed` or `console`. |
| `routingVerified` | Optional boolean. `false` shows an "unverified" hint on an API card. |
| `note` | Optional short text. |

Claude accounts carry a 5-hour meter and a weekly meter. A 5-hour meter with `state: "no_limit"`
is shown as "No limit" rather than a low bar. The weekly reset is shown only when it is still
ahead and inside 48 hours. Cursor sends three meters (plan month, Cursor Models, Other Models),
each with its own `resetAt`. API cards show spend, remaining/granted, and expiry. The same
secret rule applies. `200 {"ok":true,"count":N}`.

## POST /ingest/v1/grok-usage

Uses the **account** key, not the sessions key. Work key can only write `"account":"work"`.
Admin key can only write `"account":"leaf"`. A mismatch is `403`. One account's report does
not replace the other. 12 per account per minute, and it does not spend the bot-report budget.
Body cap 64 KB, at most 200 bots.

```json
{
  "account": "work",
  "pctUsed": 41,
  "resetAt": 1764300000000,
  "bots": [
    { "botId": "b0642d5e-4aaf-41e7-9c15-637f06e15398", "name": "Chief", "share": 22, "routinesShare": 4 }
  ]
}
```

`pctUsed` and `share` are 0–100. `routinesShare` is optional, 0–100: the part of that bot's
share that is routines. The dashboard sorts by `share` and hides the list until the Grok bar
is hovered or tapped. A bot whose `routinesShare` is at least half of `share` is drawn as
"mostly routines". `resetAt` may be null but the field is required.

## GET /api/v1/state

Auth, either one:

- `Cookie: __Host-bf_session=…` from a dashboard login, or
- `Authorization: Bearer <READ_KEY>`

`?account=work|leaf` narrows the activity page only. The bot list, sessions, usage accounts, Grok
usage and `attention` are always both accounts. Attention is what the Mac menu counts.

```json
{
  "version": 2,
  "now": 1764000000000,
  "staleAfterMs": 600000,
  "attention": [
    {
      "account": "work",
      "accountLabel": "Avi's Work",
      "id": "…",
      "name": "Comment Reply App",
      "group": "Asana",
      "state": "error",
      "step": "Blocked on the preview key",
      "statusAt": 1764000000000
    }
  ],
  "bots": [],
  "sessions": [],
  "accounts": [],
  "grok": [],
  "activity": { "items": [], "nextBefore": null }
}
```

`attention[].state` is `waiting_user`, `error` or `stale`. Saved bots are omitted. A coding
session is never an attention item. `accountLabel` is `Avi's Work` or `Admin`.

`401` when the cookie is missing and the bearer token is not the read key. The dashboard's
Save for later route stays cookie-only and same-origin.

## Collector sketch

The process substitution keeps the key out of the process list. Fixed text only; build the
JSON in a file for real snapshots.

```bash
curl -sS --max-time 10 -X POST \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: bot-fleet-collector/2.0' \
  -H @<(printf 'Authorization: Bearer %s\n' "$BOT_FLEET_SESSIONS_KEY") \
  --data-binary @sessions.json \
  "${BOT_FLEET_URL%/}/ingest/v1/sessions"
```
