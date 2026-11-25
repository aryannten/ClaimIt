/**
 * Content script for Epic Games Store pages and checkout iframes.
 * All selectors and button texts are provided dynamically from config/selectors.json
 * via message payloads so HTML breakages can be fixed via remote config updates.
 */

(() => {
  if (window.__claimitEpicListenerInstalled) return;
  window.__claimitEpicListenerInstalled = true;
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
      let candidates;
      try {
        candidates = Array.from(document.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        if (!textFilters || textFilters.length === 0) return el;
        const txt = normText(el);
        if (matchesAnyText(txt, textFilters)) return el;
      }
    }
    return null;
  }

  function findButtonByText(textFilters = []) {
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"]'));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      if (matchesAnyText(normText(btn), textFilters)) {
        return btn;
      }
    }
    return null;
  }

  function hasCaptcha(selectors = {}) {
    return Boolean(findFirstVisible(selectors.captchaContainer || []));
  }

  function inspectProduct(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};
    const bodyText = (document.body?.innerText || '').toLowerCase();

    const captcha = hasCaptcha(selectors);
    const unavailable = matchesAnyText(bodyText, texts.unavailable || []);

    const getBtn =
      findFirstVisible(selectors.getButton || [], texts.getButton || []) ||
      findFirstVisible(selectors.getButton || []);

    const ownedBtn = findFirstVisible(selectors.ownedIndicator || [], texts.owned || []);
    const owned = Boolean(ownedBtn) || (getBtn ? matchesAnyText(normText(getBtn), texts.owned || []) : false);

    // Check if primary CTA or header requires login
    const loginEl = findFirstVisible(selectors.loginIndicator || [], texts.loginRequired || []);
    const ctaLogin = getBtn ? matchesAnyText(normText(getBtn), texts.loginRequired || []) : false;
    const loginRequired = ctaLogin || (Boolean(loginEl) && !getBtn && !owned);

    const hasGetButton = Boolean(getBtn && !owned && !ctaLogin && matchesAnyText(normText(getBtn), texts.getButton || []));
    const readyForDecision = captcha || unavailable || owned || loginRequired || hasGetButton;

    return {
      readyForDecision,
      captcha,
      unavailable,
      owned,
      loginRequired,
      hasGetButton,
      ctaText: getBtn ? normText(getBtn) : null
    };
  }

  function clickGet(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};
    const btn =
      findFirstVisible(selectors.getButton || [], texts.getButton || []) ||
      findButtonByText(texts.getButton || []);

    if (!btn) {
      return { clicked: false, reason: 'Get button not found' };
    }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, reason: 'Get button is disabled' };
    }
    btn.click();
    return { clicked: true };
  }

  function inspectCheckout(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};
    const bodyText = (document.body?.innerText || '').toLowerCase();

    const captcha = hasCaptcha(selectors);
    const unavailable = matchesAnyText(bodyText, texts.unavailable || []);
    const orderConfirmed = matchesAnyText(bodyText, texts.orderConfirmed || []);

    const euAgreeBtn =
      findFirstVisible(selectors.euAgreeButton || [], texts.euAgreeButton || []) ||
      findButtonByText(texts.euAgreeButton || []);

    const placeOrderBtn =
      findFirstVisible(selectors.placeOrderButton || [], texts.placeOrderButton || []) ||
      findButtonByText(texts.placeOrderButton || []);

    return {
      captcha,
      unavailable,
      orderConfirmed,
      hasEuAgree: Boolean(euAgreeBtn),
      hasPlaceOrder: Boolean(placeOrderBtn)
    };
  }

  function acceptEuAgree(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};

    for (const cbSelector of selectors.eulaCheckbox || []) {
      try {
        const cb = document.querySelector(cbSelector);
        if (cb && isVisible(cb) && !cb.checked) {
          cb.click();
        }
      } catch {
        // Ignore invalid selector
      }
    }

    const btn =
      findFirstVisible(selectors.euAgreeButton || [], texts.euAgreeButton || []) ||
      findButtonByText(texts.euAgreeButton || []);

    if (!btn) {
      return { accepted: false, reason: 'EU I Agree button not found' };
    }
    btn.click();
    return { accepted: true };
  }

  function placeOrder(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};

    for (const cbSelector of selectors.eulaCheckbox || []) {
      try {
        const cb = document.querySelector(cbSelector);
        if (cb && isVisible(cb) && !cb.checked) {
          cb.click();
        }
      } catch {
        // Ignore invalid selector
      }
    }

    const btn =
      findFirstVisible(selectors.placeOrderButton || [], texts.placeOrderButton || []) ||
      findButtonByText(texts.placeOrderButton || []);

    if (!btn) {
      return { clicked: false, reason: 'Place Order button not found' };
    }
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      return { clicked: false, reason: 'Place Order button is disabled' };
    }
    btn.click();
    return { clicked: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      switch (message?.action) {
        case 'EPIC_INSPECT_PRODUCT':
          sendResponse(inspectProduct(message.config));
          return false;
        case 'EPIC_CLICK_GET':
          sendResponse(clickGet(message.config));
          return false;
        case 'EPIC_INSPECT_CHECKOUT':
          sendResponse(inspectCheckout(message.config));
          return false;
        case 'EPIC_ACCEPT_EU_AGREE':
          sendResponse(acceptEuAgree(message.config));
          return false;
        case 'EPIC_PLACE_ORDER':
          sendResponse(placeOrder(message.config));
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
