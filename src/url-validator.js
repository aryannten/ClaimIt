/**
 * URL allowlist guards for tabs, endpoints, and notification webhooks.
 * Enforces HTTPS without embedded credentials and strict hostname allowlists.
 */

const ALLOWED_STORE_HOSTS = new Set([
  'store.epicgames.com',
  'payment-website-pci.ol.epicgames.com',
  'store.steampowered.com',
  'steamcommunity.com',
  'steamdb.info'
]);

const ALLOWED_IMAGE_EXACT_HOSTS = new Set([
  ...ALLOWED_STORE_HOSTS,
  'steamcdn-a.akamaihd.net',
  'steamstatic.com',
  'epicgames.com',
  'unrealengine.com',
  'epicgames.dev'
]);

const ALLOWED_IMAGE_HOST_SUFFIXES = [
  '.steamstatic.com',
  '.epicgames.com',
  '.unrealengine.com',
  '.epicgames.dev'
];

const ALLOWED_STORE_ENDPOINT_HOSTS = {
  epic: new Set([
    'store-site-backend-static-ipv4.ak.epicgames.com',
    'store.epicgames.com',
    'payment-website-pci.ol.epicgames.com'
  ]),
  steam: new Set([
    'store.steampowered.com',
    'steamdb.info'
  ])
};

const ALLOWED_DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'ptb.discord.com',
  'canary.discord.com'
]);

function parseSafeHttpsUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Return true only if the URL is HTTPS (without credentials) and its hostname
 * is on the allowed game-store hostnames list.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isAllowedStoreUrl(url) {
  const parsed = parseSafeHttpsUrl(url);
  return Boolean(parsed && ALLOWED_STORE_HOSTS.has(parsed.hostname));
}

/**
 * Return true only if the URL is HTTPS (without credentials) and points to an
 * official Epic or Steam storefront/CDN image hostname.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isAllowedImageUrl(url) {
  const parsed = parseSafeHttpsUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_IMAGE_EXACT_HOSTS.has(host)) return true;
  return ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Validate a store API/page endpoint from selectors.json against that store's allowed hosts.
 * @param {string} storeId
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isAllowedStoreEndpointUrl(storeId, url) {
  const parsed = parseSafeHttpsUrl(url);
  const allowed = ALLOWED_STORE_ENDPOINT_HOSTS[storeId];
  return Boolean(parsed && allowed && allowed.has(parsed.hostname));
}

/**
 * Return true only if the URL is a valid HTTPS Discord webhook URL.
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
export function isAllowedDiscordWebhookUrl(url) {
  const parsed = parseSafeHttpsUrl(typeof url === 'string' ? url.trim() : url);
  if (!parsed) return false;
  return (
    ALLOWED_DISCORD_WEBHOOK_HOSTS.has(parsed.hostname) &&
    /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/i.test(parsed.pathname)
  );
}
