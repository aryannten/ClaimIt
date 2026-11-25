import test from 'node:test';
import assert from 'node:assert/strict';
import { appendToRingBuffer } from '../src/logger.js';
import {
  STORAGE_KEYS,
  computeValueSaved,
  acquireCycleLock,
  releaseCycleLock,
  upsertHistoryEntry,
  getHistory
} from '../src/storage.js';
import { shouldNotify, buildTelegramPayload, buildDiscordPayload, notifyOfferOutcome } from '../src/notifications.js';
import { computeAlarmPeriodMinutes, syncAlarmSchedule, CHECK_ALARM_NAME } from '../src/background.js';
import { runCheckCycle, executeClaimWithTimeout } from '../src/engine.js';
import { CLAIM_STATUS, delay } from '../src/providers/constants.js';

function createChromeMock(initialStorage = {}) {
  const store = { ...initialStorage };
  const createdNotifications = [];
  const alarms = {};

  const chromeMock = {
    runtime: {
      getURL: (p) => `chrome-extension://test-id/${p}`
    },
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') {
            return { [keys]: store[keys] };
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = store[k];
            return out;
          }
          return { ...store };
        },
        async set(items) {
          Object.assign(store, items);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            delete store[k];
          }
        }
      }
    },
    notifications: {
      async create(id, options) {
        createdNotifications.push({ id, options });
        return id;
      },
      async clear() {
        return true;
      }
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
        alarms[name] = { name, ...info };
      }
    }
  };

  return { chromeMock, store, createdNotifications, alarms };
}

function makeOffer(overrides = {}) {
  return {
    id: 'offer-1',
    store: 'epic',
    storeName: 'Epic Games Store',
    title: 'Sample Free Game',
    url: 'https://store.epicgames.com/en-US/p/sample-free-game',
    image: '',
    originalPrice: 19.99,
    originalPriceFormatted: '$19.99',
    discountPrice: 0,
    discountPercent: 100,
    currency: 'USD',
    isLimitedTime: true,
    type: 'game',
    ...overrides
  };
}

test('appendToRingBuffer caps logs at max size', () => {
  let buf = [];
  for (let i = 0; i < 250; i++) {
    buf = appendToRingBuffer(buf, { i }, 200);
  }
  assert.equal(buf.length, 200);
  assert.equal(buf[0].i, 50);
  assert.equal(buf[199].i, 249);
});

test('computeValueSaved sums only newly claimed non-dry-run items and excludes pre-owned', () => {
  const saved = computeValueSaved({
    'epic:1': { status: 'CLAIMED', originalPriceValue: 19.99, currency: 'USD', dryRun: false },
    'steam:2': { status: 'CLAIMED', originalPriceValue: 10.0, currency: 'USD', dryRun: true },
    'epic:3': { status: 'NEEDS_USER', originalPriceValue: 29.99, currency: 'USD' },
    'steam:4': { status: 'CLAIMED', originalPriceValue: 5.5, currency: 'USD' },
    'epic:5': { status: 'CLAIMED', originalPriceValue: 49.99, currency: 'USD', alreadyOwned: true }
  });
  assert.equal(saved.count, 2);
  assert.equal(saved.totalMajor, 25.49);
});

test('storage cycle lock prevents concurrent runs and expires stale locks', async () => {
  const { chromeMock } = createChromeMock();
  globalThis.chrome = chromeMock;
  try {
    assert.equal(await acquireCycleLock('cycle-a', 1000, 5000), true);
    assert.equal(await acquireCycleLock('cycle-b', 2000, 5000), false);
    // Stale lock after TTL expires
    assert.equal(await acquireCycleLock('cycle-b', 7000, 5000), true);
    await releaseCycleLock('cycle-b');
    assert.equal(await acquireCycleLock('cycle-c', 7100, 5000), true);
  } finally {
    delete globalThis.chrome;
  }
});

test('upsertHistoryEntry deduplicates by store:id key', async () => {
  const { chromeMock } = createChromeMock();
  globalThis.chrome = chromeMock;
  try {
    await upsertHistoryEntry({ store: 'epic', id: 'g1', status: 'NEEDS_USER', reason: 'Login' });
    await upsertHistoryEntry({ store: 'epic', id: 'g1', status: 'CLAIMED' });
    const history = await getHistory();
    assert.equal(Object.keys(history).length, 1);
    assert.equal(history['epic:g1'].status, 'CLAIMED');
    assert.ok(history['epic:g1'].claimedAt);
  } finally {
    delete globalThis.chrome;
  }
});

test('shouldNotify prevents duplicate notifications in same cycle unless status changes', () => {
  assert.equal(shouldNotify(undefined, 'c1', 'NEEDS_USER'), true);
  assert.equal(shouldNotify({ cycleId: 'c1', status: 'NEEDS_USER' }, 'c1', 'NEEDS_USER'), false);
  assert.equal(shouldNotify({ cycleId: 'c1', status: 'NEEDS_USER' }, 'c1', 'CLAIMED'), true);
  assert.equal(shouldNotify({ cycleId: 'c1', status: 'NEEDS_USER' }, 'c2', 'NEEDS_USER'), true);
});

test('buildTelegramPayload and buildDiscordPayload format NEEDS_USER and FAILED alerts', () => {
  const offer = {
    store: 'epic',
    storeName: 'Epic Games Store',
    title: 'Sample Game',
    url: 'https://store.epicgames.com/en-US/p/sample',
    originalPriceFormatted: '$19.99',
    label: 'DLC'
  };
  const tg = buildTelegramPayload(offer, 'NEEDS_USER', 'Captcha required', '12345');
  assert.equal(tg.chat_id, '12345');
  assert.match(tg.text, /Sample Game \[DLC\]: Free on Epic Games Store/);
  assert.equal(tg.reply_markup.inline_keyboard[0][0].url, offer.url);

  const dc = buildDiscordPayload(offer, 'FAILED', 'timeout');
  assert.match(dc.embeds[0].title, /Sample Game \[DLC\]/);
  assert.match(dc.embeds[0].description, /timeout/);
});

test('computeAlarmPeriodMinutes and syncAlarmSchedule manage chrome.alarms cleanly', async () => {
  const settings = { checkIntervalHours: 6, thursdayFridayHourlyBoost: true };
  assert.equal(computeAlarmPeriodMinutes(settings, new Date('2026-11-26T12:00:00')), 60);
  assert.equal(computeAlarmPeriodMinutes(settings, new Date('2026-11-27T12:00:00')), 60);
  assert.equal(computeAlarmPeriodMinutes(settings, new Date('2026-11-28T12:00:00')), 360);

  const { chromeMock, alarms } = createChromeMock({
    [STORAGE_KEYS.SETTINGS]: { checkIntervalHours: 6, thursdayFridayHourlyBoost: false }
  });
  globalThis.chrome = chromeMock;
  try {
    const period = await syncAlarmSchedule();
    assert.equal(period, 360);
    assert.equal(alarms[CHECK_ALARM_NAME].periodInMinutes, 360);
  } finally {
    delete globalThis.chrome;
  }
});

test('executeClaimWithTimeout aborts and returns FAILED(timeout)', async () => {
  const slowProvider = {
    async claim(_offer, { signal }) {
      await delay(500, signal);
      return { status: CLAIM_STATUS.CLAIMED };
    }
  };
  const res = await executeClaimWithTimeout(slowProvider, { id: '1' }, {}, 30);
  assert.equal(res.status, CLAIM_STATUS.FAILED);
  assert.equal(res.reason, 'timeout');
});

test('Mocked chrome.* background cycles cover CLAIMED, NEEDS_USER, FAILED, notify-only, dedup, error isolation, dry-run, and pause', async () => {
  const { chromeMock, store, createdNotifications } = createChromeMock({
    [STORAGE_KEYS.SETTINGS]: {
      paused: false,
      dryRun: false,
      stores: {
        epic: { enabled: true, mode: 'auto' },
        steam: { enabled: true, mode: 'auto' }
      },
      notifications: { chrome: true, telegram: { enabled: false }, discord: { enabled: false } }
    }
  });
  globalThis.chrome = chromeMock;

  try {
    // 1. Auto mode CLAIMED
    const epicOffer = makeOffer();
    const epicProviderClaimed = {
      id: 'epic',
      name: 'Epic Games Store',
      async fetchOffers() { return [epicOffer]; },
      async isOwned() { return false; },
      async claim() { return { status: CLAIM_STATUS.CLAIMED }; }
    };

    const cycle1 = await runCheckCycle({
      trigger: 'mock-1',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [epicProviderClaimed],
        interClaimDelay: async () => {}
      }
    });
    assert.equal(cycle1.offers[0].status, CLAIM_STATUS.CLAIMED);
    assert.equal(store[STORAGE_KEYS.HISTORY]['epic:offer-1'].status, CLAIM_STATUS.CLAIMED);
    assert.equal(createdNotifications.length, 1);
    assert.equal(createdNotifications[0].options.silent, true);

    // 2. Already claimed -> skipped, no duplicate notification
    let claimCalledAgain = false;
    const epicAlreadyClaimed = {
      ...epicProviderClaimed,
      async claim() {
        claimCalledAgain = true;
        return { status: CLAIM_STATUS.CLAIMED };
      }
    };
    await runCheckCycle({
      trigger: 'mock-2',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [epicAlreadyClaimed],
        interClaimDelay: async () => {}
      }
    });
    assert.equal(claimCalledAgain, false);
    assert.equal(createdNotifications.length, 1);

    // 3. Auto mode NEEDS_USER -> persistent notification with "Claim now" button
    const needsUserOffer = makeOffer({ id: 'offer-needs', title: 'Captcha Game' });
    const needsUserProvider = {
      id: 'epic',
      name: 'Epic Games Store',
      async fetchOffers() { return [needsUserOffer]; },
      async isOwned() { return false; },
      async claim() {
        return { status: CLAIM_STATUS.NEEDS_USER, reason: 'Captcha required', tabId: 42 };
      }
    };
    await runCheckCycle({
      trigger: 'mock-3',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [needsUserProvider],
        interClaimDelay: async () => {}
      }
    });
    const lastNotif = createdNotifications.at(-1);
    assert.equal(lastNotif.options.requireInteraction, true);
    assert.equal(lastNotif.options.title, 'Captcha Game');
    assert.match(lastNotif.options.message, /Free on Epic Games Store.*\$19\.99.*Captcha required/);
    assert.equal(lastNotif.options.buttons[0].title, 'Claim now');

    // Same cycle dedup check via notifyOfferOutcome directly
    const dedup = await notifyOfferOutcome({
      offer: needsUserOffer,
      status: CLAIM_STATUS.NEEDS_USER,
      reason: 'Captcha required',
      cycleId: store[STORAGE_KEYS.META].lastCycleId,
      settings: store[STORAGE_KEYS.SETTINGS]
    });
    assert.equal(dedup.skipped, true);

    // 4. Claim FAILED + broken provider isolation
    const brokenProvider = {
      id: 'epic',
      name: 'Epic Games Store',
      async fetchOffers() { throw new Error('API 503'); }
    };
    const failingSteamProvider = {
      id: 'steam',
      name: 'Steam',
      async fetchOffers() { return [makeOffer({ id: 's-fail', store: 'steam', storeName: 'Steam', title: 'Broken Game' })]; },
      async isOwned() { return false; },
      async claim() { return { status: CLAIM_STATUS.FAILED, reason: 'timeout' }; }
    };
    await runCheckCycle({
      trigger: 'mock-4',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [brokenProvider, failingSteamProvider],
        interClaimDelay: async () => {}
      }
    });
    assert.equal(store[STORAGE_KEYS.HISTORY]['steam:s-fail'].status, CLAIM_STATUS.FAILED);
    assert.equal(store[STORAGE_KEYS.HISTORY]['steam:s-fail'].reason, 'timeout');
    assert.ok(store.claimit_logs.some((e) => e.level === 'error' && e.message.includes('fetchOffers failed')));

    // 5. Auto mode off -> notify only (claim not called)
    store[STORAGE_KEYS.SETTINGS].stores.steam.mode = 'notify';
    let notifyModeClaimCalled = false;
    const steamNotifyOnly = {
      id: 'steam',
      name: 'Steam',
      async fetchOffers() { return [makeOffer({ id: 's-notify', store: 'steam', storeName: 'Steam', title: 'Notify Only Game' })]; },
      async isOwned() { return false; },
      async claim() {
        notifyModeClaimCalled = true;
        return { status: CLAIM_STATUS.CLAIMED };
      }
    };
    const cycleNotify = await runCheckCycle({
      trigger: 'mock-5',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [steamNotifyOnly],
        interClaimDelay: async () => {}
      }
    });
    assert.equal(notifyModeClaimCalled, false);
    assert.equal(cycleNotify.offers[0].status, CLAIM_STATUS.NEEDS_USER);

    // 6. Dry-run on -> claim called with dryRun: true, no permanent claim written
    store[STORAGE_KEYS.SETTINGS].dryRun = true;
    store[STORAGE_KEYS.SETTINGS].stores.steam.mode = 'auto';
    let receivedDryRun = false;
    const steamDryRun = {
      id: 'steam',
      name: 'Steam',
      async fetchOffers() { return [makeOffer({ id: 's-dry', store: 'steam', storeName: 'Steam', title: 'Dry Run Game' })]; },
      async isOwned() { return false; },
      async claim(_o, ctx) {
        receivedDryRun = ctx.dryRun;
        return { status: CLAIM_STATUS.CLAIMED, dryRun: true };
      }
    };
    const cycleDry = await runCheckCycle({
      trigger: 'mock-6',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [steamDryRun],
        interClaimDelay: async () => {}
      }
    });
    assert.equal(receivedDryRun, true);
    assert.equal(cycleDry.offers[0].dryRun, true);
    assert.equal(store[STORAGE_KEYS.HISTORY]['steam:s-dry'], undefined);

    // 7. Pause on -> nothing runs
    store[STORAGE_KEYS.SETTINGS].paused = true;
    let pausedFetchCalled = false;
    const cyclePaused = await runCheckCycle({
      trigger: 'mock-7',
      deps: {
        getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
        getEnabledProviders: () => [{
          id: 'epic',
          async fetchOffers() {
            pausedFetchCalled = true;
            return [];
          }
        }]
      }
    });
    assert.equal(cyclePaused.skipped, true);
    assert.equal(cyclePaused.reason, 'paused');
    assert.equal(pausedFetchCalled, false);
  } finally {
    delete globalThis.chrome;
  }
});
