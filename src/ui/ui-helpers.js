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
  if (!iso) return 'Never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'Unknown';
  const diffMs = ts - nowMs;
  if (Math.abs(diffMs) < 60000) return 'just now';
  if (Math.abs(diffMs) < 86400000) return formatRelativeDuration(diffMs, locale);
  return formatLocalDateTime(iso, locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Format next scheduled check duration using Intl.RelativeTimeFormat.
 * @param {number|null|undefined} scheduledMs
 * @param {number} [nowMs=Date.now()]
 * @param {string} [locale]
 * @returns {string}
 */
export function formatTimeUntil(scheduledMs, nowMs = Date.now(), locale) {
  if (!Number.isFinite(scheduledMs)) return 'unscheduled';
  const diffMs = Math.max(60000, scheduledMs - nowMs);
  return formatRelativeDuration(diffMs, locale);
}
