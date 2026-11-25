/**
 * ClaimIt MV3 Background Service Worker
 * Manages chrome.alarms scheduling (6h default, hourly Thu/Fri boost),
 * startup/install catch-up checks, notification button clicks, and UI messages.
 */

import { runCheckCycle, claimSingleOffer, abortActiveAutomation } from './engine.js';
import { getSettings, saveSettings, clearHistory } from './storage.js';
import { getSelectorsConfig } from './remote-config.js';
import {
  getNotificationTarget,
  removeNotificationTarget,
  sendTestWebhook
} from './notifications.js';
import { focusTab } from './providers/tab-helpers.js';
import { logger } from './logger.js';

export const CHECK_ALARM_NAME = 'claimit_check_alarm';

/**
 * Pure helper computing the alarm interval in minutes.
 * Uses hourly polling on Thursdays (4) and Fridays (5) when boost is enabled.
 * @param {object} settings
 * @param {Date} [now=new Date()]
 * @returns {number}
 */
export function computeAlarmPeriodMinutes(settings, now = new Date()) {
  const configuredHours = Math.max(1, Number(settings?.checkIntervalHours ?? 6));
  const configuredMinutes = Math.round(configuredHours * 60);
  const day = now.getDay(); // 0=Sun ... 4=Thu, 5=Fri
  const isThuOrFri = day === 4 || day === 5;
  if (settings?.thursdayFridayHourlyBoost !== false && isThuOrFri) {
    return Math.min(60, configuredMinutes);
  }
  return configuredMinutes;
}

/**
 * Synchronize chrome.alarms with current user settings and day-of-week schedule.
 */
export async function syncAlarmSchedule() {
  const settings = await getSettings();
  const periodInMinutes = computeAlarmPeriodMinutes(settings);

  const existing = await chrome.alarms.get(CHECK_ALARM_NAME);
  if (existing && existing.periodInMinutes === periodInMinutes) {
    return periodInMinutes;
  }

  await chrome.alarms.clear(CHECK_ALARM_NAME);
  await chrome.alarms.create(CHECK_ALARM_NAME, {
    delayInMinutes: periodInMinutes,
    periodInMinutes
  });
  await logger.debug('scheduler', `Alarm scheduled every ${periodInMinutes} min`);
  return periodInMinutes;
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
  if (target.offerUrl) {
    await chrome.tabs.create({ url: target.offerUrl, active: true });
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await logger.info('lifecycle', `Extension ${details.reason}`);
  await getSettings();
  await syncAlarmSchedule();
  await runCheckCycle({ trigger: `install:${details.reason}` });
});

chrome.runtime.onStartup.addListener(async () => {
  await logger.info('lifecycle', 'Browser startup catch-up check');
  await syncAlarmSchedule();
  await runCheckCycle({ trigger: 'startup' });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CHECK_ALARM_NAME) return;
  await syncAlarmSchedule();
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    switch (message?.type) {
      case 'CLAIMIT_RUN_CHECK':
        return runCheckCycle({ trigger: 'manual' });

      case 'CLAIMIT_CLAIM_ONE':
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

      case 'CLAIMIT_RESCHEDULE':
        return { periodInMinutes: await syncAlarmSchedule() };

      case 'CLAIMIT_CLEAR_HISTORY':
        await clearHistory();
        await logger.info('storage', 'Claim history cleared');
        return { ok: true };

      case 'CLAIMIT_REFRESH_REMOTE_CONFIG':
        return getSelectorsConfig({ forceRefresh: true });

      case 'CLAIMIT_TEST_WEBHOOK':
        await sendTestWebhook(message.channel, message.config);
        return { ok: true };

      default:
        return { error: `Unknown message type: ${message?.type}` };
    }
  };

  handle()
    .then((res) => sendResponse({ ok: true, data: res }))
    .catch((err) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    );
  return true; // Keep message channel open for async response
});
