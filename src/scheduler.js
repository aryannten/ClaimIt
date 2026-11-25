/**
 * Once-daily randomized one-shot scheduler built on chrome.alarms ({ when }).
 * Uses zero timers (no setTimeout/setInterval) and zero periodInMinutes polling.
 */

import { getMeta, updateMeta } from './storage.js';

export const CHECK_ALARM_NAME = 'claimit_check_alarm';

const ONE_HOUR_MS = 60 * 60 * 1000;
export const MIN_SCAN_INTERVAL_MS = 12 * ONE_HOUR_MS;
export const BASE_SCAN_INTERVAL_MS = 24 * ONE_HOUR_MS;
export const MAX_SCAN_INTERVAL_MS = 36 * ONE_HOUR_MS;
export const SCAN_JITTER_HALF_RANGE_MS = 6 * ONE_HOUR_MS;
export const OFFER_EXPIRY_MARGIN_MS = ONE_HOUR_MS;
export const CATCHUP_MIN_DELAY_MS = 30 * 1000;
export const CATCHUP_MAX_DELAY_MS = 180 * 1000;
export const MANUAL_CHECK_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Compute the next scan timestamp in epoch ms:
 * previous scan time + 24h + random(-6h..+6h), strictly clamped within [12h, 36h] after prev.
 * If an active/unclaimed offer expires before that time, move the alarm to a random time
 * before expiry with at least 1 hour of safety margin.
 *
 * @param {{
 *   lastScanMs?: number|null,
 *   offers?: Array<{ endDate?: string|null, status?: string }>,
 *   nowMs?: number,
 *   randomFn?: () => number
 * }} [params]
 * @returns {number}
 */
export function computeNextScanAt({
  lastScanMs = null,
  offers = [],
  nowMs = Date.now(),
  randomFn = Math.random
} = {}) {
  const baseMs = Number.isFinite(lastScanMs) ? lastScanMs : nowMs;
  const jitterMs = Math.round((randomFn() * 2 - 1) * SCAN_JITTER_HALF_RANGE_MS);
  let targetMs = baseMs + BASE_SCAN_INTERVAL_MS + jitterMs;

  const minAllowedMs = baseMs + MIN_SCAN_INTERVAL_MS;
  const maxAllowedMs = baseMs + MAX_SCAN_INTERVAL_MS;
  targetMs = Math.max(minAllowedMs, Math.min(maxAllowedMs, targetMs));

  let earliestEndMs = Infinity;
  for (const offer of Array.isArray(offers) ? offers : []) {
    if (!offer || offer.status === 'CLAIMED' || !offer.endDate) continue;
    const endMs = Date.parse(offer.endDate);
    if (Number.isFinite(endMs) && endMs > nowMs && endMs < targetMs && endMs < earliestEndMs) {
      earliestEndMs = endMs;
    }
  }

  if (Number.isFinite(earliestEndMs)) {
    const latestSafeMs = earliestEndMs - OFFER_EXPIRY_MARGIN_MS;
    if (latestSafeMs > nowMs) {
      const windowFloor = Math.max(nowMs + 60 * 1000, latestSafeMs - 3 * ONE_HOUR_MS);
      const low = Math.min(windowFloor, latestSafeMs);
      targetMs = low + Math.round(randomFn() * (latestSafeMs - low));
    }
  }

  return Math.round(targetMs);
}

/**
 * Pick a randomized catch-up scan time 30 to 180 seconds after browser startup / install.
 * @param {number} [nowMs=Date.now()]
 * @param {() => number} [randomFn=Math.random]
 * @returns {number}
 */
export function computeCatchUpWhen(nowMs = Date.now(), randomFn = Math.random) {
  const span = CATCHUP_MAX_DELAY_MS - CATCHUP_MIN_DELAY_MS;
  return nowMs + CATCHUP_MIN_DELAY_MS + Math.round(randomFn() * span);
}

/**
 * Enforce manual check cooldown (default 5 minutes) backed by stored lastManualCheckAt.
 * @param {string|number|null|undefined} lastManualCheckAt
 * @param {number} [nowMs=Date.now()]
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
export function checkManualRateLimit(lastManualCheckAt, nowMs = Date.now()) {
  const lastMs =
    typeof lastManualCheckAt === 'number'
      ? lastManualCheckAt
      : Date.parse(lastManualCheckAt || '');
  if (!Number.isFinite(lastMs)) {
    return { allowed: true, retryAfterMs: 0 };
  }
  const elapsed = nowMs - lastMs;
  if (elapsed < MANUAL_CHECK_COOLDOWN_MS) {
    return { allowed: false, retryAfterMs: MANUAL_CHECK_COOLDOWN_MS - elapsed };
  }
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Ensure a single one-shot alarm exists at `whenMs` without creating duplicates on worker restarts.
 * @param {number} whenMs
 * @returns {Promise<{ created: boolean, when: number }>}
 */
export async function ensureAlarmAt(whenMs) {
  if (typeof chrome === 'undefined' || !chrome.alarms) {
    return { created: false, when: whenMs };
  }
  const existing = await chrome.alarms.get(CHECK_ALARM_NAME);
  if (
    existing &&
    !existing.periodInMinutes &&
    Number.isFinite(existing.scheduledTime) &&
    Math.abs(existing.scheduledTime - whenMs) < 1000
  ) {
    return { created: false, when: existing.scheduledTime };
  }
  if (existing) {
    await chrome.alarms.clear(CHECK_ALARM_NAME);
  }
  await chrome.alarms.create(CHECK_ALARM_NAME, { when: whenMs });
  return { created: true, when: whenMs };
}

/**
 * Persist scan timestamps and schedule the next one-shot daily alarm after a completed scan.
 */
export async function scheduleNextScan({
  lastScanMs = Date.now(),
  offers = [],
  nowMs = Date.now(),
  randomFn = Math.random
} = {}) {
  const whenMs = computeNextScanAt({ lastScanMs, offers, nowMs, randomFn });
  const lastIso = new Date(lastScanMs).toISOString();
  const nextIso = new Date(whenMs).toISOString();

  await updateMeta({
    lastScanAt: lastIso,
    lastCheckedAt: lastIso,
    nextScanAt: nextIso
  });
  await ensureAlarmAt(whenMs);
  return { lastScanAt: lastIso, nextScanAt: nextIso, whenMs };
}

/**
 * Synchronize alarm state on extension install or browser startup.
 * Never scans immediately on startup:
 * - Future nextScanAt: keeps or recreates the alarm cleanly without running a scan.
 * - Missing or past nextScanAt: schedules ONE delayed catch-up scan (30-180 s random delay),
 *   unless an automatic scan already ran within the last 12 hours.
 */
export async function syncScheduleOnStartup({
  nowMs = Date.now(),
  randomFn = Math.random
} = {}) {
  const meta = await getMeta();
  const nextMs = Date.parse(meta.nextScanAt || '');
  const lastMs = Date.parse(meta.lastScanAt || meta.lastCheckedAt || '');

  if (Number.isFinite(nextMs) && nextMs > nowMs) {
    await ensureAlarmAt(nextMs);
    return { action: 'recreated', whenMs: nextMs, nextScanAt: meta.nextScanAt };
  }

  // Enforce max one automatic scan per day even across rapid restarts with stale metadata
  if (Number.isFinite(lastMs) && nowMs - lastMs < MIN_SCAN_INTERVAL_MS) {
    const futureMs = computeNextScanAt({ lastScanMs: lastMs, nowMs, randomFn });
    const nextIso = new Date(futureMs).toISOString();
    await updateMeta({ nextScanAt: nextIso });
    await ensureAlarmAt(futureMs);
    return { action: 'deferred_same_day', whenMs: futureMs, nextScanAt: nextIso };
  }

  if (typeof chrome !== 'undefined' && chrome.alarms) {
    const existing = await chrome.alarms.get(CHECK_ALARM_NAME);
    if (
      existing &&
      !existing.periodInMinutes &&
      Number.isFinite(existing.scheduledTime) &&
      existing.scheduledTime > nowMs &&
      existing.scheduledTime <= nowMs + CATCHUP_MAX_DELAY_MS + 5000
    ) {
      return {
        action: 'catchup_already_pending',
        whenMs: existing.scheduledTime,
        nextScanAt: new Date(existing.scheduledTime).toISOString()
      };
    }
  }

  const catchUpMs = computeCatchUpWhen(nowMs, randomFn);
  const catchUpIso = new Date(catchUpMs).toISOString();
  await updateMeta({ nextScanAt: catchUpIso });
  await ensureAlarmAt(catchUpMs);
  return { action: 'scheduled_catchup', whenMs: catchUpMs, nextScanAt: catchUpIso };
}
