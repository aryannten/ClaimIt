# ClaimIt

Free games, claimed while you are not looking.

ClaimIt is a Chrome Manifest V3 extension that watches Epic Games Store and Steam for limited-time free-to-keep games and claims them using your active browser session. I built this because I kept missing weekly giveaways before their claim window closed. I am sharing it publicly in case you find it useful too, under the terms in the License section below.

## Screenshots

| Free now | Claimed and regional savings | Settings |
|---|---|---|
| ![ClaimIt popup Free now tab showing active offer and next daily scan time](docs/images/popup-free-games.png) | ![ClaimIt popup Claimed tab showing total savings formatted in INR](docs/images/popup-claimed.png) | ![ClaimIt Settings page with store switches and currency selector](docs/images/options-settings.png) |

## What it does

- Claims eligible giveaways automatically in a background tab, or notifies you when input is needed.
- Auto-claims free-to-keep giveaways from Epic Games Store and Steam, ignoring free-to-play titles, demos, and trials.
- Includes **Deals** (paid Steam sales with a 40%–100% slider, search, sort, and batch refresh) and **Free Steam** (all free Steam games) tabs.
- Runs an initial scan on install, then one randomised scan per day, checking sooner if a known offer expires early.
- Displays store cover art, prices, Steam review popularity, and total savings in your local currency (such as INR, EUR, USD, or JPY).
- Sends desktop Chrome notifications plus optional Telegram Bot and Discord webhook alerts.
- Provides an instant Pause toggle and a Dry-run mode for safe testing.

## Install

1. Clone or download this folder, or extract `claimit-extension.zip` built via `npm run build`.
2. Open `chrome://extensions` or `brave://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `claimit-extension` folder.
4. Pin the ClaimIt icon to your toolbar to see current offers and recent claims.

Sign in to Epic Games Store and Steam using the **Sign in** buttons in the ClaimIt popup (or directly in Chrome); once signed in, ClaimIt automatically checks and claims eligible giveaways.

A Chrome Web Store listing is not published yet.

Internal notes on code layout, tests, and packaging live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Using it

- **Popup tabs**: Switch between **Free now**, **Deals** (40%–100% slider, search, sort, batch refresh), **Free Steam** (all free-to-play and 100%-off games), **Claimed** (total saved), and **Issues**.
- **Check now**: Runs a manual check immediately, subject to a 5-minute cooldown between runs.
- **Store controls**: Enable or disable stores in Settings, pick **Auto-claim** or **Notify only**, and view the collapsible **Activity log** under Advanced.
- **Dry-run mode**: Walks through offer detection and checkout setup without clicking the final claim button.

## Supported stores

| Store | Status | Notes |
|---|---|---|
| Epic Games Store | Active | Uses public `freeGamesPromotions` feed and checkout tab automation |
| Steam | Active | Claims free specials via Add to Account, and powers the Deals and Free Steam tabs |
| GOG, Prime Gaming, Fab, itch.io | Planned | Disabled stubs, not implemented |

## Permissions

Only the minimum permissions needed for Manifest V3 are declared in `manifest.json`.

| Permission | Why |
|---|---|
| `alarms`, `notifications`, `storage` | Schedule one daily scan, show desktop alerts, and store preferences, history (max 500), and logs (max 50) |
| `tabs`, `scripting` | Open claim tabs and inject Epic/Steam DOM helpers only during an active claim |
| Epic hosts (`store-site-backend-static-ipv4.ak.epicgames.com`, `store.epicgames.com`, `payment-website-pci.ol.epicgames.com`) | Fetch Epic giveaways and complete checkout steps |
| Steam host (`store.steampowered.com`) | Query free specials, `appdetails`, library ownership, and Add to Account pages |
| Optional hosts (`raw.githubusercontent.com`, `open.er-api.com`, `api.telegram.org`, `discord.com`, `discordapp.com`, `steamdb.info`) | Requested only at runtime when using alerts, currency overrides, remote selectors, or SteamDB |

## Privacy and safety

- Settings, claim history, cached FX rates, and debug logs remain in `chrome.storage.local` on your device.
- Passwords and login credentials are never requested, read, or stored.
- ClaimIt runs no analytics, telemetry, ads, or developer backend servers.
- Store URLs, Discord webhooks, and remote selector configs pass strict HTTPS allowlist and schema validation.
- CAPTCHAs and 2FA prompts are never bypassed; ClaimIt stops on that item and hands control to you.

Read [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) for full details.

## Known limits

- Store page layouts can change without notice and break claims until `config/selectors.json` is updated.
- Scheduled scans run only while the browser is open; missed days trigger one delayed catch-up scan on startup.
- Live Epic Games Store and Steam claim flows depend on live account sessions and are verified by hand.

## A note on store terms

Automating clicks inside store websites may be restricted or prohibited by a store's terms of service.

Switch any store to **Notify only** mode if you prefer not to automate claims, as you are responsible for how you use ClaimIt on your accounts.

## License

Copyright (c) 2026 [aryannten](https://github.com/aryannten). All rights reserved.

The unmodified extension may be installed and run strictly for personal, non-commercial use.

The source code is viewable on GitHub for reference, and modification, redistribution, or commercial use requires written permission.

See [LICENSE](LICENSE) for full terms, and contact the author via the GitHub profile above to request permission.

## Credits

- [ExchangeRate-API Open Access](https://www.exchangerate-api.com/docs/free) for keyless daily JSON exchange rates used only when converting across currencies.
- [ESLint](https://eslint.org/) for development-only linting and service-worker timer checks.
