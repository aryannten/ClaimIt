/**
 * Persistent storage layer built on chrome.storage.local.
 * Stores settings, claim history, current cycle offer snapshot, notification dedup state,
 * and cached remote config. Never stores store credentials or passwords.
 */

export const STORAGE_KEYS = {
  SETTINGS: 'claimit_settings',
  HISTORY: 'claimit_history',
  CURRENT_OFFERS: 'claimit_current_offers',
  META: 'claimit_meta',
  REMOTE_CONFIG_CACHE: 'claimit_remote_config_cache',
  NOTIFICATION_STATE: 'claimit_notification_state'
};

export const DEFAULT_SETTINGS = {
  paused: false,
  dryRun: false,
  checkIntervalHours: 6,
  thursdayFridayHourlyBoost: true,
  remoteConfigUrl: '',
  stores: {
    epic: { enabled: true, mode: 'auto' },
    steam: { enabled: true, mode: 'auto' },
    gog: { enabled: false, mode: 'notify' },
    prime: { enabled: false, mode: 'notify' },
    fab: { enabled: false, mode: 'notify' },
    itch: { enabled: false, mode: 'notify' }
  },
  notifications: {
    chrome: true,
    telegram: {
      enabled: false,
      botToken: '',
      chatId: ''
    },
    discord: {
      enabled: false,
      webhookUrl: ''
    }
  }
};

function mergeSettings(raw = {}) {
  const mergedStores = {};
  for (const [id, def] of Object.entries(DEFAULT_SETTINGS.stores)) {
    mergedStores[id] = {
      ...def,
      ...(raw.stores?.[id] || {})
    };
  }
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    stores: mergedStores,
    notifications: {
      chrome: raw.notifications?.chrome ?? DEFAULT_SETTINGS.notifications.chrome,
      telegram: {
        ...DEFAULT_SETTINGS.notifications.telegram,
        ...(raw.notifications?.telegram || {})
      },
      discord: {
        ...DEFAULT_SETTINGS.notifications.discord,
        ...(raw.notifications?.discord || {})
      }
    }
  };
}

/**
 * Deterministic key for an offer in history/dedup maps.
 * @param {string} store
 * @param {string} id
 * @returns {string}
 */
export function makeOfferKey(store, id) {
  return `${store}:${id}`;
}

/**
 * Pure helper to calculate total saved value across claimed items.
 * @param {Record<string, object>} historyMap
 * @returns {{ totalMajor: number, count: number, currency: string }}
 */
export function computeValueSaved(historyMap) {
  const items = Object.values(historyMap || {});
  let totalMajor = 0;
  let count = 0;
  let currency = 'USD';

  for (const item of items) {
    if (!item || item.status !== 'CLAIMED' || item.dryRun === true) continue;
    count += 1;
    if (item.currency) currency = item.currency;
    const price = Number(item.originalPriceValue ?? item.originalPrice ?? 0);
    if (Number.isFinite(price) && price > 0) {
      totalMajor += price;
    }
  }

  return {
    totalMajor: Math.round(totalMajor * 100) / 100,
    count,
    currency
  };
}

export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return mergeSettings(data[STORAGE_KEYS.SETTINGS]);
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = mergeSettings({
    ...current,
    ...partial,
    stores: {
      ...current.stores,
      ...(partial?.stores || {})
    },
    notifications: {
      ...current.notifications,
      ...(partial?.notifications || {}),
      telegram: {
        ...current.notifications.telegram,
        ...(partial?.notifications?.telegram || {})
      },
      discord: {
        ...current.notifications.discord,
        ...(partial?.notifications?.discord || {})
      }
    }
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

export async function getHistory() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  return data[STORAGE_KEYS.HISTORY] && typeof data[STORAGE_KEYS.HISTORY] === 'object'
    ? data[STORAGE_KEYS.HISTORY]
    : {};
}

export async function upsertHistoryEntry(entry) {
  const history = await getHistory();
  const key = makeOfferKey(entry.store, entry.id);
  const existing = history[key] || {};
  const now = new Date().toISOString();
  history[key] = {
    ...existing,
    ...entry,
    key,
    updatedAt: now,
    claimedAt: entry.status === 'CLAIMED' ? (existing.claimedAt || now) : existing.claimedAt || null
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: history });
  return history[key];
}

export async function clearHistory() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.HISTORY]: {},
    [STORAGE_KEYS.CURRENT_OFFERS]: [],
    [STORAGE_KEYS.NOTIFICATION_STATE]: {}
  });
}

export async function getCurrentOffers() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_OFFERS);
  return Array.isArray(data[STORAGE_KEYS.CURRENT_OFFERS]) ? data[STORAGE_KEYS.CURRENT_OFFERS] : [];
}

export async function setCurrentOffers(offers) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_OFFERS]: offers });
}

export async function getMeta() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.META);
  return data[STORAGE_KEYS.META] && typeof data[STORAGE_KEYS.META] === 'object'
    ? data[STORAGE_KEYS.META]
    : { lastCheckedAt: null, lastCycleId: null, isChecking: false };
}

export async function updateMeta(partial) {
  const current = await getMeta();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEYS.META]: next });
  return next;
}

export async function getNotificationState() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.NOTIFICATION_STATE);
  return data[STORAGE_KEYS.NOTIFICATION_STATE] && typeof data[STORAGE_KEYS.NOTIFICATION_STATE] === 'object'
    ? data[STORAGE_KEYS.NOTIFICATION_STATE]
    : {};
}

export async function setNotificationState(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.NOTIFICATION_STATE]: state });
}

export async function getCachedRemoteConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.REMOTE_CONFIG_CACHE);
  return data[STORAGE_KEYS.REMOTE_CONFIG_CACHE] || null;
}

export async function setCachedRemoteConfig(payload) {
  await chrome.storage.local.set({ [STORAGE_KEYS.REMOTE_CONFIG_CACHE]: payload });
}
