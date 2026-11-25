/**
 * Steam Store Provider
 *
 * Steam exposes no official free-promotion API, so all storefront scraping and
 * source adapters are isolated inside this module with a swappable source registry.
 */

import { CLAIM_STATUS, delay, humanDelay } from './constants.js';
import {
  openBackgroundTab,
  focusTab,
  closeTabSafely,
  listTabFrames,
  sendFrameMessage
} from './tab-helpers.js';

export const id = 'steam';
export const name = 'Steam';

const STEAM_CONTENT_SCRIPT = 'src/content/steam.js';

let activeSourceId = 'steam_search';
const customSources = new Map();

/**
 * Decode basic HTML entities without relying on DOMParser (safe in MV3 service workers).
 * @param {string} str
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a price string like "$19.99", "₹ 1,299.00", or "14,99€" into numeric major units.
 * @param {string} priceText
 * @returns {number}
 */
export function parsePriceText(priceText) {
  const text = String(priceText || '').trim();
  if (!text || /free/i.test(text)) return 0;
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!cleaned) return 0;

  // Handle European comma decimal vs thousands separators
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse Steam's search results HTML fragment (from /search/results/?maxprice=free&specials=1&json=1)
 * without DOM APIs so it works inside MV3 service workers and Node unit tests.
 * @param {string} resultsHtml
 * @param {object} [endpoints]
 * @returns {object[]}
 */
export function parseSteamSearchHtml(resultsHtml, endpoints = {}) {
  const html = String(resultsHtml || '');
  if (!html) return [];

  const appBase = endpoints.appBase || 'https://store.steampowered.com/app/';
  const rowRegex = /<a\b([^>]*class="[^"]*search_result_row[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
  const offers = [];
  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];

    const appIdMatch = attrs.match(/data-ds-appid="([^"]+)"/i);
    const hrefMatch = attrs.match(/href="([^"]+)"/i);
    if (!appIdMatch) continue;

    // Skip multi-app bundles if multiple IDs are comma-separated unless no single ID exists
    const rawAppIds = appIdMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    const appId = rawAppIds[0];
    if (!appId) continue;

    const titleMatch = body.match(/<span[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const imgMatch = body.match(/<div[^>]*class="[^"]*search_capsule[^"]*"[^>]*>\s*<img[^>]*src="([^"]+)"/i);
    const discountAttrMatch = body.match(/data-discount="(-?\d+)"/i);
    const finalPriceAttrMatch = body.match(/data-price-final="(\d+)"/i);
    const origPriceMatch = body.match(/<div[^>]*class="[^"]*discount_original_price[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const finalPriceMatch = body.match(/<div[^>]*class="[^"]*discount_final_price[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const pctMatch = body.match(/<div[^>]*class="[^"]*discount_pct[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

    const title = decodeHtmlEntities(titleMatch?.[1] || `Steam App ${appId}`);
    const origFormatted = decodeHtmlEntities(origPriceMatch?.[1] || '');
    const finalFormatted = decodeHtmlEntities(finalPriceMatch?.[1] || '');
    const pctText = decodeHtmlEntities(pctMatch?.[1] || '');

    const discountPercent = discountAttrMatch
      ? Math.abs(Number(discountAttrMatch[1]))
      : Math.abs(Number.parseInt(pctText.replace(/[^\d-]/g, ''), 10) || 0);

    const finalPriceCents = finalPriceAttrMatch ? Number(finalPriceAttrMatch[1]) : null;
    const originalPrice = parsePriceText(origFormatted);
    const discountPrice =
      finalPriceCents !== null ? finalPriceCents / 100 : parsePriceText(finalFormatted);

    const rawUrl = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : `${appBase}${appId}/`;
    const cleanUrl = rawUrl.split('?')[0];
    const hasFreeWeekendHint = /free\s+weekend|play\s+for\s+free/i.test(body);

    offers.push({
      id: appId,
      store: id,
      storeName: name,
      title,
      url: cleanUrl,
      image: imgMatch ? decodeHtmlEntities(imgMatch[1]) : '',
      originalPrice,
      originalPriceFormatted: origFormatted || (originalPrice > 0 ? `$${originalPrice.toFixed(2)}` : '$0.00'),
      discountPrice,
      discountPercent,
      currency: 'USD',
      startDate: null,
      endDate: null,
      type: 'game',
      isLimitedTime: discountPercent === 100 && originalPrice > 0,
      isFreeWeekend: hasFreeWeekendHint,
      isFreeToPlay: originalPrice <= 0 && discountPercent < 100
    });
  }

  return offers;
}

/**
 * Parse a community SteamDB-style free promotions HTML page (optional swappable source).
 * @param {string} html
 * @returns {object[]}
 */
export function parseSteamDbFreeHtml(html) {
  const source = String(html || '');
  if (!source) return [];

  const rowRegex = /<tr\b[^>]*data-appid="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  const offers = [];
  let match;

  while ((match = rowRegex.exec(source)) !== null) {
    const appId = match[1];
    const rowHtml = match[2];
    const isWeekend = /weekend|play\s+for\s+free/i.test(rowHtml);
    const isKeep = /keep/i.test(rowHtml);
    const titleMatch = rowHtml.match(/<a[^>]*href="[^"]*\/app\/\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const endMatch = rowHtml.match(/data-time="([^"]+)"|datetime="([^"]+)"/i);

    const title = decodeHtmlEntities(titleMatch?.[1] || `Steam App ${appId}`);
    const endIso = endMatch?.[1] || endMatch?.[2] || null;

    offers.push({
      id: appId,
      store: id,
      storeName: name,
      title,
      url: `https://store.steampowered.com/app/${appId}/`,
      image: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
      originalPrice: isKeep ? 1 : 0,
      originalPriceFormatted: 'Free promotion',
      discountPrice: 0,
      discountPercent: isKeep ? 100 : 0,
      currency: 'USD',
      startDate: null,
      endDate: endIso,
      type: 'game',
      hasPaidBaseline: isKeep,
      isLimitedTime: isKeep,
      isFreeWeekend: isWeekend,
      isFreeToPlay: !isKeep && !isWeekend
    });
  }

  return offers;
}

/**
 * Enrich candidate Steam offers using Steam's public appdetails endpoint so DLC,
 * demos, and permanent free-to-play titles are classified accurately.
 * @param {object} offer
 * @returns {Promise<object>}
 */
async function enrichFromAppDetails(offer) {
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(offer.id)}&l=english`;
    const resp = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (!resp.ok) return offer;
    const json = await resp.json();
    const detail = json?.[offer.id];
    if (!detail?.success || !detail?.data) return offer;

    const data = detail.data;
    const rawType = String(data.type || 'game').toLowerCase();
    const priceOverview = data.price_overview || null;

    const originalPrice = priceOverview
      ? Number(priceOverview.initial ?? 0) / 100
      : offer.originalPrice;
    const discountPrice = priceOverview
      ? Number(priceOverview.final ?? 0) / 100
      : offer.discountPrice;
    const discountPercent = priceOverview
      ? Number(priceOverview.discount_percent ?? offer.discountPercent)
      : offer.discountPercent;

    return {
      ...offer,
      title: data.name || offer.title,
      image: data.header_image || offer.image,
      type: rawType === 'dlc' ? 'dlc' : (rawType === 'demo' ? 'demo' : 'game'),
      rawType,
      isDlc: rawType === 'dlc',
      isDemo: rawType === 'demo',
      isUpcoming: Boolean(data.release_date?.coming_soon),
      isFreeToPlay: Boolean(data.is_free) && (!priceOverview || priceOverview.initial === 0),
      originalPrice,
      originalPriceFormatted:
        priceOverview?.initial_formatted ||
        offer.originalPriceFormatted ||
        (originalPrice > 0 ? `$${originalPrice.toFixed(2)}` : '$0.00'),
      discountPrice,
      discountPercent,
      currency: priceOverview?.currency || offer.currency || 'USD',
      isLimitedTime: discountPercent === 100 && originalPrice > 0
    };
  } catch {
    return offer;
  }
}

/**
 * Built-in Steam Store search source adapter.
 */
async function fetchFromSteamSearch(endpoints) {
  const url =
    endpoints.searchResults ||
    'https://store.steampowered.com/search/results/?query=&maxprice=free&specials=1&infinite=1&json=1';

  const resp = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store'
  });
  if (!resp.ok) {
    throw new Error(`Steam search request failed (${resp.status})`);
  }

  const payload = await resp.json();
  const candidates = parseSteamSearchHtml(payload?.results_html || '', endpoints);

  // Only enrich candidates that look like 100% free promos to minimize API calls
  const enriched = [];
  for (const candidate of candidates) {
    if (candidate.discountPercent === 100 || candidate.discountPrice === 0) {
      enriched.push(await enrichFromAppDetails(candidate));
    } else {
      enriched.push(candidate);
    }
  }
  return enriched;
}

/**
 * Optional community SteamDB source adapter (requires steamdb.info optional host permission).
 */
async function fetchFromSteamDb(endpoints) {
  const url = endpoints.steamdbFree || 'https://steamdb.info/upcoming/free/';
  const resp = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!resp.ok) {
    throw new Error(`SteamDB source failed (${resp.status})`);
  }
  const html = await resp.text();
  return parseSteamDbFreeHtml(html);
}

const BUILTIN_SOURCES = {
  steam_search: fetchFromSteamSearch,
  steamdb: fetchFromSteamDb
};

/**
 * Register or select a swappable Steam offer source.
 * @param {string} sourceId
 * @param {(endpoints: object) => Promise<object[]>} [fetcher]
 */
export function setSteamSource(sourceId, fetcher = null) {
  if (fetcher && typeof fetcher === 'function') {
    customSources.set(sourceId, fetcher);
  }
  activeSourceId = sourceId;
}

/**
 * Fetch current free-promotion candidates from the active Steam source.
 * @param {{ config?: object, sourceId?: string }} [context]
 * @returns {Promise<object[]>}
 */
export async function fetchOffers(context = {}) {
  const endpoints = context.config?.stores?.steam?.endpoints || {};
  const sourceKey = context.sourceId || activeSourceId;
  const fetcher = customSources.get(sourceKey) || BUILTIN_SOURCES[sourceKey];
  if (!fetcher) {
    throw new Error(`Unknown Steam source: ${sourceKey}`);
  }
  return fetcher(endpoints);
}

/**
 * Best-effort Steam ownership check using history and Steam's dynamicstore userdata API.
 * @param {object} offer
 * @param {{ config?: object, history?: Record<string, object>, steamUserdata?: object }} [context]
 * @returns {Promise<boolean>}
 */
export async function isOwned(offer, context = {}) {
  const key = `${id}:${offer.id}`;
  const entry = context.history?.[key];
  if (entry && entry.status === 'CLAIMED' && !entry.dryRun) {
    return true;
  }

  try {
    let userdata = context.steamUserdata;
    if (!userdata) {
      const endpoint =
        context.config?.stores?.steam?.endpoints?.userdata ||
        'https://store.steampowered.com/dynamicstore/userdata/';
      const resp = await fetch(endpoint, { credentials: 'include', cache: 'no-store' });
      if (resp.ok) {
        userdata = await resp.json();
        if (context && typeof context === 'object') {
          context.steamUserdata = userdata;
        }
      }
    }
    const ownedApps = userdata?.rgOwnedApps;
    if (Array.isArray(ownedApps)) {
      return ownedApps.includes(Number(offer.id));
    }
  } catch {
    // Best-effort check failed; fallback to DOM inspection during claim
  }
  return false;
}

/**
 * Auto-claim a Steam free-to-keep app/DLC by opening its store page in a background tab,
 * handling age gates, verifying ownership, and clicking "Add to Account".
 * @param {object} offer
 * @param {{ config?: object, dryRun?: boolean, signal?: AbortSignal }} [context]
 * @returns {Promise<{ status: string, reason?: string, alreadyOwned?: boolean, dryRun?: boolean, tabId?: number }>}
 */
export async function claim(offer, context = {}) {
  const steamCfg = context.config?.stores?.steam || {};
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

    let state = null;
    let ageGateAttempted = false;

    for (let attempt = 0; attempt < 15; attempt++) {
      if (signal?.aborted) throw new Error('timeout');

      const frames = await listTabFrames(tab.id);
      const topFrame = frames.find((f) => f.isTop);
      if (!topFrame) {
        await delay(800, signal);
        continue;
      }

      state = await sendFrameMessage(
        tab.id,
        topFrame.frameId,
        STEAM_CONTENT_SCRIPT,
        { action: 'STEAM_INSPECT_PAGE', config: steamCfg },
        signal
      );

      if (state?.ageGate) {
        if (!ageGateAttempted) {
          ageGateAttempted = true;
          await humanDelay(1000, 2000, signal);
          const passResult = await sendFrameMessage(
            tab.id,
            topFrame.frameId,
            STEAM_CONTENT_SCRIPT,
            { action: 'STEAM_PASS_AGE_GATE', config: steamCfg },
            signal
          );
          if (!passResult?.passed) {
            return await handoffToUser('Age gate could not be passed automatically');
          }
          await delay(1500, signal);
          continue;
        }
        return await handoffToUser('Age gate verification required on Steam');
      }

      if (state?.ready) break;
      await delay(900, signal);
    }

    if (!state) {
      return { status: CLAIM_STATUS.FAILED, reason: 'Could not inspect Steam app page' };
    }

    if (state.unavailable) {
      return await handoffToUser('Unavailable in your region');
    }
    if (state.owned) {
      return {
        status: CLAIM_STATUS.CLAIMED,
        alreadyOwned: true,
        reason: 'Already in Steam library'
      };
    }
    if (state.freeWeekendOrTrial) {
      return {
        status: CLAIM_STATUS.FAILED,
        reason: 'Offer is a free weekend/trial, not free-to-keep'
      };
    }
    if (state.loginRequired && !state.hasAddButton) {
      return await handoffToUser('Login required on Steam');
    }
    if (!state.hasAddButton) {
      return await handoffToUser('Add to Account button not found on Steam page');
    }

    if (dryRun) {
      return {
        status: CLAIM_STATUS.CLAIMED,
        dryRun: true,
        reason: 'Dry-run: reached Add to Account button without clicking'
      };
    }

    await humanDelay(1000, 3000, signal);

    const frames = await listTabFrames(tab.id);
    const topFrame = frames.find((f) => f.isTop);
    if (!topFrame) {
      return { status: CLAIM_STATUS.FAILED, reason: 'Steam tab frame lost before claim click' };
    }

    const clickResult = await sendFrameMessage(
      tab.id,
      topFrame.frameId,
      STEAM_CONTENT_SCRIPT,
      { action: 'STEAM_CLICK_ADD_TO_ACCOUNT', config: steamCfg },
      signal
    );

    if (!clickResult?.clicked) {
      return await handoffToUser(clickResult?.reason || 'Failed to click Add to Account');
    }

    // Poll for license grant confirmation or login redirect
    for (let step = 0; step < 15; step++) {
      if (signal?.aborted) throw new Error('timeout');
      await delay(1000, signal);

      const currentTab = await chrome.tabs.get(tab.id);
      if (/steampowered\.com\/login/i.test(currentTab.url || '')) {
        return await handoffToUser('Login required on Steam');
      }

      const curFrames = await listTabFrames(tab.id);
      const curTop = curFrames.find((f) => f.isTop);
      if (!curTop) continue;

      const postState = await sendFrameMessage(
        tab.id,
        curTop.frameId,
        STEAM_CONTENT_SCRIPT,
        { action: 'STEAM_INSPECT_PAGE', config: steamCfg },
        signal
      );

      if (postState?.claimedSuccess || postState?.owned) {
        return { status: CLAIM_STATUS.CLAIMED };
      }
      if (postState?.loginRequired) {
        return await handoffToUser('Login required on Steam');
      }
    }

    return await handoffToUser('Steam claim submitted — verify license in tab');
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
