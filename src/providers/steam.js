/**
 * Steam Store Provider
 *
 * Steam exposes no official free-promotion API, so all storefront scraping and
 * source adapters are isolated inside this module with a swappable source registry.
 */

import { CLAIM_STATUS, delay, humanDelay } from './constants.js';
import {
  inferCurrencyFromCountry,
  inferCurrencyFromFormatted,
  normalizeCountryCode,
  normalizeCurrencyCode
} from '../currency.js';
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
function decodeHtmlEntities(str) {
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
 * Parse a formatted store price string (with comma or dot decimals) into numeric major units.
 * @param {string} priceText
 * @returns {number}
 */
function parsePriceText(priceText) {
  const text = String(priceText || '').trim();
  if (!text || /free/i.test(text)) return 0;
  const cleaned = text.replace(/[^\d.,]/g, '');
  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma !== -1 && lastDot !== -1) {
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const decimalsLen = cleaned.length - lastComma - 1;
    // Thousands separator (e.g. ¥1,040 or ₹1,299 or ₹1,24,900) has 3 digits after comma
    normalized = decimalsLen === 3 ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
  } else {
    // Dot-only string (e.g. €14.99 or Rp 10.000)
    const dotGroups = cleaned.split('.');
    normalized = dotGroups.length > 2 ? dotGroups.join('') : cleaned;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse Steam's search results HTML fragment (from /search/results/?maxprice=free&specials=1&json=1)
 * without DOM APIs so it works inside MV3 service workers and Node unit tests.
 * @param {string} resultsHtml
 * @param {object} [endpoints]
 * @param {{ country?: string|null }} [options]
 * @returns {object[]}
 */
export function parseSteamSearchHtml(resultsHtml, endpoints = {}, options = {}) {
  const html = String(resultsHtml || '');
  if (!html) return [];

  const country = normalizeCountryCode(options.country);
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

    // Skip multi-app bundles where data-ds-appid contains multiple comma-separated IDs
    const rawAppIds = appIdMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (rawAppIds.length !== 1) continue;
    const appId = rawAppIds[0];

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
    const parsedFinalFormatted = finalFormatted ? parsePriceText(finalFormatted) : null;
    const discountPrice =
      parsedFinalFormatted !== null
        ? parsedFinalFormatted
        : (finalPriceCents !== null ? finalPriceCents / 100 : 0);

    const rawUrl = hrefMatch ? decodeHtmlEntities(hrefMatch[1]) : `${appBase}${appId}/`;
    const cleanUrl = rawUrl.split('?')[0];
    const hasFreeWeekendHint = /free\s+weekend|play\s+for\s+free/i.test(body);
    const currencyCode = origFormatted
      ? inferCurrencyFromFormatted(origFormatted, country)
      : inferCurrencyFromCountry(country);

    offers.push({
      id: appId,
      store: id,
      storeName: name,
      title,
      url: cleanUrl,
      image: imgMatch ? decodeHtmlEntities(imgMatch[1]) : '',
      originalPrice,
      originalPriceFormatted: origFormatted,
      discountPrice,
      discountPriceFormatted: finalFormatted,
      discountPercent,
      currencyCode,
      currency: currencyCode,
      country,
      priceSource: 'store',
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
      originalPrice: 0,
      originalPriceFormatted: '',
      discountPrice: 0,
      discountPercent: isKeep ? 100 : 0,
      currencyCode: null,
      currency: null,
      country: null,
      priceSource: 'store',
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
 * demos, regional prices (`cc`), and region locks are classified accurately.
 * Note: Steam `appdetails` always returns `price_overview.initial` / `final` scaled by 100
 * (even for zero-decimal currencies such as JPY).
 * @param {object} offer
 * @param {string|null} [country=null]
 * @returns {Promise<object>}
 */
async function enrichFromAppDetails(offer, country = null) {
  const cc = normalizeCountryCode(country);
  try {
    const url = new URL('https://store.steampowered.com/api/appdetails');
    url.searchParams.set('appids', String(offer.id));
    url.searchParams.set('l', 'english');
    if (cc) {
      url.searchParams.set('cc', cc);
    }

    const resp = await fetch(url.href, { method: 'GET', cache: 'no-store' });
    if (!resp.ok) return offer;
    const json = await resp.json();
    const detail = json?.[offer.id];
    if (detail && detail.success === false) {
      const regionCurrency = inferCurrencyFromCountry(cc) || offer.currencyCode || null;
      return {
        ...offer,
        originalPrice: 0,
        originalPriceFormatted: '',
        currencyCode: regionCurrency,
        currency: regionCurrency,
        country: cc || offer.country || null,
        priceSource: 'store',
        regionUnavailable: true
      };
    }
    if (!detail?.data) return offer;

    const data = detail.data;
    const rawType = String(data.type || 'game').toLowerCase();
    const priceOverview = data.price_overview || null;

    const originalPrice = priceOverview
      ? Number(priceOverview.initial ?? 0) / 100
      : 0;
    const discountPrice = priceOverview
      ? Number(priceOverview.final ?? 0) / 100
      : offer.discountPrice;
    const discountPercent = priceOverview
      ? Number(priceOverview.discount_percent ?? offer.discountPercent)
      : offer.discountPercent;
    const currencyCode =
      normalizeCurrencyCode(priceOverview?.currency) ||
      inferCurrencyFromCountry(cc) ||
      offer.currencyCode ||
      null;

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
        priceOverview?.final_formatted ||
        (originalPrice > 0 ? offer.originalPriceFormatted : ''),
      discountPrice,
      discountPercent,
      currencyCode,
      currency: currencyCode,
      country: cc || offer.country || null,
      priceSource: 'store',
      isLimitedTime: discountPercent === 100 && originalPrice > 0
    };
  } catch {
    return offer;
  }
}

/**
 * Built-in Steam Store search source adapter.
 */
async function fetchFromSteamSearch(endpoints, region = null) {
  const country = normalizeCountryCode(region?.country);
  const url = new URL(
    endpoints.searchResults ||
      'https://store.steampowered.com/search/results/?query=&maxprice=free&specials=1&infinite=1&json=1'
  );
  if (country) {
    url.searchParams.set('cc', country);
  }

  const resp = await fetch(url.href, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store'
  });
  if (!resp.ok) {
    throw new Error(`Steam search request failed (${resp.status})`);
  }

  const payload = await resp.json();
  const candidates = parseSteamSearchHtml(payload?.results_html || '', endpoints, { country });

  // Only enrich candidates that look like 100% free promos to minimize API calls
  const enriched = [];
  for (const candidate of candidates) {
    if (candidate.discountPercent === 100 || candidate.discountPrice === 0) {
      enriched.push(await enrichFromAppDetails(candidate, country));
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
  return fetcher(endpoints, context.region || null);
}

/**
 * Pure filter returning paid discounted Steam deals meeting `minDiscount` (40-99%).
 * Never includes 100%-off items (handled separately for auto-claiming) or free-to-play titles.
 * @param {object[]} offers
 * @param {number} [minDiscount=40]
 * @param {number[]|Set<number>|null} [ownedAppIds=null]
 * @returns {object[]}
 */
export function filterSteamDiscountDeals(offers, minDiscount = 40, ownedAppIds = null) {
  const threshold = Math.round(Number(minDiscount));
  if (!Number.isFinite(threshold) || threshold >= 100) return [];
  const minPct = Math.max(40, threshold);
  const ownedSet = ownedAppIds instanceof Set
    ? ownedAppIds
    : new Set(Array.isArray(ownedAppIds) ? ownedAppIds.map((x) => Number(x)) : []);

  return (Array.isArray(offers) ? offers : [])
    .filter((o) => {
      if (!o || !o.id || !o.title) return false;
      if (o.isFreeWeekend || o.isDemo || o.isFreeToPlay) return false;
      const pct = Number(o.discountPercent ?? 0);
      const orig = Number(o.originalPrice ?? 0);
      const finalP = Number(o.discountPrice ?? 0);
      if (!Number.isFinite(pct) || pct < minPct || pct >= 100) return false;
      if (!Number.isFinite(orig) || orig <= 0) return false;
      if (!Number.isFinite(finalP) || finalP <= 0) return false;
      if (ownedSet.has(Number(o.id))) return false;
      return true;
    })
    .sort((a, b) => (b.discountPercent - a.discountPercent) || (a.discountPrice - b.discountPrice));
}

/**
 * Fetch current paid discounted specials from Steam (never auto-claimed; listed cleanly for user review).
 * @param {{ config?: object, region?: { country?: string }|null, minDiscount?: number, steamUserdata?: object, fetchFn?: typeof fetch }} [context]
 * @returns {Promise<object[]>}
 */
export async function fetchSteamDeals(context = {}) {
  const minDiscount = Number(context.minDiscount ?? 40);
  if (minDiscount >= 100) return [];

  const endpoints = context.config?.stores?.steam?.endpoints || {};
  const country = normalizeCountryCode(context.region?.country);
  const fetchFn = context.fetchFn || fetch;
  const url = new URL(
    endpoints.dealsSearch ||
      'https://store.steampowered.com/search/results/?query=&specials=1&category1=998&count=50&infinite=1&json=1'
  );
  if (country) {
    url.searchParams.set('cc', country);
  }

  const resp = await fetchFn(url.href, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
    cache: 'no-store'
  });
  if (!resp.ok) {
    throw new Error(`Steam deals request failed (${resp.status})`);
  }

  const payload = await resp.json();
  const parsed = parseSteamSearchHtml(payload?.results_html || '', endpoints, { country });

  let ownedIds = context.steamUserdata?.rgOwnedApps;
  if (!Array.isArray(ownedIds)) {
    try {
      const userdataUrl = endpoints.userdata || 'https://store.steampowered.com/dynamicstore/userdata/';
      const uResp = await fetchFn(userdataUrl, { credentials: 'include', cache: 'no-store' });
      if (uResp.ok) {
        const uJson = await uResp.json();
        ownedIds = uJson?.rgOwnedApps;
        if (context && typeof context === 'object') {
          context.steamUserdata = uJson;
        }
      }
    } catch {
      // Optional ownership filter best-effort only
    }
  }

  return filterSteamDiscountDeals(parsed, Math.max(40, minDiscount), ownedIds).slice(0, 50);
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

  if (offer?.regionUnavailable) {
    return { status: CLAIM_STATUS.NEEDS_USER, reason: 'Not available in your region' };
  }

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

    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) throw new Error('timeout');

      const tabInfo = await chrome.tabs.get(tab.id);
      if (/steampowered\.com\/login/i.test(tabInfo.url || '')) {
        return await handoffToUser('Login required on Steam');
      }

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
        { action: 'STEAM_INSPECT_PAGE', config: steamCfg, waitMs: 1200 },
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
    }

    if (!state) {
      return { status: CLAIM_STATUS.FAILED, reason: 'Could not inspect Steam app page' };
    }

    if (state.unavailable) {
      return await handoffToUser('Not available in your region');
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
