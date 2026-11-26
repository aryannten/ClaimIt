/**
 * Tests for account session checks, one-click sign-in tab completion, and auto-claim trigger.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSteamSessionHtml,
  isLoginCompletionUrl,
  startStoreSignIn,
  handleSignInTabUpdated
} from '../src/accounts.js';
import { STORAGE_KEYS, getAccountStates } from '../src/storage.js';

describe('store session detection & one-click sign-in', () => {
  it('parseSteamSessionHtml detects signed-in persona vs signed-out header', () => {
    const loggedIn = parseSteamSessionHtml(
      '<div id="global_action_menu"><span class="pulldown" id="account_pulldown">aryan_steam</span></div>'
    );
    assert.equal(loggedIn.signedIn, true);
    assert.equal(loggedIn.accountName, 'aryan_steam');

    const loggedInButton = parseSteamSessionHtml(
      '<div id="global_action_menu"><button type="button" class="pulldown" id="account_pulldown">aryan_steam</button></div>'
    );
    assert.equal(loggedInButton.signedIn, true);
    assert.equal(loggedInButton.accountName, 'aryan_steam');

    const loggedInScript = parseSteamSessionHtml('<script>var g_steamID = "76561198000000000";</script>');
    assert.equal(loggedInScript.signedIn, true);

    const loggedOut = parseSteamSessionHtml(
      '<div id="global_action_menu"><a class="global_action_link" href="https://store.steampowered.com/login/">sign in</a></div>'
    );
    assert.equal(loggedOut.signedIn, false);

    assert.equal(parseSteamSessionHtml('').signedIn, null);
  });

  it('isLoginCompletionUrl distinguishes login pages from completed store pages', () => {
    assert.equal(isLoginCompletionUrl('epic', 'https://store.epicgames.com/en-US/free-games'), true);
    assert.equal(isLoginCompletionUrl('epic', 'https://store.epicgames.com/en-US/free-games?code=abc123'), false);
    assert.equal(isLoginCompletionUrl('epic', 'https://store.epicgames.com/login?redirectUrl=x'), false);
    assert.equal(isLoginCompletionUrl('epic', 'https://store.epicgames.com/id/login'), false);
    assert.equal(isLoginCompletionUrl('epic', 'https://accounts.epicgames.com/login'), false);

    assert.equal(isLoginCompletionUrl('steam', 'https://store.steampowered.com/'), true);
    assert.equal(isLoginCompletionUrl('steam', 'https://store.steampowered.com/login/?redir=1'), false);
  });

  it('startStoreSignIn saves pending sign-in before activating tab when tabs.update exists', async () => {
    const store = {};
    const events = [];
    let createdTab = null;

    globalThis.chrome = {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: store[keys] };
            return { ...store };
          },
          async set(obj) {
            events.push(`storage.set:${Object.keys(obj).join(',')}`);
            Object.assign(store, obj);
          },
          async remove(keys) {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
          }
        }
      },
      tabs: {
        async create(opts) {
          events.push(`tabs.create:active=${opts.active}`);
          createdTab = { id: 88, windowId: 12, ...opts };
          return createdTab;
        },
        async update(tabId, opts) {
          events.push(`tabs.update:${tabId}:active=${opts.active}`);
          return { id: tabId, ...opts };
        }
      },
      windows: {
        async update(windowId, opts) {
          events.push(`windows.update:${windowId}:focused=${opts.focused}`);
          return { id: windowId, ...opts };
        }
      }
    };

    try {
      const res = await startStoreSignIn('epic');
      assert.equal(res.tabId, 88);
      assert.equal(createdTab.active, false);
      assert.ok(createdTab.url.includes('state='), `Expected state= param in ${createdTab.url}`);
      assert.equal(createdTab.url.includes('redirectUrl='), false);
      assert.equal(store[STORAGE_KEYS.PENDING_SIGNIN].storeId, 'epic');

      const setIdx = events.findIndex((e) => e.includes(STORAGE_KEYS.PENDING_SIGNIN));
      const updateIdx = events.findIndex((e) => e.startsWith('tabs.update:88:active=true'));
      assert.ok(setIdx >= 0 && updateIdx > setIdx, `Expected PENDING_SIGNIN set before tabs.update, got ${events.join(' -> ')}`);
    } finally {
      delete globalThis.chrome;
    }
  });

  it('startStoreSignIn + handleSignInTabUpdated marks connected, closes helper tab, and triggers auto-claim', async () => {
    const store = {};
    const closedTabs = [];
    let createdTab = null;

    globalThis.chrome = {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: store[keys] };
            return { ...store };
          },
          async set(obj) {
            Object.assign(store, obj);
          },
          async remove(keys) {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
          }
        }
      },
      tabs: {
        async create(opts) {
          createdTab = { id: 77, ...opts };
          return createdTab;
        },
        async remove(id) {
          closedTabs.push(id);
        }
      }
    };

    try {
      const res = await startStoreSignIn('epic');
      assert.equal(res.tabId, 77);
      assert.equal(createdTab.active, true);
      assert.equal(store[STORAGE_KEYS.PENDING_SIGNIN].storeId, 'epic');

      // Login page navigation should not complete early
      let autoClaimTriggeredFor = null;
      const ignored = await handleSignInTabUpdated(
        77,
        { status: 'complete', url: 'https://store.epicgames.com/login' },
        { id: 77 },
        async (s) => { autoClaimTriggeredFor = s; }
      );
      assert.equal(ignored, false);
      assert.equal(autoClaimTriggeredFor, null);

      // Post-login redirect to Epic store completes sign-in and triggers auto-claim
      const done = await handleSignInTabUpdated(
        77,
        { status: 'complete', url: 'https://store.epicgames.com/en-US/free-games' },
        { id: 77 },
        async (s) => { autoClaimTriggeredFor = s; }
      );
      assert.equal(done, true);
      assert.equal(autoClaimTriggeredFor, 'epic');
      assert.deepEqual(closedTabs, [77]);
      assert.equal(store[STORAGE_KEYS.PENDING_SIGNIN], undefined);
      const accounts = await getAccountStates();
      assert.equal(accounts.epic.signedIn, true);
    } finally {
      delete globalThis.chrome;
    }
  });
});
