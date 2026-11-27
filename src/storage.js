/**
 * Persistent storage layer built on chrome.storage.local.
 * Stores settings, claim history, current cycle offer snapshot, notification dedup state,
 * region resolution state, 24h FX rate cache, and cached remote config.
 * Never stores store credentials or passwords.
 */

import {
  DEFAULT_FALLBACK_CURRENCY,
  convertAmount,
  normalizeCountryCode,
  normalizeCurrencyCode
} from './currency.js';

export const STORAGE_KEYS = {
  SETTINGS: 'claimit_settings',
  HISTORY: 'claimit_history',
  CURRENT_OFFERS: 'claimit_current_offers',
  META: 'claimit_meta',
  CYCLE_LOCK: 'claimit_cycle_lock',
  REMOTE_CONFIG_CACHE: 'claimit_remote_config_cache',
  NOTIFICATION_STATE: 'claimit_notification_state',
  REGION: 'claimit_region',
  FX_RATES: 'claimit_fx_rates',
  ACCOUNTS: 'claimit_accounts',
  PENDING_SIGNIN: 'claimit_pending_signin',
  STEAM_DEALS: 'claimit_steam_deals',
  STEAM_DEALS_META: 'claimit_steam_deals_meta',
  STEAM_FREE_GAMES: 'claimit_steam_free_games',
  STEAM_FREE_META: 'claimit_steam_free_meta'
};

export const MIN_STEAM_DISCOUNT_LIMIT = 40;
export const MAX_STEAM_DISCOUNT_LIMIT = 100;
export const DEFAULT_STEAM_MIN_DISCOUNT = 75;
export const STEAM_DEALS_SORT_OPTIONS = ['popular', 'reviews', 'discount', 'price'];
export const DEFAULT_STEAM_DEALS_SORT = 'popular';
export const STEAM_FREE_SORT_OPTIONS = ['popular', 'reviews', 'rating'];
export const DEFAULT_STEAM_FREE_SORT = 'popular';
const MAX_STEAM_DEALS = 200;
const MAX_STEAM_FREE_GAMES = 200;

export function clampSteamMinDiscount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_STEAM_MIN_DISCOUNT;
  return Math.min(MAX_STEAM_DISCOUNT_LIMIT, Math.max(MIN_STEAM_DISCOUNT_LIMIT, Math.round(num)));
}

export function normalizeSteamDealsSort(value) {
  return STEAM_DEALS_SORT_OPTIONS.includes(value) ? value : DEFAULT_STEAM_DEALS_SORT;
}

export function normalizeSteamFreeSort(value) {
  return STEAM_FREE_SORT_OPTIONS.includes(value) ? value : DEFAULT_STEAM_FREE_SORT;
}

const CYCLE_LOCK_TTL_MS = 5 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 500;

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);
}

const DEFAULT_SETTINGS = {
  paused: false,
  dryRun: false,
  currency: 'auto',
  steamMinDiscount: DEFAULT_STEAM_MIN_DISCOUNT,
  steamDealsSort: DEFAULT_STEAM_DEALS_SORT,
  steamFreeSort: DEFAULT_STEAM_FREE_SORT,
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
    paused: Boolean(raw.paused ?? DEFAULT_SETTINGS.paused),
    dryRun: Boolean(raw.dryRun ?? DEFAULT_SETTINGS.dryRun),
    currency: typeof raw.currency === 'string' ? raw.currency : DEFAULT_SETTINGS.currency,
    steamMinDiscount:
      raw.steamMinDiscount === undefined
        ? DEFAULT_SETTINGS.steamMinDiscount
        : clampSteamMinDiscount(raw.steamMinDiscount),
    steamDealsSort:
      raw.steamDealsSort === undefined
        ? DEFAULT_SETTINGS.steamDealsSort
        : normalizeSteamDealsSort(raw.steamDealsSort),
    steamFreeSort:
      raw.steamFreeSort === undefined
        ? DEFAULT_SETTINGS.steamFreeSort
        : normalizeSteamFreeSort(raw.steamFreeSort),
    remoteConfigUrl: typeof raw.remoteConfigUrl === 'string' ? raw.remoteConfigUrl : DEFAULT_SETTINGS.remoteConfigUrl,
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
 * Pure migration helper for legacy history entries saved before currency tracking.
 * Preserves existing ISO codes and marks entries with no currency code cleanly as unknown
 * without guessing or crashing.
 * @param {Record<string, object>} historyMap
 * @returns {{ history: Record<string, object>, changed: boolean }}
 */
export function migrateHistoryEntries(historyMap) {
  if (!historyMap || typeof historyMap !== 'object') {
    return { history: {}, changed: false };
  }
  const next = {};
  let changed = false;

  for (const [key, item] of Object.entries(historyMap)) {
    if (!item || typeof item !== 'object') continue;
    const resolvedCode = normalizeCurrencyCode(item.currencyCode ?? item.currency);

    if (resolvedCode) {
      const needsSync =
        item.currencyCode !== resolvedCode ||
        item.currency !== resolvedCode ||
        item.priceSource === undefined ||
        item.unknownCurrency === true;
      if (needsSync) {
        changed = true;
        next[key] = {
          ...item,
          currencyCode: resolvedCode,
          currency: resolvedCode,
          priceSource: item.priceSource || 'store',
          unknownCurrency: false
        };
      } else {
        next[key] = item;
      }
    } else {
      const needsLegacyMark =
        item.unknownCurrency !== true ||
        item.currencyCode !== null ||
        item.currency !== null ||
        item.priceSource !== 'legacy';
      if (needsLegacyMark) {
        changed = true;
        next[key] = {
          ...item,
          currencyCode: null,
          currency: null,
          unknownCurrency: true,
          priceSource: item.priceSource || 'legacy'
        };
      } else {
        next[key] = item;
      }
    }
  }

  return { history: next, changed };
}

/**
 * Pure helper to calculate total saved value across newly claimed items.
 * Never mixes currencies: stores per-currency totals cleanly and converts into
 * `displayCurrency` when provided (keeping unconvertible currencies separated).
 * Skips dry-run entries, pre-owned library games, missing/zero prices, and unknown-currency legacy rows.
 *
 * @param {Record<string, object>} historyMap
 * @param {string|null} [displayCurrency=null]
 * @param {Record<string, number>|null} [fxRates=null]
 */
export function computeValueSaved(historyMap, displayCurrency = null, fxRates = null) {
  const items = Object.values(historyMap || {});
  const totalsByCurrency = {};
  let count = 0;
  let valuedCount = 0;
  let unknownCurrencyCount = 0;

  for (const item of items) {
    if (!item || item.status !== 'CLAIMED' || item.dryRun === true || item.alreadyOwned === true) {
      continue;
    }
    count += 1;
    const price = Number(item.originalPriceValue ?? item.originalPrice ?? 0);
    if (!Number.isFinite(price) || price <= 0) {
      continue;
    }
    const cur = normalizeCurrencyCode(item.currencyCode ?? item.currency);
    if (!cur || item.unknownCurrency === true) {
      unknownCurrencyCount += 1;
      continue;
    }
    valuedCount += 1;
    totalsByCurrency[cur] = Math.round(((totalsByCurrency[cur] || 0) + price) * 1000) / 1000;
  }

  const targetCurrency = normalizeCurrencyCode(displayCurrency);
  if (targetCurrency) {
    let totalMajor = 0;
    let hasConverted = false;
    const sourceCurrencies = [];
    const unconvertedTotals = {};

    for (const [cur, amt] of Object.entries(totalsByCurrency)) {
      if (cur === targetCurrency) {
        totalMajor += amt;
        continue;
      }
      const converted = convertAmount(amt, cur, targetCurrency, fxRates);
      if (converted) {
        totalMajor += converted.amount;
        hasConverted = true;
        sourceCurrencies.push(cur);
      } else {
        unconvertedTotals[cur] = amt;
      }
    }

    return {
      totalMajor: Math.round(totalMajor * 1000) / 1000,
      count,
      valuedCount,
      unknownCurrencyCount,
      currency: targetCurrency,
      totalsByCurrency,
      unconvertedTotals,
      hasConverted,
      sourceCurrencies
    };
  }

  const currencies = Object.keys(totalsByCurrency);
  const currency = currencies.includes(DEFAULT_FALLBACK_CURRENCY)
    ? DEFAULT_FALLBACK_CURRENCY
    : (currencies[0] || DEFAULT_FALLBACK_CURRENCY);
  const totalMajor = totalsByCurrency[currency] || 0;

  return {
    totalMajor,
    count,
    valuedCount,
    unknownCurrencyCount,
    currency,
    totalsByCurrency,
    unconvertedTotals: {},
    hasConverted: false,
    sourceCurrencies: []
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
  const data = await chrome.storage.local.get([STORAGE_KEYS.HISTORY, STORAGE_KEYS.META]);
  const rawHistory = data[STORAGE_KEYS.HISTORY] && typeof data[STORAGE_KEYS.HISTORY] === 'object'
    ? data[STORAGE_KEYS.HISTORY]
    : {};
  const meta = data[STORAGE_KEYS.META] && typeof data[STORAGE_KEYS.META] === 'object'
    ? data[STORAGE_KEYS.META]
    : {};

  if (!meta.historyCurrencyMigrated && Object.keys(rawHistory).length > 0) {
    const { history, changed } = migrateHistoryEntries(rawHistory);
    if (changed) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.HISTORY]: history,
        [STORAGE_KEYS.META]: { ...meta, historyCurrencyMigrated: true }
      });
      return history;
    }
    await chrome.storage.local.set({
      [STORAGE_KEYS.META]: { ...meta, historyCurrencyMigrated: true }
    });
  }
  return rawHistory;
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

  const keys = Object.keys(history);
  if (keys.length > MAX_HISTORY_ENTRIES) {
    const trimmed = Object.fromEntries(
      Object.entries(history)
        .sort(([, a], [, b]) => Date.parse(b.updatedAt || b.claimedAt || 0) - Date.parse(a.updatedAt || a.claimedAt || 0))
        .slice(0, MAX_HISTORY_ENTRIES)
    );
    if (hasChromeStorage()) {
      await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: trimmed });
    }
    return trimmed[key];
  }

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

const DEFAULT_META = {
  lastScanAt: null,
  lastCheckedAt: null,
  nextScanAt: null,
  lastManualCheckAt: null,
  lastCycleId: null,
  isChecking: false
};

export async function getMeta() {
  if (!hasChromeStorage()) {
    return { ...DEFAULT_META };
  }
  const data = await chrome.storage.local.get(STORAGE_KEYS.META);
  return data[STORAGE_KEYS.META] && typeof data[STORAGE_KEYS.META] === 'object'
    ? { ...DEFAULT_META, ...data[STORAGE_KEYS.META] }
    : { ...DEFAULT_META };
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

export async function getRegionState() {
  if (!hasChromeStorage()) return { storeCountry: null, storeCurrency: null, updatedAt: null };
  const data = await chrome.storage.local.get(STORAGE_KEYS.REGION);
  const raw = data[STORAGE_KEYS.REGION];
  return raw && typeof raw === 'object'
    ? {
        storeCountry: normalizeCountryCode(raw.storeCountry),
        storeCurrency: normalizeCurrencyCode(raw.storeCurrency),
        updatedAt: raw.updatedAt || null
      }
    : { storeCountry: null, storeCurrency: null, updatedAt: null };
}

export async function saveRegionState(partial = {}) {
  const current = await getRegionState();
  const next = {
    storeCountry:
      partial.storeCountry !== undefined
        ? normalizeCountryCode(partial.storeCountry)
        : current.storeCountry,
    storeCurrency:
      partial.storeCurrency !== undefined
        ? normalizeCurrencyCode(partial.storeCurrency)
        : current.storeCurrency,
    updatedAt: new Date().toISOString()
  };
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEYS.REGION]: next });
  }
  return next;
}

export async function getCachedFxRates() {
  if (!hasChromeStorage()) return null;
  const data = await chrome.storage.local.get(STORAGE_KEYS.FX_RATES);
  const raw = data[STORAGE_KEYS.FX_RATES];
  return raw && typeof raw === 'object' && raw.rates ? raw : null;
}

export async function setCachedFxRates(payload) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.FX_RATES]: payload });
}

const DEFAULT_ACCOUNTS = {
  epic: { signedIn: null, accountName: null, checkedAt: null },
  steam: { signedIn: null, accountName: null, checkedAt: null }
};

export async function getAccountStates() {
  if (!hasChromeStorage()) {
    return {
      epic: { ...DEFAULT_ACCOUNTS.epic },
      steam: { ...DEFAULT_ACCOUNTS.steam }
    };
  }
  const data = await chrome.storage.local.get(STORAGE_KEYS.ACCOUNTS);
  const raw = data[STORAGE_KEYS.ACCOUNTS] && typeof data[STORAGE_KEYS.ACCOUNTS] === 'object'
    ? data[STORAGE_KEYS.ACCOUNTS]
    : {};
  return {
    epic: { ...DEFAULT_ACCOUNTS.epic, ...(raw.epic || {}) },
    steam: { ...DEFAULT_ACCOUNTS.steam, ...(raw.steam || {}) }
  };
}

export async function saveAccountState(storeId, partial = {}) {
  if (storeId !== 'epic' && storeId !== 'steam') return null;
  const current = await getAccountStates();
  const next = {
    ...current,
    [storeId]: {
      ...current[storeId],
      signedIn:
        partial.signedIn === undefined ? current[storeId].signedIn : (partial.signedIn === null ? null : Boolean(partial.signedIn)),
      accountName:
        partial.accountName === undefined ? current[storeId].accountName : (partial.accountName ? String(partial.accountName).slice(0, 64) : null),
      checkedAt: new Date().toISOString()
    }
  };
  if (hasChromeStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNTS]: next });
  }
  return next;
}

export async function getPendingSignIn() {
  if (!hasChromeStorage()) return null;
  const data = await chrome.storage.local.get(STORAGE_KEYS.PENDING_SIGNIN);
  const raw = data[STORAGE_KEYS.PENDING_SIGNIN];
  return raw && typeof raw === 'object' && typeof raw.tabId === 'number' ? raw : null;
}

export async function setPendingSignIn(info) {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.PENDING_SIGNIN]: info });
}

export async function clearPendingSignIn() {
  if (!hasChromeStorage()) return;
  await chrome.storage.local.remove(STORAGE_KEYS.PENDING_SIGNIN);
}

export async function getSteamDeals() {
  if (!hasChromeStorage()) return [];
  const data = await chrome.storage.local.get(STORAGE_KEYS.STEAM_DEALS);
  return Array.isArray(data[STORAGE_KEYS.STEAM_DEALS]) ? data[STORAGE_KEYS.STEAM_DEALS] : [];
}

const DEFAULT_STEAM_BATCH_META = {
  startOffset: 0,
  endOffset: 0,
  nextOffset: 0,
  totalCount: null,
  minDiscount: null
};

function normalizeBatchMeta(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STEAM_BATCH_META };
  return {
    startOffset: Math.max(0, Number(raw.startOffset) || 0),
    endOffset: Math.max(0, Number(raw.endOffset) || 0),
    nextOffset: Math.max(0, Number(raw.nextOffset) || 0),
    totalCount: Number.isFinite(raw.totalCount) ? raw.totalCount : null,
    minDiscount: Number.isFinite(raw.minDiscount) ? raw.minDiscount : null
  };
}

export async function getSteamDealsMeta() {
  if (!hasChromeStorage()) return { ...DEFAULT_STEAM_BATCH_META };
  const data = await chrome.storage.local.get(STORAGE_KEYS.STEAM_DEALS_META);
  return normalizeBatchMeta(data[STORAGE_KEYS.STEAM_DEALS_META]);
}

export async function setSteamDeals(deals, meta = null) {
  if (!hasChromeStorage()) return;
  const clean = Array.isArray(deals) ? deals.slice(0, MAX_STEAM_DEALS) : [];
  const payload = { [STORAGE_KEYS.STEAM_DEALS]: clean };
  if (meta && typeof meta === 'object') {
    payload[STORAGE_KEYS.STEAM_DEALS_META] = normalizeBatchMeta(meta);
  }
  await chrome.storage.local.set(payload);
}

export async function getSteamFreeGames() {
  if (!hasChromeStorage()) return [];
  const data = await chrome.storage.local.get(STORAGE_KEYS.STEAM_FREE_GAMES);
  return Array.isArray(data[STORAGE_KEYS.STEAM_FREE_GAMES]) ? data[STORAGE_KEYS.STEAM_FREE_GAMES] : [];
}

export async function getSteamFreeMeta() {
  if (!hasChromeStorage()) return { ...DEFAULT_STEAM_BATCH_META };
  const data = await chrome.storage.local.get(STORAGE_KEYS.STEAM_FREE_META);
  return normalizeBatchMeta(data[STORAGE_KEYS.STEAM_FREE_META]);
}

export async function setSteamFreeGames(games, meta = null) {
  if (!hasChromeStorage()) return;
  const clean = Array.isArray(games) ? games.slice(0, MAX_STEAM_FREE_GAMES) : [];
  const payload = { [STORAGE_KEYS.STEAM_FREE_GAMES]: clean };
  if (meta && typeof meta === 'object') {
    payload[STORAGE_KEYS.STEAM_FREE_META] = normalizeBatchMeta(meta);
  }
  await chrome.storage.local.set(payload);
}
