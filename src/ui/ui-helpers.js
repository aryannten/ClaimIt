import {
  formatPrice,
  formatLocalDateTime,
  formatRelativeDuration
} from '../currency.js';

export { formatPrice, formatLocalDateTime };

const SVG_NS = 'http://www.w3.org/2000/svg';

let illustrationsDocPromise = null;

/**
 * Create an inline SVG element referencing a symbol from assets/icons.svg or assets/stores.svg.
 * Uses currentColor so icons automatically match parent text/status color.
 * @param {string} symbolId
 * @param {string} [className='icon']
 * @param {string} [sprite='icons.svg']
 * @returns {SVGSVGElement}
 */
export function createSvgUse(symbolId, className = 'icon', sprite = 'icons.svg') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');

  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `../../assets/${sprite}#${symbolId}`);
  svg.appendChild(use);
  return svg;
}

/**
 * Load assets/illustrations.svg once and clone symbol nodes into an inline SVG element
 * so CSS custom properties (--surface, --accent, --warn, --danger) apply in light and dark modes.
 * @param {string} symbolId
 * @returns {Promise<SVGSVGElement|null>}
 */
export async function createIllustration(symbolId) {
  if (!illustrationsDocPromise) {
    illustrationsDocPromise = fetch('../../assets/illustrations.svg')
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => (text ? new window.DOMParser().parseFromString(text, 'image/svg+xml') : null))
      .catch(() => null);
  }

  const doc = await illustrationsDocPromise;
  const symbol = doc?.getElementById(symbolId);
  if (!symbol) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', symbol.getAttribute('viewBox') || '0 0 96 64');
  svg.setAttribute('class', 'state-illus');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  for (const child of Array.from(symbol.children)) {
    svg.appendChild(document.importNode(child, true));
  }
  return svg;
}

/**
 * Format a future offer end timestamp using Intl.RelativeTimeFormat and local Intl.DateTimeFormat.
 * @param {string|null|undefined} iso
 * @param {number} [nowMs=Date.now()]
 * @param {string} [locale]
 * @returns {string}
 */
export function formatCountdown(iso, nowMs = Date.now(), locale) {
  if (!iso) return 'Limited-time';
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return 'Limited-time';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'Ended';
  const rel = formatRelativeDuration(diffMs, locale);
  const local = formatLocalDateTime(iso, locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return local ? `Ends ${rel} (${local})` : `Ends ${rel}`;
}

/**
 * Format a past elapsed timestamp using Intl.RelativeTimeFormat and local date/time.
 * @param {string|null|undefined} iso
 * @param {number} [nowMs=Date.now()]
 * @param {string} [locale]
 * @returns {string}
 */
export function formatTimeAgo(iso, nowMs = Date.now(), locale) {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'unknown';
  const diffMs = ts - nowMs;
  if (Math.abs(diffMs) < 60000) return 'just now';
  if (Math.abs(diffMs) < 86400000) return formatRelativeDuration(diffMs, locale);
  return formatLocalDateTime(iso, locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Format the randomized next scan timestamp as a rough day + hour string with Intl
 * (e.g. "tomorrow, around 2 pm").
 * @param {string|number|null|undefined} isoOrMs
 * @param {number} [nowMs=Date.now()]
 * @param {string} [locale]
 * @returns {string}
 */
export function formatRoughNextScan(isoOrMs, nowMs = Date.now(), locale) {
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs || '');
  if (!Number.isFinite(ts)) return 'pending';
  const roundedMs = Math.round(ts / 3600000) * 3600000;
  const targetDate = new Date(roundedMs);
  const nowDate = new Date(nowMs);
  const dayStartNow = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const dayStartTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const dayDiff = Math.round((dayStartTarget - dayStartNow) / 86400000);

  try {
    const dayLabel =
      dayDiff === 0 || dayDiff === 1
        ? new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto' }).format(dayDiff, 'day')
        : new Intl.DateTimeFormat(locale || undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric'
          }).format(targetDate);
    const hourLabel = new Intl.DateTimeFormat(locale || undefined, { hour: 'numeric' }).format(targetDate);
    return `${dayLabel}, around ${hourLabel}`;
  } catch {
    return formatLocalDateTime(new Date(ts).toISOString(), locale);
  }
}

/**
 * Format large counts cleanly in compact notation (e.g. 325333 -> "325.3K").
 * @param {number|null|undefined} value
 * @param {string} [locale]
 * @returns {string}
 */
export function formatCompactCount(value, locale) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return '';
  if (num < 1000) return String(Math.round(num));
  try {
    return new Intl.NumberFormat(locale || undefined, {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(num);
  } catch {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    }
    return `${(num / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  }
}
