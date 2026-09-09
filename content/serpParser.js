/**
 * serpParser.js
 * Isolated Google SERP Parser for extracting organic web search results.
 * Runs in the content script context and attaches to window.serpParser.
 */

(function () {
  'use strict';

  // Tracking query parameters to strip when normalizing URLs
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

  // Selectors for elements that must be EXCLUDED from organic ranking
  const EXCLUDED_SELECTORS = [
    '#tads',
    '#bottomads',
    '[data-text-ad]',
    '[aria-label="Ads"]',
    '[aria-label="Sponsored"]',
    '.uEierd',
    '[data-ad-slot]',
    '.commercial-unit-desktop-top',
    '.commercial-unit-desktop-rhs',
    // Local Map Pack
    '#lu_map',
    '.VkpGBb',
    '[data-local-attribute]',
    'div[data-entityid*="local"]',
    '.rllt__link',
    // People Also Ask / Related Questions
    '.related-question-pair',
    'div[data-initq]',
    'div[jsname="yEVEwb"]',
    'div.cbp4De',
    '.exp-c',
    'div[jscontroller="ABbfub"]',
    // Image, Video, News Carousels
    'g-scrolling-carousel',
    'g-section-with-header',
    'video-voyager',
    'div[data-attrid*="image"]',
    'div[data-attrid*="video"]',
    'div[data-attrid*="news"]',
    'div[data-attrid*="forum"]',
    'div.ou4Vhd',
    // Shopping / Knowledge Panels
    '#kp-wp-tab-overview',
    '.cu-container',
    'div[data-attrid*="shopping"]',
    // Sitelinks containers (to avoid counting sub-links as independent rankings)
    'table.jmvtTe',
    'div.HiHjCd',
    'div.usJj9c',
    'div.MSLdpb',
    'ul.sitelinks',
    'div[data-hveid*="sitelink"]'
  ];

  // Domains or paths to ignore (Google internal)
  const IGNORED_DOMAINS = [
    'google.com',
    'google.co.uk',
    'google.co.in',
    'google.com.au',
    'google.ca',
    'google.de',
    'google.fr',
    'accounts.google.',
    'support.google.',
    'maps.google.',
    'news.google.',
    'translate.google.',
    'webcache.googleusercontent.com',
    'policies.google.',
    'www.blogger.com',
    'youtube.com'
  ];

  /**
   * Helper to determine if an element is inside an excluded block (ads, PAA, map pack, etc.)
   */
  function isInsideExcluded(el) {
    if (!el || !(el instanceof Element)) return true;
    for (const selector of EXCLUDED_SELECTORS) {
      if (el.closest(selector)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Decodes Google redirect wrappers (/url?q=... or /url?url=...)
   */
  function cleanUrl(href) {
    if (!href || typeof href !== 'string') return null;
    const trimmed = href.trim();

    if (trimmed.startsWith('/url?') || trimmed.startsWith('https://www.google.') || trimmed.includes('/url?')) {
      try {
        const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://www.google.com${trimmed}`);
        const dest = parsed.searchParams.get('q') || parsed.searchParams.get('url');
        if (dest && /^https?:\/\//i.test(dest)) {
          return dest;
        }
      } catch (_) {
        const match = trimmed.match(/[?&](?:q|url)=(https?%3A%2F%2F[^&]+|https?:\/\/[^&]+)/i);
        if (match && match[1]) {
          try {
            return decodeURIComponent(match[1]);
          } catch (e) {
            return match[1];
          }
        }
      }
    }

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    return null;
  }

  /**
   * Checks if a URL belongs to Google or is non-organic internal navigation
   */
  function isGoogleInternal(url) {
    if (!url) return true;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      for (const ign of IGNORED_DOMAINS) {
        if (host === ign || host.endsWith('.' + ign) || host.includes(ign)) {
          if (host.includes('google.') && (parsed.pathname.startsWith('/search') || parsed.pathname.startsWith('/preferences') || parsed.pathname === '/')) {
            return true;
          }
          if (host.includes('accounts.google') || host.includes('support.google') || host.includes('maps.google') || host.includes('policies.google')) {
            return true;
          }
        }
      }
    } catch (_) {
      return true;
    }
    return false;
  }

  /**
   * Normalizes a URL for comparison and deduplication:
   * Strips protocol, www, trailing slash, fragments, and tracking parameters.
   */
  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    let cleaned = cleanUrl(rawUrl.trim());
    if (!/^https?:\/\//i.test(cleaned)) {
      cleaned = 'https://' + cleaned;
    }

    try {
      const parsed = new URL(cleaned);
      let hostname = parsed.hostname.toLowerCase();
      if (hostname.startsWith('www.')) {
        hostname = hostname.slice(4);
      }

      let pathname = parsed.pathname;
      try {
        pathname = decodeURIComponent(pathname);
      } catch (_) {}
      pathname = pathname.toLowerCase();
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      if (pathname === '/') {
        pathname = '';
      }

      const searchParams = new URLSearchParams(parsed.search);
      const retainedParams = [];
      for (const [key, value] of searchParams.entries()) {
        const lowerKey = key.toLowerCase();
        if (!TRACKING_PARAMS.has(lowerKey) && !lowerKey.startsWith('utm_')) {
          retainedParams.push([lowerKey, value.trim()]);
        }
      }
      retainedParams.sort((a, b) => a[0].localeCompare(b[0]));

      let queryString = '';
      if (retainedParams.length > 0) {
        const cleanParams = new URLSearchParams();
        for (const [k, v] of retainedParams) {
          cleanParams.append(k, v);
        }
        queryString = '?' + cleanParams.toString();
      }

      return `${hostname}${pathname}${queryString}`;
    } catch (_) {
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
   * Strategy 1: Find candidate organic result blocks in #rso or #search
   */
  function parseWithContainers(rootDoc, debugInfo) {
    const results = [];
    const seenNormalized = new Set();

    const searchRoot = rootDoc.querySelector('#rso') || rootDoc.querySelector('#search') || rootDoc.body;
    if (!searchRoot) return results;

    const containerSelectors = [
      'div.MjjYud',
      'div.g',
      'div.tF2Cxc',
      'div[data-sokoban-container]'
    ];

    const containers = searchRoot.querySelectorAll(containerSelectors.join(', '));
    debugInfo.containersFound = containers.length;

    containers.forEach(container => {
      // Must not be inside ads, local pack, PAA, carousels
      if (isInsideExcluded(container)) {
        debugInfo.skippedExcluded++;
        return;
      }

      // Find the main title heading (h3) inside this result
      const h3 = container.querySelector('h3');
      if (!h3) return;

      if (isInsideExcluded(h3)) {
        debugInfo.skippedExcluded++;
        return;
      }

      // Find associated anchor
      const anchor = h3.closest('a') || container.querySelector('a:has(h3)') || container.querySelector('a');
      if (!anchor || !anchor.href) return;

      // Reject sitelinks inside this container
      if (anchor.closest('table.jmvtTe') || anchor.closest('div.HiHjCd') || anchor.closest('div.usJj9c') || anchor.closest('div.MSLdpb')) {
        debugInfo.skippedSitelinks++;
        return;
      }

      const rawUrl = cleanUrl(anchor.href);
      if (!rawUrl || isGoogleInternal(rawUrl)) {
        debugInfo.skippedInternal++;
        return;
      }

      const norm = normalizeUrl(rawUrl);
      if (!norm || seenNormalized.has(norm)) {
        debugInfo.skippedDuplicates++;
        return;
      }

      seenNormalized.add(norm);
      results.push({
        position: results.length + 1,
        url: rawUrl,
        title: (h3.textContent || '').trim(),
        normalizedUrl: norm
      });
    });

    return results;
  }

  /**
   * Strategy 2: Scan all h3 headings inside #rso if Strategy 1 found 0 results
   */
  function parseWithHeadings(rootDoc, debugInfo) {
    const results = [];
    const seenNormalized = new Set();

    const searchRoot = rootDoc.querySelector('#rso') || rootDoc.querySelector('#search') || rootDoc.body;
    if (!searchRoot) return results;

    const allH3 = searchRoot.querySelectorAll('h3');

    allH3.forEach(h3 => {
      if (isInsideExcluded(h3)) {
        debugInfo.skippedExcluded++;
        return;
      }

      const anchor = h3.closest('a') || h3.querySelector('a');
      if (!anchor || !anchor.href) return;

      if (anchor.closest('table.jmvtTe') || anchor.closest('div.HiHjCd') || anchor.closest('div.usJj9c') || anchor.closest('div.MSLdpb')) {
        debugInfo.skippedSitelinks++;
        return;
      }

      const rawUrl = cleanUrl(anchor.href);
      if (!rawUrl || isGoogleInternal(rawUrl)) {
        debugInfo.skippedInternal++;
        return;
      }

      const norm = normalizeUrl(rawUrl);
      if (!norm || seenNormalized.has(norm)) {
        debugInfo.skippedDuplicates++;
        return;
      }

      seenNormalized.add(norm);
      results.push({
        position: results.length + 1,
        url: rawUrl,
        title: (h3.textContent || '').trim(),
        normalizedUrl: norm
      });
    });

    return results;
  }

  /**
   * Main export method: Extracts organic results using cascading strategies
   * @param {Document} doc 
   * @param {object} options { debug: boolean, keyword: string, startOffset: number }
   * @returns {{ results: Array, checkedDepth: number, debugInfo: object }}
   */
  function extractOrganicResults(doc, options = {}) {
    const rootDoc = doc || document;
    const debug = Boolean(options.debug);
    const keyword = options.keyword || '';
    const startOffset = options.startOffset || 0;

    const debugInfo = {
      containersFound: 0,
      skippedExcluded: 0,
      skippedSitelinks: 0,
      skippedInternal: 0,
      skippedDuplicates: 0,
      strategyUsed: 'containers'
    };

    // Try Strategy 1 first
    let results = parseWithContainers(rootDoc, debugInfo);

    // If Strategy 1 yielded 0 results, fall back to Strategy 2
    if (!results || results.length === 0) {
      debugInfo.strategyUsed = 'headings';
      results = parseWithHeadings(rootDoc, debugInfo);
    }

    // Re-index positions sequentially 1..N
    results.forEach((item, idx) => {
      item.position = idx + 1;
    });

    const pageOrganicCount = results.length;
    const finalCheckedDepth = (options.checkedDepth !== undefined && options.checkedDepth !== null)
      ? options.checkedDepth
      : pageOrganicCount;

    // Attach debug helper to window for manual console inspection if debug is true
    if (debug) {
      window.LOCAL_RANK_DEBUG = {
        keyword,
        startOffset,
        checkedDepth: finalCheckedDepth,
        pageOrganicCount,
        parsedResults: results,
        results,
        debugInfo,
        timestamp: new Date().toISOString()
      };
      console.log('[LOCAL_RANK_DEBUG]', window.LOCAL_RANK_DEBUG);
    } else {
      delete window.LOCAL_RANK_DEBUG;
    }

    return {
      results,
      checkedDepth: pageOrganicCount,
      debugInfo
    };
  }

  // Attach to window for content script usage
  window.serpParser = {
    extractOrganicResults,
    isInsideExcluded,
    cleanUrl,
    isGoogleInternal,
    normalizeUrl
  };
})();
