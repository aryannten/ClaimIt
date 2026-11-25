/**
 * Pure classification functions for ClaimIt offers.
 * Ensures only genuine limited-time "free to keep" (100% off) offers are claimed,
 * while excluding permanent free-to-play games, demos, free weekends/trials, and upcoming offers.
 * DLCs are permitted when free-to-keep and explicitly labelled as DLC.
 */

const DEMO_PATTERN = /\b(demo|prologue|benchmark)\b/i;
const TRIAL_PATTERN = /\b(free\s+weekend|play\s+for\s+free|free\s+trial|weekend\s+trial)\b/i;
const F2P_PATTERN = /\b(free[\s-]+to[\s-]+play|f2p)\b/i;
const DLC_PATTERN = /\b(dlc|add[\s-]?on|expansion|soundtrack|season\s+pass|pack)\b/i;

/**
 * Parse a date string or timestamp into epoch milliseconds, returning null if invalid.
 * @param {string|number|Date|null|undefined} value
 * @returns {number|null}
 */
function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize a price field into numeric cents/major units (preserving positive > 0 checks).
 * @param {number|{amount?: number, value?: number}|string|null|undefined} price
 * @returns {number}
 */
function normalizePriceAmount(price) {
  if (typeof price === 'number') {
    return Number.isFinite(price) ? price : 0;
  }
  if (price && typeof price === 'object') {
    if (typeof price.amount === 'number' && Number.isFinite(price.amount)) return price.amount;
    if (typeof price.value === 'number' && Number.isFinite(price.value)) return price.value;
  }
  if (typeof price === 'string') {
    const cleaned = price.replace(/[^0-9.,-]/g, '').replace(/,/g, '.');
    const num = Number.parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  }
  return 0;
}

/**
 * Determine whether an offer represents DLC / add-on content.
 * @param {object} offer
 * @returns {boolean}
 */
function isDlcOffer(offer) {
  if (!offer || typeof offer !== 'object') return false;
  if (offer.isDlc === true) return true;
  const type = String(offer.type || '').toLowerCase();
  const rawType = String(offer.offerType || offer.rawType || '').toLowerCase();
  if (type === 'dlc' || rawType === 'dlc' || rawType === 'add_on' || rawType === 'addon') {
    return true;
  }
  if (Array.isArray(offer.categories)) {
    const hasAddonCat = offer.categories.some((c) => {
      const val = String(typeof c === 'string' ? c : c?.path || c?.name || '').toLowerCase();
      return val === 'addons' || val === 'dlc' || val.includes('downloadable content');
    });
    if (hasAddonCat) return true;
  }
  return false;
}

/**
 * Determine whether an offer is a demo.
 * @param {object} offer
 * @returns {boolean}
 */
function isDemoOffer(offer) {
  if (!offer || typeof offer !== 'object') return false;
  if (offer.isDemo === true) return true;
  const type = String(offer.type || '').toLowerCase();
  const rawType = String(offer.offerType || offer.rawType || '').toLowerCase();
  if (type === 'demo' || rawType === 'demo') return true;
  const badgeText = String(offer.badgeText || offer.promoText || '');
  if (DEMO_PATTERN.test(badgeText)) return true;
  return false;
}

/**
 * Determine whether an offer is a free weekend or temporary play-only trial.
 * @param {object} offer
 * @returns {boolean}
 */
function isTrialOrWeekendOffer(offer) {
  if (!offer || typeof offer !== 'object') return false;
  if (offer.isFreeWeekend === true || offer.isTrial === true) return true;
  const type = String(offer.type || '').toLowerCase();
  const rawType = String(offer.offerType || offer.rawType || '').toLowerCase();
  if (type === 'trial' || type === 'free_weekend' || rawType === 'trial') return true;
  const combinedText = [offer.badgeText, offer.promoText, offer.subtitle]
    .filter(Boolean)
    .join(' ');
  return TRIAL_PATTERN.test(combinedText);
}

/**
 * Determine whether an offer is a permanent free-to-play game rather than a limited-time 100% discount.
 * @param {object} offer
 * @param {number|null} endMs
 * @returns {boolean}
 */
function isPermanentFreeToPlay(offer, endMs) {
  if (!offer || typeof offer !== 'object') return false;
  if (offer.isFreeToPlay === true) return true;
  const type = String(offer.type || '').toLowerCase();
  if (type === 'f2p' || type === 'free_to_play') return true;

  const badgeText = [offer.badgeText, offer.promoText].filter(Boolean).join(' ');
  if (F2P_PATTERN.test(badgeText) && normalizePriceAmount(offer.originalPrice) <= 0) {
    return true;
  }

  const original = normalizePriceAmount(offer.originalPrice);
  const discountPercent = Number(offer.discountPercent ?? 0);
  const hasLimitedWindow = endMs !== null || offer.isLimitedTime === true;

  if (original <= 0 && discountPercent < 100) return true;
  if (!hasLimitedWindow && original <= 0) return true;
  return false;
}

/**
 * Classify a single normalized store offer.
 * @param {object} offer
 * @param {number} [nowMs=Date.now()]
 * @returns {{
 *   eligible: boolean,
 *   reason: string|null,
 *   category: 'game'|'dlc'|'excluded',
 *   label: 'DLC'|null,
 *   offer: object
 * }}
 */
export function classifyOffer(offer, nowMs = Date.now()) {
  if (!offer || typeof offer !== 'object' || !offer.id || !offer.title) {
    return {
      eligible: false,
      reason: 'invalid_offer',
      category: 'excluded',
      label: null,
      offer: offer || null
    };
  }

  const startMs = parseTimestamp(offer.startDate);
  const endMs = parseTimestamp(offer.endDate);
  const dlc = isDlcOffer(offer);
  const label = dlc ? 'DLC' : null;
  const normalizedOffer = {
    ...offer,
    type: dlc ? 'dlc' : (offer.type || 'game'),
    label
  };

  if (offer.isUpcoming === true || (startMs !== null && startMs > nowMs)) {
    return {
      eligible: false,
      reason: 'upcoming',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  if (endMs !== null && endMs <= nowMs) {
    return {
      eligible: false,
      reason: 'expired',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  if (isDemoOffer(offer)) {
    return {
      eligible: false,
      reason: 'demo',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  if (isTrialOrWeekendOffer(offer)) {
    return {
      eligible: false,
      reason: 'free_weekend_or_trial',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  if (isPermanentFreeToPlay(offer, endMs)) {
    return {
      eligible: false,
      reason: 'permanent_free_to_play',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  const original = normalizePriceAmount(offer.originalPrice);
  const discountPrice = normalizePriceAmount(offer.discountPrice ?? 0);
  const discountPercent = Number(offer.discountPercent ?? (original > 0 && discountPrice === 0 ? 100 : 0));
  const hasLimitedWindow = endMs !== null || offer.isLimitedTime === true;

  if (!hasLimitedWindow) {
    return {
      eligible: false,
      reason: 'not_limited_time',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  if (discountPrice > 0 || discountPercent < 100) {
    return {
      eligible: false,
      reason: 'not_100_percent_off',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  if (original <= 0 && offer.hasPaidBaseline !== true) {
    return {
      eligible: false,
      reason: 'no_paid_original_price',
      category: 'excluded',
      label,
      offer: normalizedOffer
    };
  }

  // Fallback DLC title hint when provider didn't explicitly tag categories
  const inferredDlc = dlc || (DLC_PATTERN.test(offer.title) && offer.type === 'dlc');

  return {
    eligible: true,
    reason: null,
    category: inferredDlc ? 'dlc' : 'game',
    label: inferredDlc ? 'DLC' : null,
    offer: {
      ...normalizedOffer,
      type: inferredDlc ? 'dlc' : 'game',
      label: inferredDlc ? 'DLC' : null
    }
  };
}

/**
 * Classify a list of offers into eligible and excluded buckets.
 * @param {object[]} offers
 * @param {number} [nowMs=Date.now()]
 * @returns {{ eligible: object[], excluded: object[] }}
 */
export function classifyOffers(offers, nowMs = Date.now()) {
  const eligible = [];
  const excluded = [];
  for (const raw of Array.isArray(offers) ? offers : []) {
    const result = classifyOffer(raw, nowMs);
    if (result.eligible) {
      eligible.push(result.offer);
    } else {
      excluded.push({ offer: result.offer, reason: result.reason });
    }
  }
  return { eligible, excluded };
}
