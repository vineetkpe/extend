/**
 * serpParser.js
 * Isolated Google SERP Parser for extracting organic web search results.
 * Runs in the content script context and attaches to window.serpParser.
 */

(function () {
  'use strict';

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
    'div.ou4Vhd',
    // Shopping / Knowledge Panels
    '#kp-wp-tab-overview',
    '.cu-container',
    // Sitelinks containers (to avoid counting sub-links as independent rankings)
    'table.jmvtTe',
    'div.HiHjCd',
    'div.usJj9c',
    'div.MSLdpb',
    'ul.sitelinks'
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
    'youtube.com' // Videos are usually carousels or internal, but keep if user needs regular web; standard practice: ignore google navigation
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
          // If it's google.com/search or google navigation, definitely ignore
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
   * Basic URL simplifier for in-page deduplication
   */
  function quickSimplify(url) {
    try {
      const u = new URL(url);
      let p = u.pathname.toLowerCase();
      if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      return (u.hostname.toLowerCase().replace(/^www\./, '') + p);
    } catch (_) {
      return url.toLowerCase();
    }
  }

  /**
   * Strategy 1: Find candidate organic result blocks in #rso or #search
   */
  function parseWithContainers(rootDoc) {
    const results = [];
    const seenUrls = new Set();

    // Standard primary search container in Google SERP
    const searchRoot = rootDoc.querySelector('#rso') || rootDoc.querySelector('#search') || rootDoc.body;
    if (!searchRoot) return results;

    // Common container selectors across desktop SERP updates
    const containerSelectors = [
      'div.MjjYud',
      'div.g',
      'div.tF2Cxc',
      'div[data-sokoban-container]'
    ];

    const containers = searchRoot.querySelectorAll(containerSelectors.join(', '));

    containers.forEach(container => {
      // Must not be inside ads, local pack, PAA, carousels
      if (isInsideExcluded(container)) return;

      // Find the main title heading (h3) inside this result
      const h3 = container.querySelector('h3');
      if (!h3) return;

      // Make sure the h3 itself isn't in an excluded sub-component
      if (isInsideExcluded(h3)) return;

      // Find associated anchor
      const anchor = h3.closest('a') || container.querySelector('a:has(h3)') || container.querySelector('a');
      if (!anchor || !anchor.href) return;

      const rawUrl = cleanUrl(anchor.href);
      if (!rawUrl || isGoogleInternal(rawUrl)) return;

      const simplified = quickSimplify(rawUrl);
      if (seenUrls.has(simplified)) return;

      seenUrls.add(simplified);
      results.push({
        position: results.length + 1,
        url: rawUrl,
        title: (h3.textContent || '').trim()
      });
    });

    return results;
  }

  /**
   * Strategy 2: Scan all h3 headings inside #rso if Strategy 1 found too few results
   */
  function parseWithHeadings(rootDoc) {
    const results = [];
    const seenUrls = new Set();

    const searchRoot = rootDoc.querySelector('#rso') || rootDoc.querySelector('#search') || rootDoc.body;
    if (!searchRoot) return results;

    const allH3 = searchRoot.querySelectorAll('h3');

    allH3.forEach(h3 => {
      if (isInsideExcluded(h3)) return;

      // Get anchor
      const anchor = h3.closest('a') || h3.querySelector('a');
      if (!anchor || !anchor.href) return;

      const rawUrl = cleanUrl(anchor.href);
      if (!rawUrl || isGoogleInternal(rawUrl)) return;

      const simplified = quickSimplify(rawUrl);
      if (seenUrls.has(simplified)) return;

      seenUrls.add(simplified);
      results.push({
        position: results.length + 1,
        url: rawUrl,
        title: (h3.textContent || '').trim()
      });
    });

    return results;
  }

  /**
   * Main export method: Extracts organic results using cascading strategies
   * @param {Document} doc 
   * @param {boolean} debug 
   * @returns {Array<{ position: number, url: string, title: string }>}
   */
  function extractOrganicResults(doc, debug = false) {
    const rootDoc = doc || document;

    if (debug) {
      console.log('[serpParser] Starting SERP extraction...');
    }

    // Try Strategy 1 first
    let results = parseWithContainers(rootDoc);

    // If Strategy 1 yielded 0 results, fall back to Strategy 2
    if (!results || results.length === 0) {
      if (debug) {
        console.log('[serpParser] Container strategy found 0 results, falling back to H3 heading strategy.');
      }
      results = parseWithHeadings(rootDoc);
    }

    // Re-index positions sequentially 1..N
    results.forEach((item, idx) => {
      item.position = idx + 1;
    });

    if (debug) {
      console.log(`[serpParser] Extracted ${results.length} organic results:`, results);
    }

    return results;
  }

  // Attach to window for content script usage
  window.serpParser = {
    extractOrganicResults,
    isInsideExcluded,
    cleanUrl,
    isGoogleInternal
  };
})();
