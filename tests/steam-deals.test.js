/**
 * Tests for Steam paid discount deals (40-99%), slider clamping, zero-decimal formatting,
 * ownership exclusion, and strict separation from 100%-off auto-claiming.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSteamSearchHtml,
  filterSteamDiscountDeals,
  fetchSteamDeals
} from '../src/providers/steam.js';
import { classifyOffers } from '../src/classifier.js';
import {
  clampSteamMinDiscount,
  DEFAULT_STEAM_MIN_DISCOUNT,
  normalizeSteamDealsSort,
  DEFAULT_STEAM_DEALS_SORT
} from '../src/storage.js';
import { formatCompactCount } from '../src/ui/ui-helpers.js';

describe('Steam discount deals filter & slider range', () => {
  it('clamps steamMinDiscount strictly between 40 and 100', () => {
    assert.equal(clampSteamMinDiscount(undefined), DEFAULT_STEAM_MIN_DISCOUNT);
    assert.equal(clampSteamMinDiscount(15), 40);
    assert.equal(clampSteamMinDiscount(40), 40);
    assert.equal(clampSteamMinDiscount(75.4), 75);
    assert.equal(clampSteamMinDiscount(99), 99);
    assert.equal(clampSteamMinDiscount(100), 100);
    assert.equal(clampSteamMinDiscount(120), 100);
  });

  it('parses live Steam specials HTML rows with regional INR and zero-decimal JPY pricing', () => {
    const html = `
      <a href="https://store.steampowered.com/app/1174180/Red_Dead_Redemption_2/?snr=1"
         data-ds-appid="1174180" class="search_result_row ds_collapse_flag">
        <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/rdr2.jpg"></div>
        <div class="search_name"><span class="title">Red Dead Redemption 2</span></div>
        <div class="discount_block search_discount_block" data-price-final="124900" data-discount="75">
          <div class="discount_pct">-75%</div>
          <div class="discount_prices">
            <div class="discount_original_price">₹4,999.00</div>
            <div class="discount_final_price">₹1,249.00</div>
          </div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/2947440/SILENT_HILL_f/?snr=1"
         data-ds-appid="2947440" class="search_result_row ds_collapse_flag">
        <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/shf.jpg"></div>
        <div class="search_name"><span class="title">SILENT HILL f</span></div>
        <div class="discount_block search_discount_block" data-price-final="89600" data-discount="72">
          <div class="discount_pct">-72%</div>
          <div class="discount_prices">
            <div class="discount_original_price">₹3,200.00</div>
            <div class="discount_final_price">₹896.00</div>
          </div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/3240220/GTA_V_Enhanced/?snr=1"
         data-ds-appid="3240220" class="search_result_row ds_collapse_flag">
        <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/gtav.jpg"></div>
        <div class="search_name"><span class="title">Grand Theft Auto V Enhanced</span></div>
        <div class="discount_block search_discount_block" data-price-final="164900" data-discount="56">
          <div class="discount_pct">-56%</div>
          <div class="discount_prices">
            <div class="discount_original_price">₹3,749.00</div>
            <div class="discount_final_price">₹1,649.00</div>
          </div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/888001/Japan_Sale/"
         data-ds-appid="888001" class="search_result_row ds_collapse_flag">
        <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/jp.jpg"></div>
        <div class="search_name"><span class="title">Japan Sale</span></div>
        <div class="discount_block search_discount_block" data-price-final="104000" data-discount="50">
          <div class="discount_pct">-50%</div>
          <div class="discount_prices">
            <div class="discount_original_price">¥2,080</div>
            <div class="discount_final_price">¥1,040</div>
          </div>
        </div>
      </a>
    `;

    const parsed = parseSteamSearchHtml(html, {}, { country: 'IN' });
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].originalPrice, 4999);
    assert.equal(parsed[0].discountPrice, 1249);
    assert.equal(parsed[0].discountPercent, 75);
    assert.equal(parsed[0].currencyCode, 'INR');
    assert.equal(parsed[3].discountPrice, 1040);

    // Free classifier still strictly rejects all <100% paid discounts
    const { eligible } = classifyOffers(parsed);
    assert.equal(eligible.length, 0);

    // Filter at 70%+ keeps 75% and 72%, sorted descending
    const highDeals = filterSteamDiscountDeals(parsed, 70);
    assert.deepEqual(highDeals.map((d) => [d.id, d.discountPercent]), [
      ['1174180', 75],
      ['2947440', 72]
    ]);

    // Filter at 50%+ excludes already owned appIds
    const unowned = filterSteamDiscountDeals(parsed, 50, [1174180]);
    assert.equal(unowned.some((d) => d.id === '1174180'), false);
    assert.equal(unowned.length, 3);

    // Threshold 100% shows zero paid deals
    assert.equal(filterSteamDiscountDeals(parsed, 100).length, 0);
  });

  it('fetchSteamDeals excludes 100%-off items and owned apps', async () => {
    const html = `
      <a href="https://store.steampowered.com/app/100/FreeGame/" data-ds-appid="100" class="search_result_row">
        <span class="title">Free Game</span>
        <div class="discount_block" data-price-final="0" data-discount="100">
          <div class="discount_original_price">$19.99</div>
          <div class="discount_final_price">Free</div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/200/OwnedDeal/" data-ds-appid="200" class="search_result_row">
        <span class="title">Owned Deal</span>
        <div class="discount_block" data-price-final="299" data-discount="90">
          <div class="discount_original_price">$29.99</div>
          <div class="discount_final_price">$2.99</div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/300/DeepSale/" data-ds-appid="300" class="search_result_row">
        <span class="title">Deep Sale</span>
        <div class="discount_block" data-price-final="499" data-discount="80">
          <div class="discount_original_price">$24.99</div>
          <div class="discount_final_price">$4.99</div>
        </div>
      </a>
    `;

    const deals = await fetchSteamDeals({
      minDiscount: 40,
      steamUserdata: { rgOwnedApps: [200] },
      fetchFn: async () => new Response(JSON.stringify({ success: 1, results_html: html }), { status: 200 })
    });

    assert.equal(deals.length, 1);
    assert.equal(deals[0].id, '300');
    assert.equal(deals[0].discountPercent, 80);
  });

  it('parses Steam review stats and supports popularity/review/price sorting + query filter', () => {
    const html = `
      <a href="https://store.steampowered.com/app/1238840/Battlefield_1/" data-ds-appid="1238840" class="search_result_row">
        <span class="title">Battlefield™ 1</span>
        <span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;86% of the 47,523 user reviews for this game are positive."></span>
        <div class="discount_block" data-price-final="12400" data-discount="95">
          <div class="discount_original_price">₹2,499.00</div>
          <div class="discount_final_price">₹124.00</div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/2807960/Battlefield_6/" data-ds-appid="2807960" class="search_result_row">
        <span class="title">Battlefield™ 6</span>
        <span class="search_review_summary mixed" data-tooltip-html="Mixed&lt;br&gt;68% of the 12,400 user reviews for this game are positive."></span>
        <div class="discount_block" data-price-final="131900" data-discount="67">
          <div class="discount_original_price">₹3,999.00</div>
          <div class="discount_final_price">₹1,319.00</div>
        </div>
      </a>
      <a href="https://store.steampowered.com/app/1174180/Red_Dead_Redemption_2/" data-ds-appid="1174180" class="search_result_row">
        <span class="title">Red Dead Redemption 2</span>
        <span class="search_review_summary positive" data-tooltip-html="Very Positive&lt;br&gt;92% of the 325,333 user reviews for this game are positive."></span>
        <div class="discount_block" data-price-final="124900" data-discount="75">
          <div class="discount_original_price">₹4,999.00</div>
          <div class="discount_final_price">₹1,249.00</div>
        </div>
      </a>
    `;

    const parsed = parseSteamSearchHtml(html, {}, { country: 'IN' }).map((o, idx) => ({
      ...o,
      topRank: idx === 2 ? 1 : idx + 2
    }));

    assert.equal(parsed[0].reviewSummary, 'Very Positive');
    assert.equal(parsed[0].reviewSentiment, 'positive');
    assert.equal(parsed[0].reviewPercent, 86);
    assert.equal(parsed[0].reviewCount, 47523);
    assert.equal(parsed[1].reviewSentiment, 'mixed');
    assert.equal(parsed[1].reviewCount, 12400);

    // Popularity sort honors topRank ascending
    const byPopular = filterSteamDiscountDeals(parsed, 40, null, { sortBy: 'popular' });
    assert.deepEqual(byPopular.map((d) => d.id), ['1174180', '1238840', '2807960']);

    // Reviews sort orders by total review count descending
    const byReviews = filterSteamDiscountDeals(parsed, 40, null, { sortBy: 'reviews' });
    assert.deepEqual(byReviews.map((d) => d.id), ['1174180', '1238840', '2807960']);

    // Lowest price sort orders by final sale price ascending
    const byPrice = filterSteamDiscountDeals(parsed, 40, null, { sortBy: 'price' });
    assert.deepEqual(byPrice.map((d) => d.id), ['1238840', '1174180', '2807960']);

    // Query filter finds multi-token Battlefield 6 cleanly
    const bf6 = filterSteamDiscountDeals(parsed, 40, null, { query: 'battlefield 6' });
    assert.deepEqual(bf6.map((d) => d.id), ['2807960']);

    assert.equal(normalizeSteamDealsSort('unknown'), DEFAULT_STEAM_DEALS_SORT);
    assert.equal(normalizeSteamDealsSort('reviews'), 'reviews');
    assert.equal(formatCompactCount(850, 'en-US'), '850');
    assert.match(formatCompactCount(325333, 'en-US'), /^325/);
  });

  it('fetchSteamDeals paginates Top Sellers past 50 rows and searches catalog without specials=1', async () => {
    const makeRows = (startId, count) =>
      Array.from({ length: count }, (_, idx) => {
        const id = startId + idx;
        return `
          <a href="https://store.steampowered.com/app/${id}/Game_${id}/" data-ds-appid="${id}" class="search_result_row">
            <span class="title">Game ${id}</span>
            <div class="discount_block" data-price-final="499" data-discount="75">
              <div class="discount_original_price">₹1,999.00</div>
              <div class="discount_final_price">₹499.00</div>
            </div>
          </a>
        `;
      }).join('');

    const browseUrls = [];
    const pagedDeals = await fetchSteamDeals({
      minDiscount: 40,
      maxPages: 3,
      steamUserdata: { rgOwnedApps: [] },
      fetchFn: async (href) => {
        browseUrls.push(href);
        const start = Number(new URL(href).searchParams.get('start') || 0);
        return new Response(
          JSON.stringify({
            success: 1,
            total_count: 120,
            results_html: start === 0 ? makeRows(1000, 50) : makeRows(2000, 30)
          }),
          { status: 200 }
        );
      }
    });

    assert.equal(browseUrls.length, 2);
    assert.ok(browseUrls[0].includes('filter=topsellers'));
    assert.ok(browseUrls[1].includes('start=50'));
    assert.equal(pagedDeals.length, 80);
    assert.equal(pagedDeals[0].topRank, 1);
    assert.equal(pagedDeals[50].topRank, 51);

    const searchUrls = [];
    const searchDeals = await fetchSteamDeals({
      minDiscount: 40,
      query: 'Battlefield',
      steamUserdata: { rgOwnedApps: [] },
      fetchFn: async (href) => {
        searchUrls.push(href);
        return new Response(
          JSON.stringify({
            success: 1,
            total_count: 1,
            results_html: `
              <a href="https://store.steampowered.com/app/2807960/Battlefield_6/" data-ds-appid="2807960" class="search_result_row">
                <span class="title">Battlefield™ 6</span>
                <div class="discount_block" data-price-final="131900" data-discount="67">
                  <div class="discount_original_price">₹3,999.00</div>
                  <div class="discount_final_price">₹1,319.00</div>
                </div>
              </a>
            `
          }),
          { status: 200 }
        );
      }
    });

    assert.equal(searchUrls.length, 1);
    const parsedSearchUrl = new URL(searchUrls[0]);
    assert.equal(parsedSearchUrl.searchParams.get('term'), 'Battlefield');
    assert.equal(parsedSearchUrl.searchParams.get('specials'), null);
    assert.equal(searchDeals[0].id, '2807960');
  });
});
