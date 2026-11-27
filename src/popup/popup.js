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
  getSteamDealsMeta,
  getSteamFreeGames,
  getSteamFreeMeta,
  clampSteamMinDiscount,
  normalizeSteamDealsSort,
  normalizeSteamFreeSort
} from '../storage.js';
import { filterSteamDiscountDeals, filterSteamFreeGames } from '../providers/steam.js';
import {
  resolveRegionAndCurrency,
  getExchangeRates,
  formatOfferPriceState,
  FX_CACHE_TTL_MS,
  normalizeCurrencyCode
} from '../currency.js';
import { CLAIM_STATUS } from '../providers/constants.js';
import { logger } from '../logger.js';
import { isAllowedStoreUrl, isAllowedImageUrl } from '../url-validator.js';
import { startStoreSignIn } from '../accounts.js';
import {
  createSvgUse,
  createIllustration,
  formatPrice,
  formatLocalDateTime,
  formatCountdown,
  formatTimeAgo,
  formatRoughNextScan,
  formatCompactCount
} from '../ui/ui-helpers.js';

const RELEVANT_STORAGE_KEYS = new Set([
  STORAGE_KEYS.SETTINGS,
  STORAGE_KEYS.HISTORY,
  STORAGE_KEYS.CURRENT_OFFERS,
  STORAGE_KEYS.META,
  STORAGE_KEYS.REGION,
  STORAGE_KEYS.FX_RATES,
  STORAGE_KEYS.ACCOUNTS,
  STORAGE_KEYS.STEAM_DEALS,
  STORAGE_KEYS.STEAM_DEALS_META,
  STORAGE_KEYS.STEAM_FREE_GAMES,
  STORAGE_KEYS.STEAM_FREE_META
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
  freeSteamCount: document.getElementById('freeSteamCount'),
  claimedCount: document.getElementById('claimedCount'),
  issuesCount: document.getElementById('issuesCount'),
  tabFree: document.getElementById('tab-free'),
  tabDeals: document.getElementById('tab-deals'),
  tabFreeSteam: document.getElementById('tab-free-steam'),
  dealsSearchInput: document.getElementById('dealsSearchInput'),
  clearDealsSearchBtn: document.getElementById('clearDealsSearchBtn'),
  dealsSortSelect: document.getElementById('dealsSortSelect'),
  dealsDiscountSlider: document.getElementById('dealsDiscountSlider'),
  dealsDiscountValue: document.getElementById('dealsDiscountValue'),
  refreshDealsBtn: document.getElementById('refreshDealsBtn'),
  dealsHint: document.getElementById('dealsHint'),
  dealsListContainer: document.getElementById('dealsListContainer'),
  freeSteamSearchInput: document.getElementById('freeSteamSearchInput'),
  clearFreeSteamSearchBtn: document.getElementById('clearFreeSteamSearchBtn'),
  freeSteamSortSelect: document.getElementById('freeSteamSortSelect'),
  refreshFreeSteamBtn: document.getElementById('refreshFreeSteamBtn'),
  freeSteamHint: document.getElementById('freeSteamHint'),
  freeSteamListContainer: document.getElementById('freeSteamListContainer'),
  tabClaimed: document.getElementById('tab-claimed'),
  tabIssues: document.getElementById('tab-issues')
};

let renderInFlight = false;
let renderQueued = false;
let lastIpcError = null;
let latestSteamDeals = [];
let latestSteamDealsMeta = null;
let latestSteamFreeGames = [];
let latestSteamFreeMeta = null;
let latestPriceContext = null;
let latestSteamEnabled = true;
let latestMinDiscount = 75;
let latestDealsSort = 'popular';
let latestFreeSteamSort = 'popular';
let dealsSearchQuery = '';
let latestRemoteSearch = null;
let dealsSearchLoading = false;
let dealsRefreshing = false;
let dealsRefreshingAdvance = false;
let freeSteamSearchQuery = '';
let latestFreeSteamRemote = null;
let freeSteamSearchLoading = false;
let freeSteamRefreshing = false;
let freeSteamRefreshingAdvance = false;
let autoLoadedDealsOnce = false;
let autoLoadedFreeSteamOnce = false;
const controlCleanupFns = [];

function isSafeHttpsUrl(url) {
  return isAllowedStoreUrl(url);
}

function createCoverThumbnail(item) {
  const candidates = [];
  if (isAllowedImageUrl(item?.image)) {
    candidates.push(item.image);
  }
  const steamId = String(item?.id || '');
  if (item?.store === 'steam' && /^\d+$/.test(steamId)) {
    for (const variant of ['capsule_231x87.jpg', 'header.jpg']) {
      const url = `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamId}/${variant}`;
      if (!candidates.includes(url)) candidates.push(url);
    }
  }
  candidates.push(COVER_FALLBACK);

  let idx = 0;
  const img = document.createElement('img');
  img.className = 'offer-thumb';
  img.width = 84;
  img.height = 48;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = candidates[0];
  img.alt = item?.title ? `${item.title} cover` : 'Game cover';
  img.addEventListener('error', () => {
    idx += 1;
    if (idx < candidates.length) {
      img.src = candidates[idx];
    }
  });
  return img;
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
  row.appendChild(createCoverThumbnail(item));

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

function appendReviewBadges(statusLine, item, priceContext, hideTopRank) {
  if (Number.isFinite(item.reviewPercent) || (Number.isFinite(item.reviewCount) && item.reviewCount > 0)) {
    const revBadge = document.createElement('span');
    revBadge.className = `badge tabular ${
      item.reviewSentiment === 'mixed'
        ? 'badge-needs'
        : item.reviewSentiment === 'negative'
          ? 'badge-failed'
          : 'badge-neutral'
    }`;
    const countLabel = Number.isFinite(item.reviewCount) && item.reviewCount > 0
      ? formatCompactCount(item.reviewCount, priceContext?.locale)
      : '';
    const pctLabel = Number.isFinite(item.reviewPercent) ? `${item.reviewPercent}%` : '';
    revBadge.textContent = [pctLabel, countLabel ? `${countLabel} reviews` : ''].filter(Boolean).join(' · ');
    if (item.reviewSummary) {
      revBadge.title = Number.isFinite(item.reviewCount) && Number.isFinite(item.reviewPercent)
        ? `${item.reviewSummary}: ${item.reviewPercent}% of ${item.reviewCount.toLocaleString()} reviews`
        : item.reviewSummary;
    }
    statusLine.appendChild(revBadge);
  }

  if (!hideTopRank && Number.isFinite(item.topRank) && item.topRank >= 1 && item.topRank <= 100) {
    const rankBadge = document.createElement('span');
    rankBadge.className = 'badge badge-neutral tabular';
    rankBadge.textContent = `Top #${item.topRank}`;
    rankBadge.title = `Steam rank #${item.topRank}`;
    statusLine.appendChild(rankBadge);
  }
}

function createDealRow(item, priceContext) {
  const row = document.createElement('article');
  row.className = 'offer-row';
  row.appendChild(createCoverThumbnail(item));

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
  appendReviewBadges(statusLine, item, priceContext, Boolean(dealsSearchQuery.trim()));
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

function createFreeSteamRow(item, priceContext) {
  const row = document.createElement('article');
  row.className = 'offer-row';
  row.appendChild(createCoverThumbnail(item));

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

  const pricePair = document.createElement('span');
  pricePair.className = 'price-pair';
  if (item.discountPercent === 100 && item.originalPrice > 0) {
    const origState = formatOfferPriceState(
      {
        originalPriceValue: item.originalPrice,
        originalPriceFormatted: item.originalPriceFormatted,
        currencyCode: item.currencyCode
      },
      priceContext
    );
    if (origState.available) {
      const del = document.createElement('del');
      del.className = 'price-old';
      del.textContent = origState.approx ? `~${origState.formatted}` : origState.formatted;
      pricePair.appendChild(del);
    }
  }
  const freeLbl = document.createElement('span');
  freeLbl.className = 'price-free';
  freeLbl.textContent = 'Free';
  pricePair.appendChild(freeLbl);
  meta.appendChild(pricePair);
  main.appendChild(meta);

  const statusLine = document.createElement('div');
  statusLine.className = 'offer-status-line';
  const kindBadge = document.createElement('span');
  kindBadge.className = item.discountPercent === 100 ? 'badge badge-claimed tabular' : 'badge badge-neutral';
  kindBadge.textContent = item.discountPercent === 100 ? '100% off' : 'Free to Play';
  statusLine.appendChild(kindBadge);

  if (item.alreadyOwned) {
    const ownedBadge = document.createElement('span');
    ownedBadge.className = 'badge badge-neutral';
    ownedBadge.append(createSvgUse('icon-check'), document.createTextNode('In library'));
    statusLine.appendChild(ownedBadge);
  }

  appendReviewBadges(statusLine, item, priceContext, Boolean(freeSteamSearchQuery.trim()));
  main.appendChild(statusLine);

  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'offer-actions';
  if (isSafeHttpsUrl(item.url)) {
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'btn btn-primary';
    viewBtn.append(createSvgUse('icon-external-link'), document.createTextNode('Open'));
    viewBtn.addEventListener('click', () => {
      openStoreTab(item.url);
    });
    actions.appendChild(viewBtn);
  }
  row.appendChild(actions);
  return row;
}

function mergeDealsById(primary, secondary) {
  const seen = new Set();
  const merged = [];
  for (const list of [primary, secondary]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item?.id || seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

async function renderDealsList({
  allDeals,
  dealsMeta,
  minDiscount,
  sortBy,
  searchQuery,
  remoteSearch,
  searchLoading,
  priceContext,
  steamEnabled
}) {
  if (!els.dealsListContainer) return;
  const threshold = clampSteamMinDiscount(minDiscount);
  const activeSort = normalizeSteamDealsSort(sortBy);
  const cleanQuery = typeof searchQuery === 'string' ? searchQuery.trim() : '';

  if (els.dealsDiscountValue) {
    els.dealsDiscountValue.textContent = formatDiscountLabel(threshold);
  }
  if (els.dealsDiscountSlider && document.activeElement !== els.dealsDiscountSlider) {
    els.dealsDiscountSlider.value = String(threshold);
  }
  if (els.dealsSortSelect && document.activeElement !== els.dealsSortSelect) {
    els.dealsSortSelect.value = activeSort;
  }
  if (els.clearDealsSearchBtn) {
    els.clearDealsSearchBtn.classList.toggle('hidden', cleanQuery.length === 0);
  }

  const hasRemoteMatch = Boolean(cleanQuery.length >= 2 && remoteSearch && remoteSearch.query === cleanQuery);
  let filtered = [];
  if (threshold < 100) {
    if (hasRemoteMatch) {
      const localMatches = filterSteamDiscountDeals(allDeals, threshold, null, { query: cleanQuery });
      const merged = mergeDealsById(remoteSearch.deals, localMatches);
      filtered = filterSteamDiscountDeals(merged, threshold, null, { sortBy: activeSort });
    } else {
      filtered = filterSteamDiscountDeals(allDeals, threshold, null, {
        query: cleanQuery,
        sortBy: activeSort
      });
    }
  }

  if (els.dealsCount) {
    els.dealsCount.textContent = String(filtered.length);
  }
  if (els.dealsHint) {
    if (searchLoading && cleanQuery.length >= 2) {
      els.dealsHint.textContent = `Searching Steam catalog for "${cleanQuery}"...`;
    } else if (dealsRefreshing && dealsRefreshingAdvance) {
      els.dealsHint.textContent = `Loading next batch of Steam ${threshold}%+ deals...`;
    } else if (dealsRefreshing) {
      els.dealsHint.textContent = `Scanning up to 500 Steam Top Sellers for ${threshold}%+ deals...`;
    } else if (hasRemoteMatch) {
      els.dealsHint.textContent = `Live Steam search for "${cleanQuery}" (${filtered.length} discounted ${filtered.length === 1 ? 'deal' : 'deals'}).`;
    } else if (cleanQuery.length === 1) {
      els.dealsHint.textContent = `Filtering cached top deals for "${cleanQuery}" (type 2+ chars for full Steam search).`;
    } else if (cleanQuery.length >= 2) {
      els.dealsHint.textContent = `Showing cached matches for "${cleanQuery}"...`;
    } else if (dealsMeta && dealsMeta.endOffset > dealsMeta.startOffset) {
      const rangeLabel = `#${dealsMeta.startOffset + 1}-${dealsMeta.endOffset}`;
      const totalLabel = Number.isFinite(dealsMeta.totalCount) ? ` of ${dealsMeta.totalCount.toLocaleString()}` : '';
      els.dealsHint.textContent = `Steam specials ${rangeLabel}${totalLabel} (${filtered.length} deals). Press Refresh for another batch.`;
    } else {
      els.dealsHint.textContent = 'Top Steam sales (40-99%) open on Steam and are never auto-bought.';
    }
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
  if ((searchLoading || dealsRefreshing) && filtered.length === 0) {
    renderLoadingSkeleton(els.dealsListContainer);
    return;
  }
  if (!cleanQuery && allDeals.length === 0) {
    await renderStateBox(els.dealsListContainer, {
      illusId: 'illus-first-run',
      title: 'No Steam deals loaded yet',
      desc: 'Load current top Steam store discounts at your chosen minimum percentage.',
      actionLabel: 'Load deals',
      onAction: () => refreshTopSteamDeals()
    });
    return;
  }
  if (filtered.length === 0) {
    await renderStateBox(els.dealsListContainer, {
      illusId: 'illus-empty-free',
      title: cleanQuery
        ? `No deals for "${cleanQuery}" at ${threshold}%+ off`
        : `No Steam specials at ${threshold}%+ off`,
      desc: cleanQuery
        ? 'Try another game title or lower the discount bar toward 40%.'
        : 'Lower the discount bar toward 40% to see more Steam sale titles.'
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

function renderCurrentDeals() {
  if (!latestPriceContext) return Promise.resolve();
  return renderDealsList({
    allDeals: latestSteamDeals,
    dealsMeta: latestSteamDealsMeta,
    minDiscount: latestMinDiscount,
    sortBy: latestDealsSort,
    searchQuery: dealsSearchQuery,
    remoteSearch: latestRemoteSearch,
    searchLoading: dealsSearchLoading,
    priceContext: latestPriceContext,
    steamEnabled: latestSteamEnabled
  });
}

async function refreshTopSteamDeals({ advance = false } = {}) {
  dealsRefreshing = true;
  dealsRefreshingAdvance = Boolean(advance);
  if (els.refreshDealsBtn) els.refreshDealsBtn.disabled = true;
  await renderCurrentDeals();
  try {
    await sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_DEALS', advance: Boolean(advance) });
    if (dealsSearchQuery.trim().length >= 2) {
      await runLiveSteamSearch(dealsSearchQuery.trim());
    } else {
      await scheduleRender();
    }
  } finally {
    dealsRefreshing = false;
    dealsRefreshingAdvance = false;
    if (els.refreshDealsBtn) els.refreshDealsBtn.disabled = false;
    await renderCurrentDeals();
  }
}

async function renderFreeSteamList({
  allGames,
  freeMeta,
  sortBy,
  searchQuery,
  remoteSearch,
  searchLoading,
  priceContext,
  steamEnabled
}) {
  if (!els.freeSteamListContainer) return;
  const activeSort = normalizeSteamFreeSort(sortBy);
  const cleanQuery = typeof searchQuery === 'string' ? searchQuery.trim() : '';

  if (els.freeSteamSortSelect && document.activeElement !== els.freeSteamSortSelect) {
    els.freeSteamSortSelect.value = activeSort;
  }
  if (els.clearFreeSteamSearchBtn) {
    els.clearFreeSteamSearchBtn.classList.toggle('hidden', cleanQuery.length === 0);
  }

  const hasRemoteMatch = Boolean(cleanQuery.length >= 2 && remoteSearch && remoteSearch.query === cleanQuery);
  let filtered = [];
  if (hasRemoteMatch) {
    const localMatches = filterSteamFreeGames(allGames, null, { query: cleanQuery });
    const merged = mergeDealsById(remoteSearch.games, localMatches);
    filtered = filterSteamFreeGames(merged, null, { sortBy: activeSort });
  } else {
    filtered = filterSteamFreeGames(allGames, null, { query: cleanQuery, sortBy: activeSort });
  }

  if (els.freeSteamCount) {
    els.freeSteamCount.textContent = String(filtered.length);
  }
  if (els.freeSteamHint) {
    if (searchLoading && cleanQuery.length >= 2) {
      els.freeSteamHint.textContent = `Searching free Steam games for "${cleanQuery}"...`;
    } else if (freeSteamRefreshing && freeSteamRefreshingAdvance) {
      els.freeSteamHint.textContent = 'Loading next batch of free Steam games...';
    } else if (freeSteamRefreshing) {
      els.freeSteamHint.textContent = 'Scanning up to 500 free Steam games...';
    } else if (hasRemoteMatch) {
      els.freeSteamHint.textContent = `Live Steam search for "${cleanQuery}" (${filtered.length} free ${filtered.length === 1 ? 'game' : 'games'}).`;
    } else if (cleanQuery.length === 1) {
      els.freeSteamHint.textContent = `Filtering cached free games for "${cleanQuery}" (type 2+ chars for full search).`;
    } else if (cleanQuery.length >= 2) {
      els.freeSteamHint.textContent = `Showing cached matches for "${cleanQuery}"...`;
    } else if (freeMeta && freeMeta.endOffset > freeMeta.startOffset) {
      const rangeLabel = `#${freeMeta.startOffset + 1}-${freeMeta.endOffset}`;
      const totalLabel = Number.isFinite(freeMeta.totalCount) ? ` of ${freeMeta.totalCount.toLocaleString()}` : '';
      els.freeSteamHint.textContent = `Free Steam ${rangeLabel}${totalLabel} (${filtered.length} games). Press Refresh for next batch.`;
    } else {
      els.freeSteamHint.textContent = 'All free-to-play and 100%-off games on Steam.';
    }
  }

  els.freeSteamListContainer.replaceChildren();
  if (!steamEnabled) {
    await renderStateBox(els.freeSteamListContainer, {
      illusId: 'illus-empty-free',
      title: 'Steam is disabled',
      desc: 'Enable Steam in Settings to browse all free Steam games.'
    });
    return;
  }
  if ((searchLoading || freeSteamRefreshing) && filtered.length === 0) {
    renderLoadingSkeleton(els.freeSteamListContainer);
    return;
  }
  if (!cleanQuery && allGames.length === 0) {
    await renderStateBox(els.freeSteamListContainer, {
      illusId: 'illus-first-run',
      title: 'No free Steam catalog loaded yet',
      desc: 'Load top free-to-play and free promotional games from Steam.',
      actionLabel: 'Load free games',
      onAction: () => refreshFreeSteamCatalog()
    });
    return;
  }
  if (filtered.length === 0) {
    await renderStateBox(els.freeSteamListContainer, {
      illusId: 'illus-empty-free',
      title: `No free Steam games match "${cleanQuery}"`,
      desc: 'Try another game title or clear the search box.'
    });
    return;
  }

  const list = document.createElement('div');
  list.className = 'offer-list';
  for (const game of filtered) {
    list.appendChild(createFreeSteamRow(game, priceContext));
  }
  els.freeSteamListContainer.appendChild(list);
}

function renderCurrentFreeSteam() {
  if (!latestPriceContext) return Promise.resolve();
  return renderFreeSteamList({
    allGames: latestSteamFreeGames,
    freeMeta: latestSteamFreeMeta,
    sortBy: latestFreeSteamSort,
    searchQuery: freeSteamSearchQuery,
    remoteSearch: latestFreeSteamRemote,
    searchLoading: freeSteamSearchLoading,
    priceContext: latestPriceContext,
    steamEnabled: latestSteamEnabled
  });
}

async function refreshFreeSteamCatalog({ advance = false } = {}) {
  freeSteamRefreshing = true;
  freeSteamRefreshingAdvance = Boolean(advance);
  if (els.refreshFreeSteamBtn) els.refreshFreeSteamBtn.disabled = true;
  await renderCurrentFreeSteam();
  try {
    await sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_FREE', advance: Boolean(advance) });
    if (freeSteamSearchQuery.trim().length >= 2) {
      await runLiveFreeSteamSearch(freeSteamSearchQuery.trim());
    } else {
      await scheduleRender();
    }
  } finally {
    freeSteamRefreshing = false;
    freeSteamRefreshingAdvance = false;
    if (els.refreshFreeSteamBtn) els.refreshFreeSteamBtn.disabled = false;
    await renderCurrentFreeSteam();
  }
}

let freeSteamSearchSeq = 0;
async function runLiveFreeSteamSearch(rawQuery) {
  const cleanQuery = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const seq = ++freeSteamSearchSeq;
  if (cleanQuery.length < 2) {
    freeSteamSearchLoading = false;
    latestFreeSteamRemote = null;
    await renderCurrentFreeSteam();
    return;
  }
  freeSteamSearchLoading = true;
  await renderCurrentFreeSteam();
  const res = await sendRuntimeMessage({
    type: 'CLAIMIT_SEARCH_STEAM_FREE',
    query: cleanQuery,
    sortBy: latestFreeSteamSort
  });
  if (seq !== freeSteamSearchSeq) return;
  freeSteamSearchLoading = false;
  if (res?.data && Array.isArray(res.data.games)) {
    latestFreeSteamRemote = {
      query: cleanQuery,
      games: res.data.games
    };
  }
  await renderCurrentFreeSteam();
}

let dealsSearchSeq = 0;
async function runLiveSteamSearch(rawQuery) {
  const cleanQuery = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const seq = ++dealsSearchSeq;
  if (cleanQuery.length < 2) {
    dealsSearchLoading = false;
    latestRemoteSearch = null;
    await renderCurrentDeals();
    return;
  }
  dealsSearchLoading = true;
  await renderCurrentDeals();
  const res = await sendRuntimeMessage({
    type: 'CLAIMIT_SEARCH_STEAM_DEALS',
    query: cleanQuery,
    sortBy: latestDealsSort
  });
  if (seq !== dealsSearchSeq) return;
  dealsSearchLoading = false;
  if (res?.data && Array.isArray(res.data.deals)) {
    latestRemoteSearch = {
      query: cleanQuery,
      deals: res.data.deals
    };
  }
  await renderCurrentDeals();
}

async function render() {
  const [settings, historyMap, currentOffers, meta, storedRegion, cachedFx, alarm, logs, accounts, steamDeals, steamDealsMeta, steamFreeGames, steamFreeMeta] = await Promise.all([
    getSettings(),
    getHistory(),
    getCurrentOffers(),
    getMeta(),
    getRegionState(),
    getCachedFxRates(),
    chrome.alarms?.get ? chrome.alarms.get('claimit_check_alarm').catch(() => null) : Promise.resolve(null),
    logger.getAll().catch(() => []),
    getAccountStates(),
    getSteamDeals(),
    getSteamDealsMeta(),
    getSteamFreeGames(),
    getSteamFreeMeta()
  ]);
  renderAccountsBar(accounts);
  latestSteamDeals = steamDeals;
  latestSteamDealsMeta = steamDealsMeta;
  latestSteamFreeGames = steamFreeGames;
  latestSteamFreeMeta = steamFreeMeta;

  const region = resolveRegionAndCurrency({ settings, storedRegion });
  const allHistory = Object.values(historyMap);
  const needsFx = [...currentOffers, ...allHistory, ...steamDeals, ...steamFreeGames].some((item) => {
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

  latestSteamEnabled = Boolean(settings.stores?.steam?.enabled);
  latestMinDiscount = clampSteamMinDiscount(settings.steamMinDiscount);
  latestDealsSort = normalizeSteamDealsSort(settings.steamDealsSort);
  latestFreeSteamSort = normalizeSteamFreeSort(settings.steamFreeSort);
  await renderCurrentDeals();
  await renderCurrentFreeSteam();
  if (latestSteamEnabled && latestMinDiscount < 100 && steamDeals.length === 0 && !autoLoadedDealsOnce) {
    autoLoadedDealsOnce = true;
    sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_DEALS' });
  }
  if (latestSteamEnabled && steamFreeGames.length === 0 && !autoLoadedFreeSteamOnce) {
    autoLoadedFreeSteamOnce = true;
    sendRuntimeMessage({ type: 'CLAIMIT_REFRESH_STEAM_FREE' });
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

function bindCatalogControls({
  inputEl,
  clearBtnEl,
  sortEl,
  refreshBtnEl,
  normalizeSort,
  onSetSort,
  onSaveSort,
  onSetQuery,
  onResetRemote,
  onRender,
  onRunSearch,
  onRefreshAdvance
}) {
  let timer = null;
  const clearTimer = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  controlCleanupFns.push(clearTimer);

  sortEl?.addEventListener('change', async () => {
    const val = normalizeSort(sortEl.value);
    onSetSort(val);
    onRender();
    await onSaveSort(val);
  });

  inputEl?.addEventListener('input', () => {
    const raw = inputEl.value;
    onSetQuery(raw);
    const trimmed = raw.trim();
    clearTimer();
    if (trimmed.length < 2) {
      onResetRemote();
      onRender();
      return;
    }
    onRender();
    timer = window.setTimeout(() => {
      timer = null;
      onRunSearch(trimmed);
    }, 450);
  });

  inputEl?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      clearTimer();
      const trimmed = inputEl.value.trim();
      if (trimmed.length >= 2) {
        onRunSearch(trimmed);
      }
    } else if (ev.key === 'Escape' && inputEl.value) {
      ev.preventDefault();
      clearTimer();
      inputEl.value = '';
      onSetQuery('');
      onResetRemote();
      onRender();
    }
  });

  clearBtnEl?.addEventListener('click', () => {
    if (!inputEl) return;
    clearTimer();
    inputEl.value = '';
    onSetQuery('');
    onResetRemote();
    onRender();
    inputEl.focus();
  });

  refreshBtnEl?.addEventListener('click', onRefreshAdvance);
}

els.dealsDiscountSlider?.addEventListener('input', () => {
  latestMinDiscount = clampSteamMinDiscount(els.dealsDiscountSlider.value);
  renderCurrentDeals();
});

els.dealsDiscountSlider?.addEventListener('change', async () => {
  const val = clampSteamMinDiscount(els.dealsDiscountSlider.value);
  latestMinDiscount = val;
  await saveSettings({ steamMinDiscount: val });
  await refreshTopSteamDeals();
});

bindCatalogControls({
  inputEl: els.dealsSearchInput,
  clearBtnEl: els.clearDealsSearchBtn,
  sortEl: els.dealsSortSelect,
  refreshBtnEl: els.refreshDealsBtn,
  normalizeSort: normalizeSteamDealsSort,
  onSetSort: (val) => { latestDealsSort = val; },
  onSaveSort: (val) => saveSettings({ steamDealsSort: val }),
  onSetQuery: (val) => { dealsSearchQuery = val; },
  onResetRemote: () => {
    dealsSearchSeq += 1;
    dealsSearchLoading = false;
    latestRemoteSearch = null;
  },
  onRender: renderCurrentDeals,
  onRunSearch: runLiveSteamSearch,
  onRefreshAdvance: () => refreshTopSteamDeals({ advance: true })
});

bindCatalogControls({
  inputEl: els.freeSteamSearchInput,
  clearBtnEl: els.clearFreeSteamSearchBtn,
  sortEl: els.freeSteamSortSelect,
  refreshBtnEl: els.refreshFreeSteamBtn,
  normalizeSort: normalizeSteamFreeSort,
  onSetSort: (val) => { latestFreeSteamSort = val; },
  onSaveSort: (val) => saveSettings({ steamFreeSort: val }),
  onSetQuery: (val) => { freeSteamSearchQuery = val; },
  onResetRemote: () => {
    freeSteamSearchSeq += 1;
    freeSteamSearchLoading = false;
    latestFreeSteamRemote = null;
  },
  onRender: renderCurrentFreeSteam,
  onRunSearch: runLiveFreeSteamSearch,
  onRefreshAdvance: () => refreshFreeSteamCatalog({ advance: true })
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
  for (const fn of controlCleanupFns) fn();
}

window.addEventListener('unload', cleanupTimers);
window.addEventListener('pagehide', cleanupTimers);
