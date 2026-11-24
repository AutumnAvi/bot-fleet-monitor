#!/usr/bin/env bash
# Bot Fleet reporter. Sends ONE report to the Bot Fleet monitor and always exits 0,
# so a failed report never breaks the work it is attached to. No retries, no polling.
#
# Configuration comes only from the environment (never put real values in a repo):
#   BOT_FLEET_URL     ingest base URL, e.g. https://bot-fleet-monitor.<subdomain>.workers.dev
#   BOT_FLEET_KEY     this account's write key (work key for work bots, Leaf key for Leaf bots)
#   BOT_FLEET_BOT_ID  this bot's id (work bots: the Grok Bot id from the roster)
#   BOT_FLEET_NAME    display name; REQUIRED for any bot not in docs/roster-seed.json
#                     (every Leaf bot, and work bots added after the seed)
#   BOT_FLEET_GROUP   optional; work bots: Main | PMs | Asana | Sub-Bots | Unassigned
#
# Usage:
#   report.sh status <working|waiting_user|idle|error|done> ["one-line step, <=80 chars"]
#   report.sh summary "short need-to-know paragraph, <=600 chars"   ("" clears it)
#   report.sh message "copy of the message you just sent Avi"       ("-" reads stdin)
#   report.sh avi-replied
#
# Requires bash and curl. The key is passed to curl through a file descriptor, so it
# never appears in the process list, and it is never printed.

set -u

warn() { printf 'bot-fleet: %s\n' "$*" >&2; }

usage() {
  sed -n '13,17p' "$0" >&2
  exit 0
}

[ $# -ge 1 ] || usage
kind=$1
shift
case $kind in -h | --help | help) usage ;; esac

: "${BOT_FLEET_URL:=}" "${BOT_FLEET_KEY:=}" "${BOT_FLEET_BOT_ID:=}"
if [ -z "$BOT_FLEET_URL" ] || [ -z "$BOT_FLEET_KEY" ] || [ -z "$BOT_FLEET_BOT_ID" ]; then
  warn "BOT_FLEET_URL, BOT_FLEET_KEY and BOT_FLEET_BOT_ID must be set; report skipped"
  exit 0
fi
case $BOT_FLEET_URL in
  https://* | http://localhost* | http://127.0.0.1*) ;;
  *)
    warn "BOT_FLEET_URL must be https; report skipped"
    exit 0
    ;;
esac
command -v curl >/dev/null 2>&1 || {
  warn "curl not found; report skipped"
  exit 0
}

# Character-aware truncation needs a UTF-8 locale. Without one, cutting by bytes could
# split a character and the server would reject the report as invalid UTF-8.
utf8_locale=0
for l in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
  { export LC_ALL=$l; } 2>/dev/null
  probe='é'
  if [ "${#probe}" -eq 1 ]; then
    utf8_locale=1
    break
  fi
done

# JSON string literal: escape \ " and newlines/tabs, drop other control characters.
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/}
  s=${s//$'\t'/\\t}
  s=$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037\177')
  printf '"%s"' "$s"
}

cap() { # cap <text> <max chars>; leaves text alone without a UTF-8 locale (server truncates)
  local s=$1 max=$2
  if [ "$utf8_locale" -eq 1 ] && [ "${#s}" -gt "$max" ]; then s="${s:0:$((max - 1))}…"; fi
  printf '%s' "$s"
}

body="{\"botId\":$(json_str "$BOT_FLEET_BOT_ID")"
[ -n "${BOT_FLEET_NAME:-}" ] && body+=",\"name\":$(json_str "$(cap "$BOT_FLEET_NAME" 60)")"
[ -n "${BOT_FLEET_GROUP:-}" ] && body+=",\"group\":$(json_str "$BOT_FLEET_GROUP")"

case $kind in
  status)
    status=${1:-}
    case $status in
      working | waiting_user | idle | error | done) ;;
      *)
        warn "status must be one of: working waiting_user idle error done; report skipped"
        exit 0
        ;;
    esac
    body+=",\"status\":$(json_str "$status")"
    [ $# -ge 2 ] && body+=",\"step\":$(json_str "$(cap "$2" 80)")"
    ;;
  summary)
    [ $# -ge 1 ] || usage
    body+=",\"summary\":$(json_str "$(cap "$1" 600)")"
    ;;
  message)
    [ $# -ge 1 ] || usage
    text=$1
    [ "$text" = "-" ] && text=$(cat)
    body+=",\"text\":$(json_str "$(cap "$text" 2000)")"
    ;;
  avi-replied) ;;
  *)
    warn "unknown report type '$kind'; report skipped"
    exit 0
    ;;
esac
body+="}"

code=$(printf '%s' "$body" | curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 5 --connect-timeout 3 --retry 0 -X POST \
  -H 'Content-Type: application/json' \
  -H @<(printf 'Authorization: Bearer %s\n' "$BOT_FLEET_KEY") \
  --data-binary @- "${BOT_FLEET_URL%/}/ingest/v1/$kind" 2>/dev/null) || code=000

case $code in
  200 | 201) ;;
  404) warn "unknown bot id for this key; set BOT_FLEET_NAME so it can register (no retry)" ;;
  *) warn "report not delivered (HTTP $code); continuing without retry" ;;
esac
exit 0
