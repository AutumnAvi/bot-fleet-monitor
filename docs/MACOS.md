# Bot Fleet for macOS

A Dock app and a menu-bar item. Opening the app, or clicking its Dock icon, brings the
Bot Fleet window forward. The menu bar shows how many bots need Avi and a short list.
It does not message or wake a bot. Its only write is Save for later (below).

The window is native SwiftUI. It reads `GET /api/v1/state` with `URLSession` every 20 seconds
and draws Monitor (the main view), Focus, Board, Feed and Later itself. There is no web view, so a Screen Time web filter that
blocks `*.workers.dev` in Safari and WebKit does not affect it (the same approach as Session
Monitor). It needs only the dashboard URL and the read key, never the dashboard password.

The read key lives in the login Keychain (`com.autumnavi.BotFleet` / `read-key`). The optional
control key has its own item (`com.autumnavi.BotFleet` / `control-key`). The dashboard URL is
not a secret; it is saved in preferences. None of them is in this repo.

## Install a build

GitHub Actions builds it on a `macos-15` runner (ad-hoc signature, the same idea as Session
Monitor). On a pull request the zip is the **BotFleet-macOS** artifact. On a `v*` tag it is
also attached to the GitHub Release.

1. Download `BotFleet.zip` and double-click to unzip.
2. Move `BotFleet.app` to `/Applications` if you want it to stay.
3. The first launch is blocked by Gatekeeper because the signature is ad-hoc. **Right-click
   the app and choose Open**, then Open again in the dialog. After that it launches normally.
4. The dashboard window opens on its own. The Dock shows the Bot Fleet icon. The menu bar
   still has a Fleet item.
5. Until a URL and read key are saved, that window is the setup screen. The URL is already
   filled in with `https://bot-fleet-monitor.autumnlakemarketing.workers.dev`. `http` is
   accepted only for `127.0.0.1` and `localhost`. The app stores the origin only, so a key
   cannot be tucked into the URL.
6. Paste the read key from `read-key` in the secrets folder (see `docs/DEPLOY.md`). Test
   connection, then Save and open. The key is written to the Keychain and is not shown again.
7. If that server is still the v1 worker, the window says so: `/api/v1/state` returned 404.
   The menu bar starts counting after v2 is deployed. Until then there is no blank page.

## What the window shows

**Monitor** is the main view and opens on every launch. Top to bottom:

- **Accounts**: Main Claude, Admin Claude, Cursor (Models and Other), Codex and Grok · Work, each
  with its usage, a chip and its next reset. **Near limit** at 80% or more; **Switch now** at 90% or
  more, or an exhausted 5-hour window; otherwise **OK**. **Use first** sits on Main Claude while it
  has room, or on Cursor when Main Claude needs a switch and Cursor has room; never on Admin Claude
  or Codex. Grok · Admin appears once it has been pushed. API pools are not on this strip (they stay
  in the usage bars on the other tabs).
- When any account is at Switch now, a slim red banner under the top bar names it and says where to
  go: Main Claude, else Cursor. It never sends you to Admin Claude or Codex.
- **Coding sessions**: T3, Claude and Cursor sessions that are live or ended in the last 24 hours,
  each with the bot that started it, its status, account and run time. Live is green; finished is
  grey.
- **Recently used**: bots by last activity (the later of the bot's own reports and any coding
  session it owns), with its symbol, name, one line and status. A dot on the symbol means it needs
  you; those rows are not pinned to the top. Click one to open it in Focus. Right-click for Open
  chat. Bots quiet for a week drop off unless they need you.

A wide window shows sessions and recently used side by side; under 900 points wide it is one
column. Leftover `[TEST]` prefixes on bot steps and summaries are not shown, and session titles
drop their `[Bot]` tag and trailing date.

**Board**, **Feed** and **Later** are quieter items after Monitor in the top bar (⌘2, ⌘3, ⌘4;
Monitor is ⌘1). Focus opens from a bot that needs you (Recently used, the menu bar, Board or Feed).
On those tabs:

- **Usage bars** sit on top. Grok first: **Grok · Avi's Work 41%** and
  **Grok · Admin 12%**, each with "as of <time>" (when the numbers were read). Hover a Grok bar for
  the per-bot breakdown. A bar with nothing pushed yet says "no data yet". Claude, Cursor, Codex
  and API pools appear in a second row once they have data.
- **Coding sessions** (Claude Code, T3, Cursor) are one slim strip under the usage bars on every
  tab: how many are running, then a chip per session (tool, short title, step, and the symbol of
  the bot that started it), then +N. Click it to expand the list in place. It is hidden when no
  session ran in the last 24 hours. Sessions are FYI only and never Needs my attention.
- **Focus**: Needs my attention, one bot at a time, with its account tag (indigo Avi's Work,
  green Admin), its one line, and its recent updates. The one line is the bot's latest summary
  while it is among the latest 40 updates the app reads, else its step. Like every feed line it
  is at most 80 characters (the Worker's cap); hover shows all of it. Showing longer summaries
  would need `summary` on `bots[]` in `/api/v1/state` (a Worker change). **Open chat · Avi's Work** / **Open chat · Admin** opens
  `grokbot://app/v1/agent?id=<botId>`; the label names the account because the link opens
  whichever Grok Bot account is signed in. Press **N** for the next bot. Up next, Save for later
  and every other bot by account follow.
- **Board**: Kanban columns Needs me, Working, Saved for later and Idle & done.
- **Later**: every bot in Save for later, with Move back.
- **Feed**: the latest bot updates, with Needs me / Avi's Work / Admin filters. Summary updates
  are not listed (the latest one is the bot's one line), and back-to-back repeats from the same
  bot show once. Labels are short: Working, Needs you, Stuck, Idle, Done, Sent you, You replied,
  Saved, Unsaved.
- Each bot has a small symbol: its Grok Bot shape and colour, or its initials on a colour that
  comes from its id when it has none. The status keeps its own badge.
- The account filter (All, Avi's Work, Admin) applies to every tab, and the feed then reads that
  account's latest updates from the server. Times are Asia/Hebron.

### Save for later

Settings has an optional **Control key (for Save for later)** field. Paste `control-key` from the
secrets folder (see `docs/DEPLOY.md`). It can only move bots in and out of Save for later
(`POST /api/v1/bots/<account>/<id>/saved`); it cannot read or report anything. Without it the
buttons below are hidden.

- **Later** on the Focus card and on every Needs-me row; **Move back** on saved rows.
- The bot moves at once, and a toast says **Saved for later · Undo** for about 6 seconds. Undo
  (or ⌘Z) sends it back.
- If Fleet refuses the change, the bot goes back where it was and the toast says why.
- Pointing the app at another server, or **Forget keys**, deletes the control key.

The bot still leaves Save for later on its next Needs-you or Stuck report, or when Avi replies.

When a read fails, a banner says why (offline, key refused, server error) and the window keeps
the last good data on screen with its time. It tries again every 20 seconds, and right away
after the Mac wakes or when you press Retry or ⌘R.

Optional: when a bot newly enters Needs my attention, macOS shows a notification. The first
successful read is a baseline and does not notify. Allow notifications when macOS asks.

The window opens at 1440×900. The Window size menu has Wide and short (1920×700) and Tall and
narrow (600×1400): wide windows use three columns, narrow ones a single column. You can also
drag it to any size. ⌘1 is Monitor; ⌘2, ⌘3 and ⌘4 are Board, Feed and Later.

Quit from the menu-bar item or the Dock. Clicking the Dock icon again brings the window back.

## Build it yourself

Needs Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) on a Mac.

```sh
cd macos
brew install xcodegen
xcodegen generate
xcodebuild -project BotFleet.xcodeproj -scheme BotFleet -configuration Release \
  -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
codesign --verify --deep --strict "build/Build/Products/Release/BotFleet.app"
```

The checked-in source is `macos/App` and `macos/project.yml`. The Xcode project is generated
and is not committed. CI does this and uploads `BotFleet.zip` (see
`.github/workflows/macos.yml`).

CI also renders the window from `macos/ci/sample-state.json` (a reply captured from a local
worker with demo data, timestamps spread over a day) and uploads the PNGs as the
**BotFleet-macOS-screenshots** artifact. To render one yourself:

```sh
APP=build/Build/Products/Release/BotFleet.app/Contents/MacOS/BotFleet
"$APP" --snapshot ci/sample-state.json focus.png tab=focus width=1920 height=700
"$APP" --snapshot ci/sample-state.json board.png tab=board width=600 height=1400 dark
```

Options: `tab=monitor|focus|board|feed|later` (default monitor), `width=`, `height=`, `dark`, `filter=all|work|leaf`,
`state=offline`, `part=grok` (the Grok breakdown popover), `nodata` (no usage or sessions
pushed yet), `toast=saved` (Later pressed on the first bot, no network), `usage=switch` (example
numbers: Main Claude 5-hour 96%, Cursor Models 81%, Grok · Work 88%, so the switch banner shows;
the picture is stamped FIXTURE). It reads only the file
you pass.
