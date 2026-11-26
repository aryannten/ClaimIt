/**
 * Shared Chrome tab, frame-probing, and messaging utilities for store claim flows.
 * Uses chrome.tabs and chrome.scripting (no extra webNavigation permission needed).
 */

import { delay } from './constants.js';
import { isAllowedStoreUrl } from '../url-validator.js';

/**
 * Open a tab in the background and wait until its initial navigation completes.
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function openBackgroundTab(url, signal) {
  if (!isAllowedStoreUrl(url)) {
    throw new Error(`openBackgroundTab: URL not on store allowlist: ${url}`);
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabComplete(tab.id, 25000, signal);
  return chrome.tabs.get(tab.id);
}

/**
 * Wait until a tab reaches status === 'complete'.
 * @param {number} tabId
 * @param {number} [timeoutMs=25000]
 * @param {AbortSignal} [signal]
 */
async function waitForTabComplete(tabId, timeoutMs = 25000, signal) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(); // Continue with DOM polling even if subresources are still settling
      }
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete' && !settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId && !settled) {
        settled = true;
        cleanup();
        reject(new Error('Tab was closed before loading completed'));
      }
    };

    const onAbort = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('timeout'));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener('abort', onAbort);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Bring a tab and its window to the foreground (used for NEEDS_USER handoff).
 * @param {number} tabId
 */
export async function focusTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Tab may have been manually closed by the user
  }
}

/**
 * Safely close a tab, ignoring errors if already closed.
 * @param {number} tabId
 */
export async function closeTabSafely(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Already closed
  }
}

/**
 * Inspect all permitted frames inside a tab using chrome.scripting.executeScript.
 * Returns frameId + href + isTop for each frame.
 * @param {number} tabId
 * @returns {Promise<Array<{ frameId: number, href: string, isTop: boolean, ready: boolean }>>}
 */
export async function listTabFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        href: window.location.href,
        isTop: window === window.top,
        ready: Boolean(window.__claimitContentReady)
      })
    });
    return results
      .filter((r) => r && r.result)
      .map((r) => ({ frameId: r.frameId, ...r.result }));
  } catch {
    return [];
  }
}

/**
 * Ensure a content script file is injected into a specific frame, then send a message.
 * @param {number} tabId
 * @param {number} frameId
 * @param {string} contentScriptFile
 * @param {object} message
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
export async function sendFrameMessage(tabId, frameId, contentScriptFile, message, signal) {
  if (signal?.aborted) throw new Error('timeout');

  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch {
    if (signal?.aborted) throw new Error('timeout');
    try {
      // Inject content script lazily if the frame navigated or loaded before script attachment
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: [contentScriptFile]
      });
      await delay(150, signal);
      return await chrome.tabs.sendMessage(tabId, message, { frameId });
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'timeout')) {
        throw new Error('timeout');
      }
      // Frame likely navigated cross-origin (e.g., to SSO login page) or closed
      return null;
    }
  }
}
