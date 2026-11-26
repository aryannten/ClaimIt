import {
  STORAGE_KEYS,
  getSettings,
  saveSettings,
  getHistory,
  getCurrentOffers,
  getMeta,
  getRegionState,
  getCachedFxRates,
  setCachedFxRates,
  computeValueSaved,
  getAccountStates,
  getSteamDeals,
  clampSteamMinDiscount
} from '../storage.js';
import { filterSteamDiscountDeals } from '../providers/steam.js';
import {
  resolveRegionAndCurrency,
  getExchangeRates,
  formatOfferPriceState,
  FX_CACHE_TTL_MS,
  normalizeCurrencyCode
} from '../currency.js';
import { CLAIM_STATUS } from '../providers/constants.js';
import { logger } from '../logger.js';
import { isAllowedStoreUrl } from '../url-validator.js';
import { startStoreSignIn } from '../accounts.js';
import {
  createSvgUse,
  createIllustration,
  formatPrice,
  formatLocalDateTime,
  formatCountdown,
  formatTimeAgo,
  formatRoughNextScan
} from '../ui/ui-helpers.js';

const RELEVANT_STORAGE_KEYS = new Set([
  STORAGE_KEYS.SETTINGS,
  STORAGE_KEYS.HISTORY,
  STORAGE_KEYS.CURRENT_OFFERS,
  STORAGE_KEYS.META,
  STORAGE_KEYS.REGION,
  STORAGE_KEYS.FX_RATES,
  STORAGE_KEYS.ACCOUNTS,
  STORAGE_KEYS.STEAM_DEALS
]);

const COVER_FALLBACK = '../../assets/cover-fallback.svg';

const els = {
  dryRunBadge: document.getElementById('dryRunBadge'),
  pauseBtn: document.getElementById('pauseBtn'),
  pauseBtnIcon: document.getElementById('pauseBtnIcon'),
  pauseBtnLabel: document.getElementById('pauseBtnLabel'),
  openOptionsBtn: document.getElementById('openOptionsBtn'),
  statusLine: document.getElementById('statusLine'),
  accountsBar: document.getElementById('accountsBar'),
  checkNowBtn: document.getElementById('checkNowBtn'),
  checkNowLabel: document.getElementById('checkNowLabel'),
  freeCount: document.getElementById('freeCount'),
  dealsCount: document.getElementById('dealsCount'),
  claimedCount: document.getElementById('claimedCount'),
  issuesCount: document.getElementById('issuesCount'),
  tabFree: document.getElementById('tab-free'),
  tabDeals: document.getElementById('tab-deals'),
  dealsDiscountSlider: document.getElementById('dealsDiscountSlider'),
  dealsDiscountValue: document.getElementById('dealsDiscountValue'),
  refreshDealsBtn: document.getElementById('refreshDealsBtn'),
  dealsListContainer: document.getElementById('dealsListContainer'),
  tabClaimed: document.getElementById('tab-claimed'),
  tabIssues: document.getElementById('tab-issues')
};

let renderInFlight = false;
let renderQueued = false;
let lastIpcError = null;
let latestSteamDeals = [];
let latestPriceContext = null;
let autoLoadedDealsOnce = false;

function isSafeHttpsUrl(url) {
  return isAllowedStoreUrl(url);
}

async function openStoreTab(url) {
  if (!isSafeHttpsUrl(url)) return;
  await chrome.tabs.create({ url, active: true });
}

async function triggerStoreSignIn(storeId) {
  lastIpcError = null;
  try {
    await startStoreSignIn(storeId);
  } catch (err) {
    lastIpcError = err instanceof Error ? err.message : String(err);
    await scheduleRender();
  }
}

async function sendRuntimeMessage(payload) {
  lastIpcError = null;
  try {
    const res = await chrome.runtime.sendMessage(payload);
    if (res && res.ok === false) {
      throw new Error(res.error || 'Background request failed');
    }
    return res;
  } catch (err) {
    lastIpcError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

function buildStatusBadge(item, isChecking) {
  const span = document.createElement('span');
  if (isChecking && !item.status) {
    span.className = 'badge badge-neutral';
    span.append(createSvgUse('icon-clock'), document.createTextNode('Checking'));
  } else if (item.dryRun && item.status === CLAIM_STATUS.CLAIMED) {
    span.className = 'badge badge-needs';
    span.append(createSvgUse('icon-shield'), document.createTextNode('Dry-run'));
  } else if (item.alreadyOwned && item.status === CLAIM_STATUS.CLAIMED) {
    span.className = 'badge badge-neutral';
    span.append(createSvgUse('icon-check'), document.createTextNode('Owned'));
  } else if (item.status === CLAIM_STATUS.CLAIMED) {
    span.className = 'badge badge-claimed';
    span.append(createSvgUse('icon-check'), document.createTextNode('Claimed'));
  } else if (item.status === CLAIM_STATUS.NEEDS_USER) {
    span.className = 'badge badge-needs';
    span.append(createSvgUse('icon-alert'), document.createTextNode('Needs you'));
  } else if (item.status === CLAIM_STATUS.FAILED) {
    span.className = 'badge badge-failed';
    span.append(createSvgUse('icon-close'), document.createTextNode('Failed'));
  } else {
    span.className = 'badge badge-neutral';
    span.append(createSvgUse('icon-tag'), document.createTextNode('Free'));
  }
  return span;
}

function formatPriceElement(item, priceContext) {
  const wrap = document.createElement('span');
  wrap.className = 'price-pair';
  const priceState = formatOfferPriceState(item, priceContext);

  if (priceState.available) {
    const del = document.createElement('del');
    del.className = 'price-old';
    del.textContent = priceState.approx ? `~${priceState.formatted}` : priceState.formatted;
    if (priceState.conversionNote) {
      del.title = priceState.conversionNote;
    }
    wrap.appendChild(del);
  } else {
    const unavail = document.createElement('span');
    unavail.className = 'price-unavailable';
    unavail.textContent = priceState.label;
    wrap.appendChild(unavail);
  }

  const free = document.createElement('span');
  free.className = 'price-free';
  free.textContent = 'Free';
  wrap.appendChild(free);
  return { element: wrap, priceState };
}

function formatHumanReason(item) {
  if (!item.reason) return '';
  if (item.status === CLAIM_STATUS.NEEDS_USER) {
    if (/captcha/i.test(item.reason)) {
      return `${item.storeName || item.store} is asking for a captcha. Open the page to finish.`;
    }
    if (/login/i.test(item.reason)) {
      return `Sign in on ${item.storeName || item.store}, then open the page to claim.`;
    }
    if (/age/i.test(item.reason)) {
      return `Age verification on ${item.storeName || item.store}. Open the page to finish.`;
    }
    return item.reason;
  }
  return item.reason;
}

function createOfferRow(item, mode, isChecking, priceContext) {
  const row = document.createElement('article');
  row.className = 'offer-row';

  const img = document.createElement('img');
  img.className = 'offer-thumb';
  img.width = 76;
  img.height = 44;
  img.src = isSafeHttpsUrl(item.image) ? item.image : COVER_FALLBACK;
  img.alt = item.title ? `${item.title} cover` : 'Game cover';
  img.addEventListener('error', () => {
    if (!img.src.endsWith('cover-fallback.svg')) {
      img.src = COVER_FALLBACK;
    }
  });
  row.appendChild(img);

  const main = document.createElement('div');
  main.className = 'offer-main';

  const title = document.createElement('h3');
  title.className = 'offer-title';
  title.textContent = item.title;
  title.title = item.title;
  main.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'offer-meta tabular';

  const storeTag = document.createElement('span');
  storeTag.className = 'store-tag';
  storeTag.append(
    createSvgUse(`store-${item.store || 'epic'}`, 'store-tile', 'stores.svg'),
    document.createTextNode(item.storeName || item.store)
  );
  meta.appendChild(storeTag);

  if (item.label === 'DLC') {
    const dlc = document.createElement('span');
    dlc.className = 'badge badge-neutral';
    dlc.textContent = 'DLC';
    meta.appendChild(dlc);
  }

  const { element: priceEl, priceState } = formatPriceElement(item, priceContext);
  meta.appendChild(priceEl);

  const timing = document.createElement('span');
  const nowMs = Date.now();
  if (mode === 'claimed' && item.claimedAt) {
    timing.textContent = `Claimed ${formatTimeAgo(item.claimedAt, nowMs, priceContext.locale)}`;
    timing.title = formatLocalDateTime(item.claimedAt, priceContext.locale);
  } else {
    timing.textContent = formatCountdown(item.endDate, nowMs, priceContext.locale);
    if (item.endDate) {
      timing.title = formatLocalDateTime(item.endDate, priceContext.locale);
    }
  }
  meta.appendChild(timing);
  main.appendChild(meta);

  if (priceState.conversionNote) {
    const approxNote = document.createElement('p');
    approxNote.className = 'price-approx-note';
    approxNote.textContent = priceState.conversionNote;
    main.appendChild(approxNote);
  }

  const statusLine = document.createElement('div');
  statusLine.className = 'offer-status-line';
  statusLine.appendChild(buildStatusBadge(item, isChecking));
  main.appendChild(statusLine);

  if (item.reason && (item.status === CLAIM_STATUS.NEEDS_USER || item.status === CLAIM_STATUS.FAILED)) {
    const reason = document.createElement('p');
    reason.className = 'offer-reason';
    reason.textContent = formatHumanReason(item);
    main.appendChild(reason);
  }

  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'offer-actions';

  if (mode !== 'claimed' && (item.status === CLAIM_STATUS.NEEDS_USER || item.status === CLAIM_STATUS.FAILED)) {
    if (/login/i.test(item.reason || '') && (item.store === 'epic' || item.store === 'steam')) {
      const signInBtn = document.createElement('button');
      signInBtn.type = 'button';
      signInBtn.className = 'btn btn-primary';
      signInBtn.textContent = 'Sign in & claim';
      signInBtn.addEventListener('click', () => {
        triggerStoreSignIn(item.store);
      });
      actions.appendChild(signInBtn);
    } else if (isSafeHttpsUrl(item.url)) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-primary';
      openBtn.append(createSvgUse('icon-external-link'), document.createTextNode('Open page'));
      openBtn.addEventListener('click', () => {
        openStoreTab(item.url);
      });
      actions.appendChild(openBtn);
    }

    if (mode === 'issues') {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn';
      retryBtn.append(createSvgUse('icon-refresh'), document.createTextNode('Retry'));
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying…';
        try {
          await sendRuntimeMessage({
            type: 'CLAIMIT_CLAIM_ONE',
            store: item.store,
            id: item.id
          });
        } finally {
          await scheduleRender();
        }
      });
      actions.appendChild(retryBtn);
    }
  } else if (mode === 'free' && item.status !== CLAIM_STATUS.CLAIMED) {
    const claimBtn = document.createElement('button');
    claimBtn.type = 'button';
    claimBtn.className = 'btn btn-primary';
    claimBtn.textContent = 'Claim';
    claimBtn.addEventListener('click', async () => {
      claimBtn.disabled = true;
      claimBtn.textContent = 'Claiming…';
      try {
        await sendRuntimeMessage({
          type: 'CLAIMIT_CLAIM_ONE',
          store: item.store,
          id: item.id
        });
      } finally {
        await scheduleRender();
      }
    });
    actions.appendChild(claimBtn);
  } else if (isSafeHttpsUrl(item.url)) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn btn-ghost';
    openBtn.setAttribute('aria-label', `Open ${item.title} store page`);
    openBtn.append(createSvgUse('icon-external-link'), document.createTextNode('Open page'));
    openBtn.addEventListener('click', () => {
      openStoreTab(item.url);
    });
    actions.appendChild(openBtn);
  }

  row.appendChild(actions);
  return row;
}

function renderLoadingSkeleton(container) {
  const list = document.createElement('div');
  list.className = 'offer-list';
  list.setAttribute('aria-busy', 'true');
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'skeleton-row';
    const thumb = document.createElement('div');
    thumb.className = 'skel-box skel-thumb';
    const lines = document.createElement('div');
    lines.className = 'skel-lines';
    const l1 = document.createElement('div');
    l1.className = 'skel-box skel-line';
    const l2 = document.createElement('div');
    l2.className = 'skel-box skel-line short';
    lines.append(l1, l2);
    row.append(thumb, lines);
    list.appendChild(row);
  }
  container.appendChild(list);
}

async function renderStateBox(container, { illusId, title, desc, actionLabel, onAction }) {
  const box = document.createElement('div');
  box.className = 'state-box';

  const illus = await createIllustration(illusId);
  if (illus) box.appendChild(illus);

  const heading = document.createElement('p');
  heading.className = 'state-title';
  heading.textContent = title;
  box.appendChild(heading);

  const text = document.createElement('p');
  text.className = 'state-desc';
  text.textContent = desc;
  box.appendChild(text);

  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.textContent = actionLabel;
    btn.addEventListener('click', onAction);
    box.appendChild(btn);
  }

  container.appendChild(box);
}

function buildStatusSummary(settings, meta, alarm, locale) {
  const lastAt = meta.lastScanAt || meta.lastCheckedAt;
  if (settings.paused) {
    return `Last checked ${formatTimeAgo(lastAt, Date.now(), locale)} | Automation paused`;
  }
  if (meta.isChecking) {
    return 'Checking enabled stores for free offers…';
  }
  const lastText = lastAt
    ? `Last checked ${formatTimeAgo(lastAt, Date.now(), locale)}`
    : 'Not checked yet';
  const nextAt = meta.nextScanAt || alarm?.scheduledTime || null;
  const nextText = nextAt
    ? `Next scan ${formatRoughNextScan(nextAt, Date.now(), locale)}`
    : 'Next scan pending';
  return `${lastText} | ${nextText}`;
}

async function triggerCheck() {
  els.checkNowBtn.disabled = true;
  els.checkNowLabel.textContent = 'Checking…';
  try {
    const res = await sendRuntimeMessage({ type: 'CLAIMIT_RUN_CHECK' });
    if (res?.data?.rateLimited) {
      const waitMins = Math.max(1, Math.ceil((res.data.retryAfterMs || 60000) / 60000));
      lastIpcError = `Please wait ${waitMins} min before checking manually again.`;
    }
  } finally {
    await scheduleRender();
  }
}

function renderAccountsBar(accounts) {
  if (!els.accountsBar) return;
  els.accountsBar.replaceChildren();
  const stores = [
    { id: 'epic', label: 'Epic' },
    { id: 'steam', label: 'Steam' }
  ];

  for (const store of stores) {
    const acc = accounts?.[store.id] || {};
    const pill = document.createElement('div');
    pill.className = 'account-pill';

    const left = document.createElement('div');
    left.className = 'account-id';
    left.appendChild(createSvgUse(`store-${store.id}`, 'store-tile', 'stores.svg'));
    const nameEl = document.createElement('span');
    nameEl.className = 'account-name';
    nameEl.textContent = acc.signedIn === true && acc.accountName ? acc.accountName : store.label;
    nameEl.title = acc.signedIn === true ? `${store.label} signed in` : `${store.label} session`;
    left.appendChild(nameEl);
    pill.appendChild(left);

    if (acc.signedIn === true) {
      const okBadge = document.createElement('span');
      okBadge.className = 'badge badge-claimed';
      okBadge.textContent = 'Signed in';
      pill.appendChild(okBadge);
    } else {
      const signInBtn = document.createElement('button');
      signInBtn.type = 'button';
      signInBtn.className = 'btn btn-primary btn-account';
      signInBtn.textContent = 'Sign in';
      signInBtn.addEventListener('click', () => {
        triggerStoreSignIn(store.id);
      });
      pill.appendChild(signInBtn);
    }

    els.accountsBar.appendChild(pill);
  }
}

function formatDiscountLabel(minDiscount) {
  const val = clampSteamMinDiscount(minDiscount);
  return val >= 100 ? '100% (Free only)' : `${val}%+ off`;
}

function createDealRow(item, priceContext) {
  const row = document.createElement('article');
  row.className = 'offer-row';

  const img = document.createElement('img');
  img.className = 'offer-thumb';
  img.width = 76;
  img.height = 44;
  img.src = isSafeHttpsUrl(item.image) ? item.image : COVER_FALLBACK;
  img.alt = item.title ? `${item.title} cover` : 'Game cover';
  img.addEventListener('error', () => {
    if (!img.src.endsWith('cover-fallback.svg')) {
      img.src = COVER_FALLBACK;
    }
  });
  row.appendChild(img);

  const main = document.createElement('div');
  main.className = 'offer-main';

  const title = document.createElement('h3');
  title.className = 'offer-title';
  title.textContent = item.title;
  title.title = item.title;
  main.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'offer-meta tabular';

  const storeTag = document.createElement('span');
  storeTag.className = 'store-tag';
  storeTag.append(createSvgUse('store-steam', 'store-tile', 'stores.svg'), document.createTextNode('Steam'));
  meta.appendChild(storeTag);

  const origState = formatOfferPriceState(
    {
      originalPriceValue: item.originalPrice,
      originalPriceFormatted: item.originalPriceFormatted,
      currencyCode: item.currencyCode
    },
    priceContext
  );
  const saleState = formatOfferPriceState(
    {
      originalPriceValue: item.discountPrice,
      originalPriceFormatted: item.discountPriceFormatted,
      currencyCode: item.currencyCode
    },
    priceContext
  );

  const pricePair = document.createElement('span');
  pricePair.className = 'price-pair';
  if (origState.available) {
    const del = document.createElement('del');
    del.className = 'price-old';
    del.textContent = origState.approx ? `~${origState.formatted}` : origState.formatted;
    pricePair.appendChild(del);
  }
  const sale = document.createElement('span');
  sale.className = 'price-free';
  sale.textContent = saleState.available
    ? (saleState.approx ? `~${saleState.formatted}` : saleState.formatted)
    : (item.discountPriceFormatted || 'Sale');
  pricePair.appendChild(sale);
  meta.appendChild(pricePair);
  main.appendChild(meta);

  const statusLine = document.createElement('div');
  statusLine.className = 'offer-status-line';
  const pctBadge = document.createElement('span');
  pctBadge.className = 'badge badge-claimed tabular';
  pctBadge.textContent = `-${item.discountPercent}%`;
  statusLine.appendChild(pctBadge);
  main.appendChild(statusLine);

  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'offer-actions';
  if (isSafeHttpsUrl(item.url)) {
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn btn-primary';
    viewBtn.append(createSvgUse('icon-external-link'), document.createTextNode('View deal'));
    viewBtn.addEventListener('click', () => {
      openStoreTab(item.url);
    });
    actions.appendChild(viewBtn);
  }
  row.appendChild(actions);
  return row;
}

async function renderDealsList(allDeals, minDiscount, priceContext, steamEnabled) {
  if (!els.dealsListContainer) return;
  const threshold = clampSteamMinDiscount(minDiscount);
  if (els.dealsDiscountValue) {
    els.dealsDiscountValue.textContent = formatDiscountLabel(threshold);
  }
  if (els.dealsDiscountSlider && document.activeElement !== els.dealsDiscountSlider) {
    els.dealsDiscountSlider.value = String(threshold);
  }

  const filtered = threshold >= 100 ? [] : filterSteamDiscountDeals(allDeals, threshold);
  if (els.dealsCount) {
    els.dealsCount.textContent = String(filtered.length);
  }

  els.dealsListContainer.replaceChildren();
  if (!steamEnabled) {
    await renderStateBox(els.dealsListContainer, {
      illusId: 'illus-empty-free',
      title: 'Steam is disabled',
      desc: 'Enable Steam in Settings to view discounted specials.'
    });
    return;
  }
  if (threshold >= 100) {
    await renderStateBox(els.dealsListContainer, {
      illusId: 'illus-empty-free',
      title: 'Free games only (100%)',
      desc: 'Slide the percentage bar between 40% and 99% to browse Steam sale discounts.'
    });
    return;
  }
  if (allDeals.length === 0) {
    await renderStateBox(els.dealsListContainer, {
      illusId: 'illus-first-run',
      title: 'No Steam deals loaded yet',
      desc: 'Load current Steam store discounts at your chosen minimum percentage.',
      actionLabel: 'Load deals',
      onAction: async () => {
        await sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_DEALS' });
        await scheduleRender();
      }
    });
    return;
  }
  if (filtered.length === 0) {
    await renderStateBox(els.dealsListContainer, {
      illusId: 'illus-empty-free',
      title: `No Steam specials at ${threshold}%+ off`,
      desc: 'Lower the discount bar toward 40% to see more Steam sale titles.'
    });
    return;
  }

  const list = document.createElement('div');
  list.className = 'offer-list';
  for (const deal of filtered) {
    list.appendChild(createDealRow(deal, priceContext));
  }
  els.dealsListContainer.appendChild(list);
}

async function render() {
  const [settings, historyMap, currentOffers, meta, storedRegion, cachedFx, alarm, logs, accounts, steamDeals] = await Promise.all([
    getSettings(),
    getHistory(),
    getCurrentOffers(),
    getMeta(),
    getRegionState(),
    getCachedFxRates(),
    chrome.alarms?.get ? chrome.alarms.get('claimit_check_alarm').catch(() => null) : Promise.resolve(null),
    logger.getAll().catch(() => []),
    getAccountStates(),
    getSteamDeals()
  ]);
  renderAccountsBar(accounts);
  latestSteamDeals = steamDeals;

  const region = resolveRegionAndCurrency({ settings, storedRegion });
  const allHistory = Object.values(historyMap);
  const needsFx = [...currentOffers, ...allHistory, ...steamDeals].some((item) => {
    const cur = normalizeCurrencyCode(item?.currencyCode ?? item?.currency);
    return cur && cur !== region.currency;
  });

  let fxEntry = cachedFx;
  if (
    needsFx &&
    (!cachedFx?.rates || !Number.isFinite(cachedFx.fetchedAtMs) || Date.now() - cachedFx.fetchedAtMs >= FX_CACHE_TTL_MS)
  ) {
    fxEntry = await getExchangeRates({
      cached: cachedFx,
      saveCacheFn: setCachedFxRates
    }).catch(() => cachedFx);
  }
  const priceContext = {
    displayCurrency: region.currency,
    locale: region.locale,
    rates: fxEntry?.rates || null
  };
  latestPriceContext = priceContext;

  const steamEnabled = Boolean(settings.stores?.steam?.enabled);
  const minDiscount = clampSteamMinDiscount(settings.steamMinDiscount);
  await renderDealsList(steamDeals, minDiscount, priceContext, steamEnabled);
  if (steamEnabled && minDiscount < 100 && steamDeals.length === 0 && !autoLoadedDealsOnce) {
    autoLoadedDealsOnce = true;
    sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_DEALS' });
  }

  const paused = Boolean(settings.paused);
  els.pauseBtn.setAttribute('aria-checked', String(paused));
  els.pauseBtn.setAttribute('aria-label', paused ? 'Resume automation' : 'Pause automation');
  els.pauseBtnIcon.querySelector('use')?.setAttribute(
    'href',
    `../../assets/icons.svg#${paused ? 'icon-play' : 'icon-pause'}`
  );
  els.pauseBtnLabel.textContent = paused ? 'Resume' : 'Pause';

  els.dryRunBadge.classList.toggle('hidden', !settings.dryRun);
  els.checkNowBtn.disabled = Boolean(meta.isChecking || paused);
  els.checkNowLabel.textContent = meta.isChecking ? 'Checking…' : 'Check now';
  els.statusLine.textContent = lastIpcError || buildStatusSummary(settings, meta, alarm, region.locale);

  const recentFetchErr = logs
    .slice(-10)
    .reverse()
    .find((entry) => entry.level === 'error' && /fetchOffers failed|Unexpected error/i.test(entry.message));

  // Tab 1: Free now
  els.tabFree.replaceChildren();
  els.freeCount.textContent = String(currentOffers.length);

  if (meta.isChecking && currentOffers.length === 0) {
    renderLoadingSkeleton(els.tabFree);
  } else if (currentOffers.length === 0) {
    if (navigator.onLine === false) {
      await renderStateBox(els.tabFree, {
        illusId: 'illus-offline',
        title: 'You appear to be offline',
        desc: 'Reconnect to check Epic Games Store and Steam for current free offers.',
        actionLabel: 'Retry check',
        onAction: triggerCheck
      });
    } else if (lastIpcError || recentFetchErr) {
      await renderStateBox(els.tabFree, {
        illusId: 'illus-store-changed',
        title: 'Could not complete store check',
        desc: lastIpcError || recentFetchErr.meta?.error || recentFetchErr.message,
        actionLabel: 'Check now',
        onAction: triggerCheck
      });
    } else if (!meta.lastCheckedAt) {
      await renderStateBox(els.tabFree, {
        illusId: 'illus-first-run',
        title: 'Ready for your first check',
        desc: 'Scan Epic Games Store and Steam using your logged-in browser sessions.',
        actionLabel: 'Check now',
        onAction: triggerCheck
      });
    } else {
      await renderStateBox(els.tabFree, {
        illusId: 'illus-empty-free',
        title: 'No free games right now',
        desc: 'Scheduled checks continue running automatically in the background.',
        actionLabel: 'Check now',
        onAction: triggerCheck
      });
    }
  } else {
    const list = document.createElement('div');
    list.className = 'offer-list';
    for (const offer of currentOffers) {
      list.appendChild(createOfferRow(offer, 'free', meta.isChecking, priceContext));
    }
    els.tabFree.appendChild(list);
  }

  // Tab 2: Claimed (excludes dry-run and pre-existing owned items)
  const claimed = allHistory
    .filter((h) => h.status === CLAIM_STATUS.CLAIMED && !h.dryRun && !h.alreadyOwned)
    .sort((a, b) => Date.parse(b.claimedAt || b.updatedAt || 0) - Date.parse(a.claimedAt || a.updatedAt || 0));

  els.claimedCount.textContent = String(claimed.length);
  els.tabClaimed.replaceChildren();

  if (claimed.length === 0) {
    await renderStateBox(els.tabClaimed, {
      illusId: 'illus-empty-free',
      title: 'No claimed games yet',
      desc: 'Free-to-keep games claimed by ClaimIt will appear here with total savings.',
      actionLabel: 'Check now',
      onAction: triggerCheck
    });
  } else {
    const saved = computeValueSaved(historyMap, region.currency, priceContext.rates);
    const strip = document.createElement('div');
    strip.className = 'value-strip';

    const stripTop = document.createElement('div');
    stripTop.className = 'value-strip-top';

    const lbl = document.createElement('span');
    lbl.className = 'value-label';
    lbl.append(
      createSvgUse('icon-history'),
      document.createTextNode(`Value saved (${claimed.length} ${claimed.length === 1 ? 'game' : 'games'})`)
    );

    const val = document.createElement('span');
    val.className = 'value-amount tabular';
    const unconvertedParts = Object.entries(saved.unconvertedTotals || {}).map(
      ([cur, amt]) => formatPrice(amt, cur, region.locale)
    );
    if (saved.totalMajor > 0) {
      const formattedTotal = formatPrice(saved.totalMajor, saved.currency, region.locale);
      const displayTotal = saved.hasConverted ? `~${formattedTotal}` : formattedTotal;
      val.textContent = unconvertedParts.length
        ? `${displayTotal} + ${unconvertedParts.join(' + ')}`
        : displayTotal;
    } else if (unconvertedParts.length > 0) {
      val.textContent = unconvertedParts.join(' + ');
    } else {
      val.textContent = 'Price unavailable';
    }

    stripTop.append(lbl, val);
    strip.appendChild(stripTop);

    if (saved.hasConverted && saved.sourceCurrencies?.length) {
      const noteText = `Converted from ${saved.sourceCurrencies.join(', ')} at today's rate.`;
      val.title = noteText;
      const note = document.createElement('span');
      note.className = 'value-note';
      note.textContent = noteText;
      strip.appendChild(note);
    } else if (unconvertedParts.length > 0) {
      const note = document.createElement('span');
      note.className = 'value-note';
      note.textContent = 'Exchange rates unavailable; showing original store currencies.';
      strip.appendChild(note);
    }

    els.tabClaimed.appendChild(strip);

    const list = document.createElement('div');
    list.className = 'offer-list';
    for (const item of claimed) {
      list.appendChild(createOfferRow(item, 'claimed', false, priceContext));
    }
    els.tabClaimed.appendChild(list);
  }

  // Tab 3: Issues
  const issues = allHistory
    .filter((h) => h.status === CLAIM_STATUS.NEEDS_USER || h.status === CLAIM_STATUS.FAILED)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));

  els.issuesCount.textContent = String(issues.length);
  els.tabIssues.replaceChildren();

  if (issues.length === 0) {
    await renderStateBox(els.tabIssues, {
      illusId: 'illus-all-claimed',
      title: 'Everything is clear',
      desc: 'No pending verifications, captchas, or failed claims need your attention.'
    });
  } else {
    const list = document.createElement('div');
    list.className = 'offer-list';
    for (const item of issues) {
      list.appendChild(createOfferRow(item, 'issues', false, priceContext));
    }
    els.tabIssues.appendChild(list);
  }
}

async function scheduleRender() {
  if (renderInFlight) {
    renderQueued = true;
    return;
  }
  renderInFlight = true;
  try {
    await render();
  } finally {
    renderInFlight = false;
    if (renderQueued) {
      renderQueued = false;
      await scheduleRender();
    }
  }
}

const tabButtons = Array.from(document.querySelectorAll('.tab'));

function activateTab(targetBtn) {
  const target = targetBtn.dataset.tab;
  for (const btn of tabButtons) {
    const active = btn === targetBtn;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
  }
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const show = panel.id === `tab-${target}`;
    panel.classList.toggle('active', show);
    panel.hidden = !show;
  });
}

tabButtons.forEach((btn, index) => {
  btn.addEventListener('click', () => activateTab(btn));
  btn.addEventListener('keydown', (ev) => {
    let nextIdx = -1;
    if (ev.key === 'ArrowRight') nextIdx = (index + 1) % tabButtons.length;
    else if (ev.key === 'ArrowLeft') nextIdx = (index - 1 + tabButtons.length) % tabButtons.length;
    else if (ev.key === 'Home') nextIdx = 0;
    else if (ev.key === 'End') nextIdx = tabButtons.length - 1;
    if (nextIdx >= 0) {
      ev.preventDefault();
      tabButtons[nextIdx].focus();
      activateTab(tabButtons[nextIdx]);
    }
  });
});

els.pauseBtn.addEventListener('click', async () => {
  const currentlyPaused = els.pauseBtn.getAttribute('aria-checked') === 'true';
  await sendRuntimeMessage({
    type: 'CLAIMIT_SET_PAUSED',
    paused: !currentlyPaused
  });
  await scheduleRender();
});

els.checkNowBtn.addEventListener('click', triggerCheck);

els.dealsDiscountSlider?.addEventListener('input', () => {
  const val = clampSteamMinDiscount(els.dealsDiscountSlider.value);
  if (latestPriceContext) {
    renderDealsList(latestSteamDeals, val, latestPriceContext, true);
  }
});

els.dealsDiscountSlider?.addEventListener('change', async () => {
  const val = clampSteamMinDiscount(els.dealsDiscountSlider.value);
  await saveSettings({ steamMinDiscount: val });
  if (val < 100 && latestSteamDeals.length === 0) {
    await sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_DEALS' });
  }
});

els.refreshDealsBtn?.addEventListener('click', async () => {
  els.refreshDealsBtn.disabled = true;
  try {
    await sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_DEALS' });
    await scheduleRender();
  } finally {
    els.refreshDealsBtn.disabled = false;
  }
});

els.openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (Object.keys(changes).some((k) => RELEVANT_STORAGE_KEYS.has(k))) {
    scheduleRender();
  }
});

scheduleRender();
sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_ACCOUNTS' });

const countdownRefreshTimer = window.setInterval(() => {
  scheduleRender();
}, 60_000);

function cleanupTimers() {
  window.clearInterval(countdownRefreshTimer);
}

window.addEventListener('unload', cleanupTimers);
window.addEventListener('pagehide', cleanupTimers);
