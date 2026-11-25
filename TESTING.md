# ClaimIt Manual Test Script (`TESTING.md`)

Follow these steps to load ClaimIt unpacked in Chrome (or Brave) and verify all runtime behaviors.

## 1. Load the Extension Unpacked
1. Open `chrome://extensions` (or `brave://extensions`).
2. Toggle **Developer mode** ON (top right).
3. Click **Load unpacked** and select the `claimit-extension` directory.
4. **Expected:** ClaimIt appears with no error badge and `Errors` button is absent.

## 2. Inspect Service Worker Console
1. On the ClaimIt card in `chrome://extensions`, click **Inspect views: service worker**.
2. **Expected:** DevTools opens on `src/background.js` with zero uncaught exceptions or syntax errors. On first install, the console/logs show an initial check cycle starting.

## 3. Verify Popup UI & Tabs
1. Click the ClaimIt toolbar icon to open the popup.
2. Click through **Free now**, **Claimed**, and **Issues** tabs.
3. Toggle the **Active / Paused** switch in the header, then toggle it back to **Active**.
4. **Expected:** All three tabs render cleanly without console errors (right-click popup -> **Inspect** to verify). Empty states show helpful messages; toggling Pause updates the **Paused** badge and disables **Check now** immediately.

## 4. Verify Options Persistence
1. Click the gear icon in the popup to open `src/options/options.html`.
2. Toggle **Dry-run mode** ON, change **Check interval** to `4` hours, switch Steam mode to **Notify only**, then reload the Options tab (`Ctrl+R` / `Cmd+R`).
3. **Expected:** All modified values persist after reload; store mode remains **Notify only** even if you toggle the store checkbox off and back on.

## 5. Trigger "Check now" & Dry-run Verification
1. Leave **Dry-run mode** ON in Options (and ensure you are logged into Epic Games Store and Steam in this browser profile if testing live pages).
2. Open the popup and click **Check now**.
3. Open **Options -> Data & Diagnostics -> Refresh logs**.
4. **Expected:**
   - Popup displays any active 100%-off free-to-keep offers under **Free now** with a `Dry-run` chip (no real purchase/claim click is made).
   - **Claimed** tab does **not** record dry-run runs as real claims or inflate **Total Value Saved**.
   - Logs contain structured entries for `Loaded selectors config`, `Provider ... fetched offers`, and `Dry-run completed` (if eligible non-owned offers were found).

## 6. Verify Notification Buttons
1. Set a store with an active free offer to **Notify only** (or test with a `NEEDS_USER` offer / webhook test).
2. Click **Check now** in the popup.
3. **Expected:**
   - A persistent Chrome notification appears with the game title, store availability, **Claim now**, and **Dismiss** buttons.
   - Clicking **Claim now** opens/focuses the exact store page tab and clears the notification.
   - Clicking **Dismiss** closes the notification without opening a tab.

## 7. Verify Alarm Firing Quickly
1. Open the **service worker** DevTools Console (`chrome://extensions` -> **service worker**).
2. Run:
   ```js
   chrome.alarms.create('claimit_check_alarm', { delayInMinutes: 0.1 });
   ```
3. Wait ~6 seconds and refresh Options logs.
4. **Expected:** `runCheckCycle` triggers with `(alarm)` and logs the new cycle cleanly without overlapping or duplicate alarms.

## 8. Verify Remote Config Fallback
1. In Options -> **Remote Selector Config**, enter an invalid URL (e.g. `https://raw.githubusercontent.com/invalid/nonexistent/main/selectors.json`) and click **Fetch & Validate**.
2. **Expected:** Status updates to `Active source: bundled (fallback reason: HTTP 404)` and the extension keeps working normally.
