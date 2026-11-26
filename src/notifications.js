/**
 * Multi-channel notification dispatcher:
 * - Chrome rich notifications with game cover image and "Claim now" / "Dismiss" buttons
 * - Optional Telegram Bot API & Discord Webhook alerts for NEEDS_USER and FAILED events
 * - Per-cycle deduplication (no re-notification within the same cycle unless status changes)
 */

import { CLAIM_STATUS } from './providers/constants.js';
import {
  getNotificationState,
  setNotificationState,
  makeOfferKey,
  getSettings,
  getRegionState,
  getCachedFxRates,
  setCachedFxRates
} from './storage.js';
import {
  resolveRegionAndCurrency,
  getExchangeRates,
  formatOfferPriceState,
  formatLocalDateTime,
  normalizeCurrencyCode
} from './currency.js';
import { logger, redactSecrets } from './logger.js';
import { isAllowedStoreUrl, isAllowedImageUrl, isAllowedDiscordWebhookUrl } from './url-validator.js';

const TARGETS_STORAGE_KEY = 'claimit_notification_targets';
const MAX_IMAGE_BYTES = 1_500_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
]);

/**
 * Pure helper to determine whether a notification should be emitted for an offer in a cycle.
 * Never re-notifies within the same cycle unless the status changed.
 * @param {{ cycleId?: string, status?: string } | undefined} previousEntry
 * @param {string} cycleId
 * @param {string} status
 * @returns {boolean}
 */
export function shouldNotify(previousEntry, cycleId, status) {
  if (!previousEntry) return true;
  if (previousEntry.status !== status) return true;
  if (previousEntry.cycleId !== cycleId) return true;
  return false;
}

/**
 * Pure helper to convert an ArrayBuffer into a base64 string (safe in MV3 service workers).
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }
  return btoa(parts.join(''));
}

/**
 * Fetch a remote cover image and convert it into a data URL for chrome.notifications,
 * because MV3 service workers do not expose URL.createObjectURL.
 * @param {string} imageUrl
 * @returns {Promise<string|null>}
 */
async function fetchCoverDataUrl(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('https://')) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(imageUrl, { signal: controller.signal, redirect: 'error' });
    clearTimeout(timer);
    if (!resp.ok) return null;

    const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) return null;

    const contentLength = Number(resp.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) return null;

    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;

    return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
  } catch {
    return null;
  }
}

function getBundledIconUrl() {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL('assets/notification-icon.png');
  }
  return 'assets/notification-icon.png';
}

async function saveNotificationTarget(notificationId, target) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const data = await chrome.storage.local.get(TARGETS_STORAGE_KEY);
  const map = data[TARGETS_STORAGE_KEY] && typeof data[TARGETS_STORAGE_KEY] === 'object'
    ? data[TARGETS_STORAGE_KEY]
    : {};

  // Keep only the latest 50 targets to avoid unbounded growth
  const keys = Object.keys(map);
  if (keys.length >= 50) {
    for (const oldKey of keys.slice(0, keys.length - 49)) {
      delete map[oldKey];
    }
  }
  map[notificationId] = {
    ...target,
    createdAt: Date.now()
  };
  await chrome.storage.local.set({ [TARGETS_STORAGE_KEY]: map });
}

export async function getNotificationTarget(notificationId) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  const data = await chrome.storage.local.get(TARGETS_STORAGE_KEY);
  return data[TARGETS_STORAGE_KEY]?.[notificationId] || null;
}

export async function removeNotificationTarget(notificationId) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const data = await chrome.storage.local.get(TARGETS_STORAGE_KEY);
  const map = data[TARGETS_STORAGE_KEY];
  if (map && map[notificationId]) {
    delete map[notificationId];
    await chrome.storage.local.set({ [TARGETS_STORAGE_KEY]: map });
  }
}

/**
 * Create a Chrome notification with cover image fallback so platform limitations
 * (e.g. macOS ignoring `image` type or CORS failure on cover images) never prevent display.
 */
async function createChromeNotification(notificationId, options, coverDataUrl) {
  const bundledIcon = getBundledIconUrl();
  const baseOptions = {
    title: options.title,
    message: options.message,
    contextMessage: options.contextMessage,
    buttons: options.buttons,
    requireInteraction: options.requireInteraction,
    silent: options.silent
  };

  if (coverDataUrl) {
    try {
      await chrome.notifications.create(notificationId, {
        ...baseOptions,
        type: 'image',
        iconUrl: bundledIcon,
        imageUrl: coverDataUrl
      });
      return;
    } catch {
      // Fallback to basic notification using coverDataUrl as iconUrl
    }

    try {
      await chrome.notifications.create(notificationId, {
        ...baseOptions,
        type: 'basic',
        iconUrl: coverDataUrl
      });
      return;
    } catch {
      // Fallback to bundled extension icon
    }
  }

  await chrome.notifications.create(notificationId, {
    ...baseOptions,
    type: 'basic',
    iconUrl: bundledIcon
  });
}

function formatUntilLabel(endDate, locale) {
  const formatted = formatLocalDateTime(endDate, locale);
  return formatted ? ` until ${formatted}` : '';
}

function formatPriceBadgeText(offer, currencyContext) {
  const priceState = formatOfferPriceState(offer, currencyContext);
  if (!priceState.available) return '';
  return priceState.approx ? `~${priceState.formatted}` : priceState.formatted;
}

/**
 * Format Telegram Bot API payload for NEEDS_USER or FAILED alerts.
 * @param {object} offer
 * @param {string} status
 * @param {string} [reason]
 * @param {string} [chatId]
 * @param {{ displayCurrency?: string, locale?: string, rates?: Record<string, number>|null }} [currencyContext]
 * @returns {object}
 */
export function buildTelegramPayload(offer, status, reason, chatId, currencyContext = null) {
  const storeName = offer.storeName || offer.store;
  const dlcTag = offer.label === 'DLC' ? ' [DLC]' : '';
  const effectiveCtx = currencyContext || (() => {
    const resolved = resolveRegionAndCurrency({
      storedRegion: { storeCurrency: offer.currencyCode || offer.currency || null }
    });
    return { displayCurrency: resolved.currency, locale: resolved.locale, rates: null };
  })();
  const until = formatUntilLabel(offer.endDate, effectiveCtx.locale);
  const priceLabel = formatPriceBadgeText(offer, effectiveCtx);
  const priceNote = priceLabel ? ` (normally ${priceLabel})` : '';
  const text =
    status === CLAIM_STATUS.NEEDS_USER
      ? `${offer.title}${dlcTag}: Free on ${storeName}${until}${priceNote}. ${reason || 'Needs you to claim.'}\n${offer.url}`
      : `ClaimIt failed on ${storeName} for ${offer.title}${dlcTag}${priceNote}. Reason: ${reason || 'Unknown error'}.\n${offer.url}`;

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  };

  if (isAllowedStoreUrl(offer.url)) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: 'Claim now', url: offer.url }]]
    };
  }
  return payload;
}

/**
 * Format Discord Webhook embed payload for NEEDS_USER or FAILED alerts.
 * @param {object} offer
 * @param {string} status
 * @param {string} [reason]
 * @param {{ displayCurrency?: string, locale?: string, rates?: Record<string, number>|null }} [currencyContext]
 * @returns {object}
 */
export function buildDiscordPayload(offer, status, reason, currencyContext = null) {
  const storeName = offer.storeName || offer.store;
  const dlcTag = offer.label === 'DLC' ? ' [DLC]' : '';
  const effectiveCtx = currencyContext || (() => {
    const resolved = resolveRegionAndCurrency({
      storedRegion: { storeCurrency: offer.currencyCode || offer.currency || null }
    });
    return { displayCurrency: resolved.currency, locale: resolved.locale, rates: null };
  })();
  const until = formatUntilLabel(offer.endDate, effectiveCtx.locale);
  const priceLabel = formatPriceBadgeText(offer, effectiveCtx);
  const priceNote = priceLabel ? ` (normally ${priceLabel})` : '';
  const isNeedsUser = status === CLAIM_STATUS.NEEDS_USER;

  const safeUrl = isAllowedStoreUrl(offer.url) ? offer.url : undefined;
  const safeImage = isAllowedImageUrl(offer.image) ? offer.image : undefined;

  return {
    username: 'ClaimIt',
    embeds: [
      {
        title: `${offer.title}${dlcTag}`,
        url: safeUrl,
        description: isNeedsUser
          ? `Free on ${storeName}${until}${priceNote}. ${reason || 'Needs you to claim.'}`
          : `Could not claim on ${storeName}${priceNote}. Reason: ${reason || 'Unknown error'}.`,
        color: isNeedsUser ? 0x16a34a : 0xdc2626,
        thumbnail: safeImage ? { url: safeImage } : undefined,
        footer: { text: `ClaimIt · ${storeName}` },
        timestamp: new Date().toISOString()
      }
    ]
  };
}

async function sendTelegramAlert(telegramCfg, offer, status, reason, currencyContext) {
  if (!telegramCfg?.enabled || !telegramCfg.botToken || !telegramCfg.chatId) return;
  const token = String(telegramCfg.botToken).trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('Telegram bot token format is invalid');
  }
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
  const payload = buildTelegramPayload(offer, status, reason, telegramCfg.chatId.trim(), currencyContext);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`Telegram API HTTP ${resp.status}`);
    }
  } catch (err) {
    throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
}

async function sendDiscordAlert(discordCfg, offer, status, reason, currencyContext) {
  if (!discordCfg?.enabled || !discordCfg.webhookUrl) return;
  const url = String(discordCfg.webhookUrl).trim();
  if (!isAllowedDiscordWebhookUrl(url)) {
    throw new Error('Discord webhook URL must be a valid https://discord.com/api/webhooks/... URL');
  }
  const payload = buildDiscordPayload(offer, status, reason, currencyContext);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`Discord webhook HTTP ${resp.status}`);
    }
  } catch (err) {
    throw new Error(redactSecrets(err instanceof Error ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a test notification to Telegram or Discord from the Options page.
 */
export async function sendTestWebhook(channel, config) {
  const settings = await getSettings();
  const storedRegion = await getRegionState();
  const region = resolveRegionAndCurrency({ settings, storedRegion });
  const sampleOffer = {
    id: 'test-offer',
    store: 'epic',
    storeName: 'Epic Games Store',
    title: 'ClaimIt Test Alert',
    url: 'https://store.epicgames.com/en-US/free-games',
    originalPrice: 499,
    originalPriceValue: 499,
    currencyCode: region.currency,
    label: null
  };
  const currencyContext = { displayCurrency: region.currency, locale: region.locale, rates: null };
  if (channel === 'telegram') {
    await sendTelegramAlert(config, sampleOffer, CLAIM_STATUS.NEEDS_USER, 'Test notification', currencyContext);
  } else if (channel === 'discord') {
    await sendDiscordAlert(config, sampleOffer, CLAIM_STATUS.NEEDS_USER, 'Test notification', currencyContext);
  } else {
    throw new Error(`Unknown notification channel: ${channel}`);
  }
}

/**
 * Dispatch notifications for an offer outcome while honoring per-cycle deduplication.
 * @param {{
 *   offer: object,
 *   status: string,
 *   reason?: string,
 *   tabId?: number,
 *   dryRun?: boolean,
 *   cycleId: string,
 *   settings: object
 * }} params
 */
export async function notifyOfferOutcome({
  offer,
  status,
  reason,
  tabId,
  dryRun = false,
  cycleId,
  settings
}) {
  const key = makeOfferKey(offer.store, offer.id);
  const state = await getNotificationState();
  const prev = state[key];

  if (!shouldNotify(prev, cycleId, status)) {
    return { skipped: true };
  }

  state[key] = {
    cycleId,
    status,
    notifiedAt: new Date().toISOString()
  };
  await setNotificationState(state);

  const storeName = offer.storeName || offer.store;
  const dlcTag = offer.label === 'DLC' ? ' (DLC)' : '';
  const storedRegion = await getRegionState();
  const effectiveSettings = settings || (await getSettings());
  const region = resolveRegionAndCurrency({ settings: effectiveSettings, storedRegion });
  const offerCur = normalizeCurrencyCode(offer.currencyCode ?? offer.currency);
  let fxRates = null;
  if (offerCur && offerCur !== region.currency) {
    const fxResult = await getExchangeRates({
      cached: await getCachedFxRates(),
      saveCacheFn: setCachedFxRates
    }).catch(() => null);
    fxRates = fxResult?.rates || null;
  }
  const currencyContext = {
    displayCurrency: region.currency,
    locale: region.locale,
    rates: fxRates
  };
  const priceLabel = formatPriceBadgeText(offer, currencyContext);
  const pricePart = priceLabel ? ` (normally ${priceLabel})` : '';

  // Chrome Notifications
  if (effectiveSettings?.notifications?.chrome !== false && typeof chrome !== 'undefined' && chrome.notifications) {
    const notificationId = `claimit:${key}:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await saveNotificationTarget(notificationId, {
      offerUrl: offer.url,
      store: offer.store,
      id: offer.id,
      tabId: typeof tabId === 'number' ? tabId : null
    });

    const coverDataUrl = await fetchCoverDataUrl(offer.image);

    try {
      const until = formatUntilLabel(offer.endDate, region.locale);
      if (status === CLAIM_STATUS.CLAIMED) {
        const title = dryRun ? `Dry-run: ${offer.title}${dlcTag}` : `${offer.title}${dlcTag}`;
        const message = dryRun
          ? `Dry-run completed on ${storeName}${pricePart}. No claim clicked.`
          : `Claimed on ${storeName}${pricePart}.`;

        await createChromeNotification(
          notificationId,
          {
            title,
            message,
            contextMessage: storeName,
            buttons: [{ title: 'Claim now' }, { title: 'Dismiss' }],
            requireInteraction: false,
            silent: true
          },
          coverDataUrl
        );
      } else if (status === CLAIM_STATUS.NEEDS_USER) {
        await createChromeNotification(
          notificationId,
          {
            title: `${offer.title}${dlcTag}`,
            message: `Free on ${storeName}${until}${pricePart}. ${reason ? `${reason}. ` : ''}Needs you to claim.`,
            contextMessage: storeName,
            buttons: [{ title: 'Claim now' }, { title: 'Dismiss' }],
            requireInteraction: true,
            silent: false
          },
          coverDataUrl
        );
      } else if (status === CLAIM_STATUS.FAILED) {
        await createChromeNotification(
          notificationId,
          {
            title: `${offer.title}${dlcTag}`,
            message: `Could not claim on ${storeName}${pricePart}: ${reason || 'Unknown error'}.`,
            contextMessage: storeName,
            buttons: [{ title: 'Claim now' }, { title: 'Dismiss' }],
            requireInteraction: false,
            silent: true
          },
          coverDataUrl
        );
      }
    } catch (err) {
      await logger.warn('notifications', 'Chrome notification failed', {
        key,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // External alerts (Telegram & Discord) for NEEDS_USER and FAILED
  if (status === CLAIM_STATUS.NEEDS_USER || status === CLAIM_STATUS.FAILED) {
    try {
      await sendTelegramAlert(effectiveSettings?.notifications?.telegram, offer, status, reason, currencyContext);
    } catch (err) {
      await logger.warn('notifications', 'Telegram alert failed', {
        key,
        error: redactSecrets(err instanceof Error ? err.message : String(err))
      });
    }

    try {
      await sendDiscordAlert(effectiveSettings?.notifications?.discord, offer, status, reason, currencyContext);
    } catch (err) {
      await logger.warn('notifications', 'Discord alert failed', {
        key,
        error: redactSecrets(err instanceof Error ? err.message : String(err))
      });
    }
  }

  return { skipped: false };
}
