# Bot Fleet for macOS

A Dock app and a menu-bar item. Opening the app, or clicking its Dock icon, brings the
dashboard window forward. The menu bar still shows how many bots need Avi, from
`GET /api/v1/state`, and a short list. It does not message or wake a bot.

The read key lives in the login Keychain (`com.autumnavi.BotFleet` / `read-key`). The
dashboard URL is not a secret; it is saved in preferences. Neither is in this repo.

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
8. When the server answers, sign in with the dashboard password once. The web view keeps that cookie.

Optional: when a bot newly enters Needs my attention, macOS shows a notification. The first
successful read is a baseline and does not notify. Allow notifications when macOS asks.

The window opens at 1440×900. The Window menu has Wide and short (1920×700) and Tall and
narrow (600×1400), which are the two reflowed layouts. You can also drag it to any size.

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
