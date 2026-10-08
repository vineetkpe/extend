/**
 * urlNormalizer.js
 * Normalizes URLs for accurate SEO rank matching.
 * Handles protocol, www, trailing slashes, fragments, tracking parameters,
 * and Google redirect wrappers.
 */

// Tracking parameters to strip out
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid',
  'ref',
  'source',
  'ved',
  'usg',
  'ei',
  'sa',
  'sqi',
  'dpr'
]);

// Only actual Google search hosts may supply /url?q= redirect wrappers.
const GOOGLE_REDIRECT_HOSTS = new Set([
  'google.com', 'google.co.uk', 'google.co.in', 'google.com.au',
  'google.ca', 'google.de', 'google.fr'
]);

/**
 * Unwrap a genuine Google search redirect; leave unrelated URLs untouched.
 * Return an empty string for invalid/unsafe Google redirect destinations.
 */
export function cleanGoogleRedirect(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  const value = rawUrl.trim();
  const relativeRedirect = value.startsWith('/url?');
  if (!relativeRedirect && !/^https?:\/\//i.test(value)) return value;

  try {
    const parsed = new URL(value, relativeRedirect ? 'https://www.google.com' : undefined);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (parsed.pathname !== '/url' || !GOOGLE_REDIRECT_HOSTS.has(host)) {
      return relativeRedirect ? '' : value;
    }
    const destination = parsed.searchParams.get('q') || parsed.searchParams.get('url');
    if (!destination || !/^https?:\/\//i.test(destination)) return '';
    const target = new URL(destination);
    return ['http:', 'https:'].includes(target.protocol) ? target.href : '';
  } catch (_) {
    return relativeRedirect ? '' : value;
  }
}

/**
 * Strictly validates that a target URL is safe (only http: or https:, no script/data schemes).
 * @param {string} rawUrl 
 * @returns {boolean}
 */
export function isValidTargetUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (/^(javascript|data|file|chrome|chrome-extension|about|blob|vbscript):/i.test(trimmed)) {
    return false;
  }
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(candidate);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname && parsed.hostname.includes('.'));
  } catch (_) {
    return false;
  }
}

export const isSafeUrl = isValidTargetUrl;

/**
 * Normalize a URL for exact landing-page matching and SERP deduplication.
 *
 * Intentional equivalences: scheme, www, root/trailing slash, fragments,
 * tracking parameters and query parameter ordering.
 * Strict distinctions: path case/encoding, query key case/value and ports.
 * Invalid input must not turn into a guessed matching URL.
 */
export function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  const trimmed = rawUrl.trim();
  if (/^(javascript|data|file|chrome|chrome-extension|about|blob|vbscript):/i.test(trimmed)) {
    return '';
  }
  const unwrapped = cleanGoogleRedirect(trimmed);
  if (!unwrapped) return '';
  const candidate = /^https?:\/\//i.test(unwrapped) ? unwrapped : 'https://' + unwrapped;

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';

    let host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    // WHATWG URL already removes default ports; retain non-default ports.
    if (parsed.port) host += ':' + parsed.port;

    // Preserve path case and percent escapes: /a%2Fb may differ from /a/b.
    let pathname = parsed.pathname;
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    if (pathname === '/') pathname = '';

    const retainedParams = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      if (!TRACKING_PARAMS.has(lowerKey) && !lowerKey.startsWith('utm_')) {
        retainedParams.push([key, value]);
      }
    }
    // Stable sorting keeps duplicate values of the same key in input order.
    retainedParams.sort((a, b) => a[0].localeCompare(b[0]));
    const queryString = retainedParams.length
      ? '?' + new URLSearchParams(retainedParams).toString()
      : '';

    return host + pathname + queryString;
  } catch (_) {
    return '';
  }
}

/**
 * Extracts normalized domain from a URL:
 * e.g. "https://www.example.com/dentist" -> "example.com"
 * @param {string} rawUrl 
 * @returns {string} normalized domain
 */
export function extractDomain(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let cleaned = cleanGoogleRedirect(rawUrl.trim());
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'https://' + cleaned;
  }
  try {
    const parsed = new URL(cleaned);
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    return hostname;
  } catch (e) {
    let fallback = cleaned
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split('?')[0]
      .split(':')[0]
      .toLowerCase()
      .trim();
    return fallback;
  }
}

/**
 * Match result types
 */
export const MATCH_TYPES = {
  EXACT_PAGE: 'EXACT PAGE',
  OTHER_DOMAIN_PAGE: 'OTHER DOMAIN PAGE FOUND',
  NOT_FOUND: 'TARGET PAGE NOT FOUND'
};

/**
 * Compares a target URL against a candidate URL found in SERP.
 * @param {string} targetUrl The target URL expected by the user
 * @param {string} candidateUrl The organic search result URL from Google
 * @returns {{ match: boolean, isSameDomain?: boolean, type: string }}
 */
export function matchUrl(targetUrl, candidateUrl) {
  const normTarget = normalizeUrl(targetUrl);
  const normCandidate = normalizeUrl(candidateUrl);

  if (normTarget && normCandidate && normTarget === normCandidate) {
    return { match: true, isSameDomain: true, type: MATCH_TYPES.EXACT_PAGE };
  }

  const domainTarget = extractDomain(targetUrl);
  const domainCandidate = extractDomain(candidateUrl);

  if (domainTarget && domainCandidate && domainTarget === domainCandidate) {
    return { match: false, isSameDomain: true, type: MATCH_TYPES.OTHER_DOMAIN_PAGE };
  }

  return { match: false, isSameDomain: false, type: MATCH_TYPES.NOT_FOUND };
}
