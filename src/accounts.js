/**
 * Browser-session authentication status checks and one-click sign-in orchestration
 * for Epic Games Store and Steam.
 * Never asks for, reads, or stores user passwords.
 */

import {
  getAccountStates,
  saveAccountState,
  getPendingSignIn,
  setPendingSignIn,
  clearPendingSignIn
} from './storage.js';
import { closeTabSafely } from './providers/tab-helpers.js';
import { logger } from './logger.js';

export const STORE_LOGIN_URLS = {
  epic: 'https://store.epicgames.com/login?lang=en-US&state=' +
    encodeURIComponent('/en-US/free-games'),
  steam: 'https://store.steampowered.com/login/?redir=' +
    encodeURIComponent('https://store.steampowered.com/')
};

export function isSupportedLoginStore(storeId) {
  return storeId === 'epic' || storeId === 'steam';
}

export function parseSteamSessionHtml(html) {
  const source = String(html || '');
  if (!source) return { signedIn: null, accountName: null };

  const pulldownMatch = source.match(
    /id=["']account_pulldown["'][^>]*>([\s\S]*?)<\/(?:span|button|a|div)>/i
  );
  if (pulldownMatch) {
    const cleanName = pulldownMatch[1].replace(/<[^>]+>/g, '').trim() || null;
    return { signedIn: true, accountName: cleanName };
  }
  const steamIdMatch = source.match(/\bg_steamID\s*=\s*["'](\d{10,})["']/);
  if (steamIdMatch) {
    return { signedIn: true, accountName: null };
  }
  if (/global_action_link[^>]*href=["'][^"']*\/login/i.test(source)) {
    return { signedIn: false, accountName: null };
  }
  return { signedIn: null, accountName: null };
}

/**
 * Check whether the user currently has a live Steam session via store homepage HTML.
 * Uses existing store.steampowered.com host permission; reads no passwords.
 */
export async function checkSteamSession(fetchFn = typeof fetch === 'function' ? fetch : null) {
  if (typeof fetchFn !== 'function') return null;
  try {
    const resp = await fetchFn('https://store.steampowered.com/', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store'
    });
    if (!resp || !resp.ok) return null;
    const html = await resp.text();
    const parsed = parseSteamSessionHtml(html);
    if (parsed.signedIn !== null) {
      await saveAccountState('steam', parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Refresh store session indicators where readable without interrupting the user.
 */
export async function refreshStoreSessions() {
  await checkSteamSession();
  return getAccountStates();
}

export function isLoginCompletionUrl(storeId, url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  if (storeId === 'epic') {
    return (
      url.startsWith('https://store.epicgames.com/') &&
      !/\/login\b|\/id\/|authenticate|callback|[?&]code=/i.test(url)
    );
  }
  if (storeId === 'steam') {
    return (
      url.startsWith('https://store.steampowered.com/') &&
      !/\/login\b|openid|checkstoredlogin/i.test(url)
    );
  }
  return false;
}

/**
 * Open the official store sign-in page in a new tab, record it before activating
 * (so extension popups never close mid-storage write), then bring it to focus.
 */
export async function startStoreSignIn(storeId) {
  if (!isSupportedLoginStore(storeId)) {
    throw new Error(`Unsupported sign-in store: ${String(storeId || '')}`);
  }
  const loginUrl = STORE_LOGIN_URLS[storeId];
  const hasTabsUpdate = typeof chrome.tabs?.update === 'function';
  const tab = await chrome.tabs.create({ url: loginUrl, active: !hasTabsUpdate });
  await setPendingSignIn({
    storeId,
    tabId: tab.id,
    startedAt: new Date().toISOString()
  });
  if (hasTabsUpdate) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined && chrome.windows?.update) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  }
  await logger.info('accounts', `Opened ${storeId} sign-in tab`, { tabId: tab.id });
  return { tabId: tab.id, storeId };
}

/**
 * React to tab completion during a user-initiated store sign-in flow.
 * Marks the account connected, closes the login helper tab, and calls onSignedIn().
 */
export async function handleSignInTabUpdated(tabId, changeInfo, tab, onSignedIn = null) {
  const pending = await getPendingSignIn();
  if (!pending || pending.tabId !== tabId) return false;

  const url = changeInfo?.url || tab?.url || '';
  if (!isLoginCompletionUrl(pending.storeId, url)) return false;
  if (changeInfo?.status !== 'complete') return false;

  if (pending.storeId === 'steam') {
    const verified = await checkSteamSession();
    if (!verified || verified.signedIn !== true) {
      return false;
    }
  } else {
    await saveAccountState('epic', { signedIn: true });
  }

  await clearPendingSignIn();
  await closeTabSafely(tabId);
  await logger.info('accounts', `Signed in to ${pending.storeId}; triggering auto-claim`);

  if (typeof onSignedIn === 'function') {
    await onSignedIn(pending.storeId);
  }
  return true;
}

export async function handleSignInTabRemoved(tabId) {
  const pending = await getPendingSignIn();
  if (pending && pending.tabId === tabId) {
    await clearPendingSignIn();
  }
}
