# Bot Fleet reporting rule (text for each bot)

Chief rolls this out. Copy the block below into each bot's instructions as-is. It uses
environment variable names only; the real URL and write keys live outside the repo
(see `docs/DEPLOY.md`). Work-account bots get the work key, Leaf-account bots the Leaf key.

Set per bot: `BOT_FLEET_URL`, `BOT_FLEET_KEY`, `BOT_FLEET_BOT_ID` (and `BOT_FLEET_NAME` for
Leaf bots, which are not in the roster seed). `report.sh` is `docs/report.sh` from this repo,
installed wherever the bot can run it.

---

```text
BOT FLEET REPORTING
Avi's Bot Fleet dashboard shows only what you push. Pushing is cheap; it must never cost a turn.

1. Report only inside a turn you are already doing. Never start a turn, routine, timer or
   loop just to report, and never read, poll or check the dashboard.
2. First action of the turn: if this turn is Avi's reply to you, run `report.sh avi-replied`.
   Then `report.sh status working "<what you are doing>"`.
3. Last action of the turn: `report.sh status <done|idle|waiting_user|error> "<one line>"`.
   Statuses: working = doing it now; waiting_user = you need Avi; idle = nothing to do;
   error = you are stuck; done = finished (shows as idle).
4. When what Avi needs to know changes, push it: `report.sh summary "<short paragraph>"`.
5. Every time you send Avi a message, push a copy: `report.sh message "<exact text you sent>"`.
6. Limits: step ≤ 80 characters, summary ≤ 600 characters (one paragraph), message ≤ 2000
   characters. Never include secrets, passwords, API keys, tokens or the write key itself.
7. If a report fails, carry on with the work. Do not retry in a loop and do not start a
   turn later to resend it; your next normal report replaces it.
8. Config comes from env vars BOT_FLEET_URL, BOT_FLEET_KEY, BOT_FLEET_BOT_ID
   (+ BOT_FLEET_NAME on Leaf bots). Never print, paste or commit BOT_FLEET_KEY.
```

---

## Without the script (one curl, same rules)

```sh
curl -sS -o /dev/null --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  -H @<(printf 'Authorization: Bearer %s\n' "$BOT_FLEET_KEY") \
  --data-binary '{"botId":"'"$BOT_FLEET_BOT_ID"'","status":"working","step":"Building phase 3"}' \
  "$BOT_FLEET_URL/ingest/v1/status" || true
```

Endpoints: `/ingest/v1/status`, `/ingest/v1/summary`, `/ingest/v1/message`,
`/ingest/v1/avi-replied`. Field reference: `README.md` → "Ingest API".
