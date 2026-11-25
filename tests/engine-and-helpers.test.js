import test from 'node:test';
import assert from 'node:assert/strict';
import { appendToRingBuffer } from '../src/logger.js';
import { computeValueSaved } from '../src/storage.js';
import { shouldNotify, buildTelegramPayload, buildDiscordPayload } from '../src/notifications.js';
import { computeAlarmPeriodMinutes } from '../src/background.js';
import { runCheckCycle, executeClaimWithTimeout } from '../src/engine.js';
import { CLAIM_STATUS, delay } from '../src/providers/constants.js';

test('appendToRingBuffer caps logs at max size', () => {
  let buf = [];
  for (let i = 0; i < 250; i++) {
    buf = appendToRingBuffer(buf, { i }, 200);
  }
  assert.equal(buf.length, 200);
  assert.equal(buf[0].i, 50);
  assert.equal(buf[199].i, 249);
});

test('computeValueSaved sums only non-dry-run CLAIMED items', () => {
  const saved = computeValueSaved({
    'epic:1': { status: 'CLAIMED', originalPriceValue: 19.99, currency: 'USD', dryRun: false },
    'steam:2': { status: 'CLAIMED', originalPriceValue: 10.0, currency: 'USD', dryRun: true },
    'epic:3': { status: 'NEEDS_USER', originalPriceValue: 29.99, currency: 'USD' },
    'steam:4': { status: 'CLAIMED', originalPriceValue: 5.5, currency: 'USD' }
  });
  assert.equal(saved.count, 2);
  assert.equal(saved.totalMajor, 25.49);
});

test('shouldNotify prevents duplicate notifications in same cycle unless status changes', () => {
  assert.equal(shouldNotify(undefined, 'c1', 'NEEDS_USER'), true);
  assert.equal(shouldNotify({ cycleId: 'c1', status: 'NEEDS_USER' }, 'c1', 'NEEDS_USER'), false);
  assert.equal(shouldNotify({ cycleId: 'c1', status: 'NEEDS_USER' }, 'c1', 'CLAIMED'), true);
  assert.equal(shouldNotify({ cycleId: 'c1', status: 'NEEDS_USER' }, 'c2', 'NEEDS_USER'), true);
});

test('buildTelegramPayload and buildDiscordPayload format NEEDS_USER alerts', () => {
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
  assert.match(tg.text, /Sample Game \[DLC\] is free on Epic Games Store/);
  assert.equal(tg.reply_markup.inline_keyboard[0][0].url, offer.url);

  const dc = buildDiscordPayload(offer, 'FAILED', 'timeout');
  assert.match(dc.embeds[0].title, /ClaimIt failed/);
  assert.match(dc.embeds[0].description, /timeout/);
});

test('computeAlarmPeriodMinutes uses hourly polling on Thursday and Friday when enabled', () => {
  const settings = { checkIntervalHours: 6, thursdayFridayHourlyBoost: true };
  // 2026-11-26 is Thursday, 2026-11-27 is Friday, 2026-11-28 is Saturday
  assert.equal(computeAlarmPeriodMinutes(settings, new Date('2026-11-26T12:00:00')), 60);
  assert.equal(computeAlarmPeriodMinutes(settings, new Date('2026-11-27T12:00:00')), 60);
  assert.equal(computeAlarmPeriodMinutes(settings, new Date('2026-11-28T12:00:00')), 360);
  assert.equal(
    computeAlarmPeriodMinutes({ checkIntervalHours: 6, thursdayFridayHourlyBoost: false }, new Date('2026-11-26T12:00:00')),
    360
  );
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

test('runCheckCycle isolates broken provider errors and respects notify-only vs auto mode', async () => {
  const savedHistory = {};
  const notifications = [];
  let savedOffers = [];

  const brokenProvider = {
    id: 'epic',
    name: 'Epic Games Store',
    async fetchOffers() {
      throw new Error('Network down');
    }
  };

  const workingProvider = {
    id: 'steam',
    name: 'Steam',
    async fetchOffers() {
      return [
        {
          id: '100',
          store: 'steam',
          storeName: 'Steam',
          title: 'Free Keep Indie',
          url: 'https://store.steampowered.com/app/100/',
          originalPrice: 9.99,
          originalPriceFormatted: '$9.99',
          discountPrice: 0,
          discountPercent: 100,
          isLimitedTime: true,
          type: 'game'
        }
      ];
    },
    async isOwned() {
      return false;
    },
    async claim() {
      throw new Error('Should not be called in notify mode');
    }
  };

  const result = await runCheckCycle({
    trigger: 'test',
    deps: {
      getSettings: async () => ({
        paused: false,
        dryRun: false,
        stores: {
          epic: { enabled: true, mode: 'auto' },
          steam: { enabled: true, mode: 'notify' }
        }
      }),
      getHistory: async () => savedHistory,
      getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
      getEnabledProviders: () => [brokenProvider, workingProvider],
      upsertHistoryEntry: async (entry) => {
        savedHistory[entry.key] = entry;
      },
      notifyOfferOutcome: async (n) => {
        notifications.push(n);
      },
      setCurrentOffers: async (offers) => {
        savedOffers = offers;
      },
      updateMeta: async () => {},
      interClaimDelay: async () => {}
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(savedOffers.length, 1);
  assert.equal(savedOffers[0].status, CLAIM_STATUS.NEEDS_USER);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].status, CLAIM_STATUS.NEEDS_USER);
});

test('runCheckCycle skips immediately when paused', async () => {
  let called = false;
  const res = await runCheckCycle({
    trigger: 'test',
    deps: {
      getSettings: async () => ({ paused: true }),
      getCurrentOffers: async () => [],
      getEnabledProviders: () => {
        called = true;
        return [];
      }
    }
  });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'paused');
  assert.equal(called, false);
});

test('runCheckCycle runs auto-claim in dryRun mode without writing permanent history', async () => {
  const savedHistory = {};
  let receivedDryRun = false;

  const mockProvider = {
    id: 'epic',
    name: 'Epic Games Store',
    async fetchOffers() {
      return [
        {
          id: 'dry-1',
          store: 'epic',
          storeName: 'Epic Games Store',
          title: 'Dry Run Game',
          url: 'https://store.epicgames.com/en-US/p/dry-run',
          originalPrice: 19.99,
          originalPriceFormatted: '$19.99',
          discountPrice: 0,
          discountPercent: 100,
          isLimitedTime: true,
          type: 'game'
        }
      ];
    },
    async isOwned() {
      return false;
    },
    async claim(_offer, ctx) {
      receivedDryRun = ctx.dryRun;
      return { status: CLAIM_STATUS.CLAIMED, dryRun: true, reason: 'Dry-run stop' };
    }
  };

  const res = await runCheckCycle({
    trigger: 'test-dry-run',
    deps: {
      getSettings: async () => ({
        paused: false,
        dryRun: true,
        stores: { epic: { enabled: true, mode: 'auto' } }
      }),
      getHistory: async () => savedHistory,
      getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
      getEnabledProviders: () => [mockProvider],
      upsertHistoryEntry: async (entry) => {
        savedHistory[entry.key] = entry;
      },
      notifyOfferOutcome: async () => {},
      setCurrentOffers: async () => {},
      updateMeta: async () => {},
      interClaimDelay: async () => {}
    }
  });

  assert.equal(receivedDryRun, true);
  assert.equal(res.offers[0].dryRun, true);
  assert.equal(Object.keys(savedHistory).length, 0);
});
