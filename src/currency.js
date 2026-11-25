/**
 * Regional detection, currency resolution, keyless FX conversion cache,
 * and Intl formatting helpers for ClaimIt.
 *
 * Exchange-rate API chosen: ExchangeRate-API Open Access
 *   Endpoint: https://open.er-api.com/v6/latest/USD
 *   Why: completely free, no API key, HTTPS JSON, 166 currencies including INR/EUR/JPY/BHD,
 *   daily update cadence cached for 24h in chrome.storage.local.
 */

export const DEFAULT_FALLBACK_CURRENCY = 'USD';
export const DEFAULT_FALLBACK_COUNTRY = 'US';
export const FX_RATE_URL = 'https://open.er-api.com/v6/latest/USD';
export const FX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const SUPPORTED_CURRENCIES = [
  'INR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD',
  'KRW', 'SGD', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'NZD', 'SEK', 'NOK',
  'DKK', 'PLN', 'TRY', 'UAH', 'TWD', 'THB', 'MYR', 'IDR', 'PHP', 'VND',
  'BHD', 'KWD', 'OMR', 'ILS'
];

const COUNTRY_TO_CURRENCY = {
  IN: 'INR',
  US: 'USD',
  PR: 'USD',
  GB: 'GBP',
  UK: 'GBP',
  JP: 'JPY',
  AU: 'AUD',
  CA: 'CAD',
  NZ: 'NZD',
  CH: 'CHF',
  LI: 'CHF',
  CN: 'CNY',
  HK: 'HKD',
  TW: 'TWD',
  KR: 'KRW',
  SG: 'SGD',
  AE: 'AED',
  SA: 'SAR',
  BR: 'BRL',
  MX: 'MXN',
  ZA: 'ZAR',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  TR: 'TRY',
  UA: 'UAH',
  TH: 'THB',
  MY: 'MYR',
  ID: 'IDR',
  PH: 'PHP',
  VN: 'VND',
  BH: 'USD',
  KW: 'KWD',
  OM: 'OMR',
  IL: 'ILS',
  AD: 'EUR', AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR',
  ES: 'EUR', FI: 'EUR', FR: 'EUR', GR: 'EUR', HR: 'EUR', IE: 'EUR',
  IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR', MC: 'EUR', MT: 'EUR',
  NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR', SM: 'EUR', VA: 'EUR'
};

const DOLLAR_COUNTRIES = {
  AU: 'AUD',
  CA: 'CAD',
  HK: 'HKD',
  NZ: 'NZD',
  SG: 'SGD',
  TW: 'TWD',
  MX: 'MXN'
};

export function getBrowserLocale() {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language.trim()) {
    return navigator.language.trim();
  }
  try {
    return new Intl.NumberFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

export function normalizeCurrencyCode(code) {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : null;
}

export function normalizeCountryCode(code) {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

export function getCountryName(countryCode, locale = 'en') {
  const cc = normalizeCountryCode(countryCode);
  if (!cc) return 'Unknown region';
  try {
    const names = new Intl.DisplayNames([locale || 'en', 'en'], { type: 'region' });
    return names.of(cc) || cc;
  } catch {
    return cc;
  }
}

export function getCurrencyLabel(currencyCode, locale = 'en') {
  const cur = normalizeCurrencyCode(currencyCode);
  if (!cur) return '';
  try {
    const names = new Intl.DisplayNames([locale || 'en', 'en'], { type: 'currency' });
    const display = names.of(cur);
    return display && display !== cur ? `${cur} - ${display}` : cur;
  } catch {
    return cur;
  }
}

export function inferCurrencyFromCountry(countryCode) {
  const cc = normalizeCountryCode(countryCode);
  if (!cc) return null;
  return COUNTRY_TO_CURRENCY[cc] || null;
}

/**
 * Extract country and inferred currency from a BCP-47 browser locale tag (e.g. en-IN -> IN, INR).
 * @param {string} [locale]
 * @returns {{ locale: string, country: string|null, currency: string|null, countryName: string }}
 */
export function detectLocaleRegion(locale = getBrowserLocale()) {
  const rawLocale = typeof locale === 'string' && locale.trim() ? locale.trim() : 'en-US';
  let country = null;

  try {
    const parsed = new Intl.Locale(rawLocale);
    country = normalizeCountryCode(parsed.region);
    if (!country) {
      country = normalizeCountryCode(parsed.maximize()?.region);
    }
  } catch {
    const match = rawLocale.match(/[-_]([A-Za-z]{2})\b/);
    country = normalizeCountryCode(match?.[1]);
  }

  return {
    locale: rawLocale,
    country,
    currency: inferCurrencyFromCountry(country),
    countryName: country ? getCountryName(country, rawLocale) : 'Unknown region'
  };
}

/**
 * Infer an ISO-4217 currency code from scraped storefront price text and optional country code.
 * Used only as a secondary fallback when an API does not provide an explicit ISO currencyCode.
 * @param {string} priceText
 * @param {string|null|undefined} countryCode
 * @returns {string|null}
 */
export function inferCurrencyFromFormatted(priceText, countryCode = null) {
  const text = String(priceText || '').trim();
  const upper = text.toUpperCase();
  const explicitIso = upper.match(/\b(INR|USD|EUR|GBP|JPY|AUD|CAD|CHF|CNY|HKD|KRW|SGD|AED|SAR|BRL|MXN|ZAR|NZD|SEK|NOK|DKK|PLN|TRY|UAH|TWD|THB|MYR|IDR|PHP|VND|BHD|KWD|OMR|ILS)\b/);
  if (explicitIso) return explicitIso[1];

  const cc = normalizeCountryCode(countryCode);
  if (text.includes('\u20B9') || /\bRs\.?/i.test(text)) return 'INR';
  if (text.includes('\u20AC')) return 'EUR';
  if (text.includes('\u00A3')) return 'GBP';
  if (text.includes('\u20A9')) return 'KRW';
  if (text.includes('\u20B4')) return 'UAH';
  if (text.includes('\u20AB')) return 'VND';
  if (text.includes('\u20AA')) return 'ILS';
  if (text.includes('\u20BA')) return 'TRY';
  if (text.includes('\u20BD')) return 'RUB';
  if (text.includes('R$')) return 'BRL';
  if (text.includes('S$')) return 'SGD';
  if (text.includes('HK$')) return 'HKD';
  if (text.includes('CA$') || text.includes('CDN$')) return 'CAD';
  if (text.includes('A$')) return 'AUD';
  if (text.includes('NT$')) return 'TWD';
  if (text.includes('\u00A5')) return cc === 'CN' ? 'CNY' : 'JPY';
  if (text.includes('$')) return DOLLAR_COUNTRIES[cc] || DEFAULT_FALLBACK_CURRENCY;
  return null;
}

/**
 * Pick formatting locale so INR uses Indian grouping even if the user switched currency manually.
 * @param {string} currency
 * @param {string} [preferredLocale]
 * @returns {string}
 */
export function getFormatLocale(currency, preferredLocale = getBrowserLocale()) {
  const cur = normalizeCurrencyCode(currency);
  const baseLoc = typeof preferredLocale === 'string' && preferredLocale.trim()
    ? preferredLocale.trim()
    : 'en-US';
  if (cur === 'INR') {
    const loc = detectLocaleRegion(baseLoc);
    return loc.country === 'IN' ? baseLoc : 'en-IN';
  }
  return baseLoc;
}

/**
 * Resolve effective region and display currency in priority order:
 * 1. User's explicit selection in Options (settings.currency !== 'auto')
 * 2. Store's detected region (storedRegion.storeCurrency / storeCountry)
 * 3. Browser locale via navigator.language + Intl (e.g. en-IN -> IN, INR)
 * 4. Fallback: USD
 *
 * @param {{
 *   settings?: { currency?: string },
 *   storedRegion?: { storeCountry?: string|null, storeCurrency?: string|null } | null,
 *   navigatorLanguage?: string
 * }} [params]
 */
export function resolveRegionAndCurrency({
  settings = {},
  storedRegion = null,
  navigatorLanguage
} = {}) {
  const browserLocale = navigatorLanguage || getBrowserLocale();
  const localeInfo = detectLocaleRegion(browserLocale);

  const explicitCurrency =
    settings?.currency && String(settings.currency).toLowerCase() !== 'auto'
      ? normalizeCurrencyCode(settings.currency)
      : null;

  const storeCountry = normalizeCountryCode(storedRegion?.storeCountry);
  const storeCurrency =
    normalizeCurrencyCode(storedRegion?.storeCurrency) ||
    inferCurrencyFromCountry(storeCountry);

  const detectedCountry = storeCountry || localeInfo.country || DEFAULT_FALLBACK_COUNTRY;
  const detectedCurrency = storeCurrency || localeInfo.currency || DEFAULT_FALLBACK_CURRENCY;
  const countryName = getCountryName(detectedCountry, browserLocale);

  let currency = DEFAULT_FALLBACK_CURRENCY;
  let source = 'fallback';

  if (explicitCurrency) {
    currency = explicitCurrency;
    source = 'user';
  } else if (storeCurrency) {
    currency = storeCurrency;
    source = 'store';
  } else if (localeInfo.currency) {
    currency = localeInfo.currency;
    source = 'locale';
  }

  return {
    currency,
    source,
    isOverridden: Boolean(explicitCurrency),
    country: detectedCountry,
    countryName,
    detectedCurrency,
    storeCountry,
    storeCurrency,
    locale: getFormatLocale(currency, browserLocale),
    browserLocale
  };
}

/**
 * Format a numeric price strictly with Intl.NumberFormat in the given ISO currency and locale.
 * Respects zero-decimal (JPY), two-decimal (INR/USD/EUR), and three-decimal (BHD/KWD) currencies.
 * @param {number} amount
 * @param {string} currency
 * @param {string} [locale]
 * @returns {string}
 */
export function formatPrice(amount, currency = DEFAULT_FALLBACK_CURRENCY, locale) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return '';
  const isoCurrency = normalizeCurrencyCode(currency) || DEFAULT_FALLBACK_CURRENCY;
  const fmtLocale = getFormatLocale(isoCurrency, locale);

  try {
    return new Intl.NumberFormat(fmtLocale, {
      style: 'currency',
      currency: isoCurrency,
      trailingZeroDisplay: 'stripIfInteger'
    }).format(num);
  } catch {
    return `${isoCurrency} ${num}`;
  }
}

/**
 * Convert an amount between any two ISO currencies using cached USD-anchored rates.
 * Returns null if either currency rate is unavailable or non-positive.
 * @param {number} amount
 * @param {string} fromCurrency
 * @param {string} toCurrency
 * @param {Record<string, number>|null|undefined} rates
 */
export function convertAmount(amount, fromCurrency, toCurrency, rates) {
  const num = Number(amount);
  const from = normalizeCurrencyCode(fromCurrency);
  const to = normalizeCurrencyCode(toCurrency);
  if (!Number.isFinite(num) || !from || !to) return null;

  if (from === to) {
    return { amount: num, converted: false, fromCurrency: from, toCurrency: to, rate: 1 };
  }
  if (!rates || typeof rates !== 'object') return null;

  const fromRate = from === DEFAULT_FALLBACK_CURRENCY ? 1 : Number(rates[from]);
  const toRate = to === DEFAULT_FALLBACK_CURRENCY ? 1 : Number(rates[to]);
  if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(toRate) || toRate <= 0) {
    return null;
  }

  const rate = toRate / fromRate;
  return {
    amount: num * rate,
    converted: true,
    fromCurrency: from,
    toCurrency: to,
    rate
  };
}

/**
 * Fetch and cache FX rates at most once per 24 hours, falling back cleanly to stale cache
 * or null on network/API failure (never throwing or returning NaN).
 * @param {{
 *   cached?: { baseCode?: string, rates?: Record<string, number>, fetchedAtMs?: number, dateLabel?: string }|null,
 *   nowMs?: number,
 *   fetchFn?: typeof fetch,
 *   saveCacheFn?: (entry: object) => Promise<void>
 * }} [options]
 */
export async function getExchangeRates({
  cached = null,
  nowMs = Date.now(),
  fetchFn = typeof fetch === 'function' ? fetch : null,
  saveCacheFn = null
} = {}) {
  if (
    cached &&
    cached.rates &&
    typeof cached.rates === 'object' &&
    Number.isFinite(cached.fetchedAtMs) &&
    nowMs - cached.fetchedAtMs < FX_CACHE_TTL_MS
  ) {
    return { ...cached, fromCache: true, stale: false };
  }

  if (typeof fetchFn === 'function') {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 6000) : null;
    try {
      const resp = await fetchFn(FX_RATE_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller?.signal
      });
      if (resp && resp.ok) {
        const json = await resp.json();
        const rawRates = json?.rates;
        if (json?.result === 'success' && rawRates && typeof rawRates === 'object') {
          const cleanRates = { [DEFAULT_FALLBACK_CURRENCY]: 1 };
          for (const [k, v] of Object.entries(rawRates)) {
            const code = normalizeCurrencyCode(k);
            const val = Number(v);
            if (code && Number.isFinite(val) && val > 0) {
              cleanRates[code] = val;
            }
          }
          if (Object.keys(cleanRates).length > 1) {
            const entry = {
              baseCode: DEFAULT_FALLBACK_CURRENCY,
              rates: cleanRates,
              fetchedAtMs: nowMs,
              dateLabel: String(json.time_last_update_utc || new Date(nowMs).toISOString())
            };
            if (typeof saveCacheFn === 'function') {
              await saveCacheFn(entry);
            }
            return { ...entry, fromCache: false, stale: false };
          }
        }
      }
    } catch {
      // Fall back to cached rates if available
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (cached && cached.rates && typeof cached.rates === 'object') {
    return { ...cached, fromCache: true, stale: true };
  }
  return null;
}

/**
 * Format an offer or history price into a normalized display descriptor, handling:
 * - Missing / zero price -> "Price unavailable"
 * - Unknown legacy currency -> raw value labelled without guessing
 * - Native regional currency vs FX fallback conversion ("Converted from <CUR> at today's rate.")
 * - No-cache offline fallback -> shows original store currency instead of guessing
 *
 * @param {object} item
 * @param {{ displayCurrency?: string, locale?: string, rates?: Record<string, number>|null }} [opts]
 */
export function formatOfferPriceState(item, opts = {}) {
  const num = Number(item?.originalPriceValue ?? item?.originalPrice ?? 0);
  if (!Number.isFinite(num) || num <= 0) {
    return {
      available: false,
      approx: false,
      label: 'Price unavailable',
      formatted: '',
      conversionNote: null
    };
  }

  const locale = opts.locale || getBrowserLocale();
  const displayCurrency = normalizeCurrencyCode(opts.displayCurrency) || DEFAULT_FALLBACK_CURRENCY;
  const sourceCurrency = normalizeCurrencyCode(item?.currencyCode ?? item?.currency);

  if (!sourceCurrency || item?.unknownCurrency === true) {
    const rawText = item?.originalPriceFormatted || String(num);
    return {
      available: true,
      approx: false,
      unknownCurrency: true,
      amount: num,
      currency: null,
      formatted: `${rawText} (unknown currency)`,
      conversionNote: 'Saved before currency tracking was added.'
    };
  }

  if (sourceCurrency === displayCurrency) {
    return {
      available: true,
      approx: false,
      amount: num,
      currency: displayCurrency,
      originalCurrency: sourceCurrency,
      formatted: formatPrice(num, displayCurrency, locale),
      conversionNote: null
    };
  }

  const converted = convertAmount(num, sourceCurrency, displayCurrency, opts.rates);
  if (converted) {
    const note = `Converted from ${sourceCurrency} at today's rate.`;
    return {
      available: true,
      approx: true,
      amount: converted.amount,
      currency: displayCurrency,
      originalAmount: num,
      originalCurrency: sourceCurrency,
      formatted: formatPrice(converted.amount, displayCurrency, locale),
      originalFormatted: formatPrice(num, sourceCurrency, locale),
      conversionNote: note
    };
  }

  return {
    available: true,
    approx: false,
    conversionUnavailable: true,
    amount: num,
    currency: sourceCurrency,
    originalCurrency: sourceCurrency,
    formatted: formatPrice(num, sourceCurrency, locale),
    conversionNote: `Shown in ${sourceCurrency} (exchange rates unavailable).`
  };
}

/**
 * Format an ISO timestamp in the user's locale and local timezone.
 * @param {string|null|undefined} iso
 * @param {string} [locale]
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export function formatLocalDateTime(
  iso,
  locale = getBrowserLocale(),
  options = { dateStyle: 'medium', timeStyle: 'short' }
) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  try {
    return new Intl.DateTimeFormat(locale || undefined, options).format(new Date(ts));
  } catch {
    return new Date(ts).toLocaleString();
  }
}

/**
 * Format a relative time offset via Intl.RelativeTimeFormat in the user's locale.
 * @param {number} diffMs - positive for future, negative for past
 * @param {string} [locale]
 * @returns {string}
 */
export function formatRelativeDuration(diffMs, locale = getBrowserLocale()) {
  if (!Number.isFinite(diffMs)) return '';
  const absSec = Math.round(Math.abs(diffMs) / 1000);
  const sign = diffMs >= 0 ? 1 : -1;

  try {
    const rtf = new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto' });
    if (absSec < 60) return rtf.format(sign * Math.max(1, absSec), 'second');
    const absMin = Math.round(absSec / 60);
    if (absMin < 60) return rtf.format(sign * absMin, 'minute');
    const absHours = Math.round(absMin / 60);
    if (absHours < 24) return rtf.format(sign * absHours, 'hour');
    const absDays = Math.round(absHours / 24);
    return rtf.format(sign * absDays, 'day');
  } catch {
    const mins = Math.max(1, Math.round(absSec / 60));
    return sign >= 0 ? `in ${mins}m` : `${mins}m ago`;
  }
}
