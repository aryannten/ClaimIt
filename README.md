# ClaimIt

ClaimIt is a Chrome Manifest V3 browser extension that monitors Epic Games Store and Steam for limited-time free-to-keep game promotions and automatically claims eligible offers using your existing logged-in browser session. When an offer cannot be auto-claimed (such as when a store requires login, age verification, region confirmation, or CAPTCHA solving), ClaimIt alerts you via Chrome, Telegram, or Discord notifications with a one-click link to finish claiming the game directly.

## Features

- **Plugin-style Provider Architecture (`src/providers/`)**: Active providers for **Epic Games Store** and **Steam** (with swappable search/community source adapters), plus disabled TODO stubs for **GOG**, **Prime Gaming**, **Fab**, and **itch.io**.
- **Strict Offer Classifier (`src/classifier.js`)**: Claims only limited-time, 100%-off free-to-keep titles (including DLC, labeled as `DLC`). Excludes permanent free-to-play games, demos, free weekends / play-for-free trials, partial discounts, and upcoming promotions.
- **Session-only Automation**: Never asks for, reads, or stores account passwords. Opens store pages in a background tab using your existing logged-in browser session and closes tabs automatically unless user action (`NEEDS_USER`) is required.
- **Remote Selector Config (`config/selectors.json`)**: All endpoints, CSS selectors, and button text matchers are externalized and can be refreshed from a configurable HTTPS GitHub raw URL with schema validation, caching, and bundled fallback.
- **Smart Scheduling**: Checks every 6 hours by default (configurable), polls hourly on Thursdays and Fridays for Epic's weekly rotation, and runs catch-up checks on startup and install.
- **Multi-channel Notifications**: Chrome rich notifications with game cover art and **Claim now** / **Dismiss** actions, plus optional Telegram Bot and Discord Webhook alerts for `NEEDS_USER` and `FAILED` events.
- **Safety & Observability**: Instant Pause switch, Dry-run mode, one-claim-at-a-time rate limiting with randomized 1–3 s click delays, 60 s per-claim abort timeout, per-store error isolation, and a 200-entry structured log buffer in `chrome.storage.local`.

## Project Structure

```text
claimit-extension/
├── manifest.json
├── config/
│   └── selectors.json
├── assets/
│   ├── cover-fallback.svg
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   ├── icon-128.png
│   ├── icons.svg
│   ├── illustrations.svg
│   ├── logo.svg
│   ├── notification-icon.png
│   ├── stores.svg
│   └── wordmark.svg
├── src/
│   ├── background.js          # MV3 service worker, alarms, lifecycle, notification handlers
│   ├── classifier.js          # Pure offer classification logic
│   ├── currency.js            # Region detection, 24h FX rate cache & Intl formatting
│   ├── engine.js              # Check cycle, rate limit, timeout, dry-run, pause abort
│   ├── logger.js              # 200-entry structured ring buffer in chrome.storage.local
│   ├── notifications.js       # Chrome, Telegram, and Discord notification dispatcher
│   ├── remote-config.js       # Bundled + GitHub raw JSON loader & schema validator
│   ├── storage.js             # Settings, history, value saved, and snapshot helpers
│   ├── content/
│   │   ├── epic.js            # Epic product & checkout iframe DOM interactions
│   │   └── steam.js           # Steam store page, age-gate & Add to Account DOM helper
│   ├── providers/
│   │   ├── index.js           # Provider registry
│   │   ├── constants.js       # Claim status enum and randomized delay helpers
│   │   ├── tab-helpers.js     # Tab lifecycle and frame messaging helpers
│   │   ├── epic.js            # Epic freeGamesPromotions + checkout claim flow
│   │   ├── steam.js           # Swappable Steam search/appdetails/userdata scraper & claimer
│   │   ├── gog.js             # Stub (disabled)
│   │   ├── prime-gaming.js    # Stub (disabled)
│   │   ├── fab.js             # Stub (disabled)
│   │   └── itch.js            # Stub (disabled)
│   ├── styles/
│   │   └── tokens.css         # Shared light/dark CSS design tokens
│   ├── ui/
│   │   └── ui-helpers.js      # SVG sprite/illustration mounting & Intl formatters
│   ├── popup/
│   │   ├── popup.html / .css / .js
│   └── options/
│       ├── options.html / .css / .js
└── tests/
    ├── classifier.test.js
    ├── engine-and-helpers.test.js
    ├── providers.test.js
    └── remote-config.test.js
```

Manual verification steps for Chrome/Brave are documented in [TESTING.md](TESTING.md).

## Permissions Explained

ClaimIt requests the minimum permissions required for MV3 operation:

| Permission | Why it is needed |
|---|---|
| `alarms` | Schedules periodic background checks (default 6 h, hourly Thu/Fri) across service worker restarts. |
| `notifications` | Displays desktop notifications with cover art and **Claim now** / **Dismiss** buttons. |
| `storage` | Persists settings, claim history, offer snapshots, notification dedup state, selector cache, and the 200-entry debug log in `chrome.storage.local`. |
| `scripting` | Enumerates frames (`allFrames`) and lazily ensures Epic/Steam content scripts are active inside store and checkout iframes. |
| `tabs` | Opens store pages in background tabs during claiming, closes completed tabs, and focuses `NEEDS_USER` tabs in the foreground. |

### Host Permissions

- `https://store-site-backend-static-ipv4.ak.epicgames.com/*`: Fetches Epic's public `freeGamesPromotions` JSON feed.
- `https://store.epicgames.com/*` and `https://payment-website-pci.ol.epicgames.com/*`: Inspects Epic store pages and interacts with Epic's checkout modal/iframe during auto-claim.
- `https://store.steampowered.com/*`: Queries Steam's free specials search results, `appdetails`, `dynamicstore/userdata/`, and interacts with Steam app pages.
- `https://raw.githubusercontent.com/*`: Fetches user-configured remote `selectors.json` updates.
- `https://open.er-api.com/*`: Fetches keyless daily exchange rates (`USD` base, cached for 24 h in `chrome.storage.local`) only as a fallback when a store returns a currency different from your display currency.

### Optional Host Permissions

Requested only on explicit user action in **Options** when enabling/testing optional features:

- `https://api.telegram.org/*`: Sends Telegram Bot alerts for `NEEDS_USER` and `FAILED` outcomes.
- `https://discord.com/*`, `https://discordapp.com/*`: Sends Discord Webhook alerts for `NEEDS_USER` and `FAILED` outcomes.
- `https://steamdb.info/*`: Optional swappable SteamDB source if enabled.

## Installation (Developer Mode)

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `claimit-extension` folder.
4. Make sure you are signed into Epic Games Store and/or Steam in your browser, then click the ClaimIt toolbar icon or **Options** to configure preferences.

## Running Tests

Requires Node.js 20+ (no external dependencies):

```bash
node --test tests/classifier.test.js tests/providers.test.js tests/remote-config.test.js tests/engine-and-helpers.test.js
```
