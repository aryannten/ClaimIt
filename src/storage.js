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
  CYCLE_LOCK: 'claimit_cycle_lock',
  REMOTE_CONFIG_CACHE: 'claimit_remote_config_cache',
  NOTIFICATION_STATE: 'claimit_notification_state'
};

export const CYCLE_LOCK_TTL_MS = 5 * 60 * 1000;

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);
}

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
 * Pure helper to calculate total saved value across newly claimed items.
 * Skips dry-run entries and pre-owned library games (`alreadyOwned: true`).
 * @param {Record<string, object>} historyMap
 * @returns {{ totalMajor: number, count: number, currency: string, totalsByCurrency: Record<string, number> }}
 */
export function computeValueSaved(historyMap) {
  const items = Object.values(historyMap || {});
  const totalsByCurrency = {};
  let count = 0;

  for (const item of items) {
    if (!item || item.status !== 'CLAIMED' || item.dryRun === true || item.alreadyOwned === true) {
      continue;
    }
    count += 1;
    const cur = item.currency || 'USD';
    const price = Number(item.originalPriceValue ?? item.originalPrice ?? 0);
    if (Number.isFinite(price) && price > 0) {
      totalsByCurrency[cur] = Math.round(((totalsByCurrency[cur] || 0) + price) * 100) / 100;
    }
  }

  const currencies = Object.keys(totalsByCurrency);
  const currency = currencies.includes('USD') ? 'USD' : (currencies[0] || 'USD');
  const totalMajor = totalsByCurrency[currency] || 0;

  return {
    totalMajor,
    count,
    currency,
    totalsByCurrency
  };
}

export async function getSettings() {
  if (!hasChromeStorage()) return mergeSettings();
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
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  }
  return next;
}

export async function getHistory() {
  if (!hasChromeStorage()) return {};
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
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: history });
  }
  return history[key];
}

export async function clearHistory() {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({
    [STORAGE_KEYS.HISTORY]: {},
    [STORAGE_KEYS.CURRENT_OFFERS]: [],
    [STORAGE_KEYS.NOTIFICATION_STATE]: {}
  });
}

export async function getCurrentOffers() {
  if (!hasChromeStorage()) return [];
  const data = await chrome.storage.local.get(STORAGE_KEYS.CURRENT_OFFERS);
  return Array.isArray(data[STORAGE_KEYS.CURRENT_OFFERS]) ? data[STORAGE_KEYS.CURRENT_OFFERS] : [];
}

export async function setCurrentOffers(offers) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_OFFERS]: offers });
}

export async function getMeta() {
  if (!hasChromeStorage()) {
    return { lastCheckedAt: null, lastCycleId: null, isChecking: false };
  }
  const data = await chrome.storage.local.get(STORAGE_KEYS.META);
  return data[STORAGE_KEYS.META] && typeof data[STORAGE_KEYS.META] === 'object'
    ? data[STORAGE_KEYS.META]
    : { lastCheckedAt: null, lastCycleId: null, isChecking: false };
}

export async function updateMeta(partial) {
  const current = await getMeta();
  const next = { ...current, ...partial };
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEYS.META]: next });
  }
  return next;
}

/**
 * Acquire a persistent cycle lock in chrome.storage.local so overlapping alarms
 * across service worker restarts never double-claim. Expires stale locks after TTL.
 * @param {string} ownerId
 * @param {number} [nowMs=Date.now()]
 * @param {number} [ttlMs=CYCLE_LOCK_TTL_MS]
 * @returns {Promise<boolean>}
 */
export async function acquireCycleLock(ownerId, nowMs = Date.now(), ttlMs = CYCLE_LOCK_TTL_MS) {
  if (!hasChromeStorage()) return true;
  const data = await chrome.storage.local.get(STORAGE_KEYS.CYCLE_LOCK);
  const existing = data[STORAGE_KEYS.CYCLE_LOCK];
  if (
    existing &&
    existing.ownerId &&
    existing.ownerId !== ownerId &&
    Number.isFinite(existing.acquiredAtMs) &&
    nowMs - existing.acquiredAtMs < ttlMs
  ) {
    return false;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.CYCLE_LOCK]: { ownerId, acquiredAtMs: nowMs }
  });
  return true;
}

export async function releaseCycleLock(ownerId) {
  if (!hasChromeStorage()) return;
  const data = await chrome.storage.local.get(STORAGE_KEYS.CYCLE_LOCK);
  const existing = data[STORAGE_KEYS.CYCLE_LOCK];
  if (!existing || !ownerId || existing.ownerId === ownerId) {
    await chrome.storage.local.remove(STORAGE_KEYS.CYCLE_LOCK);
  }
}

export async function getNotificationState() {
  if (!hasChromeStorage()) return {};
  const data = await chrome.storage.local.get(STORAGE_KEYS.NOTIFICATION_STATE);
  return data[STORAGE_KEYS.NOTIFICATION_STATE] && typeof data[STORAGE_KEYS.NOTIFICATION_STATE] === 'object'
    ? data[STORAGE_KEYS.NOTIFICATION_STATE]
    : {};
}

export async function setNotificationState(state) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.NOTIFICATION_STATE]: state });
}

export async function getCachedRemoteConfig() {
  if (!hasChromeStorage()) return null;
  const data = await chrome.storage.local.get(STORAGE_KEYS.REMOTE_CONFIG_CACHE);
  return data[STORAGE_KEYS.REMOTE_CONFIG_CACHE] || null;
}

export async function setCachedRemoteConfig(payload) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.REMOTE_CONFIG_CACHE]: payload });
}
