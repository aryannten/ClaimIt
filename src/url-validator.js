/**
 * URL allowlist guard for chrome.tabs.create and notification click targets.
 * Only HTTPS URLs on known store hostnames are permitted to open in a new tab.
 * This prevents any injected or corrupted offer URL from opening arbitrary pages.
 */

const ALLOWED_STORE_ORIGINS = new Set([
  'store.epicgames.com',
  'payment-website-pci.ol.epicgames.com',
  'store.steampowered.com',
  'steamcommunity.com',
  'steamdb.info'
]);

/**
 * Return true only if the URL is HTTPS and its hostname is on the store allowlist.
 * Rejects javascript:, data:, blob:, http:, and unknown hostnames.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isAllowedStoreUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && ALLOWED_STORE_ORIGINS.has(hostname);
  } catch {
    return false;
  }
}
