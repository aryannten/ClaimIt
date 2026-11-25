import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FX_CACHE_TTL_MS,
  formatPrice,
  convertAmount,
  getExchangeRates,
  resolveRegionAndCurrency,
  formatOfferPriceState,
  formatLocalDateTime,
  formatRelativeDuration,
  inferCurrencyFromFormatted
} from '../src/currency.js';
import {
  STORAGE_KEYS,
  computeValueSaved,
  migrateHistoryEntries,
  getHistory
} from '../src/storage.js';
import { parseEpicPromotions, claim as claimEpic } from '../src/providers/epic.js';
import { parseSteamSearchHtml, claim as claimSteam } from '../src/providers/steam.js';
import { buildTelegramPayload, buildDiscordPayload } from '../src/notifications.js';
import { CLAIM_STATUS } from '../src/providers/constants.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

test('formatPrice formats INR with en-IN Indian grouping, USD, EUR, JPY, and 3-decimal BHD via Intl', () => {
  assert.equal(formatPrice(1299, 'INR', 'en-IN'), '₹1,299');
  assert.equal(formatPrice(1249900, 'INR', 'en-IN'), '₹12,49,900');
  assert.equal(formatPrice(469.5, 'INR', 'en-IN'), '₹469.50');
  // Even if user switches manually to INR under en-US browser locale, Indian grouping applies
  assert.equal(formatPrice(1249900, 'INR', 'en-US'), '₹12,49,900');

  assert.equal(formatPrice(19.99, 'USD', 'en-US'), '$19.99');
  assert.match(formatPrice(14.99, 'EUR', 'de-DE'), /^14,99\s*€$/);
  assert.match(formatPrice(2080, 'JPY', 'ja-JP'), /^[￥¥]2,080$/);
  assert.doesNotMatch(formatPrice(2080, 'JPY', 'en-US'), /\./);
  assert.match(formatPrice(0.376, 'BHD', 'en-US'), /0\.376/);
});

test('local date and relative duration format UTC timestamps in user locale/timezone', () => {
  const ist = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata'
  }).format(new Date('2026-11-26T16:00:00.000Z'));
  assert.match(ist, /9:30\s*pm/i);

  assert.ok(formatLocalDateTime('2026-11-26T16:00:00.000Z', 'en-IN').length > 0);
  assert.match(formatRelativeDuration(5 * 3600 * 1000, 'en-IN'), /in 5 hours/i);
  assert.match(formatRelativeDuration(-15 * 60 * 1000, 'en-IN'), /15 minutes ago/i);
});

test('parseEpicPromotions parses minor units accurately for INR, USD, and zero-decimal JPY fixtures', () => {
  const fixture = {
    data: {
      Catalog: {
        searchStore: {
          elements: [
            {
              id: 'epic-in',
              namespace: 'ns-in',
              title: 'India Priced Game',
              offerType: 'BASE_GAME',
              urlSlug: 'india-game',
              categories: [{ path: 'freegames' }],
              keyImages: [],
              price: {
                totalPrice: {
                  originalPrice: 46900,
                  discountPrice: 0,
                  currencyCode: 'INR',
                  currencyInfo: { decimals: 2 },
                  fmtPrice: { originalPrice: '₹469.00', discountPrice: '0' }
                }
              },
              promotions: {
                promotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: '2026-11-19T16:00:00.000Z',
                        endDate: '2026-11-26T16:00:00.000Z',
                        discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 }
                      }
                    ]
                  }
                ]
              }
            },
            {
              id: 'epic-us',
              namespace: 'ns-us',
              title: 'US Priced Game',
              offerType: 'BASE_GAME',
              urlSlug: 'us-game',
              categories: [{ path: 'freegames' }],
              keyImages: [],
              price: {
                totalPrice: {
                  originalPrice: 1999,
                  discountPrice: 0,
                  currencyCode: 'USD',
                  currencyInfo: { decimals: 2 },
                  fmtPrice: { originalPrice: '$19.99', discountPrice: '0' }
                }
              },
              promotions: {
                promotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: '2026-11-19T16:00:00.000Z',
                        endDate: '2026-11-26T16:00:00.000Z',
                        discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 }
                      }
                    ]
                  }
                ]
              }
            },
            {
              id: 'epic-jp',
              namespace: 'ns-jp',
              title: 'Japan Zero Decimal Game',
              offerType: 'BASE_GAME',
              urlSlug: 'jp-game',
              categories: [{ path: 'freegames' }],
              keyImages: [],
              price: {
                totalPrice: {
                  originalPrice: 2080,
                  discountPrice: 0,
                  currencyCode: 'JPY',
                  currencyInfo: { decimals: 0 },
                  fmtPrice: { originalPrice: '¥2,080', discountPrice: '0' }
                }
              },
              promotions: {
                promotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: '2026-11-19T16:00:00.000Z',
                        endDate: '2026-11-26T16:00:00.000Z',
                        discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 }
                      }
                    ]
                  }
                ]
              }
            }
          ]
        }
      }
    }
  };

  const inOffer = parseEpicPromotions(fixture, {}, NOW, { country: 'IN' })[0];
  assert.equal(inOffer.originalPrice, 469);
  assert.equal(inOffer.currencyCode, 'INR');
  assert.equal(inOffer.country, 'IN');
  assert.equal(inOffer.priceSource, 'store');

  const usOffer = parseEpicPromotions(fixture, {}, NOW, { country: 'US' })[1];
  assert.equal(usOffer.originalPrice, 19.99);
  assert.equal(usOffer.currencyCode, 'USD');
  assert.equal(usOffer.country, 'US');

  const jpOffer = parseEpicPromotions(fixture, {}, NOW, { country: 'JP' })[2];
  assert.equal(jpOffer.originalPrice, 2080);
  assert.equal(jpOffer.currencyCode, 'JPY');
  assert.equal(jpOffer.country, 'JP');
});

test('parseSteamSearchHtml reads Indian Rupee pricing accurately without hardcoded USD', () => {
  const html = `
    <a href="https://store.steampowered.com/app/777111/Regional_Game/"
       data-ds-appid="777111" class="search_result_row ds_collapse_flag">
      <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/g.jpg"></div>
      <div class="search_name"><span class="title">Regional Game</span></div>
      <div class="discount_block search_discount_block" data-price-final="0" data-discount="100">
        <div class="discount_pct">-100%</div>
        <div class="discount_prices">
          <div class="discount_original_price">₹ 1,299.00</div>
          <div class="discount_final_price">Free</div>
        </div>
      </div>
    </a>
  `;
  const [offer] = parseSteamSearchHtml(html, {}, { country: 'IN' });
  assert.equal(offer.originalPrice, 1299);
  assert.equal(offer.currencyCode, 'INR');
  assert.equal(offer.country, 'IN');
  assert.equal(offer.priceSource, 'store');
  assert.equal(inferCurrencyFromFormatted('€14,99', 'DE'), 'EUR');
});

test('resolveRegionAndCurrency follows strict priority: explicit choice > store region > locale > USD fallback', () => {
  const r1 = resolveRegionAndCurrency({
    settings: { currency: 'EUR' },
    storedRegion: { storeCountry: 'IN', storeCurrency: 'INR' },
    navigatorLanguage: 'en-IN'
  });
  assert.equal(r1.currency, 'EUR');
  assert.equal(r1.source, 'user');
  assert.equal(r1.isOverridden, true);
  assert.equal(r1.countryName, 'India');
  assert.equal(r1.detectedCurrency, 'INR');

  const r2 = resolveRegionAndCurrency({
    settings: { currency: 'auto' },
    storedRegion: { storeCountry: 'JP', storeCurrency: 'JPY' },
    navigatorLanguage: 'en-IN'
  });
  assert.equal(r2.currency, 'JPY');
  assert.equal(r2.source, 'store');

  const r3 = resolveRegionAndCurrency({
    settings: { currency: 'auto' },
    storedRegion: null,
    navigatorLanguage: 'en-IN'
  });
  assert.equal(r3.currency, 'INR');
  assert.equal(r3.country, 'IN');
  assert.equal(r3.countryName, 'India');
  assert.equal(r3.source, 'locale');

  const r4 = resolveRegionAndCurrency({
    settings: { currency: 'auto' },
    storedRegion: null,
    navigatorLanguage: 'xx-ZZ'
  });
  assert.equal(r4.currency, 'USD');
  assert.equal(r4.source, 'fallback');
});

test('getExchangeRates uses fresh cache, refreshes stale cache, falls back on network failure, and avoids NaN', async () => {
  let fetchCount = 0;
  let savedPayload = null;
  const freshCache = {
    baseCode: 'USD',
    rates: { USD: 1, INR: 90, EUR: 0.9 },
    fetchedAtMs: NOW - 1000
  };

  const fromFresh = await getExchangeRates({
    cached: freshCache,
    nowMs: NOW,
    fetchFn: async () => {
      fetchCount += 1;
      throw new Error('should not fetch');
    }
  });
  assert.equal(fetchCount, 0);
  assert.equal(fromFresh.rates.INR, 90);

  const staleCache = {
    ...freshCache,
    fetchedAtMs: NOW - FX_CACHE_TTL_MS - 1000
  };
  const refreshed = await getExchangeRates({
    cached: staleCache,
    nowMs: NOW,
    fetchFn: async () => {
      fetchCount += 1;
      return {
        ok: true,
        async json() {
          return {
            result: 'success',
            base_code: 'USD',
            time_last_update_utc: 'Thu, 26 Nov 2026',
            rates: { USD: 1, INR: 92.5, EUR: 0.91 }
          };
        }
      };
    },
    saveCacheFn: async (entry) => {
      savedPayload = entry;
    }
  });
  assert.equal(fetchCount, 1);
  assert.equal(refreshed.rates.INR, 92.5);
  assert.equal(savedPayload.rates.INR, 92.5);

  const fallbackStale = await getExchangeRates({
    cached: staleCache,
    nowMs: NOW,
    fetchFn: async () => ({ ok: false, status: 503 })
  });
  assert.equal(fallbackStale.stale, true);
  assert.equal(fallbackStale.rates.INR, 90);

  const noCacheFail = await getExchangeRates({
    cached: null,
    nowMs: NOW,
    fetchFn: async () => {
      throw new Error('offline');
    }
  });
  assert.equal(noCacheFail, null);
  assert.equal(convertAmount(10, 'USD', 'INR', null), null);
});

test('computeValueSaved sums mixed currencies cleanly into display currency and excludes missing/zero/unknown', () => {
  const rates = { USD: 1, INR: 90, EUR: 0.9 };
  const history = {
    'epic:1': { status: 'CLAIMED', originalPriceValue: 500, currencyCode: 'INR' },
    'steam:2': { status: 'CLAIMED', originalPriceValue: 10, currencyCode: 'USD' },
    'epic:3': { status: 'CLAIMED', originalPriceValue: 0, currencyCode: 'INR' },
    'epic:4': { status: 'CLAIMED', originalPriceValue: 999, currencyCode: null, unknownCurrency: true },
    'epic:5': { status: 'CLAIMED', originalPriceValue: 200, currencyCode: 'INR', dryRun: true }
  };

  const inrSaved = computeValueSaved(history, 'INR', rates);
  assert.equal(inrSaved.count, 4);
  assert.equal(inrSaved.valuedCount, 2);
  assert.equal(inrSaved.totalMajor, 1400);
  assert.equal(inrSaved.hasConverted, true);
  assert.deepEqual(inrSaved.sourceCurrencies, ['USD']);
  assert.equal(inrSaved.unknownCurrencyCount, 1);

  // When FX rates are absent, never guess or mix: separate unconverted bucket cleanly
  const noRatesSaved = computeValueSaved(history, 'INR', null);
  assert.equal(noRatesSaved.totalMajor, 500);
  assert.equal(noRatesSaved.unconvertedTotals.USD, 10);
});

test('formatOfferPriceState handles missing price, conversion note, no-cache fallback, and unknown legacy entry', () => {
  const zeroState = formatOfferPriceState({ originalPriceValue: 0, currencyCode: 'INR' }, { displayCurrency: 'INR', locale: 'en-IN' });
  assert.equal(zeroState.available, false);
  assert.equal(zeroState.label, 'Price unavailable');

  const convState = formatOfferPriceState(
    { originalPriceValue: 10, currencyCode: 'USD' },
    { displayCurrency: 'INR', locale: 'en-IN', rates: { USD: 1, INR: 90 } }
  );
  assert.equal(convState.approx, true);
  assert.equal(convState.formatted, '₹900');
  assert.equal(convState.conversionNote, "Converted from USD at today's rate.");

  const offlineFallback = formatOfferPriceState(
    { originalPriceValue: 10, currencyCode: 'USD' },
    { displayCurrency: 'INR', locale: 'en-IN', rates: null }
  );
  assert.equal(offlineFallback.approx, false);
  assert.equal(offlineFallback.currency, 'USD');
  assert.equal(offlineFallback.formatted, '$10');

  const legacyUnknown = formatOfferPriceState(
    { originalPriceValue: 25, unknownCurrency: true },
    { displayCurrency: 'INR', locale: 'en-IN' }
  );
  assert.match(legacyUnknown.formatted, /unknown currency/);
});

test('migrateHistoryEntries and getHistory migrate legacy entries cleanly without crashing', async () => {
  const { history, changed } = migrateHistoryEntries({
    'epic:old-no-cur': { id: 'old-no-cur', store: 'epic', status: 'CLAIMED', originalPriceValue: 19.99 },
    'steam:old-usd': { id: 'old-usd', store: 'steam', status: 'CLAIMED', originalPriceValue: 9.99, currency: 'USD' }
  });
  assert.equal(changed, true);
  assert.equal(history['epic:old-no-cur'].unknownCurrency, true);
  assert.equal(history['epic:old-no-cur'].currencyCode, null);
  assert.equal(history['steam:old-usd'].currencyCode, 'USD');

  const store = {
    [STORAGE_KEYS.HISTORY]: {
      'epic:legacy': { id: 'legacy', store: 'epic', status: 'CLAIMED', originalPriceValue: 15 }
    }
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = store[k];
          return out;
        },
        async set(vals) {
          Object.assign(store, vals);
        }
      }
    }
  };
  try {
    const loaded = await getHistory();
    assert.equal(loaded['epic:legacy'].unknownCurrency, true);
    assert.equal(store[STORAGE_KEYS.META].historyCurrencyMigrated, true);
  } finally {
    delete globalThis.chrome;
  }
});

test('region-unavailable offers return NEEDS_USER with "Not available in your region" without crashing', async () => {
  const offer = {
    id: 'locked-1',
    title: 'Region Locked Title',
    url: 'https://store.epicgames.com/en-US/p/locked',
    regionUnavailable: true
  };
  const epicRes = await claimEpic(offer);
  assert.equal(epicRes.status, CLAIM_STATUS.NEEDS_USER);
  assert.equal(epicRes.reason, 'Not available in your region');

  const steamRes = await claimSteam(offer);
  assert.equal(steamRes.status, CLAIM_STATUS.NEEDS_USER);
  assert.equal(steamRes.reason, 'Not available in your region');
});

test('notification payloads include converted/regional price cleanly', () => {
  const tg = buildTelegramPayload(
    {
      store: 'epic',
      storeName: 'Epic Games Store',
      title: 'Regional Game',
      url: 'https://store.epicgames.com/en-US/p/rg',
      originalPriceValue: 10,
      currencyCode: 'USD'
    },
    CLAIM_STATUS.NEEDS_USER,
    'Login required',
    '123',
    { displayCurrency: 'INR', locale: 'en-IN', rates: { USD: 1, INR: 90 } }
  );
  assert.match(tg.text, /normally ~₹900/);

  const dc = buildDiscordPayload(
    {
      store: 'steam',
      storeName: 'Steam',
      title: 'Indian Price Title',
      url: 'https://store.steampowered.com/app/1/',
      originalPriceValue: 1299,
      currencyCode: 'INR'
    },
    CLAIM_STATUS.FAILED,
    'timeout',
    { displayCurrency: 'INR', locale: 'en-IN', rates: null }
  );
  assert.match(dc.embeds[0].description, /normally ₹1,299/);
});
