import {
  STORAGE_KEYS,
  getSettings,
  getHistory,
  getCurrentOffers,
  getMeta,
  computeValueSaved
} from '../storage.js';
import { CLAIM_STATUS } from '../providers/constants.js';

const RELEVANT_STORAGE_KEYS = new Set([
  STORAGE_KEYS.SETTINGS,
  STORAGE_KEYS.HISTORY,
  STORAGE_KEYS.CURRENT_OFFERS,
  STORAGE_KEYS.META
]);

const els = {
  lastCheckedText: document.getElementById('lastCheckedText'),
  pauseSwitch: document.getElementById('pauseSwitch'),
  pauseLabel: document.getElementById('pauseLabel'),
  openOptionsBtn: document.getElementById('openOptionsBtn'),
  dryRunBadge: document.getElementById('dryRunBadge'),
  pausedBadge: document.getElementById('pausedBadge'),
  checkNowBtn: document.getElementById('checkNowBtn'),
  freeCount: document.getElementById('freeCount'),
  claimedCount: document.getElementById('claimedCount'),
  issuesCount: document.getElementById('issuesCount'),
  tabFree: document.getElementById('tab-free'),
  tabClaimed: document.getElementById('tab-claimed'),
  tabIssues: document.getElementById('tab-issues')
};

let renderInFlight = false;
let renderQueued = false;

function isSafeHttpsUrl(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

async function openStoreTab(url) {
  if (!isSafeHttpsUrl(url)) return;
  await chrome.tabs.create({ url, active: true });
}

async function sendRuntimeMessage(payload) {
  try {
    const res = await chrome.runtime.sendMessage(payload);
    if (res && res.ok === false) {
      throw new Error(res.error || 'Background request failed');
    }
    return res;
  } catch (err) {
    els.lastCheckedText.textContent = err instanceof Error ? err.message : String(err);
    return null;
  }
}

function formatRelativeTime(iso) {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return date.toLocaleDateString();
}

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function statusChip(status, dryRun, alreadyOwned) {
  const span = document.createElement('span');
  if (dryRun && status === CLAIM_STATUS.CLAIMED) {
    span.className = 'chip chip-warn';
    span.textContent = 'Dry-run';
  } else if (alreadyOwned && status === CLAIM_STATUS.CLAIMED) {
    span.className = 'chip chip-muted';
    span.textContent = 'Owned';
  } else if (status === CLAIM_STATUS.CLAIMED) {
    span.className = 'chip chip-claimed';
    span.textContent = 'Claimed';
  } else if (status === CLAIM_STATUS.NEEDS_USER) {
    span.className = 'chip chip-needs';
    span.textContent = 'Action needed';
  } else if (status === CLAIM_STATUS.FAILED) {
    span.className = 'chip chip-failed';
    span.textContent = 'Failed';
  } else {
    span.className = 'chip chip-muted';
    span.textContent = status || 'Free';
  }
  return span;
}

function createOfferCard(item, mode) {
  const card = document.createElement('article');
  card.className = 'card';

  const img = document.createElement('img');
  img.className = 'card-thumb';
  img.src = isSafeHttpsUrl(item.image) ? item.image : '../../assets/icon-128.png';
  img.alt = item.title || 'Game cover';
  img.addEventListener('error', () => {
    img.src = '../../assets/icon-128.png';
  });
  card.appendChild(img);

  const body = document.createElement('div');
  body.className = 'card-body';

  const titleRow = document.createElement('div');
  titleRow.className = 'card-title-row';
  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = item.title;
  title.title = item.title;
  titleRow.appendChild(title);
  titleRow.appendChild(statusChip(item.status, item.dryRun, item.alreadyOwned));
  body.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const storeSpan = document.createElement('span');
  storeSpan.textContent = item.storeName || item.store;
  meta.appendChild(storeSpan);

  if (item.label === 'DLC') {
    const dlcChip = document.createElement('span');
    dlcChip.className = 'chip chip-info';
    dlcChip.textContent = 'DLC';
    meta.appendChild(dlcChip);
  }

  if (item.originalPrice) {
    const priceSpan = document.createElement('span');
    priceSpan.textContent = `Worth ${item.originalPrice}`;
    meta.appendChild(priceSpan);
  }

  if (mode === 'claimed' && item.claimedAt) {
    const dateSpan = document.createElement('span');
    dateSpan.textContent = `Claimed ${formatDateShort(item.claimedAt)}`;
    meta.appendChild(dateSpan);
  } else if (item.endDate) {
    const endSpan = document.createElement('span');
    endSpan.textContent = `Ends ${formatDateShort(item.endDate)}`;
    meta.appendChild(endSpan);
  }

  body.appendChild(meta);

  if (item.reason && (item.status === CLAIM_STATUS.NEEDS_USER || item.status === CLAIM_STATUS.FAILED)) {
    const reason = document.createElement('div');
    reason.className = `card-reason ${item.status === CLAIM_STATUS.FAILED ? 'error' : ''}`;
    reason.textContent = item.reason;
    body.appendChild(reason);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (mode === 'free' || mode === 'issues') {
    if (item.status !== CLAIM_STATUS.CLAIMED) {
      const claimBtn = document.createElement('button');
      claimBtn.className = 'btn btn-primary btn-sm';
      claimBtn.textContent = item.status === CLAIM_STATUS.NEEDS_USER ? 'Open & Claim' : 'Claim';
      claimBtn.addEventListener('click', async () => {
        if (item.status === CLAIM_STATUS.NEEDS_USER) {
          await openStoreTab(item.url);
          return;
        }
        claimBtn.disabled = true;
        claimBtn.textContent = 'Claiming...';
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
    }

    if (mode === 'issues') {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn btn-sm';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying...';
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
  }

  if (isSafeHttpsUrl(item.url)) {
    const openLinkBtn = document.createElement('button');
    openLinkBtn.className = 'btn btn-sm';
    openLinkBtn.textContent = 'Store';
    openLinkBtn.addEventListener('click', () => {
      openStoreTab(item.url);
    });
    actions.appendChild(openLinkBtn);
  }

  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

function renderEmpty(container, message) {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent = message;
  container.appendChild(empty);
}

async function render() {
  const [settings, historyMap, currentOffers, meta] = await Promise.all([
    getSettings(),
    getHistory(),
    getCurrentOffers(),
    getMeta()
  ]);

  els.lastCheckedText.textContent = meta.isChecking
    ? 'Checking stores now...'
    : `Last checked: ${formatRelativeTime(meta.lastCheckedAt)}`;

  els.pauseSwitch.checked = Boolean(settings.paused);
  els.pauseLabel.textContent = settings.paused ? 'Paused' : 'Active';
  els.pausedBadge.classList.toggle('hidden', !settings.paused);
  els.dryRunBadge.classList.toggle('hidden', !settings.dryRun);
  els.checkNowBtn.disabled = Boolean(meta.isChecking || settings.paused);
  els.checkNowBtn.textContent = meta.isChecking ? 'Checking...' : 'Check now';

  // Tab 1: Free now
  els.tabFree.replaceChildren();
  els.freeCount.textContent = String(currentOffers.length);
  if (currentOffers.length === 0) {
    renderEmpty(els.tabFree, 'No active free-to-keep offers cached yet. Click "Check now" to scan.');
  } else {
    for (const offer of currentOffers) {
      els.tabFree.appendChild(createOfferCard(offer, 'free'));
    }
  }

  // Tab 2: Claimed (excludes dry-run and pre-existing owned items)
  const allHistory = Object.values(historyMap);
  const claimed = allHistory
    .filter((h) => h.status === CLAIM_STATUS.CLAIMED && !h.dryRun && !h.alreadyOwned)
    .sort((a, b) => Date.parse(b.claimedAt || b.updatedAt || 0) - Date.parse(a.claimedAt || a.updatedAt || 0));

  const saved = computeValueSaved(historyMap);
  els.claimedCount.textContent = String(claimed.length);
  els.tabClaimed.replaceChildren();

  const summary = document.createElement('div');
  summary.className = 'summary-card';
  const summaryLeft = document.createElement('div');
  const sumLbl = document.createElement('div');
  sumLbl.className = 'summary-label';
  sumLbl.textContent = 'Total Value Saved';
  const sumVal = document.createElement('div');
  sumVal.className = 'summary-value';
  const extraCurrencies = Object.entries(saved.totalsByCurrency || {})
    .filter(([cur]) => cur !== saved.currency)
    .map(([cur, amt]) => `${cur} ${amt.toFixed(2)}`);
  sumVal.textContent = extraCurrencies.length
    ? `${saved.currency} ${saved.totalMajor.toFixed(2)} + ${extraCurrencies.join(', ')}`
    : `${saved.currency} ${saved.totalMajor.toFixed(2)}`;
  summaryLeft.append(sumLbl, sumVal);

  const summaryRight = document.createElement('div');
  summaryRight.className = 'last-checked';
  summaryRight.textContent = `${claimed.length} game${claimed.length === 1 ? '' : 's'} claimed`;
  summary.append(summaryLeft, summaryRight);
  els.tabClaimed.appendChild(summary);

  if (claimed.length === 0) {
    renderEmpty(els.tabClaimed, 'No claimed games in history yet.');
  } else {
    for (const item of claimed) {
      els.tabClaimed.appendChild(createOfferCard(item, 'claimed'));
    }
  }

  // Tab 3: Issues
  const issues = allHistory
    .filter((h) => h.status === CLAIM_STATUS.NEEDS_USER || h.status === CLAIM_STATUS.FAILED)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));

  els.issuesCount.textContent = String(issues.length);
  els.tabIssues.replaceChildren();
  if (issues.length === 0) {
    renderEmpty(els.tabIssues, 'No pending actions or failed claims.');
  } else {
    for (const item of issues) {
      els.tabIssues.appendChild(createOfferCard(item, 'issues'));
    }
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

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === btn);
      t.setAttribute('aria-selected', String(t === btn));
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${target}`);
    });
  });
});

els.pauseSwitch.addEventListener('change', async () => {
  await sendRuntimeMessage({
    type: 'CLAIMIT_SET_PAUSED',
    paused: els.pauseSwitch.checked
  });
  await scheduleRender();
});

els.checkNowBtn.addEventListener('click', async () => {
  els.checkNowBtn.disabled = true;
  els.checkNowBtn.textContent = 'Checking...';
  try {
    await sendRuntimeMessage({ type: 'CLAIMIT_RUN_CHECK' });
  } finally {
    await scheduleRender();
  }
});

els.openOptionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (Object.keys(changes).some((k) => RELEVANT_STORAGE_KEYS.has(k))) {
    scheduleRender();
  }
});

scheduleRender();
