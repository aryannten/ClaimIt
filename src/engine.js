/**
 * Core orchestration engine for ClaimIt.
 * Executes scheduled and manual check cycles, enforces rate limiting (one claim at a time),
 * 60-second per-claim timeouts, dry-run mode, pause switch aborting, and error isolation.
 */

import { classifyOffers } from './classifier.js';
import { getSelectorsConfig } from './remote-config.js';
import { getEnabledProviders, getProvider } from './providers/index.js';
import { CLAIM_STATUS, humanDelay } from './providers/constants.js';
import {
  getSettings,
  getHistory,
  upsertHistoryEntry,
  setCurrentOffers,
  getCurrentOffers,
  updateMeta,
  getMeta,
  makeOfferKey
} from './storage.js';
import { notifyOfferOutcome } from './notifications.js';
import { logger } from './logger.js';

export const CLAIM_TIMEOUT_MS = 60_000;

let activeCyclePromise = null;
let activeClaimAbortController = null;

/**
 * Abort any in-flight claim immediately when the user flips the Pause switch.
 */
export function abortActiveAutomation() {
  if (activeClaimAbortController) {
    activeClaimAbortController.abort(new Error('paused'));
  }
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
}

/**
 * Build a displayable offer entry for Popup's "Free now" tab.
 */
function buildOfferSnapshot(offer, status, reason = null, extra = {}) {
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
    originalPrice: offer.originalPriceFormatted || `$${Number(offer.originalPrice || 0).toFixed(2)}`,
    originalPriceValue: Number(offer.originalPrice || 0),
    currency: offer.currency || 'USD',
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
  const updateMetaFn = deps.updateMeta || updateMeta;
  const timeoutMs = deps.claimTimeoutMs || CLAIM_TIMEOUT_MS;
  const interClaimDelayFn = deps.interClaimDelay || (() => humanDelay(1500, 3000));

  const settings = await loadSettings();
  if (settings.paused) {
    await logger.info('engine', `Skipped ${trigger} cycle because automation is paused`);
    return { skipped: true, reason: 'paused', offers: await getCurrentOffers() };
  }

  const cycleId = `cycle-${Date.now()}`;
  await updateMetaFn({ isChecking: true, lastCycleId: cycleId });
  await logger.info('engine', `Starting check cycle (${trigger})`, {
    cycleId,
    dryRun: settings.dryRun
  });

  const snapshotOffers = [];
  let claimsAttempted = 0;

  try {
    const { config, source } = await loadConfig({ forceRefresh: Boolean(options.forceConfigRefresh) });
    await logger.debug('engine', `Loaded selectors config from ${source}`);

    const providers = getProvidersFn(settings);
    const history = await loadHistory();

    for (const provider of providers) {
      const currentSettings = await loadSettings();
      if (currentSettings.paused) {
        await logger.info('engine', 'Automation paused mid-cycle; stopping further stores');
        break;
      }

      const storeCfg = currentSettings.stores?.[provider.id] || { enabled: true, mode: 'auto' };
      const providerCtx = { config, settings: currentSettings, history };

      let rawOffers = [];
      try {
        rawOffers = await provider.fetchOffers(providerCtx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logger.error('engine', `Provider ${provider.id} fetchOffers failed`, { error: msg });
        continue; // Error isolation: broken store never stops others
      }

      const { eligible, excluded } = classifyOffers(rawOffers);
      await logger.info('engine', `Provider ${provider.id} fetched offers`, {
        total: rawOffers.length,
        eligible: eligible.length,
        excluded: excluded.map((e) => ({ title: e.offer?.title, reason: e.reason }))
      });

      for (const offer of eligible) {
        const latestSettings = await loadSettings();
        if (latestSettings.paused) {
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

        // Rate-limit: one claim at a time with human-like delay between consecutive claims
        if (claimsAttempted > 0) {
          await interClaimDelayFn();
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

    await saveCurrentOffersFn(snapshotOffers);
    await updateMetaFn({
      isChecking: false,
      lastCheckedAt: new Date().toISOString(),
      lastCycleId: cycleId
    });

    return { skipped: false, cycleId, offers: snapshotOffers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logger.error('engine', 'Unexpected error during check cycle', { error: msg });
    await updateMetaFn({ isChecking: false });
    return { skipped: false, error: msg, offers: snapshotOffers };
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

  if (!(result.status === CLAIM_STATUS.CLAIMED && snap.dryRun)) {
    await upsertHistoryFnSafe(snap);
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

async function upsertHistoryFnSafe(snap) {
  return upsertHistoryEntry(snap);
}
