/**
 * Content script for Steam Store app pages.
 * Selectors and text patterns are dynamically supplied from config/selectors.json.
 */

(() => {
  if (window.__claimitSteamListenerInstalled) return;
  window.__claimitSteamListenerInstalled = true;
  window.__claimitContentReady = true;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normText(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function matchesAnyText(text, patterns = []) {
    const lower = (text || '').toLowerCase();
    return patterns.some((p) => lower.includes(String(p).toLowerCase()));
  }

  function findFirstVisible(selectors = [], textFilters = null) {
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        if (!textFilters || textFilters.length === 0) return el;
        if (matchesAnyText(normText(el), textFilters)) return el;
      }
    }
    return null;
  }

  function inspectPage(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};
    const bodyText = (document.body?.innerText || '').toLowerCase();

    const ageGateEl = findFirstVisible(selectors.ageGateForm || []);
    const ageGate = Boolean(ageGateEl) || /\/agecheck\//i.test(window.location.pathname);

    const ownedEl = findFirstVisible(selectors.ownedIndicator || []);
    const owned = Boolean(ownedEl) || matchesAnyText(bodyText, texts.alreadyOwned || []);

    const claimedSuccess =
      matchesAnyText(bodyText, texts.claimedSuccess || []) ||
      /\/account\/licenses/i.test(window.location.pathname);

    const unavailable = matchesAnyText(bodyText, texts.unavailable || []);

    const addBtn =
      findFirstVisible(selectors.addToAccountButton || [], texts.addToAccount || []) ||
      findFirstVisible(["a[href*='addFreeLicense']"]);

    const purchaseBlock = document.querySelector('.game_area_purchase_game_wrapper, #game_area_purchase');
    const purchaseText = purchaseBlock ? normText(purchaseBlock) : '';
    const freeWeekendOrTrial =
      !addBtn && matchesAnyText(purchaseText, texts.freeWeekendOrTrial || []);

    const accountPulldown = document.querySelector('#account_pulldown');
    const loginLink = findFirstVisible(["a.global_action_link[href*='login']"]);
    const loginRequired = !accountPulldown && (Boolean(loginLink) || /\/login/i.test(window.location.pathname));

    const ready =
      ageGate ||
      owned ||
      claimedSuccess ||
      unavailable ||
      Boolean(addBtn) ||
      freeWeekendOrTrial ||
      document.readyState === 'complete';

    return {
      ready,
      ageGate,
      owned,
      claimedSuccess,
      unavailable,
      loginRequired,
      freeWeekendOrTrial,
      hasAddButton: Boolean(addBtn),
      addText: addBtn ? normText(addBtn) : null
    };
  }

  function passAgeGate(config = {}) {
    const selectors = config.selectors || {};
    const yearSelect = document.querySelector('#ageYear');
    if (yearSelect && isVisible(yearSelect)) {
      yearSelect.value = '1990';
      yearSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const continueBtn = findFirstVisible(selectors.ageGateContinue || []);
    if (!continueBtn) {
      return { passed: false, reason: 'Age gate continue button not found' };
    }
    continueBtn.click();
    return { passed: true };
  }

  function clickAddToAccount(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};

    const btn =
      findFirstVisible(selectors.addToAccountButton || [], texts.addToAccount || []) ||
      findFirstVisible(["a[href*='addFreeLicense']"]);

    if (!btn) {
      return { clicked: false, reason: 'Add to Account button not found' };
    }
    btn.click();
    return { clicked: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.action) {
        case 'STEAM_INSPECT_PAGE':
          sendResponse(inspectPage(message.config));
          return false;
        case 'STEAM_PASS_AGE_GATE':
          sendResponse(passAgeGate(message.config));
          return false;
        case 'STEAM_CLICK_ADD_TO_ACCOUNT':
          sendResponse(clickAddToAccount(message.config));
          return false;
        default:
          return false;
      }
    } catch (err) {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  });
})();
