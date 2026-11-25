# Bot Fleet for macOS

A menu-bar app. The window is the dashboard (the same page as the browser). The menu-bar
item shows how many bots need Avi, from `GET /api/v1/state`, and a short list. Clicking a
row opens the window. It does not message or wake a bot.

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
4. Click the menu-bar item (it says Fleet until the key is set) and choose Settings.
5. Dashboard URL: `https://bot-fleet-monitor.autumnlakemarketing.workers.dev` once v2 is
   deployed. Until then a local `http://127.0.0.1:8787` is accepted. `http` anywhere else is
   refused. The app stores the origin only, so a key cannot be tucked into the URL.
6. Paste the read key from `read-key` in the secrets folder (see `docs/DEPLOY.md`). Save.
   Test connection should say it reached Fleet. The key is written to the Keychain and is
   not shown again.
7. In the window, sign in with the dashboard password once. The web view keeps that cookie.

Optional: when a bot newly enters Needs my attention, macOS shows a notification. The first
successful read is a baseline and does not notify. Allow notifications when macOS asks.

The window opens at 1440×900. The Window menu has Wide and short (1920×700) and Tall and
narrow (600×1400), which are the two reflowed layouts. You can also drag it to any size.

Quit from the menu-bar item. The app has no Dock icon.

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
