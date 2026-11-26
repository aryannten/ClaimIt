/**
 * ClaimIt MV3 Background Service Worker
 * Uses a once-daily randomized one-shot alarm (chrome.alarms with `when`),
 * delayed missed-scan catch-up on startup/install, notification clicks, and UI IPC.
 * Runs exclusively via Chrome events with no background timers or idle state.
 */

import { runCheckCycle, claimSingleOffer, abortActiveAutomation } from './engine.js';
import { getSettings, saveSettings, clearHistory, getMeta, updateMeta } from './storage.js';
import {
  CHECK_ALARM_NAME,
  checkManualRateLimit,
  syncScheduleOnStartup
} from './scheduler.js';
import { getSelectorsConfig } from './remote-config.js';
import {
  getNotificationTarget,
  removeNotificationTarget,
  sendTestWebhook
} from './notifications.js';
import { focusTab } from './providers/tab-helpers.js';
import { logger, redactSecrets } from './logger.js';
import { isAllowedStoreUrl } from './url-validator.js';
import {
  startStoreSignIn,
  refreshStoreSessions,
  handleSignInTabUpdated,
  handleSignInTabRemoved
} from './accounts.js';

export { CHECK_ALARM_NAME };

/**
 * Run an on-demand manual check enforced by the 5-minute rate limit in chrome.storage.local.
 */
export async function runManualCheck(nowMs = Date.now()) {
  const meta = await getMeta();
  const limit = checkManualRateLimit(meta.lastManualCheckAt, nowMs);
  if (!limit.allowed) {
    return { skipped: true, rateLimited: true, retryAfterMs: limit.retryAfterMs };
  }
  await updateMeta({ lastManualCheckAt: new Date(nowMs).toISOString() });
  return runCheckCycle({ trigger: 'manual' });
}

async function openOrFocusNotificationTarget(notificationId) {
  const target = await getNotificationTarget(notificationId);
  await removeNotificationTarget(notificationId);
  await chrome.notifications.clear(notificationId);

  if (!target) return;
  if (typeof target.tabId === 'number') {
    try {
      await chrome.tabs.get(target.tabId);
      await focusTab(target.tabId);
      return;
    } catch {
      // Original tab was closed; open a fresh active tab
    }
  }
  if (target.offerUrl && isAllowedStoreUrl(target.offerUrl)) {
    await chrome.tabs.create({ url: target.offerUrl, active: true });
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(async (details) => {
    await logger.info('lifecycle', `Extension ${details.reason}`);
    await getSettings();
    await refreshStoreSessions();
    if (details.reason === 'install') {
      await runCheckCycle({ trigger: 'install' });
    } else {
      await syncScheduleOnStartup();
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    await logger.info('lifecycle', 'Browser startup schedule check');
    await refreshStoreSessions();
    await syncScheduleOnStartup();
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    await handleSignInTabUpdated(tabId, changeInfo, tab, () =>
      runCheckCycle({ trigger: 'login' })
    );
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await handleSignInTabRemoved(tabId);
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== CHECK_ALARM_NAME) return;
    await runCheckCycle({ trigger: 'alarm' });
  });

  chrome.notifications.onClicked.addListener(async (notificationId) => {
    if (!notificationId.startsWith('claimit:')) return;
    await openOrFocusNotificationTarget(notificationId);
  });

  chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    if (!notificationId.startsWith('claimit:')) return;
    if (buttonIndex === 0) {
      await openOrFocusNotificationTarget(notificationId);
    } else {
      await removeNotificationTarget(notificationId);
      await chrome.notifications.clear(notificationId);
    }
  });

  chrome.notifications.onClosed.addListener(async (notificationId) => {
    if (!notificationId.startsWith('claimit:')) return;
    await removeNotificationTarget(notificationId);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only process messages from this extension's own pages (popup, options).
    // Reject messages from web pages or content scripts relaying external data.
    if (sender?.id !== chrome.runtime.id) return false;
    const handle = async () => {
      switch (message?.type) {
        case 'CLAIMIT_RUN_CHECK':
          return runManualCheck();

        case 'CLAIMIT_SIGN_IN':
          return startStoreSignIn(message.store);

        case 'CLAIMIT_REFRESH_ACCOUNTS':
          return refreshStoreSessions();

        case 'CLAIMIT_CLAIM_ONE':
          if (
            typeof message.store !== 'string' ||
            typeof message.id !== 'string' ||
            message.id.length === 0 ||
            message.id.length > 128
          ) {
            throw new Error('Invalid store or offer identifier');
          }
          return claimSingleOffer(message.store, message.id);

        case 'CLAIMIT_SET_PAUSED': {
          const paused = Boolean(message.paused);
          const updated = await saveSettings({ paused });
          if (paused) {
            abortActiveAutomation();
          }
          await logger.info('engine', paused ? 'Automation paused' : 'Automation resumed');
          return { paused: updated.paused };
        }

        case 'CLAIMIT_CLEAR_HISTORY':
          await clearHistory();
          await logger.info('storage', 'Claim history cleared');
          return { ok: true };

        case 'CLAIMIT_REFRESH_REMOTE_CONFIG':
          return getSelectorsConfig({ forceRefresh: true });

        case 'CLAIMIT_TEST_WEBHOOK':
          if (message.channel !== 'telegram' && message.channel !== 'discord') {
            throw new Error('Unsupported notification channel');
          }
          await sendTestWebhook(message.channel, message.config);
          return { ok: true };

        default:
          return { error: `Unknown message type: ${String(message?.type || '')}` };
      }
    };

    handle()
      .then((res) => sendResponse({ ok: true, data: res }))
      .catch((err) =>
        sendResponse({ ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) })
      );
    return true; // Keep message channel open for async response
  });
}
