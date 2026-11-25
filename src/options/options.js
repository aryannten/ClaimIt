import { getSettings, saveSettings } from '../storage.js';
import { getAllProviders } from '../providers/index.js';
import { logger } from '../logger.js';

const els = {
  saveStatus: document.getElementById('saveStatus'),
  storesList: document.getElementById('storesList'),
  checkIntervalHours: document.getElementById('checkIntervalHours'),
  thuFriBoost: document.getElementById('thuFriBoost'),
  dryRunToggle: document.getElementById('dryRunToggle'),
  chromeNotifToggle: document.getElementById('chromeNotifToggle'),
  telegramEnabled: document.getElementById('telegramEnabled'),
  telegramBotToken: document.getElementById('telegramBotToken'),
  telegramChatId: document.getElementById('telegramChatId'),
  testTelegramBtn: document.getElementById('testTelegramBtn'),
  discordEnabled: document.getElementById('discordEnabled'),
  discordWebhookUrl: document.getElementById('discordWebhookUrl'),
  testDiscordBtn: document.getElementById('testDiscordBtn'),
  remoteConfigUrl: document.getElementById('remoteConfigUrl'),
  refreshConfigBtn: document.getElementById('refreshConfigBtn'),
  remoteConfigStatus: document.getElementById('remoteConfigStatus'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  logLevelFilter: document.getElementById('logLevelFilter'),
  refreshLogsBtn: document.getElementById('refreshLogsBtn'),
  copyLogsBtn: document.getElementById('copyLogsBtn'),
  clearLogsBtn: document.getElementById('clearLogsBtn'),
  logsContainer: document.getElementById('logsContainer')
};

let statusTimer = null;

function flashStatus(text, isError = false) {
  clearTimeout(statusTimer);
  els.saveStatus.textContent = text;
  els.saveStatus.style.color = isError ? '#f87171' : '#10b981';
  statusTimer = setTimeout(() => {
    els.saveStatus.textContent = '';
  }, 2600);
}

async function ensureHostPermission(origins) {
  if (!chrome.permissions?.request) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function renderStores(settings) {
  els.storesList.replaceChildren();
  const providers = getAllProviders();

  for (const provider of providers) {
    const isStub = provider.stub === true;
    const storeCfg = settings.stores?.[provider.id] || { enabled: false, mode: 'notify' };

    const card = document.createElement('div');
    card.className = `store-card${isStub ? ' stub' : ''}`;

    const top = document.createElement('div');
    top.className = 'store-top';

    const title = document.createElement('span');
    title.textContent = isStub ? `${provider.name} (Soon)` : provider.name;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !isStub && Boolean(storeCfg.enabled);
    toggle.disabled = isStub;
    toggle.addEventListener('change', async () => {
      const current = await getSettings();
      await saveSettings({
        stores: {
          [provider.id]: {
            ...current.stores[provider.id],
            enabled: toggle.checked
          }
        }
      });
      flashStatus('Saved');
    });

    top.append(title, toggle);
    card.appendChild(top);

    const modeSelect = document.createElement('select');
    modeSelect.disabled = isStub;
    const optAuto = new Option('Auto-claim', 'auto');
    const optNotify = new Option('Notify only', 'notify');
    modeSelect.add(optAuto);
    modeSelect.add(optNotify);
    modeSelect.value = storeCfg.mode || 'auto';
    modeSelect.addEventListener('change', async () => {
      const current = await getSettings();
      await saveSettings({
        stores: {
          [provider.id]: {
            ...current.stores[provider.id],
            mode: modeSelect.value
          }
        }
      });
      flashStatus('Saved');
    });

    card.appendChild(modeSelect);
    els.storesList.appendChild(card);
  }
}

async function renderLogs() {
  const level = els.logLevelFilter.value;
  const all = await logger.getAll();
  const filtered = level === 'all' ? all : all.filter((e) => e.level === level);
  const newestFirst = filtered.slice().reverse();

  els.logsContainer.replaceChildren();
  if (newestFirst.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-entry log-level-debug';
    empty.textContent = 'No log entries.';
    els.logsContainer.appendChild(empty);
    return;
  }

  for (const entry of newestFirst) {
    const row = document.createElement('div');
    row.className = `log-entry log-level-${entry.level}`;
    const metaText = entry.meta ? ` ${JSON.stringify(entry.meta)}` : '';
    row.textContent = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.scope}] ${entry.message}${metaText}`;
    els.logsContainer.appendChild(row);
  }
}

async function hydrate() {
  const settings = await getSettings();
  renderStores(settings);

  els.checkIntervalHours.value = String(settings.checkIntervalHours ?? 6);
  els.thuFriBoost.checked = settings.thursdayFridayHourlyBoost !== false;
  els.dryRunToggle.checked = Boolean(settings.dryRun);
  els.chromeNotifToggle.checked = settings.notifications?.chrome !== false;

  els.telegramEnabled.checked = Boolean(settings.notifications?.telegram?.enabled);
  els.telegramBotToken.value = settings.notifications?.telegram?.botToken || '';
  els.telegramChatId.value = settings.notifications?.telegram?.chatId || '';

  els.discordEnabled.checked = Boolean(settings.notifications?.discord?.enabled);
  els.discordWebhookUrl.value = settings.notifications?.discord?.webhookUrl || '';

  els.remoteConfigUrl.value = settings.remoteConfigUrl || '';
  await renderLogs();
}

async function saveNotificationFields() {
  await saveSettings({
    notifications: {
      chrome: els.chromeNotifToggle.checked,
      telegram: {
        enabled: els.telegramEnabled.checked,
        botToken: els.telegramBotToken.value.trim(),
        chatId: els.telegramChatId.value.trim()
      },
      discord: {
        enabled: els.discordEnabled.checked,
        webhookUrl: els.discordWebhookUrl.value.trim()
      }
    }
  });
  flashStatus('Saved');
}

async function sendBgMessage(payload) {
  try {
    const res = await chrome.runtime.sendMessage(payload);
    if (res && res.ok === false) {
      flashStatus(res.error || 'Request failed', true);
      return null;
    }
    return res;
  } catch (err) {
    flashStatus(err instanceof Error ? err.message : String(err), true);
    return null;
  }
}

els.checkIntervalHours.addEventListener('change', async () => {
  const hours = Math.max(1, Math.min(168, Number(els.checkIntervalHours.value) || 6));
  els.checkIntervalHours.value = String(hours);
  await saveSettings({ checkIntervalHours: hours });
  if (await sendBgMessage({ type: 'CLAIMIT_RESCHEDULE' })) {
    flashStatus('Schedule updated');
  }
});

els.thuFriBoost.addEventListener('change', async () => {
  await saveSettings({ thursdayFridayHourlyBoost: els.thuFriBoost.checked });
  if (await sendBgMessage({ type: 'CLAIMIT_RESCHEDULE' })) {
    flashStatus('Schedule updated');
  }
});

els.dryRunToggle.addEventListener('change', async () => {
  await saveSettings({ dryRun: els.dryRunToggle.checked });
  flashStatus('Saved');
});

els.chromeNotifToggle.addEventListener('change', saveNotificationFields);

els.telegramEnabled.addEventListener('change', async () => {
  if (els.telegramEnabled.checked) {
    await ensureHostPermission(['https://api.telegram.org/*']);
  }
  await saveNotificationFields();
});
els.telegramBotToken.addEventListener('change', saveNotificationFields);
els.telegramChatId.addEventListener('change', saveNotificationFields);

els.discordEnabled.addEventListener('change', async () => {
  if (els.discordEnabled.checked) {
    await ensureHostPermission(['https://discord.com/*', 'https://discordapp.com/*']);
  }
  await saveNotificationFields();
});
els.discordWebhookUrl.addEventListener('change', saveNotificationFields);

els.testTelegramBtn.addEventListener('click', async () => {
  const granted = await ensureHostPermission(['https://api.telegram.org/*']);
  if (!granted) {
    flashStatus('Telegram host permission declined', true);
    return;
  }
  await saveNotificationFields();
  const res = await sendBgMessage({
    type: 'CLAIMIT_TEST_WEBHOOK',
    channel: 'telegram',
    config: {
      enabled: true,
      botToken: els.telegramBotToken.value.trim(),
      chatId: els.telegramChatId.value.trim()
    }
  });
  if (res?.ok) {
    flashStatus('Telegram test sent');
  }
});

els.testDiscordBtn.addEventListener('click', async () => {
  const granted = await ensureHostPermission(['https://discord.com/*', 'https://discordapp.com/*']);
  if (!granted) {
    flashStatus('Discord host permission declined', true);
    return;
  }
  await saveNotificationFields();
  const res = await sendBgMessage({
    type: 'CLAIMIT_TEST_WEBHOOK',
    channel: 'discord',
    config: {
      enabled: true,
      webhookUrl: els.discordWebhookUrl.value.trim()
    }
  });
  if (res?.ok) {
    flashStatus('Discord test sent');
  }
});

els.remoteConfigUrl.addEventListener('change', async () => {
  await saveSettings({ remoteConfigUrl: els.remoteConfigUrl.value.trim() });
  flashStatus('Saved');
});

els.refreshConfigBtn.addEventListener('click', async () => {
  await saveSettings({ remoteConfigUrl: els.remoteConfigUrl.value.trim() });
  const res = await sendBgMessage({ type: 'CLAIMIT_REFRESH_REMOTE_CONFIG' });
  if (res?.ok && res.data) {
    const { source, error } = res.data;
    els.remoteConfigStatus.textContent = error
      ? `Active source: ${source} (fallback reason: ${error})`
      : `Active source: ${source}`;
    flashStatus(error ? 'Fallback active' : 'Remote config valid', Boolean(error));
  }
});

els.clearHistoryBtn.addEventListener('click', async () => {
  if (await sendBgMessage({ type: 'CLAIMIT_CLEAR_HISTORY' })) {
    flashStatus('History cleared');
  }
});

els.logLevelFilter.addEventListener('change', renderLogs);
els.refreshLogsBtn.addEventListener('click', renderLogs);

els.copyLogsBtn.addEventListener('click', async () => {
  try {
    const logs = await logger.getAll();
    await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
    flashStatus('Logs copied');
  } catch {
    flashStatus('Clipboard copy failed', true);
  }
});

els.clearLogsBtn.addEventListener('click', async () => {
  await logger.clear();
  await renderLogs();
  flashStatus('Logs cleared');
});

hydrate();
