/**
 * Security tests for ClaimIt:
 * - URL & Discord webhook allowlist validation
 * - Remote config schema validation (unknown keys, disallowed hosts, oversize, non-HTTPS/private URLs)
 * - FX rate upper-bound & malformed payload sanitization
 * - Secret redaction in logger ring buffer & notifications
 * - Open tab URL allowlist enforcement
 * - Per-cycle claim cap enforcement
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  isAllowedStoreUrl,
  isAllowedStoreEndpointUrl,
  isAllowedDiscordWebhookUrl
} from '../src/url-validator.js';
import { validateSelectorsConfig, mergeConfigs, getSelectorsConfig, isValidRemoteConfigUrl } from '../src/remote-config.js';
import { openBackgroundTab } from '../src/providers/tab-helpers.js';
import { appendToRingBuffer, logger, redactSecrets } from '../src/logger.js';
import { getExchangeRates } from '../src/currency.js';
import { MAX_CLAIMS_PER_CYCLE, runCheckCycle } from '../src/engine.js';
import { buildTelegramPayload, buildDiscordPayload } from '../src/notifications.js';
import { STORAGE_KEYS } from '../src/storage.js';
import { CLAIM_STATUS } from '../src/providers/constants.js';

describe('URL allowlists', () => {
  it('accepts valid Epic and Steam store URLs', () => {
    assert.equal(isAllowedStoreUrl('https://store.epicgames.com/en-US/free-games'), true);
    assert.equal(isAllowedStoreUrl('https://store.steampowered.com/app/1234/'), true);
    assert.equal(isAllowedStoreUrl('https://payment-website-pci.ol.epicgames.com/purchase'), true);
  });

  it('rejects javascript:, data:, blob:, http:, credentials, and unknown hostnames', () => {
    assert.equal(isAllowedStoreUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedStoreUrl('data:text/html,<h1>test</h1>'), false);
    assert.equal(isAllowedStoreUrl('blob:https://store.epicgames.com/abc'), false);
    assert.equal(isAllowedStoreUrl('http://store.epicgames.com/en-US/free-games'), false);
    assert.equal(isAllowedStoreUrl('https://user:pass@store.epicgames.com/en-US/free-games'), false);
    assert.equal(isAllowedStoreUrl('https://evil.example.com/claim'), false);
    assert.equal(isAllowedStoreUrl(''), false);
    assert.equal(isAllowedStoreUrl(null), false);
  });

  it('validates Discord webhook URLs strictly by host and webhook path', () => {
    assert.equal(isAllowedDiscordWebhookUrl('https://discord.com/api/webhooks/123456789/abcdef_token-1'), true);
    assert.equal(isAllowedDiscordWebhookUrl('https://discordapp.com/api/webhooks/123456789/abcdef_token'), true);
    assert.equal(isAllowedDiscordWebhookUrl('http://discord.com/api/webhooks/123/abc'), false);
    assert.equal(isAllowedDiscordWebhookUrl('https://evil.example.com/api/webhooks/123/abc'), false);
    assert.equal(isAllowedDiscordWebhookUrl('https://discord.com/channels/123/456'), false);
  });

  it('openBackgroundTab throws before calling chrome.tabs.create on disallowed URLs', async () => {
    let tabCreateCalled = false;
    globalThis.chrome = {
      tabs: {
        async create() {
          tabCreateCalled = true;
          return { id: 1 };
        }
      }
    };
    try {
      await assert.rejects(
        () => openBackgroundTab('https://evil.example.com/phish'),
        /allowlist/i
      );
      await assert.rejects(
        () => openBackgroundTab('javascript:alert(1)'),
        /allowlist/i
      );
      assert.equal(tabCreateCalled, false);
    } finally {
      delete globalThis.chrome;
    }
  });
});

describe('remote config security', () => {
  it('rejects unknown top-level, store, and endpoint keys plus disallowed endpoint domains', () => {
    assert.equal(validateSelectorsConfig({ version: 1, stores: {} }).valid, false);
    assert.equal(validateSelectorsConfig('not an object').valid, false);

    const unknownTopKey = validateSelectorsConfig({
      version: 1,
      extraDangerousFlag: true,
      stores: {
        epic: {
          endpoints: { promotions: 'https://store.epicgames.com/free-games' },
          selectors: { getButton: ['button'] },
          texts: { getButton: ['get'] }
        },
        steam: {
          endpoints: { searchResults: 'https://store.steampowered.com/search' },
          selectors: { addToAccountButton: ['a'] },
          texts: { addToAccount: ['add'] }
        }
      }
    });
    assert.equal(unknownTopKey.valid, false);

    const hijackedEndpoint = validateSelectorsConfig({
      version: 1,
      stores: {
        epic: {
          endpoints: { promotions: 'https://attacker.example.com/collect' },
          selectors: { getButton: ['button'] },
          texts: { getButton: ['get'] }
        },
        steam: {
          endpoints: { searchResults: 'https://store.steampowered.com/search' },
          selectors: { addToAccountButton: ['a'] },
          texts: { addToAccount: ['add'] }
        }
      }
    });
    assert.equal(hijackedEndpoint.valid, false);
    assert.ok(isAllowedStoreEndpointUrl('epic', 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions'));
    assert.equal(isAllowedStoreEndpointUrl('epic', 'https://store.steampowered.com/'), false);
  });

  it('rejects non-HTTPS, credentialed, loopback, and private network remote config URLs', () => {
    assert.equal(isValidRemoteConfigUrl('https://raw.githubusercontent.com/user/repo/main/selectors.json'), true);
    assert.equal(isValidRemoteConfigUrl('http://raw.githubusercontent.com/user/repo/main/selectors.json'), false);
    assert.equal(isValidRemoteConfigUrl('https://user:pass@raw.githubusercontent.com/a.json'), false);
    assert.equal(isValidRemoteConfigUrl('https://localhost/selectors.json'), false);
    assert.equal(isValidRemoteConfigUrl('https://127.0.0.1/selectors.json'), false);
    assert.equal(isValidRemoteConfigUrl('https://192.168.1.10/selectors.json'), false);
    assert.equal(isValidRemoteConfigUrl('ftp://raw.githubusercontent.com/a.json'), false);
  });

  it('mergeConfigs strips unknown/prototype properties', () => {
    const merged = mergeConfigs(
      { version: 1, updatedAt: '2026-01-01', stores: { epic: { selectors: { getButton: ['a'] } }, steam: {} } },
      JSON.parse('{"version":2,"unknownKey":"bad","__proto__":{"polluted":true},"stores":{"epic":{"selectors":{"getButton":["b"],"evil":["x"]}}}}')
    );
    assert.equal(merged.version, 2);
    assert.equal(merged.unknownKey, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal(merged.stores.epic.selectors.evil, undefined);
    assert.deepEqual(merged.stores.epic.selectors.getButton, ['b']);
  });

  it('getSelectorsConfig rejects >512KB remote config response and falls back to bundled', async () => {
    const rawBundled = await fs.readFile(new URL('../config/selectors.json', import.meta.url), 'utf8');
    const memStorage = {
      [STORAGE_KEYS.SETTINGS]: {
        remoteConfigUrl: 'https://raw.githubusercontent.com/test/repo/main/selectors.json'
      }
    };
    globalThis.chrome = {
      storage: {
        local: {
          async get(key) {
            return { [key]: memStorage[key] };
          },
          async set(obj) {
            Object.assign(memStorage, obj);
          }
        }
      }
    };

    const origFetch = globalThis.fetch;
    try {
      const oversizeBody = 'x'.repeat(600_000);
      globalThis.fetch = async (url) => {
        if (String(url).includes('raw.githubusercontent.com')) {
          return new Response(oversizeBody, { status: 200 });
        }
        return new Response(rawBundled, { status: 200 });
      };

      const res = await getSelectorsConfig({ forceRefresh: true });
      assert.equal(res.source, 'bundled');
      assert.match(res.error, /512 KB/i);
    } finally {
      globalThis.fetch = origFetch;
      delete globalThis.chrome;
    }
  });
});

describe('FX rate bounds, secret redaction, and claim cap', () => {
  it('rejects out-of-bounds or negative exchange rates', async () => {
    const res = await getExchangeRates({
      cached: null,
      nowMs: 1_700_000_000_000,
      fetchFn: async () => new Response(JSON.stringify({
        result: 'success',
        rates: { USD: 1, INR: 85, BAD_HUGE: 1e12, BAD_ZERO: 0, BAD_NEG: -5 }
      }), { status: 200 })
    });
    assert.equal(res.rates.INR, 85);
    assert.equal(res.rates.BAD_HUGE, undefined);
    assert.equal(res.rates.BAD_ZERO, undefined);
    assert.equal(res.rates.BAD_NEG, undefined);
  });

  it('redacts Telegram tokens and Discord webhook secrets in logger and notification payloads', async () => {
    const sample = 'Failed POST https://api.telegram.org/bot123456:SECRET_TOKEN_XYZ/sendMessage and https://discord.com/api/webhooks/999999/SECRET_HOOK';
    const redacted = redactSecrets(sample);
    assert.equal(redacted.includes('SECRET_TOKEN_XYZ'), false);
    assert.equal(redacted.includes('SECRET_HOOK'), false);
    assert.ok(redacted.includes('bot[REDACTED]'));
    assert.ok(redacted.includes('/webhooks/[REDACTED]'));

    const memStorage = {};
    globalThis.chrome = {
      storage: {
        local: {
          async get(k) { return { [k]: memStorage[k] }; },
          async set(obj) { Object.assign(memStorage, obj); }
        }
      }
    };
    try {
      await logger.warn('test', sample, { detail: 'https://discord.com/api/webhooks/999/MY_SECRET' });
      const entries = await logger.getAll();
      const serialized = JSON.stringify(entries);
      assert.equal(serialized.includes('SECRET_TOKEN_XYZ'), false);
      assert.equal(serialized.includes('MY_SECRET'), false);
    } finally {
      delete globalThis.chrome;
    }

    const offer = {
      store: 'epic',
      storeName: 'Epic Games Store',
      title: 'Test Game',
      url: 'javascript:alert(1)',
      image: 'http://insecure.example/img.jpg',
      originalPriceValue: 999,
      currencyCode: 'INR'
    };
    const tg = buildTelegramPayload(offer, 'NEEDS_USER', 'Test', 'chat123');
    assert.equal(tg.reply_markup, undefined);
    const dc = buildDiscordPayload(offer, 'NEEDS_USER', 'Test');
    assert.equal(dc.embeds[0].url, undefined);
    assert.equal(dc.embeds[0].thumbnail, undefined);
    assert.equal(appendToRingBuffer([], { a: 1 }).length, 1);
  });

  it('enforces MAX_CLAIMS_PER_CYCLE in engine to bound runaway loops', async () => {
    const storeData = {
      [STORAGE_KEYS.SETTINGS]: {
        paused: false,
        dryRun: false,
        stores: { epic: { enabled: true, mode: 'auto' } },
        notifications: { chrome: false }
      }
    };
    globalThis.chrome = {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: storeData[keys] };
            const out = {};
            for (const k of Array.isArray(keys) ? keys : []) out[k] = storeData[k];
            return out;
          },
          async set(v) { Object.assign(storeData, v); },
          async remove(ks) { for (const k of Array.isArray(ks) ? ks : [ks]) delete storeData[k]; }
        }
      },
      alarms: {
        async get() { return null; },
        async clear() { return true; },
        async create() {}
      }
    };

    try {
      const nowMs = Date.now();
      let claimCalls = 0;
      const manyOffers = Array.from({ length: MAX_CLAIMS_PER_CYCLE + 5 }, (_, i) => ({
        id: `game-${i}`,
        store: 'epic',
        storeName: 'Epic Games Store',
        title: `Game ${i}`,
        url: `https://store.epicgames.com/en-US/p/game-${i}`,
        originalPrice: 499,
        discountPrice: 0,
        discountPercent: 100,
        currencyCode: 'INR',
        endDate: new Date(nowMs + 4 * 3600_000).toISOString(),
        isLimitedTime: true,
        type: 'game'
      }));

      const res = await runCheckCycle({
        trigger: 'manual',
        deps: {
          getSelectorsConfig: async () => ({ config: {}, source: 'bundled' }),
          getEnabledProviders: () => [{
            id: 'epic',
            name: 'Epic Games Store',
            async fetchOffers() { return manyOffers; },
            async isOwned() { return false; },
            async claim() { claimCalls += 1; return { status: CLAIM_STATUS.CLAIMED }; }
          }],
          interClaimDelay: async () => {},
          nowMs: () => nowMs
        }
      });

      assert.equal(claimCalls, MAX_CLAIMS_PER_CYCLE);
      assert.equal(res.offers.length, manyOffers.length);
      assert.equal(res.offers.at(-1).status, CLAIM_STATUS.NEEDS_USER);
    } finally {
      delete globalThis.chrome;
    }
  });
});
