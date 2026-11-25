import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateSelectorsConfig, mergeConfigs } from '../src/remote-config.js';

test('bundled config/selectors.json passes schema validation', async () => {
  const raw = await fs.readFile(new URL('../config/selectors.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  const res = validateSelectorsConfig(parsed);
  assert.equal(res.valid, true, `Validation errors: ${res.errors.join(', ')}`);
});

test('validateSelectorsConfig rejects invalid schemas', () => {
  assert.equal(validateSelectorsConfig(null).valid, false);
  assert.equal(validateSelectorsConfig({ version: 0, stores: {} }).valid, false);
  const badUrl = validateSelectorsConfig({
    version: 1,
    stores: {
      epic: {
        endpoints: { promotions: 'http://insecure.example.com' },
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
  assert.equal(badUrl.valid, false);
});

test('mergeConfigs preserves bundled keys while applying remote overrides', async () => {
  const raw = await fs.readFile(new URL('../config/selectors.json', import.meta.url), 'utf8');
  const bundled = JSON.parse(raw);
  const merged = mergeConfigs(bundled, {
    version: 2,
    stores: {
      epic: {
        selectors: {
          getButton: ['button.new-get-selector']
        }
      }
    }
  });
  assert.equal(merged.version, 2);
  assert.deepEqual(merged.stores.epic.selectors.getButton, ['button.new-get-selector']);
  assert.ok(merged.stores.epic.selectors.placeOrderButton.length > 0);
  assert.ok(merged.stores.steam.endpoints.searchResults.startsWith('https://'));
});

test('getSelectorsConfig fetches remote config, caches, and falls back to cache/bundled on failure', async () => {
  const { getSelectorsConfig } = await import('../src/remote-config.js');
  const raw = await fs.readFile(new URL('../config/selectors.json', import.meta.url), 'utf8');
  const validRemote = JSON.parse(raw);
  validRemote.version = 99;
  validRemote.stores.epic.selectors.getButton = ['button.remote-get'];

  const memStorage = {
    claimit_settings: {
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
    // 1. Valid remote fetch
    globalThis.fetch = async (url) => {
      if (String(url).includes('raw.githubusercontent.com')) {
        return new Response(JSON.stringify(validRemote), { status: 200 });
      }
      return new Response(raw, { status: 200 });
    };
    const resRemote = await getSelectorsConfig({ forceRefresh: true });
    assert.equal(resRemote.source, 'remote');
    assert.equal(resRemote.config.version, 99);
    assert.deepEqual(resRemote.config.stores.epic.selectors.getButton, ['button.remote-get']);

    // 2. Network error falls back to cache
    globalThis.fetch = async () => new Response('Not Found', { status: 404 });
    const resFallback = await getSelectorsConfig({ forceRefresh: true });
    assert.equal(resFallback.source, 'cache');
    assert.equal(resFallback.config.version, 99);
    assert.match(resFallback.error, /HTTP 404/);
  } finally {
    globalThis.fetch = origFetch;
    delete globalThis.chrome;
  }
});
