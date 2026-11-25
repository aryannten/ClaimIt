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
 * Format a numeric amount using Intl.NumberFormat in the given ISO currency.
 * @param {number} amount
 * @param {string} [currency='USD']
 * @returns {string}
 */
export function formatCurrency(amount, currency = 'USD') {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2
    }).format(num);
  } catch {
    return `${currency} ${num.toFixed(2)}`;
  }
}

/**
 * Format a future countdown cleanly (e.g., "2d 4h", "45m", or "Ended").
 * @param {string|null|undefined} iso
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatCountdown(iso, nowMs = Date.now()) {
  if (!iso) return 'Limited-time';
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs)) return 'Limited-time';
  const diffMin = Math.floor((targetMs - nowMs) / 60000);
  if (diffMin <= 0) return 'Ended';
  if (diffMin < 60) return `Ends in ${diffMin}m`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `Ends in ${hours}h ${diffMin % 60}m`;
  const days = Math.floor(hours / 24);
  return `Ends in ${days}d ${hours % 24}h`;
}

/**
 * Format a past elapsed duration calmly (e.g., "Just now", "14 min ago", "2 h ago").
 * @param {string|null|undefined} iso
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatTimeAgo(iso, nowMs = Date.now()) {
  if (!iso) return 'Never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'Unknown';
  const diffMin = Math.max(0, Math.floor((nowMs - ts) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts));
}

/**
 * Format duration until next scheduled check (e.g., "5 h 46 m").
 * @param {number|null|undefined} scheduledMs
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatTimeUntil(scheduledMs, nowMs = Date.now()) {
  if (!Number.isFinite(scheduledMs)) return 'unscheduled';
  const diffMin = Math.max(1, Math.round((scheduledMs - nowMs) / 60000));
  if (diffMin < 60) return `${diffMin} m`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return mins > 0 ? `${hours} h ${mins} m` : `${hours} h`;
}
