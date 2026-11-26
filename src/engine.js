/**
 * Core orchestration engine for ClaimIt.
 * Executes scheduled and manual check cycles, enforces rate limiting (one claim at a time),
 * 60-second per-claim timeouts, dry-run mode, pause switch aborting, and error isolation.
 */

import { classifyOffers } from './classifier.js';
import { getSelectorsConfig } from './remote-config.js';
import { getEnabledProviders, getProvider } from './providers/index.js';
import { fetchSteamDeals } from './providers/steam.js';
import { CLAIM_STATUS, humanDelay } from './providers/constants.js';
import {
  getSettings,
  getHistory,
  upsertHistoryEntry,
  setCurrentOffers,
  getCurrentOffers,
  updateMeta,
  getMeta,
  acquireCycleLock,
  releaseCycleLock,
  makeOfferKey,
  getRegionState,
  saveRegionState,
  getCachedFxRates,
  setCachedFxRates,
  saveAccountState,
  setSteamDeals
} from './storage.js';
import {
  resolveRegionAndCurrency,
  getExchangeRates,
  normalizeCurrencyCode,
  normalizeCountryCode
} from './currency.js';
import { scheduleNextScan } from './scheduler.js';
import { notifyOfferOutcome } from './notifications.js';
import { logger } from './logger.js';

export const CLAIM_TIMEOUT_MS = 60_000;
export const MAX_CLAIMS_PER_CYCLE = 20;

let activeCyclePromise = null;
let activeCycleAbortController = null;
let activeClaimAbortController = null;
let claimQueue = Promise.resolve();

/**
 * Abort any in-flight cycle delay or claim immediately when the user flips Pause.
 */
export function abortActiveAutomation() {
  if (activeCycleAbortController) {
    activeCycleAbortController.abort(new Error('paused'));
  }
  if (activeClaimAbortController) {
    activeClaimAbortController.abort(new Error('paused'));
  }
}

/**
 * Serialize claim attempts so at most one store claim runs at any instant.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runSerializedClaim(fn) {
  const next = claimQueue.then(fn, fn);
  claimQueue = next.catch(() => {});
  return next;
}

/**
 * Run a provider's claim() strictly bounded by a timeout AbortController.
 * Ensures at most one claim executes at a time and always yields CLAIMED | NEEDS_USER | FAILED.
 * @param {object} provider
 * @param {object} offer
 * @param {object} context
 * @param {number} [timeoutMs=CLAIM_TIMEOUT_MS]
 */
export async function executeClaimWithTimeout(provider, offer, context, timeoutMs = CLAIM_TIMEOUT_MS) {
  return runSerializedClaim(async () => {
    const controller = new AbortController();
    activeClaimAbortController = controller;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, timeoutMs);

    try {
      const result = await provider.claim(offer, {
        ...context,
        signal: controller.signal
      });
      if (!result || !result.status) {
        return { status: CLAIM_STATUS.FAILED, reason: 'Invalid provider claim result' };
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (timedOut || message === 'timeout') {
        return { status: CLAIM_STATUS.FAILED, reason: 'timeout' };
      }
      if (message === 'paused') {
        return { status: CLAIM_STATUS.FAILED, reason: 'Paused by user' };
      }
      return { status: CLAIM_STATUS.FAILED, reason: message };
    } finally {
      clearTimeout(timer);
      if (activeClaimAbortController === controller) {
        activeClaimAbortController = null;
      }
    }
  });
}

/**
 * Build a displayable offer entry for Popup's "Free now" tab.
 */
function buildOfferSnapshot(offer, status, reason = null, extra = {}) {
  const numericPrice = Number(offer.originalPrice ?? offer.originalPriceValue ?? 0);
  const cleanPrice = Number.isFinite(numericPrice) && numericPrice > 0 ? numericPrice : 0;
  const currencyCode = normalizeCurrencyCode(offer.currencyCode ?? offer.currency);

  return {
    key: makeOfferKey(offer.store, offer.id),
    id: offer.id,
    store: offer.store,
    storeName: offer.storeName || offer.store,
    title: offer.title,
    url: offer.url,
    image: offer.image,
    type: offer.type,
    label: offer.label || null,
    originalPrice: cleanPrice,
    originalPriceValue: cleanPrice,
    originalPriceFormatted: offer.originalPriceFormatted || '',
    currencyCode,
    currency: currencyCode,
    country: normalizeCountryCode(offer.country),
    priceSource: offer.priceSource || 'store',
    endDate: offer.endDate || null,
    status,
    reason,
    dryRun: Boolean(extra.dryRun),
    alreadyOwned: Boolean(extra.alreadyOwned),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Run one complete check cycle across all enabled store providers.
 * @param {{ trigger?: string, forceConfigRefresh?: boolean, deps?: object }} [options]
 */
export async function runCheckCycle(options = {}) {
  if (activeCyclePromise) {
    return activeCyclePromise;
  }

  activeCyclePromise = runCheckCycleInternal(options).finally(() => {
    activeCyclePromise = null;
  });
  return activeCyclePromise;
}

async function runCheckCycleInternal(options = {}) {
  const trigger = options.trigger || 'manual';
  const deps = options.deps || {};
  const loadSettings = deps.getSettings || getSettings;
  const loadHistory = deps.getHistory || getHistory;
  const loadConfig = deps.getSelectorsConfig || getSelectorsConfig;
  const getProvidersFn = deps.getEnabledProviders || getEnabledProviders;
  const notifyFn = deps.notifyOfferOutcome || notifyOfferOutcome;
  const upsertHistoryFn = deps.upsertHistoryEntry || upsertHistoryEntry;
  const saveCurrentOffersFn = deps.setCurrentOffers || setCurrentOffers;
  const loadCurrentOffersFn = deps.getCurrentOffers || getCurrentOffers;
  const updateMetaFn = deps.updateMeta || updateMeta;
  const loadMetaFn = deps.getMeta || getMeta;
  const scheduleFn = deps.scheduleNextScan || scheduleNextScan;
  const acquireLockFn = deps.acquireCycleLock || acquireCycleLock;
  const releaseLockFn = deps.releaseCycleLock || releaseCycleLock;
  const timeoutMs = deps.claimTimeoutMs || CLAIM_TIMEOUT_MS;
  const interClaimDelayFn =
    deps.interClaimDelay || ((sig) => humanDelay(1500, 3000, sig));

  const settings = await loadSettings();
  if (settings.paused) {
    await logger.info('engine', `Skipped ${trigger} cycle because automation is paused`);
    const existingOffers = await loadCurrentOffersFn();
    if (trigger !== 'manual') {
      const nowMs = Date.now();
      await scheduleFn({ lastScanMs: nowMs, offers: existingOffers, nowMs });
    }
    return { skipped: true, reason: 'paused', offers: existingOffers, newOffersCount: 0 };
  }

  const cycleId = `cycle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const acquired = await acquireLockFn(cycleId);
  if (!acquired) {
    await logger.info('engine', `Skipped ${trigger} cycle because another check is already running`);
    return { skipped: true, reason: 'locked', offers: await loadCurrentOffersFn(), newOffersCount: 0 };
  }

  const cycleController = new AbortController();
  activeCycleAbortController = cycleController;
  await updateMetaFn({ isChecking: true, lastCycleId: cycleId });
  await logger.info('engine', `Starting check cycle (${trigger})`, {
    cycleId,
    dryRun: settings.dryRun
  });

  const snapshotOffers = [];
  let claimsAttempted = 0;
  let newOffersCount = 0;

  try {
    const { config, source } = await loadConfig({ forceRefresh: Boolean(options.forceConfigRefresh) });
    await logger.debug('engine', `Loaded selectors config from ${source}`);

    const providers = getProvidersFn(settings);
    const history = await loadHistory();
    let storedRegion = await getRegionState();
    let region = resolveRegionAndCurrency({ settings, storedRegion });

    for (const provider of providers) {
      const currentSettings = await loadSettings();
      if (currentSettings.paused || cycleController.signal.aborted) {
        await logger.info('engine', 'Automation paused mid-cycle; stopping further stores');
        break;
      }

      const storeCfg = currentSettings.stores?.[provider.id] || { enabled: true, mode: 'auto' };
      region = resolveRegionAndCurrency({ settings: currentSettings, storedRegion });
      const providerCtx = { config, settings: currentSettings, history, region };

      let rawOffers = [];
      try {
        rawOffers = await provider.fetchOffers(providerCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.error('engine', `Provider ${provider.id} fetchOffers failed`, { error: msg });
        continue; // Error isolation: broken store never stops others
      }

      const detectedStoreOffer = (rawOffers || []).find(
        (o) => normalizeCurrencyCode(o?.currencyCode ?? o?.currency)
      );
      if (detectedStoreOffer) {
        const observedCur = normalizeCurrencyCode(detectedStoreOffer.currencyCode ?? detectedStoreOffer.currency);
        const observedCountry = normalizeCountryCode(detectedStoreOffer.country) || region.country;
        if (
          observedCur &&
          (observedCur !== storedRegion.storeCurrency || observedCountry !== storedRegion.storeCountry)
        ) {
          storedRegion = await saveRegionState({
            storeCurrency: observedCur,
            storeCountry: observedCountry
          });
          region = resolveRegionAndCurrency({ settings: currentSettings, storedRegion });
        }
      }

      const cycleNowMs = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
      const { eligible, excluded } = classifyOffers(rawOffers, cycleNowMs);
      await logger.info('engine', `Provider ${provider.id} fetched offers`, {
        total: rawOffers.length,
        eligible: eligible.length,
        excluded: excluded.map((e) => ({ title: e.offer?.title, reason: e.reason }))
      });

      const needsFx = eligible.some((o) => {
        const oc = normalizeCurrencyCode(o?.currencyCode ?? o?.currency);
        return oc && oc !== region.currency;
      });
      if (needsFx) {
        await getExchangeRates({
          cached: await getCachedFxRates(),
          saveCacheFn: setCachedFxRates
        }).catch(() => null);
      }

      for (const offer of eligible) {
        const latestSettings = await loadSettings();
        if (latestSettings.paused || cycleController.signal.aborted) {
          await logger.info('engine', 'Automation paused mid-cycle; aborting remaining offers');
          break;
        }

        const key = makeOfferKey(offer.store, offer.id);
        const existing = history[key];

        // 1. Skip already claimed in history
        if (existing && existing.status === CLAIM_STATUS.CLAIMED && !existing.dryRun) {
          snapshotOffers.push(
            buildOfferSnapshot(offer, CLAIM_STATUS.CLAIMED, existing.reason || null, {
              alreadyOwned: existing.alreadyOwned
            })
          );
          continue;
        }

        // 2. Best-effort ownership check
        let owned = false;
        try {
          owned = await provider.isOwned(offer, providerCtx);
        } catch (err) {
          await logger.warn('engine', `isOwned check failed for ${key}`, {
            error: err instanceof Error ? err.message : String(err)
          });
        }

        if (owned) {
          await upsertHistoryFn({
            ...buildOfferSnapshot(offer, CLAIM_STATUS.CLAIMED, 'Already owned', { alreadyOwned: true }),
            alreadyOwned: true
          });
          snapshotOffers.push(
            buildOfferSnapshot(offer, CLAIM_STATUS.CLAIMED, 'Already owned', { alreadyOwned: true })
          );
          continue;
        }

        // 3. Auto-claim vs Notify-only mode
        newOffersCount += 1;
        if (storeCfg.mode !== 'auto') {
          const reason = 'Auto-claim disabled for store (Notify only)';
          await upsertHistoryFn(buildOfferSnapshot(offer, CLAIM_STATUS.NEEDS_USER, reason));
          await notifyFn({
            offer,
            status: CLAIM_STATUS.NEEDS_USER,
            reason,
            cycleId,
            settings: latestSettings
          });
          snapshotOffers.push(buildOfferSnapshot(offer, CLAIM_STATUS.NEEDS_USER, reason));
          continue;
        }

        if (claimsAttempted >= MAX_CLAIMS_PER_CYCLE) {
          const capReason = `Skipped auto-claim after reaching per-cycle safety limit (${MAX_CLAIMS_PER_CYCLE})`;
          await logger.warn('engine', capReason, { key });
          snapshotOffers.push(buildOfferSnapshot(offer, CLAIM_STATUS.NEEDS_USER, capReason));
          continue;
        }

        // Rate-limit: one claim at a time with human-like delay between consecutive claims
        if (claimsAttempted > 0) {
          try {
            await interClaimDelayFn(cycleController.signal);
          } catch {
            await logger.info('engine', 'Inter-claim delay aborted by pause');
            break;
          }
        }
        claimsAttempted += 1;

        await logger.info('engine', `Attempting claim on ${offer.store}`, {
          id: offer.id,
          title: offer.title,
          dryRun: latestSettings.dryRun
        });

        const result = await executeClaimWithTimeout(
          provider,
          offer,
          { config, dryRun: latestSettings.dryRun, history },
          timeoutMs
        );

        const snap = buildOfferSnapshot(offer, result.status, result.reason || null, {
          dryRun: Boolean(result.dryRun || (latestSettings.dryRun && result.status === CLAIM_STATUS.CLAIMED)),
          alreadyOwned: Boolean(result.alreadyOwned)
        });

        if (result.status === CLAIM_STATUS.CLAIMED) {
          await saveAccountState(offer.store, { signedIn: true });
        } else if (result.status === CLAIM_STATUS.NEEDS_USER && /login/i.test(result.reason || '')) {
          await saveAccountState(offer.store, { signedIn: false });
        }

        if (result.status === CLAIM_STATUS.CLAIMED && snap.dryRun) {
          await logger.info('engine', `Dry-run completed for ${offer.title}`, {
            store: offer.store,
            reason: result.reason
          });
        } else {
          await upsertHistoryFn(snap);
        }

        await notifyFn({
          offer,
          status: result.status,
          reason: result.reason,
          tabId: result.tabId,
          dryRun: snap.dryRun,
          cycleId,
          settings: latestSettings
        });

        snapshotOffers.push(snap);
        await logger.info('engine', `Claim finished: ${result.status}`, {
          key,
          reason: result.reason || null,
          dryRun: snap.dryRun
        });
      }
    }

    const finishedMs = typeof deps.nowMs === 'function' ? deps.nowMs() : Date.now();
    const finishedIso = new Date(finishedMs).toISOString();
    await saveCurrentOffersFn(snapshotOffers);

    // Fetch paid Steam discounted specials (40-99%) strictly for user browsing (never auto-claimed)
    const latestForDeals = await loadSettings();
    const fetchDealsFn = deps.fetchSteamDeals || fetchSteamDeals;
    if (latestForDeals.stores?.steam?.enabled && Number(latestForDeals.steamMinDiscount) < 100) {
      try {
        const steamDeals = await fetchDealsFn({
          config,
          region,
          minDiscount: 40
        });
        await setSteamDeals(steamDeals);
      } catch (err) {
        await logger.warn('engine', 'Failed to refresh Steam discount deals', {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } else if (Number(latestForDeals.steamMinDiscount) >= 100) {
      await setSteamDeals([]);
    }
    const metaBefore = await loadMetaFn();
    const shouldReschedule =
      trigger !== 'manual' ||
      newOffersCount > 0 ||
      !metaBefore?.nextScanAt ||
      Date.parse(metaBefore.nextScanAt) <= finishedMs;

    if (shouldReschedule) {
      await updateMetaFn({ isChecking: false, lastCycleId: cycleId });
      await scheduleFn({ lastScanMs: finishedMs, offers: snapshotOffers, nowMs: finishedMs });
    } else {
      await updateMetaFn({
        isChecking: false,
        lastScanAt: finishedIso,
        lastCheckedAt: finishedIso,
        lastCycleId: cycleId
      });
    }

    return { skipped: false, cycleId, offers: snapshotOffers, newOffersCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error('engine', 'Unexpected error during check cycle', { error: msg });
    await updateMetaFn({ isChecking: false });
    return { skipped: false, error: msg, offers: snapshotOffers };
  } finally {
    if (activeCycleAbortController === cycleController) {
      activeCycleAbortController = null;
    }
    await releaseLockFn(cycleId);
  }
}

/**
 * Claim a single offer explicitly triggered from the Popup "Claim" button.
 * @param {string} storeId
 * @param {string} offerId
 */
export async function claimSingleOffer(storeId, offerId) {
  const settings = await getSettings();
  if (settings.paused) {
    return { status: CLAIM_STATUS.FAILED, reason: 'Automation is paused' };
  }

  const provider = getProvider(storeId);
  if (!provider) {
    return { status: CLAIM_STATUS.FAILED, reason: `Unknown store: ${storeId}` };
  }

  const offers = await getCurrentOffers();
  const offer = offers.find((o) => o.store === storeId && o.id === offerId);
  if (!offer) {
    return { status: CLAIM_STATUS.FAILED, reason: 'Offer not found in current cycle' };
  }

  const { config } = await getSelectorsConfig();
  const history = await getHistory();
  const result = await executeClaimWithTimeout(provider, offer, {
    config,
    dryRun: settings.dryRun,
    history
  });

  const snap = buildOfferSnapshot(offer, result.status, result.reason || null, {
    dryRun: Boolean(result.dryRun || (settings.dryRun && result.status === CLAIM_STATUS.CLAIMED)),
    alreadyOwned: Boolean(result.alreadyOwned)
  });

  if (result.status === CLAIM_STATUS.CLAIMED) {
    await saveAccountState(offer.store, { signedIn: true });
  } else if (result.status === CLAIM_STATUS.NEEDS_USER && /login/i.test(result.reason || '')) {
    await saveAccountState(offer.store, { signedIn: false });
  }

  if (!(result.status === CLAIM_STATUS.CLAIMED && snap.dryRun)) {
    await upsertHistoryEntry(snap);
  }

  const updated = offers.map((o) => (o.key === snap.key ? snap : o));
  await setCurrentOffers(updated);

  const meta = await getMeta();
  await notifyOfferOutcome({
    offer,
    status: result.status,
    reason: result.reason,
    tabId: result.tabId,
    dryRun: snap.dryRun,
    cycleId: meta.lastCycleId || `manual-${Date.now()}`,
    settings
  });

  return result;
}

/**
 * Refresh Steam's paid discount deals list on demand (e.g. when user lowers the % threshold).
 */
export async function refreshSteamDeals() {
  const [settings, storedRegion, { config }] = await Promise.all([
    getSettings(),
    getRegionState(),
    getSelectorsConfig()
  ]);
  if (!settings.stores?.steam?.enabled || Number(settings.steamMinDiscount) >= 100) {
    await setSteamDeals([]);
    return [];
  }
  const region = resolveRegionAndCurrency({ settings, storedRegion });
  const deals = await fetchSteamDeals({ config, region, minDiscount: 40 });
  await setSteamDeals(deals);
  return deals;
}
