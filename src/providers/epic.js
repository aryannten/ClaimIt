/**
 * Epic Games Store Provider
 *
 * Verified live against https://store.epicgames.com/en-US/free-games network traffic:
 * - Endpoint URL:
 *   https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US
 *   (Storefront also passes optional `country` and `allowCountries` query params, e.g.
 *   `&country=US&allowCountries=US`; omitting them lets Epic's edge resolve GeoIP or default.)
 *
 * - Response Shape (HTTP 200, application/json):
 *   {
 *     data: {
 *       Catalog: {
 *         searchStore: {
 *           paging: { count: number, total: number },
 *           elements: Array<{
 *             id: string,
 *             namespace: string,
 *             title: string,
 *             description: string,
 *             offerType: "BASE_GAME" | "ADD_ON" | "BUNDLE" | string,
 *             productSlug: string | null,
 *             urlSlug: string,
 *             categories: Array<{ path: string }>,
 *             keyImages: Array<{ type: string, url: string }>,
 *             catalogNs: { mappings: Array<{ pageSlug: string, pageType: string }> },
 *             offerMappings: Array<{ pageSlug: string, pageType: string }>,
 *             price: {
 *               totalPrice: {
 *                 discountPrice: number,
 *                 originalPrice: number,
 *                 currencyCode: string,
 *                 currencyInfo: { decimals: number },
 *                 fmtPrice: { originalPrice: string, discountPrice: string, intermediatePrice: string }
 *               }
 *             },
 *             promotions: {
 *               promotionalOffers: Array<{
 *                 promotionalOffers: Array<{
 *                   startDate: string,
 *                   endDate: string,
 *                   discountSetting: { discountType: "PERCENTAGE", discountPercentage: number }
 *                 }>
 *               }>,
 *               upcomingPromotionalOffers: Array<{
 *                 promotionalOffers: Array<{
 *                   startDate: string,
 *                   endDate: string,
 *                   discountSetting: { discountType: "PERCENTAGE", discountPercentage: number }
 *                 }>
 *               }>
 *             } | null
 *           }>
 *         }
 *       }
 *     }
 *   }
 *
 * Notes from live verification:
 * - `discountSetting.discountPercentage` represents % of original price PAID (0 === 100% off!).
 * - Active partial discounts (e.g. discountPercentage: 70) and F2P items (originalPrice: 0)
 *   can also appear in elements[], so both active promo checks and classifier checks are vital.
 * - `productSlug` is often null on newer listings; `offerMappings` / `catalogNs.mappings` hold
 *   the real storefront `pageSlug` (important for ADD_ON / DLC vs base games).
 */

import { CLAIM_STATUS, delay, humanDelay } from './constants.js';
import {
  openBackgroundTab,
  focusTab,
  closeTabSafely,
  listTabFrames,
  sendFrameMessage
} from './tab-helpers.js';

export const id = 'epic';
export const name = 'Epic Games Store';

const EPIC_CONTENT_SCRIPT = 'src/content/epic.js';

/**
 * Pick the best cover image URL from Epic's keyImages array.
 * @param {Array<{ type?: string, url?: string }>} keyImages
 * @returns {string}
 */
function pickCoverImage(keyImages) {
  if (!Array.isArray(keyImages) || keyImages.length === 0) return '';
  const preferredTypes = [
    'OfferImageWide',
    'DieselStoreFrontWide',
    'OfferImageTall',
    'DieselGameBoxTall',
    'Thumbnail'
  ];
  for (const type of preferredTypes) {
    const match = keyImages.find((img) => img?.type === type && img?.url);
    if (match) return match.url;
  }
  return keyImages.find((img) => img?.url)?.url || '';
}

/**
 * Build the Epic storefront URL for a catalog element.
 * @param {object} element
 * @param {object} endpoints
 * @returns {string}
 */
export function resolveEpicStoreUrl(element, endpoints = {}) {
  const storeBase = endpoints.storeBase || 'https://store.epicgames.com/en-US/p/';
  const bundleBase = endpoints.bundleBase || 'https://store.epicgames.com/en-US/bundles/';

  const offerSlug = element.offerMappings?.find((m) => m?.pageSlug)?.pageSlug;
  const catalogSlug = element.catalogNs?.mappings?.find((m) => m?.pageSlug)?.pageSlug;
  const rawProductSlug = element.productSlug ? String(element.productSlug).replace(/\/home$/, '') : '';
  const isDlc =
    element.offerType === 'ADD_ON' ||
    (element.categories || []).some((c) => c?.path === 'addons' || c?.path === 'addons/durable');

  const slug = isDlc
    ? (offerSlug || catalogSlug || rawProductSlug || element.urlSlug)
    : (catalogSlug || offerSlug || rawProductSlug || element.urlSlug);

  if (!slug) {
    return endpoints.freeGamesPage || 'https://store.epicgames.com/en-US/free-games';
  }
  const base = element.offerType === 'BUNDLE' ? bundleBase : storeBase;
  return `${base.replace(/\/$/, '')}/${slug.replace(/^\//, '')}`;
}

/**
 * Pure parser converting Epic's freeGamesPromotions JSON payload into ClaimIt offer objects.
 * @param {object} json
 * @param {object} [endpoints]
 * @param {number} [nowMs=Date.now()]
 * @returns {object[]}
 */
export function parseEpicPromotions(json, endpoints = {}, nowMs = Date.now()) {
  const elements = json?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) return [];

  const offers = [];
  for (const el of elements) {
    if (!el || !el.id || !el.title) continue;

    const totalPrice = el.price?.totalPrice || {};
    const decimals = Number(totalPrice.currencyInfo?.decimals ?? 2);
    const divisor = Math.pow(10, decimals);
    const rawOriginal = Number(totalPrice.originalPrice ?? 0);
    const rawDiscount = Number(totalPrice.discountPrice ?? rawOriginal);
    const originalPrice = divisor > 0 ? rawOriginal / divisor : rawOriginal;
    const discountPrice = divisor > 0 ? rawDiscount / divisor : rawDiscount;

    const promoGroups = el.promotions?.promotionalOffers || [];
    const upcomingGroups = el.promotions?.upcomingPromotionalOffers || [];

    let activePromo = null;
    for (const group of promoGroups) {
      for (const promo of group?.promotionalOffers || []) {
        const start = Date.parse(promo.startDate);
        const end = Date.parse(promo.endDate);
        const pctPaid = Number(promo.discountSetting?.discountPercentage ?? 100);
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start <= nowMs &&
          end > nowMs &&
          pctPaid === 0
        ) {
          activePromo = promo;
          break;
        }
      }
      if (activePromo) break;
    }

    // If no active 100%-off promo, check if there's a partial promo or upcoming promo
    let fallbackPromo = activePromo;
    let isUpcoming = false;
    if (!fallbackPromo) {
      const anyActive = promoGroups.flatMap((g) => g?.promotionalOffers || [])[0];
      const anyUpcoming = upcomingGroups.flatMap((g) => g?.promotionalOffers || [])[0];
      if (anyActive) {
        fallbackPromo = anyActive;
      } else if (anyUpcoming) {
        fallbackPromo = anyUpcoming;
        isUpcoming = true;
      }
    }

    const categories = (el.categories || []).map((c) => c?.path).filter(Boolean);
    const isDlc =
      el.offerType === 'ADD_ON' ||
      categories.includes('addons') ||
      categories.includes('addons/durable');
    const isDemo = el.offerType === 'DEMO' || categories.includes('demos');

    let discountPercent = 0;
    if (activePromo && rawDiscount === 0) {
      discountPercent = 100;
    } else if (fallbackPromo?.discountSetting?.discountType === 'PERCENTAGE') {
      const paidPct = Number(fallbackPromo.discountSetting.discountPercentage ?? 100);
      discountPercent = Math.max(0, 100 - paidPct);
    }

    offers.push({
      id: el.id,
      namespace: el.namespace,
      store: id,
      storeName: name,
      title: el.title,
      url: resolveEpicStoreUrl(el, endpoints),
      image: pickCoverImage(el.keyImages),
      originalPrice,
      originalPriceFormatted: totalPrice.fmtPrice?.originalPrice || `$${originalPrice.toFixed(2)}`,
      discountPrice,
      discountPercent,
      currency: totalPrice.currencyCode || 'USD',
      startDate: fallbackPromo?.startDate || null,
      endDate: fallbackPromo?.endDate || null,
      type: isDlc ? 'dlc' : (isDemo ? 'demo' : 'game'),
      offerType: el.offerType || 'BASE_GAME',
      categories,
      isDlc,
      isDemo,
      isUpcoming,
      isLimitedTime: Boolean(fallbackPromo?.endDate),
      isFreeToPlay: rawOriginal === 0 && !activePromo
    });
  }

  return offers;
}

/**
 * Fetch current offers from Epic's public freeGamesPromotions endpoint.
 * Returns normalized offer objects (including active 100% off and upcoming/non-100% items
 * so classifier.js can filter deterministically).
 * @param {{ config: object }} context
 * @returns {Promise<object[]>}
 */
export async function fetchOffers(context = {}) {
  const epicCfg = context.config?.stores?.epic || {};
  const endpoints = epicCfg.endpoints || {};
  const url =
    endpoints.promotions ||
    'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Epic promotions request failed (${response.status})`);
  }

  const json = await response.json();
  return parseEpicPromotions(json, endpoints);
}

/**
 * Best-effort ownership check before opening a claim tab.
 * Epic requires authenticated GraphQL calls for library inspection; real ownership is
 * confirmed directly on the product page ("In Library" CTA) during claim.
 * @param {object} offer
 * @param {{ history?: Record<string, object> }} context
 * @returns {Promise<boolean>}
 */
export async function isOwned(offer, context = {}) {
  const key = `${id}:${offer.id}`;
  const entry = context.history?.[key];
  return Boolean(entry && entry.status === 'CLAIMED' && !entry.dryRun);
}

function isEpicLoginUrl(url) {
  return /\/id\/login|\/login\b|accounts\.epicgames\.com/i.test(url || '');
}

/**
 * Find the checkout frame (payment-website-pci or store.epicgames.com/purchase),
 * or top frame ONLY when an inline checkout container (#webPurchaseContainer/#purchase-app) exists.
 */
function pickCheckoutFrame(frames, hasInlineCheckout) {
  const iframe = frames.find((f) => !f.isTop && /payment-website-pci|\/purchase/i.test(f.href));
  if (iframe) return iframe;
  return hasInlineCheckout ? (frames.find((f) => f.isTop) || null) : null;
}

/**
 * Auto-claim an Epic Games Store offer using the user's active logged-in session.
 * @param {object} offer
 * @param {{ config: object, dryRun?: boolean, signal?: AbortSignal }} context
 * @returns {Promise<{ status: string, reason?: string, alreadyOwned?: boolean, dryRun?: boolean, tabId?: number }>}
 */
export async function claim(offer, context = {}) {
  const epicCfg = context.config?.stores?.epic || {};
  const dryRun = Boolean(context.dryRun);
  const signal = context.signal;

  let tab = null;
  let keepTabOpen = false;

  const handoffToUser = async (reason) => {
    keepTabOpen = true;
    if (tab?.id) {
      await focusTab(tab.id);
    }
    return { status: CLAIM_STATUS.NEEDS_USER, reason, tabId: tab?.id };
  };

  try {
    tab = await openBackgroundTab(offer.url, signal);

    // Wait for Epic's SPA hydration using MutationObserver-backed inspection
    let topState = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) throw new Error('timeout');

      const tabInfo = await chrome.tabs.get(tab.id);
      if (isEpicLoginUrl(tabInfo.url)) {
        return await handoffToUser('Login required on Epic Games Store');
      }

      const frames = await listTabFrames(tab.id);
      const topFrame = frames.find((f) => f.isTop);
      if (topFrame) {
        topState = await sendFrameMessage(
          tab.id,
          topFrame.frameId,
          EPIC_CONTENT_SCRIPT,
          { action: 'EPIC_INSPECT_PRODUCT', config: epicCfg, waitMs: 1500 },
          signal
        );
        if (topState?.readyForDecision) break;
      } else {
        await delay(800, signal);
      }
    }

    if (!topState) {
      return { status: CLAIM_STATUS.FAILED, reason: 'Could not inspect Epic store page' };
    }

    if (topState.captcha) {
      return await handoffToUser('Captcha detected on Epic store page');
    }
    if (topState.unavailable) {
      return await handoffToUser('Unavailable in your region');
    }
    if (topState.loginRequired) {
      return await handoffToUser('Login required on Epic Games Store');
    }
    if (topState.owned) {
      return {
        status: CLAIM_STATUS.CLAIMED,
        alreadyOwned: true,
        reason: 'Already in Epic library'
      };
    }
    if (!topState.hasGetButton) {
      return await handoffToUser('Get button not found on Epic store page');
    }

    // Human-like delay before clicking Get
    await humanDelay(1000, 3000, signal);

    const framesBeforeClick = await listTabFrames(tab.id);
    const topFrame = framesBeforeClick.find((f) => f.isTop);
    if (!topFrame) {
      const tabInfo = await chrome.tabs.get(tab.id);
      if (isEpicLoginUrl(tabInfo.url)) {
        return await handoffToUser('Login required on Epic Games Store');
      }
      return { status: CLAIM_STATUS.FAILED, reason: 'Top frame disappeared before Get click' };
    }

    const getClickResult = await sendFrameMessage(
      tab.id,
      topFrame.frameId,
      EPIC_CONTENT_SCRIPT,
      { action: 'EPIC_CLICK_GET', config: epicCfg },
      signal
    );

    if (!getClickResult?.clicked) {
      return await handoffToUser(getClickResult?.reason || 'Failed to click Get button');
    }

    // Poll checkout modal / iframe (handling EU "I Agree", captcha, login redirect, Place Order)
    let euAgreeHandled = false;
    let orderPlaced = false;

    for (let step = 0; step < 30; step++) {
      if (signal?.aborted) throw new Error('timeout');
      await delay(1000, signal);

      const tabInfo = await chrome.tabs.get(tab.id);
      if (isEpicLoginUrl(tabInfo.url)) {
        return await handoffToUser('Login required on Epic Games Store');
      }

      const frames = await listTabFrames(tab.id);
      const top = frames.find((f) => f.isTop);
      let topCheck = null;

      if (top) {
        topCheck = await sendFrameMessage(
          tab.id,
          top.frameId,
          EPIC_CONTENT_SCRIPT,
          { action: 'EPIC_INSPECT_PRODUCT', config: epicCfg },
          signal
        );
        if (topCheck?.captcha) {
          return await handoffToUser('Captcha appeared before checkout');
        }
        if (topCheck?.loginRequired) {
          return await handoffToUser('Login required on Epic Games Store');
        }
        if (topCheck?.unavailable) {
          return await handoffToUser('Unavailable in your region');
        }
        if (orderPlaced && topCheck?.owned) {
          return { status: CLAIM_STATUS.CLAIMED };
        }
      }

      const checkout = pickCheckoutFrame(frames, Boolean(topCheck?.hasCheckoutContainer));
      if (!checkout) continue;

      const checkoutState = await sendFrameMessage(
        tab.id,
        checkout.frameId,
        EPIC_CONTENT_SCRIPT,
        { action: 'EPIC_INSPECT_CHECKOUT', config: epicCfg },
        signal
      );

      if (!checkoutState) continue;

      if (checkoutState.captcha) {
        return await handoffToUser('Captcha appeared during Epic checkout');
      }
      if (checkoutState.unavailable) {
        return await handoffToUser('Unavailable in your region');
      }
      if (checkoutState.orderConfirmed) {
        return { status: CLAIM_STATUS.CLAIMED };
      }

      // Handle EU "I Agree" / EULA agreement
      if (checkoutState.hasEuAgree && !euAgreeHandled) {
        await humanDelay(1000, 2500, signal);
        const agreeRes = await sendFrameMessage(
          tab.id,
          checkout.frameId,
          EPIC_CONTENT_SCRIPT,
          { action: 'EPIC_ACCEPT_EU_AGREE', config: epicCfg },
          signal
        );
        if (!agreeRes?.accepted) {
          return await handoffToUser('Extra agreement confirmation required');
        }
        euAgreeHandled = true;
        continue;
      }

      if (checkoutState.hasPlaceOrder && !orderPlaced) {
        if (dryRun) {
          return {
            status: CLAIM_STATUS.CLAIMED,
            dryRun: true,
            reason: 'Dry-run: reached Place Order button without clicking'
          };
        }

        await humanDelay(1000, 3000, signal);
        const placeRes = await sendFrameMessage(
          tab.id,
          checkout.frameId,
          EPIC_CONTENT_SCRIPT,
          { action: 'EPIC_PLACE_ORDER', config: epicCfg },
          signal
        );
        if (!placeRes?.clicked) {
          return await handoffToUser(placeRes?.reason || 'Place Order button not clickable');
        }
        orderPlaced = true;
      }
    }

    if (orderPlaced) {
      return await handoffToUser('Order submitted — verify confirmation in tab');
    }
    return await handoffToUser('Checkout UI did not reach Place Order');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'timeout' || signal?.aborted) {
      return { status: CLAIM_STATUS.FAILED, reason: 'timeout' };
    }
    return { status: CLAIM_STATUS.FAILED, reason: message };
  } finally {
    if (tab?.id && !keepTabOpen) {
      await closeTabSafely(tab.id);
    }
  }
}
