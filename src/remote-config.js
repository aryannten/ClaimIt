/**
 * Remote selector & endpoint configuration loader with strict schema validation,
 * chrome.storage.local caching, size cap, and safe fallback to config/selectors.json.
 */

import { getCachedRemoteConfig, setCachedRemoteConfig, getSettings } from './storage.js';
import { logger } from './logger.js';
import { isAllowedStoreEndpointUrl } from './url-validator.js';

const MAX_REMOTE_CONFIG_BYTES = 524_288; // 512 KB
const ALLOWED_ROOT_KEYS = new Set(['version', 'updatedAt', 'stores']);
const ALLOWED_STORE_IDS = new Set(['epic', 'steam']);
const ALLOWED_STORE_SECTIONS = new Set(['endpoints', 'selectors', 'texts']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const ALLOWED_STORE_KEYS = {
  epic: {
    endpoints: new Set(['promotions', 'storeBase', 'bundleBase', 'freeGamesPage']),
    selectors: new Set([
      'getButton',
      'placeOrderButton',
      'euAgreeButton',
      'eulaCheckbox',
      'checkoutContainer',
      'checkoutIframe',
      'captchaContainer',
      'ownedIndicator',
      'regionUnavailableIndicator',
      'loginIndicator'
    ]),
    texts: new Set([
      'getButton',
      'placeOrderButton',
      'euAgreeButton',
      'owned',
      'unavailable',
      'loginRequired',
      'orderConfirmed'
    ])
  },
  steam: {
    endpoints: new Set(['searchResults', 'dealsSearch', 'freeGamesSearch', 'userdata', 'appBase', 'steamdbFree']),
    selectors: new Set([
      'purchaseContainer',
      'addToAccountButton',
      'ownedIndicator',
      'ageGateForm',
      'ageGateYear',
      'ageGateContinue',
      'loginIndicator',
      'accountIndicator',
      'regionError'
    ]),
    texts: new Set([
      'addToAccount',
      'alreadyOwned',
      'loginRequired',
      'ageGate',
      'freeWeekendOrTrial',
      'unavailable',
      'claimedSuccess'
    ])
  }
};

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0 && val.length <= 512;
}

function isStringArray(val) {
  return Array.isArray(val) && val.length > 0 && val.length <= 32 && val.every((item) => isNonEmptyString(item));
}

function isPlainRecord(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function checkAllowedKeys(obj, allowedSet, pathLabel, errors) {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key) || !allowedSet.has(key)) {
      errors.push(`Unexpected key at ${pathLabel}.${key}`);
    }
  }
}

/**
 * Validate remote selectors.json schema strictly:
 * rejects wrong types, unknown keys, oversized lists, and non-store endpoint URLs.
 * @param {unknown} candidate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSelectorsConfig(candidate) {
  const errors = [];
  if (!isPlainRecord(candidate)) {
    return { valid: false, errors: ['Root config must be a JSON object'] };
  }
  checkAllowedKeys(candidate, ALLOWED_ROOT_KEYS, 'root', errors);

  if (typeof candidate.version !== 'number' || !Number.isFinite(candidate.version) || candidate.version < 1) {
    errors.push('version must be a positive number');
  }
  if (candidate.updatedAt !== undefined && typeof candidate.updatedAt !== 'string') {
    errors.push('updatedAt must be a string when present');
  }
  if (!isPlainRecord(candidate.stores)) {
    errors.push('stores must be an object');
    return { valid: false, errors };
  }
  checkAllowedKeys(candidate.stores, ALLOWED_STORE_IDS, 'stores', errors);

  for (const storeId of ALLOWED_STORE_IDS) {
    const store = candidate.stores[storeId];
    if (!isPlainRecord(store)) {
      errors.push(`stores.${storeId} must be an object`);
      continue;
    }
    checkAllowedKeys(store, ALLOWED_STORE_SECTIONS, `stores.${storeId}`, errors);

    const schema = ALLOWED_STORE_KEYS[storeId];

    if (!isPlainRecord(store.endpoints) || Object.keys(store.endpoints).length === 0) {
      errors.push(`stores.${storeId}.endpoints must be a non-empty object`);
    } else {
      checkAllowedKeys(store.endpoints, schema.endpoints, `stores.${storeId}.endpoints`, errors);
      for (const [k, url] of Object.entries(store.endpoints)) {
        if (!isNonEmptyString(url) || !url.startsWith('https://')) {
          errors.push(`stores.${storeId}.endpoints.${k} must be an https:// URL`);
        } else if (!isAllowedStoreEndpointUrl(storeId, url)) {
          errors.push(`stores.${storeId}.endpoints.${k} points to a disallowed host`);
        }
      }
    }

    if (!isPlainRecord(store.selectors) || Object.keys(store.selectors).length === 0) {
      errors.push(`stores.${storeId}.selectors must be a non-empty object`);
    } else {
      checkAllowedKeys(store.selectors, schema.selectors, `stores.${storeId}.selectors`, errors);
      for (const [k, arr] of Object.entries(store.selectors)) {
        if (!isStringArray(arr)) {
          errors.push(`stores.${storeId}.selectors.${k} must be a non-empty array of non-empty strings`);
        }
      }
    }

    if (!isPlainRecord(store.texts) || Object.keys(store.texts).length === 0) {
      errors.push(`stores.${storeId}.texts must be a non-empty object`);
    } else {
      checkAllowedKeys(store.texts, schema.texts, `stores.${storeId}.texts`, errors);
      for (const [k, arr] of Object.entries(store.texts)) {
        if (!isStringArray(arr)) {
          errors.push(`stores.${storeId}.texts.${k} must be a non-empty array of non-empty strings`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function pickWhitelistedSection(baseSection, remoteSection, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (remoteSection && Object.hasOwn(remoteSection, key)) {
      result[key] = Array.isArray(remoteSection[key]) ? remoteSection[key].slice() : remoteSection[key];
    } else if (baseSection && Object.hasOwn(baseSection, key)) {
      result[key] = Array.isArray(baseSection[key]) ? baseSection[key].slice() : baseSection[key];
    }
  }
  return result;
}

/**
 * Merge a validated remote config over the bundled config using explicit key allowlists
 * so unknown keys or prototype properties can never be copied.
 * @param {object} bundled
 * @param {object} remote
 * @returns {object}
 */
export function mergeConfigs(bundled, remote) {
  const merged = {
    version: typeof remote?.version === 'number' ? remote.version : bundled.version,
    updatedAt: typeof remote?.updatedAt === 'string' ? remote.updatedAt : bundled.updatedAt,
    stores: {}
  };
  for (const storeId of ALLOWED_STORE_IDS) {
    const b = bundled?.stores?.[storeId] || {};
    const r = remote?.stores?.[storeId] || {};
    const schema = ALLOWED_STORE_KEYS[storeId];
    merged.stores[storeId] = {
      endpoints: pickWhitelistedSection(b.endpoints, r.endpoints, schema.endpoints),
      selectors: pickWhitelistedSection(b.selectors, r.selectors, schema.selectors),
      texts: pickWhitelistedSection(b.texts, r.texts, schema.texts)
    };
  }
  return merged;
}

/**
 * Load the bundled config/selectors.json shipped with the extension.
 * @returns {Promise<object>}
 */
async function loadBundledConfig() {
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('config/selectors.json')
    : new URL('../config/selectors.json', import.meta.url).href;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load bundled selectors.json (${response.status})`);
  }
  return response.json();
}

function isDisallowedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    host === '0.0.0.0'
  ) {
    return true;
  }
  // Block RFC1918, loopback, and link-local IPv4 ranges
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * Validate whether a remote config URL is safe to fetch (HTTPS only, no credentials, no local/LAN IPs).
 * @param {string} url
 * @returns {boolean}
 */
export function isValidRemoteConfigUrl(url) {
  if (!isNonEmptyString(url)) return false;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return false;
    }
    return !isDisallowedHostname(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Load bundled selectors config first, then attempt to fetch & validate remote JSON
 * if configured. Caches valid remote configs and falls back to cached/bundled on error.
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<{ config: object, source: 'remote'|'cache'|'bundled', error: string|null }>}
 */
export async function getSelectorsConfig(options = {}) {
  const bundled = await loadBundledConfig();
  const settings = await getSettings();
  const remoteUrl = (settings.remoteConfigUrl || '').trim();

  if (!remoteUrl) {
    return { config: bundled, source: 'bundled', error: null };
  }

  if (!isValidRemoteConfigUrl(remoteUrl)) {
    const err = 'Invalid remote config URL (must use https:// public host without credentials)';
    await logger.warn('remote-config', err, { remoteUrl });
    return { config: bundled, source: 'bundled', error: err };
  }

  const cached = await getCachedRemoteConfig();
  const cacheFresh =
    !options.forceRefresh &&
    cached?.url === remoteUrl &&
    cached?.fetchedAt &&
    Date.now() - Date.parse(cached.fetchedAt) < 60 * 60 * 1000 &&
    cached?.data;

  if (cacheFresh) {
    const validation = validateSelectorsConfig(cached.data);
    if (validation.valid) {
      return { config: mergeConfigs(bundled, cached.data), source: 'cache', error: null };
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(remoteUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const contentLen = Number(resp.headers?.get?.('content-length') || 0);
    if (Number.isFinite(contentLen) && contentLen > MAX_REMOTE_CONFIG_BYTES) {
      throw new Error('Remote config response exceeds 512 KB size limit');
    }
    const rawText = await resp.text();
    if (rawText.length > MAX_REMOTE_CONFIG_BYTES) {
      throw new Error('Remote config response exceeds 512 KB size limit');
    }
    const json = JSON.parse(rawText);
    const validation = validateSelectorsConfig(json);
    if (!validation.valid) {
      throw new Error(`Schema validation failed: ${validation.errors.join('; ')}`);
    }

    await setCachedRemoteConfig({
      url: remoteUrl,
      fetchedAt: new Date().toISOString(),
      data: json
    });
    await logger.info('remote-config', 'Updated selectors from remote URL', {
      remoteUrl,
      version: json.version
    });
    return { config: mergeConfigs(bundled, json), source: 'remote', error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logger.warn('remote-config', 'Remote config fetch failed, falling back', {
      remoteUrl,
      error: message
    });
    if (cached?.url === remoteUrl && cached?.data) {
      const validation = validateSelectorsConfig(cached.data);
      if (validation.valid) {
        return { config: mergeConfigs(bundled, cached.data), source: 'cache', error: message };
      }
    }
    return { config: bundled, source: 'bundled', error: message };
  }
}
