import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECK_ALARM_NAME,
  MIN_SCAN_INTERVAL_MS,
  MAX_SCAN_INTERVAL_MS,
  OFFER_EXPIRY_MARGIN_MS,
  CATCHUP_MIN_DELAY_MS,
  CATCHUP_MAX_DELAY_MS,
  MANUAL_CHECK_COOLDOWN_MS,
  computeNextScanAt,
  computeCatchUpWhen,
  checkManualRateLimit,
  ensureAlarmAt,
  syncScheduleOnStartup
} from '../src/scheduler.js';
import { STORAGE_KEYS, upsertHistoryEntry, getHistory } from '../src/storage.js';
import { appendToRingBuffer } from '../src/logger.js';
import { runCheckCycle } from '../src/engine.js';
import { runManualCheck } from '../src/background.js';
import { CLAIM_STATUS } from '../src/providers/constants.js';
import { formatRoughNextScan } from '../src/ui/ui-helpers.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createChromeSchedulerMock(initialStorage = {}) {
  const store = { ...initialStorage };
  const alarms = {};
  let alarmCreateCalls = 0;

  const chromeMock = {
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: store[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = store[k];
            return out;
          }
          return { ...store };
        },
        async set(vals) {
          Object.assign(store, vals);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
        }
      }
    },
    notifications: {
      async create() { return 'n1'; },
      async clear() { return true; }
    },
    alarms: {
      async get(name) {
        return alarms[name] || null;
      },
      async clear(name) {
        delete alarms[name];
        return true;
      },
      async create(name, info) {
        alarmCreateCalls += 1;
        alarms[name] = { name, scheduledTime: info.when, ...info };
      }
    }
  };

  return {
    chromeMock,
    store,
    alarms,
    getAlarmCreateCalls: () => alarmCreateCalls
  };
}

test('computeNextScanAt always stays between 12h and 36h after previous scan and varies randomly', () => {
  const prevMs = Date.parse('2026-11-26T08:00:00.000Z');
  for (const r of [0, 0.25, 0.5, 0.75, 0.9999]) {
    const nextMs = computeNextScanAt({ lastScanMs: prevMs, nowMs: prevMs, randomFn: () => r });
    assert.ok(nextMs >= prevMs + MIN_SCAN_INTERVAL_MS);
    assert.ok(nextMs <= prevMs + MAX_SCAN_INTERVAL_MS);
  }

  const samples = new Set();
  for (let i = 0; i < 10; i++) {
    samples.add(computeNextScanAt({ lastScanMs: prevMs, nowMs: prevMs }));
  }
  assert.ok(samples.size > 1, 'Expected randomized scan timestamps across runs');
});

test('ensureAlarmAt creates a single one-shot { when } alarm and never duplicates across restarts', async () => {
  const { chromeMock, alarms, getAlarmCreateCalls } = createChromeSchedulerMock();
  globalThis.chrome = chromeMock;

  try {
    const targetMs = Date.parse('2026-11-27T10:15:00.000Z');
    const first = await ensureAlarmAt(targetMs);
    assert.equal(first.created, true);
    assert.equal(alarms[CHECK_ALARM_NAME].when, targetMs);
    assert.equal(alarms[CHECK_ALARM_NAME].periodInMinutes, undefined);
    assert.equal(getAlarmCreateCalls(), 1);

    // Worker restarts repeatedly and calls ensureAlarmAt again
    const second = await ensureAlarmAt(targetMs);
    const third = await ensureAlarmAt(targetMs + 200);
    assert.equal(second.created, false);
    assert.equal(third.created, false);
    assert.equal(getAlarmCreateCalls(), 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('startup handles past, future, and multi-day missed scans correctly with delayed single catch-up', async () => {
  const nowMs = Date.parse('2026-11-26T09:00:00.000Z');

  // 1. Future nextScanAt -> recreates alarm only, no catch-up scan scheduled
  {
    const futureIso = new Date(nowMs + 10 * 3600_000).toISOString();
    const { chromeMock, alarms, store } = createChromeSchedulerMock({
      [STORAGE_KEYS.META]: {
        lastScanAt: new Date(nowMs - 14 * 3600_000).toISOString(),
        nextScanAt: futureIso
      }
    });
    globalThis.chrome = chromeMock;
    try {
      const res = await syncScheduleOnStartup({ nowMs, randomFn: () => 0.5 });
      assert.equal(res.action, 'recreated');
      assert.equal(alarms[CHECK_ALARM_NAME].scheduledTime, Date.parse(futureIso));
      assert.equal(store[STORAGE_KEYS.META].nextScanAt, futureIso);
    } finally {
      delete globalThis.chrome;
    }
  }

  // 2. Past nextScanAt (several days missed) -> schedules ONE delayed catch-up (30s..180s)
  {
    const fiveDaysAgo = new Date(nowMs - 5 * 86400_000).toISOString();
    const sixDaysAgo = new Date(nowMs - 6 * 86400_000).toISOString();
    const { chromeMock, alarms, getAlarmCreateCalls } = createChromeSchedulerMock({
      [STORAGE_KEYS.META]: {
        lastScanAt: sixDaysAgo,
        nextScanAt: fiveDaysAgo
      }
    });
    globalThis.chrome = chromeMock;
    try {
      const res = await syncScheduleOnStartup({ nowMs, randomFn: () => 0.5 });
      assert.equal(res.action, 'scheduled_catchup');
      const delayMs = alarms[CHECK_ALARM_NAME].scheduledTime - nowMs;
      assert.ok(delayMs >= CATCHUP_MIN_DELAY_MS && delayMs <= CATCHUP_MAX_DELAY_MS);
      assert.equal(getAlarmCreateCalls(), 1);

      // Restart again before catch-up fires -> keeps existing catch-up alarm, zero duplicate
      const res2 = await syncScheduleOnStartup({ nowMs: nowMs + 10_000, randomFn: () => 0.9 });
      assert.ok(res2.action === 'recreated' || res2.action === 'catchup_already_pending');
      assert.equal(getAlarmCreateCalls(), 1);
    } finally {
      delete globalThis.chrome;
    }
  }

  // 3. Same-day safeguard (< 12h since last scan) prevents multiple automatic scans per day
  {
    const twoHoursAgo = new Date(nowMs - 2 * 3600_000).toISOString();
    const { chromeMock, alarms } = createChromeSchedulerMock({
      [STORAGE_KEYS.META]: {
        lastScanAt: twoHoursAgo,
        nextScanAt: null
      }
    });
    globalThis.chrome = chromeMock;
    try {
      const res = await syncScheduleOnStartup({ nowMs, randomFn: () => 0.5 });
      assert.equal(res.action, 'deferred_same_day');
      assert.ok(alarms[CHECK_ALARM_NAME].scheduledTime > nowMs + 10 * 3600_000);
    } finally {
      delete globalThis.chrome;
    }
  }

  const catchMin = computeCatchUpWhen(nowMs, () => 0);
  const catchMax = computeCatchUpWhen(nowMs, () => 1);
  assert.equal(catchMin - nowMs, CATCHUP_MIN_DELAY_MS);
  assert.equal(catchMax - nowMs, CATCHUP_MAX_DELAY_MS);
});

test('expiring offer pulls next scan earlier than expiry minus 1 hour margin', () => {
  const nowMs = Date.parse('2026-11-26T00:00:00.000Z');
  const soonEndMs = nowMs + 8 * 3600_000;

  for (const r of [0, 0.3, 0.99]) {
    const nextMs = computeNextScanAt({
      lastScanMs: nowMs,
      nowMs,
      offers: [
        { id: 'unclaimed', endDate: new Date(soonEndMs).toISOString(), status: 'NEEDS_USER' },
        // Already claimed items must not pull schedule earlier
        { id: 'already-got', endDate: new Date(nowMs + 2 * 3600_000).toISOString(), status: 'CLAIMED' }
      ],
      randomFn: () => r
    });
    assert.ok(nextMs > nowMs);
    assert.ok(nextMs <= soonEndMs - OFFER_EXPIRY_MARGIN_MS);
  }
});

test('manual check is rate-limited (5 min) and preserves nextScanAt when no new offers are found', async () => {
  const nowMs = Date.parse('2026-11-26T10:00:00.000Z');
  assert.equal(checkManualRateLimit(nowMs - 60_000, nowMs).allowed, false);
  assert.equal(checkManualRateLimit(nowMs - MANUAL_CHECK_COOLDOWN_MS, nowMs).allowed, true);

  const scheduledIso = new Date(nowMs + 16 * 3600_000).toISOString();
  const { chromeMock, store, alarms, getAlarmCreateCalls } = createChromeSchedulerMock({
    [STORAGE_KEYS.SETTINGS]: {
      paused: false,
      stores: { epic: { enabled: true, mode: 'auto' }, steam: { enabled: false, mode: 'auto' } }
    },
    [STORAGE_KEYS.META]: {
      lastScanAt: new Date(nowMs - 4 * 3600_000).toISOString(),
      nextScanAt: scheduledIso,
      lastManualCheckAt: null
    }
  });
  chromeMock.alarms.create(CHECK_ALARM_NAME, { when: Date.parse(scheduledIso) });
  const initialCalls = getAlarmCreateCalls();

  globalThis.chrome = chromeMock;
  try {
    // Empty scan (nothing new) via manual trigger leaves nextScanAt & existing alarm intact
    const emptyRes = await runCheckCycle({
      trigger: 'manual',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [{ id: 'epic', name: 'Epic Games Store', async fetchOffers() { return []; } }],
        nowMs: () => nowMs
      }
    });
    assert.equal(emptyRes.newOffersCount, 0);
    assert.equal(store[STORAGE_KEYS.META].nextScanAt, scheduledIso);
    assert.equal(alarms[CHECK_ALARM_NAME].scheduledTime, Date.parse(scheduledIso));
    assert.equal(getAlarmCreateCalls(), initialCalls);

    // Rate-limit via runManualCheck
    store[STORAGE_KEYS.META].lastManualCheckAt = new Date(Date.now() - 30_000).toISOString();
    const blocked = await runManualCheck(Date.now());
    assert.equal(blocked.rateLimited, true);
    assert.equal(blocked.skipped, true);

    // Manual scan finding a new offer updates schedule (e.g. pull before expiry)
    const offerEndIso = new Date(nowMs + 5 * 3600_000).toISOString();
    const newOfferRes = await runCheckCycle({
      trigger: 'manual',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [
          {
            id: 'epic',
            name: 'Epic Games Store',
            async fetchOffers() {
              return [
                {
                  id: 'fresh-1',
                  store: 'epic',
                  title: 'Fresh Free Game',
                  url: 'https://store.epicgames.com/en-US/p/fresh',
                  originalPrice: 999,
                  currencyCode: 'INR',
                  discountPrice: 0,
                  discountPercent: 100,
                  endDate: offerEndIso,
                  isLimitedTime: true,
                  type: 'game'
                }
              ];
            },
            async isOwned() { return false; },
            async claim() { return { status: CLAIM_STATUS.NEEDS_USER, reason: 'Login required' }; }
          }
        ],
        nowMs: () => nowMs
      }
    });
    assert.equal(newOfferRes.newOffersCount, 1);
    assert.notEqual(store[STORAGE_KEYS.META].nextScanAt, scheduledIso);
    assert.ok(Date.parse(store[STORAGE_KEYS.META].nextScanAt) <= Date.parse(offerEndIso) - OFFER_EXPIRY_MARGIN_MS);
  } finally {
    delete globalThis.chrome;
  }
});

test('data caps and rough next-scan formatter work accurately', async () => {
  const now = new Date('2026-11-26T10:00:00').getTime();
  const tomorrowTwoPm = new Date('2026-11-27T14:18:00').getTime();
  assert.match(formatRoughNextScan(tomorrowTwoPm, now, 'en-US'), /^tomorrow, around 2\s*PM$/i);

  let ring = [];
  for (let i = 0; i < 80; i++) {
    ring = appendToRingBuffer(ring, { i });
  }
  assert.equal(ring.length, 50);

  const bigHistory = {};
  for (let i = 0; i < 502; i++) {
    bigHistory[`epic:item-${i}`] = {
      key: `epic:item-${i}`,
      id: `item-${i}`,
      store: 'epic',
      status: 'CLAIMED',
      updatedAt: new Date(1700000000000 + i * 1000).toISOString()
    };
  }
  const { chromeMock } = createChromeSchedulerMock({
    [STORAGE_KEYS.HISTORY]: bigHistory,
    [STORAGE_KEYS.META]: { historyCurrencyMigrated: true }
  });
  globalThis.chrome = chromeMock;
  try {
    await upsertHistoryEntry({ id: 'newest', store: 'epic', status: 'CLAIMED' });
    const saved = await getHistory();
    assert.equal(Object.keys(saved).length, 500);
    assert.ok(saved['epic:newest']);
  } finally {
    delete globalThis.chrome;
  }
});

test('static guard: service worker contains no periodInMinutes/setTimeout/setInterval and manifest has no content_scripts', async () => {
  const [bgSrc, schedSrc, manifestSrc, optionsHtml, optionsJs] = await Promise.all([
    fs.readFile(path.join(ROOT_DIR, 'src/background.js'), 'utf8'),
    fs.readFile(path.join(ROOT_DIR, 'src/scheduler.js'), 'utf8'),
    fs.readFile(path.join(ROOT_DIR, 'manifest.json'), 'utf8'),
    fs.readFile(path.join(ROOT_DIR, 'src/options/options.html'), 'utf8'),
    fs.readFile(path.join(ROOT_DIR, 'src/options/options.js'), 'utf8')
  ]);

  const forbiddenWorker = /\b(periodInMinutes|setTimeout|setInterval)\b/;
  assert.equal(forbiddenWorker.test(bgSrc), false, 'src/background.js must not use periodInMinutes, setTimeout, or setInterval');
  assert.equal(forbiddenWorker.test(schedSrc), false, 'src/scheduler.js must not use periodInMinutes, setTimeout, or setInterval');

  const manifest = JSON.parse(manifestSrc);
  assert.equal(manifest.content_scripts, undefined, 'manifest.json must not declare always-on content_scripts');

  const forbiddenLegacy = /\b(checkIntervalHours|thursdayFridayHourlyBoost|thuFriBoost|CLAIMIT_RESCHEDULE)\b/;
  assert.equal(forbiddenLegacy.test(optionsHtml), false);
  assert.equal(forbiddenLegacy.test(optionsJs), false);
});
