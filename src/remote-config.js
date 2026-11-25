/**
 * Remote selector & endpoint configuration loader with schema validation,
 * chrome.storage.local caching, and safe fallback to the bundled config/selectors.json.
 */

import { getCachedRemoteConfig, setCachedRemoteConfig, getSettings } from './storage.js';
import { logger } from './logger.js';

let bundledConfigMemo = null;

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

function isStringArray(val) {
  return Array.isArray(val) && val.every((item) => isNonEmptyString(item));
}

function isStringRecord(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Validate remote selectors.json schema strictly so malformed or unexpected payloads
 * never break store automation.
 * @param {unknown} candidate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSelectorsConfig(candidate) {
  const errors = [];
  if (!isStringRecord(candidate)) {
    return { valid: false, errors: ['Root config must be a JSON object'] };
  }
  if (typeof candidate.version !== 'number' || candidate.version < 1) {
    errors.push('version must be a positive number');
  }
  if (!isStringRecord(candidate.stores)) {
    errors.push('stores must be an object');
    return { valid: false, errors };
  }

  for (const storeId of ['epic', 'steam']) {
    const store = candidate.stores[storeId];
    if (!isStringRecord(store)) {
      errors.push(`stores.${storeId} must be an object`);
      continue;
    }
    if (!isStringRecord(store.endpoints) || Object.keys(store.endpoints).length === 0) {
      errors.push(`stores.${storeId}.endpoints must be a non-empty object`);
    } else {
      for (const [k, url] of Object.entries(store.endpoints)) {
        if (!isNonEmptyString(url) || !url.startsWith('https://')) {
          errors.push(`stores.${storeId}.endpoints.${k} must be an https:// URL`);
        }
      }
    }
    if (!isStringRecord(store.selectors) || Object.keys(store.selectors).length === 0) {
      errors.push(`stores.${storeId}.selectors must be a non-empty object`);
    } else {
      for (const [k, arr] of Object.entries(store.selectors)) {
        if (!isStringArray(arr) || arr.length === 0) {
          errors.push(`stores.${storeId}.selectors.${k} must be a non-empty array of non-empty strings`);
        }
      }
    }
    if (!isStringRecord(store.texts) || Object.keys(store.texts).length === 0) {
      errors.push(`stores.${storeId}.texts must be a non-empty object`);
    } else {
      for (const [k, arr] of Object.entries(store.texts)) {
        if (!isStringArray(arr) || arr.length === 0) {
          errors.push(`stores.${storeId}.texts.${k} must be a non-empty array of non-empty strings`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Merge a validated remote config over the bundled config so missing optional keys
 * gracefully inherit bundled defaults.
 * @param {object} bundled
 * @param {object} remote
 * @returns {object}
 */
export function mergeConfigs(bundled, remote) {
  const merged = {
    ...bundled,
    ...remote,
    stores: {}
  };
  for (const storeId of new Set([
    ...Object.keys(bundled.stores || {}),
    ...Object.keys(remote?.stores || {})
  ])) {
    const b = bundled.stores?.[storeId] || {};
    const r = remote?.stores?.[storeId] || {};
    merged.stores[storeId] = {
      endpoints: { ...(b.endpoints || {}), ...(r.endpoints || {}) },
      selectors: { ...(b.selectors || {}), ...(r.selectors || {}) },
      texts: { ...(b.texts || {}), ...(r.texts || {}) }
    };
  }
  return merged;
}

/**
 * Load the bundled config/selectors.json shipped with the extension.
 * @returns {Promise<object>}
 */
async function loadBundledConfig() {
  if (bundledConfigMemo) return bundledConfigMemo;
  const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL
    ? chrome.runtime.getURL('config/selectors.json')
    : new URL('../config/selectors.json', import.meta.url).href;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load bundled selectors.json (${response.status})`);
  }
  bundledConfigMemo = await response.json();
  return bundledConfigMemo;
}

/**
 * Validate whether a remote config URL is safe to fetch (HTTPS only, JSON data only).
 * @param {string} url
 * @returns {boolean}
 */
function isValidRemoteConfigUrl(url) {
  if (!isNonEmptyString(url)) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:';
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
    const err = 'Invalid remote config URL (must use https://)';
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
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const json = await resp.json();
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
