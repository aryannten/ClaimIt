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

  function findFirstVisible(selectors = [], textFilters = null, root = document) {
    for (const selector of selectors) {
      let candidates;
      try {
        candidates = Array.from(root.querySelectorAll(selector));
      } catch {
        continue;
      }
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        if (!textFilters || textFilters.length === 0) return el;
        if (matchesAnyText(normText(el), textFilters)) return el;
      }
    }
    return null;
  }

  function findButtonByText(textFilters = [], root = document) {
    const buttons = Array.from(root.querySelectorAll('button, a[role="button"]'));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      if (matchesAnyText(normText(btn), textFilters)) {
        return btn;
      }
    }
    return null;
  }

  function getCheckoutRoot(selectors = {}) {
    if (window !== window.top) return document;
    const container = findFirstVisible(selectors.checkoutContainer || ['#webPurchaseContainer', '#purchase-app']);
    return container || null;
  }

  function hasCaptcha(selectors = {}) {
    return Boolean(findFirstVisible(selectors.captchaContainer || []));
  }

  function waitForState(inspectFn, isDone, waitMs = 0) {
    const initial = inspectFn();
    if (!waitMs || isDone(initial) || !document.body) {
      return Promise.resolve(initial);
    }

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      const timer = setTimeout(() => finish(inspectFn()), waitMs);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (observer) observer.disconnect();
        resolve(result);
      };

      observer = new MutationObserver(() => {
        const next = inspectFn();
        if (isDone(next)) {
          finish(next);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  }

  function inspectProduct(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};

    const captcha = hasCaptcha(selectors);
    const unavailableEl = findFirstVisible(selectors.regionUnavailableIndicator || [], texts.unavailable || []);
    const unavailable = Boolean(unavailableEl);

    const getBtn =
      findFirstVisible(selectors.getButton || [], texts.getButton || []) ||
      findFirstVisible(selectors.getButton || []);

    const ownedBtn = findFirstVisible(selectors.ownedIndicator || [], texts.owned || []);
    const owned = Boolean(ownedBtn) || (getBtn ? matchesAnyText(normText(getBtn), texts.owned || []) : false);

    const loginEl = findFirstVisible(selectors.loginIndicator || [], texts.loginRequired || []);
    const ctaLogin = getBtn ? matchesAnyText(normText(getBtn), texts.loginRequired || []) : false;
    const loginRequired = ctaLogin || (Boolean(loginEl) && !getBtn && !owned);

    const hasGetButton = Boolean(
      getBtn && !owned && !ctaLogin && matchesAnyText(normText(getBtn), texts.getButton || [])
    );
    const hasCheckoutContainer = Boolean(
      findFirstVisible(selectors.checkoutContainer || ['#webPurchaseContainer', '#purchase-app']) ||
        findFirstVisible(selectors.checkoutIframe || [])
    );

    const readyForDecision = captcha || unavailable || owned || loginRequired || hasGetButton;

    return {
      readyForDecision,
      captcha,
      unavailable,
      owned,
      loginRequired,
      hasGetButton,
      hasCheckoutContainer,
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
    const root = getCheckoutRoot(selectors);
    if (!root) {
      return {
        captcha: hasCaptcha(selectors),
        unavailable: false,
        orderConfirmed: false,
        hasEuAgree: false,
        hasPlaceOrder: false
      };
    }

    const rootText = (root.innerText || root.body?.innerText || '').toLowerCase();
    const captcha = hasCaptcha(selectors);
    const unavailable = matchesAnyText(rootText, texts.unavailable || []);
    const orderConfirmed = matchesAnyText(rootText, texts.orderConfirmed || []);

    const euAgreeBtn =
      findFirstVisible(selectors.euAgreeButton || [], texts.euAgreeButton || [], root) ||
      findButtonByText(texts.euAgreeButton || [], root);

    const placeOrderBtn =
      findFirstVisible(selectors.placeOrderButton || [], texts.placeOrderButton || [], root) ||
      findButtonByText(texts.placeOrderButton || [], root);

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
    const root = getCheckoutRoot(selectors);
    if (!root) {
      return { accepted: false, reason: 'Checkout container not found' };
    }

    for (const cbSelector of selectors.eulaCheckbox || []) {
      try {
        const cb = root.querySelector(cbSelector);
        if (cb && isVisible(cb) && !cb.checked) {
          cb.click();
        }
      } catch {
        // Ignore invalid selector
      }
    }

    const btn =
      findFirstVisible(selectors.euAgreeButton || [], texts.euAgreeButton || [], root) ||
      findButtonByText(texts.euAgreeButton || [], root);

    if (!btn) {
      return { accepted: false, reason: 'EU I Agree button not found' };
    }
    btn.click();
    return { accepted: true };
  }

  function placeOrder(config = {}) {
    const selectors = config.selectors || {};
    const texts = config.texts || {};
    const root = getCheckoutRoot(selectors);
    if (!root) {
      return { clicked: false, reason: 'Checkout container not found' };
    }

    for (const cbSelector of selectors.eulaCheckbox || []) {
      try {
        const cb = root.querySelector(cbSelector);
        if (cb && isVisible(cb) && !cb.checked) {
          cb.click();
        }
      } catch {
        // Ignore invalid selector
      }
    }

    const btn =
      findFirstVisible(selectors.placeOrderButton || [], texts.placeOrderButton || [], root) ||
      findButtonByText(texts.placeOrderButton || [], root);

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
          if (message.waitMs) {
            waitForState(
              () => inspectProduct(message.config),
              (s) => s.readyForDecision,
              message.waitMs
            ).then(sendResponse);
            return true;
          }
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
