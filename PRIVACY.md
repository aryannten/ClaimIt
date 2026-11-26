# Privacy Policy for ClaimIt

**Last updated:** 2026-11-27

ClaimIt is designed to run completely locally inside your browser without developer servers, tracking, analytics, or advertising.

## Data We Do Not Collect

ClaimIt **does not** collect, transmit to developer servers, sell, or share:
- Account usernames, emails, passwords, cookies, or authentication tokens
- Browsing history across websites you visit
- Device identifiers, telemetry, crash reports, or usage analytics

## Data Stored Locally on Your Device

All extension state is stored strictly inside your browser's `chrome.storage.local` storage:
- **Preferences (`claimit_settings`)**: Enabled stores, claim modes (`auto` / `notify`), dry-run mode, pause flag, selected currency, optional remote selector URL, and any Telegram Bot token / Chat ID or Discord Webhook URL you explicitly enter.
- **Claim history and snapshots (`claimit_history`, `claimit_current_offers`, `claimit_notification_state`)**: Game titles, store IDs, URLs, original prices, currencies, claim status, and timestamps (history is capped at 500 entries).
- **Schedule and region metadata (`claimit_meta`, `claimit_region`, `claimit_fx_rates`)**: Last/next scan timestamps, detected store/browser currency & country code, and a 24-hour cache of public exchange rates.
- **Troubleshooting logs (`claimit_logs`)**: Up to 50 recent structured events (bot tokens and webhook secrets are automatically redacted).

You can delete claim history, cached offers, and logs at any time from **Settings -> Log -> Clear logs** and **Settings -> Advanced -> Clear history**, or remove everything by uninstalling the extension.

## Network Requests Made by ClaimIt

ClaimIt communicates only directly from your browser to the destinations listed below:

| Destination | When Sent | Data Sent |
|---|---|---|
| `store-site-backend-static-ipv4.ak.epicgames.com`, `store.epicgames.com`, `payment-website-pci.ol.epicgames.com` | During checks/claims when Epic Games Store is enabled | Standard storefront HTTPS requests and active browser session cookies on Epic claim tabs |
| `store.steampowered.com` | During checks/claims when Steam is enabled | Standard storefront HTTPS requests (`search/results`, `appdetails`, `dynamicstore/userdata`) and active browser session cookies on Steam claim tabs |
| `open.er-api.com` | At most once per 24 hours, only when converting an offer price from another currency | Public `GET /v6/latest/USD` request (no user data) |
| `api.telegram.org` | Only when Telegram alerts are enabled and a `NEEDS_USER`/`FAILED` event or test occurs | Bot token, chat ID, and game promotion details configured by you |
| `discord.com` / `discordapp.com` | Only when Discord webhook alerts are enabled and a `NEEDS_USER`/`FAILED` event or test occurs | Game promotion embed sent directly to your configured webhook URL |
| User-configured HTTPS URL (`raw.githubusercontent.com`) | Only when you enter a remote `selectors.json` URL or refresh it | Standard `GET` request expecting public JSON selector rules |

## Browser Permissions Justification

- **alarms / storage / notifications**: Required for daily background checks, saving local history/preferences, and notifying you when a game needs manual claiming.
- **scripting / tabs**: Required strictly to open background claim tabs on enabled store pages and inject claiming scripts on demand while claiming. ClaimIt runs no always-on scripts on general websites.
