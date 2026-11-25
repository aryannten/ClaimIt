import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEpicPromotions } from '../src/providers/epic.js';
import {
  parseSteamSearchHtml,
  parseSteamDbFreeHtml,
  setSteamSource,
  fetchOffers as fetchSteamOffers
} from '../src/providers/steam.js';
import { getAllProviders, getActiveProviders, getEnabledProviders } from '../src/providers/index.js';
import { classifyOffers } from '../src/classifier.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');

test('parseEpicPromotions parses live Epic payload and classifier selects only active 100%-off items', () => {
  const payload = {
    data: {
      Catalog: {
        searchStore: {
          elements: [
            {
              id: '1f9a12b06b4f437790b6913ad136a08c',
              namespace: 'ns1',
              title: 'Mark of the Deep',
              offerType: 'BASE_GAME',
              productSlug: null,
              urlSlug: '2fd257a6cd80405a833f9004ff07993a',
              categories: [{ path: 'freegames' }, { path: 'games/edition/base' }],
              keyImages: [{ type: 'OfferImageWide', url: 'https://cdn1.epicgames.com/mark.jpg' }],
              catalogNs: { mappings: [{ pageSlug: 'mark-of-the-deep-f7dc08', pageType: 'productHome' }] },
              offerMappings: [{ pageSlug: 'mark-of-the-deep-f7dc08', pageType: 'productHome' }],
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
                ],
                upcomingPromotionalOffers: []
              }
            },
            {
              id: 'partial-id',
              namespace: 'ns2',
              title: 'TerraScape',
              offerType: 'BASE_GAME',
              productSlug: null,
              urlSlug: 'terrascape',
              categories: [{ path: 'freegames' }],
              keyImages: [],
              catalogNs: { mappings: [{ pageSlug: 'terrascape-2b12b1', pageType: 'productHome' }] },
              price: {
                totalPrice: {
                  originalPrice: 1699,
                  discountPrice: 1189,
                  currencyCode: 'USD',
                  currencyInfo: { decimals: 2 },
                  fmtPrice: { originalPrice: '$16.99', discountPrice: '$11.89' }
                }
              },
              promotions: {
                promotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: '2026-11-21T16:00:00.000Z',
                        endDate: '2026-12-21T16:00:00.000Z',
                        discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 70 }
                      }
                    ]
                  }
                ],
                upcomingPromotionalOffers: []
              }
            },
            {
              id: 'upcoming-id',
              namespace: 'ns3',
              title: 'Bread and Fred',
              offerType: 'BASE_GAME',
              productSlug: null,
              urlSlug: 'bread-and-fred',
              categories: [{ path: 'freegames' }],
              keyImages: [],
              catalogNs: { mappings: [{ pageSlug: 'bread-and-fred-1db362', pageType: 'productHome' }] },
              price: {
                totalPrice: {
                  originalPrice: 1499,
                  discountPrice: 1499,
                  currencyCode: 'USD',
                  currencyInfo: { decimals: 2 },
                  fmtPrice: { originalPrice: '$14.99' }
                }
              },
              promotions: {
                promotionalOffers: [],
                upcomingPromotionalOffers: [
                  {
                    promotionalOffers: [
                      {
                        startDate: '2026-11-26T16:00:00.000Z',
                        endDate: '2026-12-03T16:00:00.000Z',
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

  const parsed = parseEpicPromotions(payload, {}, NOW);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].url, 'https://store.epicgames.com/en-US/p/mark-of-the-deep-f7dc08');

  const { eligible, excluded } = classifyOffers(parsed, NOW);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].title, 'Mark of the Deep');
  assert.equal(excluded.length, 2);
});

test('parseSteamSearchHtml parses 100%-off search rows and rejects partial/weekend offers', () => {
  const html = `
    <a href="https://store.steampowered.com/app/555111/Free_Keep_Game/?snr=1"
       data-ds-appid="555111" class="search_result_row ds_collapse_flag">
      <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/capsule.jpg"></div>
      <div class="search_name"><span class="title">Free Keep Game</span></div>
      <div class="discount_block search_discount_block" data-price-final="0" data-discount="100">
        <div class="discount_pct">-100%</div>
        <div class="discount_prices">
          <div class="discount_original_price">$19.99</div>
          <div class="discount_final_price">Free</div>
        </div>
      </div>
    </a>
    <a href="https://store.steampowered.com/app/1174180/Red_Dead_Redemption_2/?snr=1"
       data-ds-appid="1174180" class="search_result_row ds_collapse_flag">
      <div class="search_capsule"><img src="https://shared.fastly.steamstatic.com/rdr2.jpg"></div>
      <div class="search_name"><span class="title">Red Dead Redemption 2</span></div>
      <div class="discount_block search_discount_block" data-price-final="124900" data-discount="75">
        <div class="discount_pct">-75%</div>
        <div class="discount_prices">
          <div class="discount_original_price">$59.99</div>
          <div class="discount_final_price">$14.99</div>
        </div>
      </div>
    </a>
  `;

  const parsed = parseSteamSearchHtml(html);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, '555111');
  assert.equal(parsed[0].originalPrice, 19.99);
  assert.equal(parsed[0].discountPercent, 100);

  const { eligible } = classifyOffers(parsed, NOW);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, '555111');
});

test('Steam source can be swapped cleanly', async () => {
  const html = `<table><tr data-appid="999001"><td><a href="/app/999001/">Indie Gem</a></td><td>Keep</td><td datetime="2026-12-01T00:00:00Z"></td></tr></table>`;
  const steamDbOffers = parseSteamDbFreeHtml(html);
  assert.equal(steamDbOffers.length, 1);
  assert.equal(steamDbOffers[0].id, '999001');

  setSteamSource('mock_source', async () => steamDbOffers);
  const fetched = await fetchSteamOffers({ sourceId: 'mock_source' });
  assert.equal(fetched[0].title, 'Indie Gem');
  setSteamSource('steam_search');
});

test('provider registry exposes active stores and keeps stubs disabled', () => {
  const all = getAllProviders();
  const active = getActiveProviders();
  assert.equal(all.length, 6);
  assert.equal(active.map((p) => p.id).join(','), 'epic,steam');

  const enabled = getEnabledProviders({
    stores: {
      epic: { enabled: true },
      steam: { enabled: false },
      gog: { enabled: true }
    }
  });
  assert.deepEqual(enabled.map((p) => p.id), ['epic']);
});
