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

/**
 * Extracts destination URL if wrapped in Google redirect (/url?q=... or /url?url=...)
 * @param {string} url 
 * @returns {string} unwrapped URL or original
 */
export function cleanGoogleRedirect(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    if (url.includes('/url?') || url.includes('/url&')) {
      const parsed = new URL(url.startsWith('http') ? url : `https://www.google.com${url}`);
      const dest = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (dest) {
        return dest;
      }
    }
  } catch (e) {
    // If parsing fails, fall back to regex
    const match = url.match(/[?&](?:q|url)=(https?%3A%2F%2F[^&]+|https?:\/\/[^&]+)/i);
    if (match && match[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch (_) {
        return match[1];
      }
    }
  }
  return url;
}

/**
 * Normalizes a URL for comparison:
 * - Trims whitespace
 * - Decodes percent-encoded characters where safe
 * - Normalizes scheme (forces lowercase)
 * - Removes 'www.'
 * - Removes default ports (:80, :443)
 * - Removes trailing slash from path
 * - Strips URL fragments (#...)
 * - Strips common tracking parameters
 * - Sorts remaining query parameters for consistent order
 * 
 * @param {string} rawUrl 
 * @returns {string} normalized URL string
 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';

  let cleaned = cleanGoogleRedirect(rawUrl.trim());

  // Ensure scheme exists for URL parser
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = 'https://' + cleaned;
  }

  try {
    const parsed = new URL(cleaned);

    // 1. Lowercase hostname and remove www.
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    // 2. Normalize pathname: lowercase, decode safely, strip trailing slash
    let pathname = parsed.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch (_) {
      // Keep as-is if malformed percent encoding
    }
    pathname = pathname.toLowerCase();
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    // If pathname is just '/', normalize to empty string for root domain
    if (pathname === '/') {
      pathname = '';
    }

    // 3. Filter query parameters
    const searchParams = new URLSearchParams(parsed.search);
    const retainedParams = [];
    for (const [key, value] of searchParams.entries()) {
      const lowerKey = key.toLowerCase();
      if (!TRACKING_PARAMS.has(lowerKey) && !lowerKey.startsWith('utm_')) {
        retainedParams.push([lowerKey, value.trim()]);
      }
    }

    // Sort query parameters alphabetically
    retainedParams.sort((a, b) => a[0].localeCompare(b[0]));

    let queryString = '';
    if (retainedParams.length > 0) {
      const cleanParams = new URLSearchParams();
      for (const [k, v] of retainedParams) {
        cleanParams.append(k, v);
      }
      queryString = '?' + cleanParams.toString();
    }

    // Return hostname + path + query (without protocol or www)
    return `${hostname}${pathname}${queryString}`;
  } catch (err) {
    // Basic fallback string cleanup if URL constructor fails
    let fallback = cleaned
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('#')[0]
      .split('?')[0]
      .trim()
      .toLowerCase();
    if (fallback.endsWith('/')) {
      fallback = fallback.slice(0, -1);
    }
    return fallback;
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
