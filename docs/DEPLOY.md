# Deploying Bot Fleet

Status on 2026-11-24: **not deployed.** The build box had no Cloudflare login
(`npx wrangler whoami` → "You are not authenticated") and no `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID`. Everything below is ready to run once someone with Avi's Cloudflare
account authenticates. A custom domain is not needed; `workers.dev` is fine.

The secrets already exist outside the repo in `/workspace/bot-fleet-monitor-secrets/`
(mode 700, files mode 600). See the `README.md` in that folder. Never commit or print them.
To create them on another machine, or to rotate all of them (prints file names only):

```sh
mkdir -m 700 -p /workspace/bot-fleet-monitor-secrets
node scripts/gen-secrets.mjs --dir /workspace/bot-fleet-monitor-secrets   # add --force to rotate
```

## 1. Authenticate (pick one)

```sh
npx wrangler login                     # opens a browser, on a machine with one
# or, headless: create an API token with "Edit Cloudflare Workers" permission, then
export CLOUDFLARE_API_TOKEN=...        # don't put this in shell history on shared boxes
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler whoami                    # confirm the right account
```

## 2. Install and check

```sh
npm ci
npm run check                          # lint, typecheck, tests, dry-run build
```

## 3. Create the Worker and set its secrets

`wrangler secret put` creates the Worker if it does not exist yet. Each value is read from a
file on stdin, so nothing is echoed:

```sh
S=/workspace/bot-fleet-monitor-secrets
npx wrangler secret put DASHBOARD_PASSWORD_HASH < "$S/dashboard-password.hash"
npx wrangler secret put INGEST_KEY_WORK         < "$S/ingest-key-work"
npx wrangler secret put INGEST_KEY_LEAF         < "$S/ingest-key-leaf"
```

The Worker refuses every login while `DASHBOARD_PASSWORD_HASH` is missing or malformed, and
refuses every ingest while the keys are missing, shorter than 32 characters, or identical.

## 4. Deploy

```sh
npm run deploy                         # builds dist/client, then wrangler deploy
```

Wrangler prints the URL, e.g. `https://bot-fleet-monitor.<subdomain>.workers.dev`. Save it:

```sh
printf '%s\n' 'https://bot-fleet-monitor.<subdomain>.workers.dev' > "$S/ingest-url"
chmod 600 "$S/ingest-url"
```

The first deploy applies the Durable Object migration `v1` (SQLite-backed `FleetStore`).

## 5. Seed and smoke-test

The work-account roster from `docs/roster-seed.json` is loaded automatically the first time the
Durable Object starts (any request that reaches it, e.g. the first login). This is the one-time
migration; nothing to run by hand. If `docs/roster-seed.json` changes later, redeploy: the seed
re-applies once (adds bots, refreshes names/groups/order, never touches status). Removing a bot
from the seed does not delete it from the dashboard (v1 never deletes bot data). Leaf starts empty.

```sh
URL=$(cat "$S/ingest-url")
curl -sS "$URL/healthz"                                     # → ok
# One test report for Chief (work key). Shows on the dashboard as Idle · "Bot Fleet connected".
BOT_FLEET_URL="$URL" BOT_FLEET_KEY="$(cat "$S/ingest-key-work")" \
  BOT_FLEET_BOT_ID=b0642d5e-4aaf-41e7-9c15-637f06e15398 \
  bash docs/report.sh status idle "Bot Fleet connected"
```

Then open the URL, sign in with the password from `$S/dashboard-password`, and check Chief.

## 6. Roll out to bots

Give each bot `BOT_FLEET_URL`, its account's `BOT_FLEET_KEY`, its `BOT_FLEET_BOT_ID`, plus
`BOT_FLEET_NAME` for any bot not in `docs/roster-seed.json` (all Leaf bots, and work bots added
after the seed), and the rule in `docs/BOT-RULE.md`.

## Local development

```sh
cp .dev.vars.example .dev.vars         # then put throwaway local values in it (gitignored)
printf '%s' 'local-dev-password-123' | node scripts/hash-password.mjs   # paste into .dev.vars
npm run dev                            # http://localhost:8787
```

## Rollback

`npx wrangler rollback` restores the previous Worker version. Data lives in the Durable Object
and is kept across deploys and rollbacks.
