import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOffer, classifyOffers } from '../src/classifier.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

test('accepts genuine limited-time 100%-off game', () => {
  const res = classifyOffer(
    {
      id: 'g1',
      store: 'epic',
      title: 'Mark of the Deep',
      originalPrice: 19.99,
      discountPrice: 0,
      discountPercent: 100,
      startDate: '2026-11-19T16:00:00.000Z',
      endDate: '2026-11-26T16:00:00.000Z',
      type: 'game'
    },
    NOW
  );
  assert.equal(res.eligible, true);
  assert.equal(res.category, 'game');
  assert.equal(res.label, null);
});

test('accepts limited-time 100%-off DLC and labels it as DLC', () => {
  const res = classifyOffer(
    {
      id: 'dlc1',
      store: 'epic',
      title: 'Lost Castle: The Old Ones Awaken',
      originalPrice: 3.99,
      discountPrice: 0,
      discountPercent: 100,
      startDate: '2026-11-19T16:00:00.000Z',
      endDate: '2026-11-26T16:00:00.000Z',
      offerType: 'ADD_ON',
      categories: ['addons', 'freegames']
    },
    NOW
  );
  assert.equal(res.eligible, true);
  assert.equal(res.category, 'dlc');
  assert.equal(res.label, 'DLC');
  assert.equal(res.offer.type, 'dlc');
  assert.equal(res.offer.label, 'DLC');
});

test('excludes permanent free-to-play games', () => {
  const res = classifyOffer(
    {
      id: 'f2p',
      store: 'epic',
      title: 'Firestone Idle RPG',
      originalPrice: 0,
      discountPrice: 0,
      discountPercent: 0,
      isFreeToPlay: true,
      type: 'game'
    },
    NOW
  );
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'permanent_free_to_play');
});

test('excludes demos', () => {
  const res = classifyOffer(
    {
      id: 'demo1',
      store: 'steam',
      title: 'Cool Game Demo',
      originalPrice: 14.99,
      discountPrice: 0,
      discountPercent: 100,
      isLimitedTime: true,
      type: 'demo'
    },
    NOW
  );
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'demo');
});

test('excludes free weekends and play-for-free trials', () => {
  const res = classifyOffer(
    {
      id: 'wknd1',
      store: 'steam',
      title: 'Tactical Shooter',
      originalPrice: 29.99,
      discountPrice: 0,
      discountPercent: 100,
      isLimitedTime: true,
      promoText: 'Free Weekend - Play for Free'
    },
    NOW
  );
  assert.equal(res.eligible, false);
  assert.equal(res.reason, 'free_weekend_or_trial');
});

test('excludes upcoming offers and expired offers', () => {
  const upcoming = classifyOffer(
    {
      id: 'up1',
      store: 'epic',
      title: 'Bread and Fred',
      originalPrice: 14.99,
      discountPrice: 0,
      discountPercent: 100,
      startDate: '2026-11-26T16:00:00.000Z',
      endDate: '2026-12-03T16:00:00.000Z'
    },
    NOW
  );
  assert.equal(upcoming.eligible, false);
  assert.equal(upcoming.reason, 'upcoming');

  const expired = classifyOffer(
    {
      id: 'exp1',
      store: 'epic',
      title: 'Old Free Game',
      originalPrice: 14.99,
      discountPrice: 0,
      discountPercent: 100,
      startDate: '2026-11-12T16:00:00.000Z',
      endDate: '2026-11-19T16:00:00.000Z'
    },
    NOW
  );
  assert.equal(expired.eligible, false);
  assert.equal(expired.reason, 'expired');
});

test('excludes partial discounts (<100% off)', () => {
  const { eligible, excluded } = classifyOffers(
    [
      {
        id: 'partial',
        store: 'epic',
        title: 'TerraScape',
        originalPrice: 16.99,
        discountPrice: 11.89,
        discountPercent: 30,
        startDate: '2026-11-21T16:00:00.000Z',
        endDate: '2026-12-21T16:00:00.000Z'
      }
    ],
    NOW
  );
  assert.equal(eligible.length, 0);
  assert.equal(excluded[0].reason, 'not_100_percent_off');
});
