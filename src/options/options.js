import {
  STORAGE_KEYS,
  getSettings,
  saveSettings,
  getRegionState,
  getCachedFxRates,
  setCachedFxRates
} from '../storage.js';
import {
  SUPPORTED_CURRENCIES,
  resolveRegionAndCurrency,
  getCurrencyLabel,
  getExchangeRates
} from '../currency.js';
import { getAllProviders } from '../providers/index.js';
import { logger } from '../logger.js';
import { createSvgUse, createIllustration } from '../ui/ui-helpers.js';

const STORE_HELPERS = {
  epic: 'Checks weekly free promotions and claims via Epic store checkout.',
  steam: 'Monitors 100%-off specials and claims free-to-keep Steam licenses.',
  gog: 'Planned provider for GOG giveaway banners (not yet enabled).',
  prime: 'Planned provider for Prime Gaming PC drops (not yet enabled).',
  fab: 'Planned provider for Fab limited-time assets (not yet enabled).',
  itch: 'Planned provider for itch.io 100%-off sales (not yet enabled).'
};

const els = {
  saveStatus: document.getElementById('saveStatus'),
  storesList: document.getElementById('storesList'),
  currencySelect: document.getElementById('currencySelect'),
  detectedRegionText: document.getElementById('detectedRegionText'),
  changeCurrencyBtn: document.getElementById('changeCurrencyBtn'),
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
let clearConfirmTimer = null;
let clearArmed = false;

function flashStatus(text, isError = false) {
  clearTimeout(statusTimer);
  els.saveStatus.textContent = text;
  els.saveStatus.classList.toggle('error', isError);
  statusTimer = setTimeout(() => {
    els.saveStatus.textContent = '';
    els.saveStatus.classList.remove('error');
  }, 3000);
}

async function ensureHostPermission(origins) {
  if (!chrome.permissions?.request) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
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

function renderStores(settings) {
  els.storesList.replaceChildren();
  const providers = getAllProviders();

  for (const provider of providers) {
    const isStub = provider.stub === true;
    const storeCfg = settings.stores?.[provider.id] || { enabled: false, mode: 'notify' };

    const row = document.createElement('div');
    row.className = `store-row${isStub ? ' stub' : ''}`;

    const idWrap = document.createElement('div');
    idWrap.className = 'store-id';
    idWrap.appendChild(createSvgUse(`store-${provider.id}`, 'store-tile', 'stores.svg'));

    const textCol = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'store-name';
    nameEl.textContent = isStub ? `${provider.name} (Planned)` : provider.name;
    const helper = document.createElement('p');
    helper.className = 'helper';
    helper.textContent = STORE_HELPERS[provider.id] || 'Store automation provider.';
    textCol.append(nameEl, helper);
    idWrap.appendChild(textCol);

    const modeSelect = document.createElement('select');
    modeSelect.className = 'select';
    modeSelect.disabled = isStub;
    modeSelect.setAttribute('aria-label', `${provider.name} claim mode`);
    modeSelect.add(new Option('Auto-claim', 'auto'));
    modeSelect.add(new Option('Notify only', 'notify'));
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

    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !isStub && Boolean(storeCfg.enabled);
    toggle.disabled = isStub;
    toggle.setAttribute('aria-label', `Enable ${provider.name}`);
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
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    switchLabel.append(toggle, track);

    row.append(idWrap, modeSelect, switchLabel);
    els.storesList.appendChild(row);
  }
}

async function renderLogs(locale) {
  const effectiveLocale = locale || resolveRegionAndCurrency({ settings: await getSettings(), storedRegion: await getRegionState() }).locale;
  const level = els.logLevelFilter.value;
  const all = await logger.getAll();
  const recent = all.slice(-50);
  const filtered = level === 'all' ? recent : recent.filter((e) => e.level === level);
  const newestFirst = filtered.slice().reverse();

  els.logsContainer.replaceChildren();
  if (newestFirst.length === 0) {
    const emptyWrap = document.createElement('div');
    emptyWrap.className = 'state-box';
    const illus = await createIllustration('illus-empty-free');
    if (illus) emptyWrap.appendChild(illus);
    const title = document.createElement('p');
    title.className = 'state-title';
    title.textContent = 'No activity logged yet';
    const desc = document.createElement('p');
    desc.className = 'state-desc';
    desc.textContent = 'Events appear here after your first store check or claim attempt.';
    emptyWrap.append(title, desc);
    els.logsContainer.appendChild(emptyWrap);
    return;
  }

  const timeFmt = new Intl.DateTimeFormat(effectiveLocale || undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  for (const entry of newestFirst) {
    const row = document.createElement('div');
    row.className = 'log-row';

    const ts = document.createElement('span');
    ts.className = 'log-ts tabular';
    const d = new Date(entry.ts);
    ts.textContent = Number.isNaN(d.getTime()) ? entry.ts : timeFmt.format(d);
    ts.title = entry.ts;

    const lvl = document.createElement('span');
    lvl.className = `log-lvl-${entry.level}`;
    lvl.textContent = entry.level.toUpperCase();

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    const metaText = entry.meta ? ` · ${JSON.stringify(entry.meta)}` : '';
    msg.textContent = `[${entry.scope}] ${entry.message}${metaText}`;

    row.append(ts, lvl, msg);
    els.logsContainer.appendChild(row);
  }
}

async function hydrate() {
  const settings = await getSettings();
  const storedRegion = await getRegionState();
  const region = resolveRegionAndCurrency({ settings, storedRegion });
  renderStores(settings);
  renderCurrencyControl(settings, region);

  els.dryRunToggle.checked = Boolean(settings.dryRun);
  els.chromeNotifToggle.checked = settings.notifications?.chrome !== false;

  els.telegramEnabled.checked = Boolean(settings.notifications?.telegram?.enabled);
  els.telegramBotToken.value = settings.notifications?.telegram?.botToken || '';
  els.telegramChatId.value = settings.notifications?.telegram?.chatId || '';

  els.discordEnabled.checked = Boolean(settings.notifications?.discord?.enabled);
  els.discordWebhookUrl.value = settings.notifications?.discord?.webhookUrl || '';

  els.remoteConfigUrl.value = settings.remoteConfigUrl || '';
  await renderLogs(region.locale);
}

function renderCurrencyControl(settings, region) {
  els.currencySelect.replaceChildren();
  els.currencySelect.add(
    new Option(`Auto (${region.countryName} - ${region.detectedCurrency})`, 'auto')
  );
  for (const code of SUPPORTED_CURRENCIES) {
    els.currencySelect.add(new Option(getCurrencyLabel(code, region.browserLocale), code));
  }
  const activeVal =
    settings.currency && String(settings.currency).toLowerCase() !== 'auto'
      ? settings.currency.toUpperCase()
      : 'auto';
  els.currencySelect.value = activeVal;

  if (region.isOverridden) {
    els.detectedRegionText.textContent = `Detected: ${region.countryName}, ${region.detectedCurrency}. Showing ${region.currency}.`;
    els.changeCurrencyBtn.textContent = 'Reset to Auto';
  } else {
    els.detectedRegionText.textContent = `Detected: ${region.countryName}, ${region.detectedCurrency}.`;
    els.changeCurrencyBtn.textContent = 'Change';
  }
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

async function applyCurrencySelection(selectedValue) {
  const currency = selectedValue || 'auto';
  if (currency !== 'auto') {
    await ensureHostPermission(['https://open.er-api.com/*']);
  }
  const nextSettings = await saveSettings({ currency });
  const storedRegion = await getRegionState();
  const region = resolveRegionAndCurrency({ settings: nextSettings, storedRegion });
  renderCurrencyControl(nextSettings, region);
  await getExchangeRates({
    cached: await getCachedFxRates(),
    saveCacheFn: setCachedFxRates
  }).catch(() => null);
  flashStatus('Currency updated');
}

els.currencySelect.addEventListener('change', async () => {
  await applyCurrencySelection(els.currencySelect.value);
});

els.changeCurrencyBtn.addEventListener('click', async () => {
  const isOverridden =
    els.currencySelect.value && String(els.currencySelect.value).toLowerCase() !== 'auto';
  if (isOverridden) {
    els.currencySelect.value = 'auto';
    await applyCurrencySelection('auto');
    return;
  }
  els.currencySelect.focus();
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
  const remoteUrl = els.remoteConfigUrl.value.trim();
  if (remoteUrl.startsWith('https://raw.githubusercontent.com/')) {
    const granted = await ensureHostPermission(['https://raw.githubusercontent.com/*']);
    if (!granted) {
      flashStatus('Remote config host permission declined', true);
      return;
    }
  }
  await saveSettings({ remoteConfigUrl: remoteUrl });
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
  if (!clearArmed) {
    clearArmed = true;
    els.clearHistoryBtn.textContent = 'Click again to confirm';
    clearTimeout(clearConfirmTimer);
    clearConfirmTimer = setTimeout(() => {
      clearArmed = false;
      els.clearHistoryBtn.textContent = 'Clear history';
    }, 4000);
    return;
  }
  clearTimeout(clearConfirmTimer);
  clearArmed = false;
  els.clearHistoryBtn.textContent = 'Clear history';
  if (await sendBgMessage({ type: 'CLAIMIT_CLEAR_HISTORY' })) {
    flashStatus('History cleared');
  }
});

els.logLevelFilter.addEventListener('change', () => renderLogs());
els.refreshLogsBtn.addEventListener('click', () => renderLogs());

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

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEYS.REGION] || changes[STORAGE_KEYS.SETTINGS]) {
    Promise.all([getSettings(), getRegionState()]).then(([settings, storedRegion]) => {
      const region = resolveRegionAndCurrency({ settings, storedRegion });
      renderCurrencyControl(settings, region);
    });
  }
});

hydrate();
