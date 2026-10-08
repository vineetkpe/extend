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

  // Rank only standalone organic web listings, not "universal"/SERP modules.
  // These selectors are intentionally applied to the heading's ancestors:
  // links cited INSIDE an AI Overview or news carousel are NOT organic ranks.
  // Keep this list narrow enough to retain legitimate standalone web listings.
  const EXCLUDED_SELECTORS = [
    // AI Overviews / AI-generated answer cards and their citation links
    '#m-x-content',
    '#m-x-root',
    '#ai-overview',
    '#aic',
    '.M8OgIe',
    // Additional rendered AIO wrappers used by newer SERP variants
    '.Kevs9',
    'div[jsname="dvXlsc"]',
    '[data-testid="ai-overview"]',
    '[data-module-type="ai-overview"]',
    '[data-async-context*="ai_overview"]',
    '[data-rl="ai_overview"]',
    '[data-attrid*="generative"]',
    '[data-attrid*="ai_overview"]',
    '[data-attrid*="ai-overview"]',
    '[aria-label*="AI Overview"]',
    '[aria-label*="AI overview"]',
    '[aria-label*="AI-generated"]',
    // Non-result page areas
    '#rhs',
    '#taw',
    '#botstuff',
    '[aria-hidden="true"]',
    '[hidden]',
    '#tads',
    '#bottomads',
    '[data-text-ad]',
    '[aria-label="Ads"]',
    '[aria-label="Sponsored"]',
    '[aria-label*="Sponsored"]',
    '[aria-label*="Advertisement"]',
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
    '[aria-label*="Places"]',
    '[aria-label*="Local results"]',
    '[data-attrid*="local_pack"]',
    // People Also Ask / Related Questions
    '.related-question-pair',
    'div[data-initq]',
    'div[jsname="yEVEwb"]',
    'div.cbp4De',
    '.exp-c',
    'div[jscontroller="ABbfub"]',
    '[aria-label*="People also ask"]',
    '[aria-label*="People Also Ask"]',
    '[aria-label*="Related questions"]',
    '[data-attrid*="people_also_ask"]',
    // Image, Video, News Carousels
    'g-scrolling-carousel',
    'g-section-with-header',
    'video-voyager',
    '#videobox',
    '#imagebox_bigimages',
    '[aria-label*="Top stories"]',
    '[aria-label*="Top Stories"]',
    '[aria-label*="Short videos"]',
    '[aria-label*="Videos"]',
    '[aria-label*="Images"]',
    '[aria-label*="Discussions and forums"]',
    '[aria-label*="Perspectives"]',
    '[aria-label*="Things to know"]',
    '[aria-label*="Popular products"]',
    '[aria-label*="Shopping"]',
    '[aria-label*="Related searches"]',
    '[aria-label*="What people are saying"]',
    '[data-attrid*="top_stories"]',
    '[data-attrid*="short_video"]',
    'div[data-attrid*="image"]',
    'div[data-attrid*="video"]',
    'div[data-attrid*="news"]',
    'div[data-attrid*="forum"]',
    'div.ou4Vhd',
    // Shopping / Knowledge Panels
    '#kp-wp-tab-overview',
    '#rhs',
    '[data-attrid*="knowledge"]',
    '.cu-container',
    'div[data-attrid*="shopping"]',
    // Sitelinks containers (to avoid counting sub-links as independent rankings)
    'table.jmvtTe',
    'div.HiHjCd',
    'div.usJj9c',
    'div.MSLdpb',
    'ul.sitelinks',
    '[data-testid="sitelinks"]',
    '[aria-label*="Sitelinks"]',
    '[aria-label*="Site links"]',
    'div[data-hveid*="sitelink"]'
  ];

  // Only filter internal links on genuine Google hosts, not third-party URLs
  // containing the string "google" (or organic YouTube results).
  const GOOGLE_SEARCH_DOMAINS = [
    'google.com', 'google.co.uk', 'google.co.in', 'google.com.au',
    'google.ca', 'google.de', 'google.fr', 'google.es', 'google.it',
    'google.co.nz', 'google.ie', 'google.com.sg', 'google.com.mx',
    'google.com.br'
  ];
  const GOOGLE_SERVICE_PREFIXES = [
    'accounts.google.', 'support.google.', 'maps.google.',
    'news.google.', 'translate.google.', 'policies.google.'
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
   * A result title needs to be rendered, not hidden in a collapsed,
   * preloaded or cloned SERP component. A hidden h3 cannot consume a
   * visible organic position.
   */
  function isRenderedHeading(heading) {
    if (typeof heading.getClientRects === 'function' && heading.getClientRects().length === 0) {
      return false;
    }
    if (typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(heading);
      if (style && (style.display === 'none' || style.visibility === 'hidden' ||
                    style.visibility === 'collapse')) return false;
    }
    return true;
  }

  /**
   * Some AI Overview citation panels do not carry stable class names. An
   * explicit AI Overview heading in that SAME result-region wrapper is a
   * structural signal. Do not inspect parents beyond the nearest bounded
   * region, otherwise the whole results page could be falsely excluded.
   */
  function isInLabeledAIPanel(heading) {
    const card = heading.closest('.MjjYud') || heading.closest('[role="region"]');
    if (!card) return false;
    const label = card.querySelector('h2') ||
      card.querySelector('[aria-label="AI Overview"]');
    return Boolean(label && /^AI Overview\b/i.test((label.textContent || '').trim()));
  }

  /**
   * Unwraps Google's /url?q= redirect only when it actually comes from Google.
   * Rejects unresolvable redirects rather than accidentally ranking google.com.
   */
  function cleanUrl(href) {
    if (!href || typeof href !== 'string') return null;
    const trimmed = href.trim();
    try {
      const relativeRedirect = trimmed.startsWith('/url?');
      if (!relativeRedirect && !/^https?:\/\//i.test(trimmed)) return null;
      const parsed = new URL(trimmed, relativeRedirect ? 'https://www.google.com' : undefined);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      const hostname = parsed.hostname.toLowerCase();
      const isSearchHost = GOOGLE_SEARCH_DOMAINS.some(domain =>
        hostname === domain || hostname === `www.${domain}`
      );
      if (parsed.pathname === '/url' && (relativeRedirect || isSearchHost)) {
        const destination = parsed.searchParams.get('q') || parsed.searchParams.get('url');
        if (!destination || !/^https?:\/\//i.test(destination)) return null;
        const resolved = new URL(destination);
        return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : null;
      }
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  /**
   * Excludes Google navigation/challenge links without suppressing legitimate
   * third-party organic results such as YouTube videos.
   */
  function isGoogleInternal(url) {
    if (!url) return true;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (GOOGLE_SERVICE_PREFIXES.some(prefix => host.startsWith(prefix))) {
        return true;
      }
      const searchHost = GOOGLE_SEARCH_DOMAINS.some(domain =>
        host === domain || host === `www.${domain}`
      );
      if (!searchHost) return false;
      return parsed.pathname === '/' ||
        ['/search', '/url', '/preferences', '/sorry', '/advanced_search']
          .some(path => parsed.pathname === path || parsed.pathname.startsWith(path + '/'));
    } catch (_) {
      return true;
    }
  }

  /**
   * Normalizes a URL for comparison and deduplication:
   * Strips protocol, www, trailing slash, fragments, and tracking parameters.
   */
  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    // Normalization also supports plain domain/path inputs from manual checks.
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed
      : (/^[a-z0-9.-]+(?:\/|$)/i.test(trimmed) ? 'https://' + trimmed : '');
    const cleaned = cleanUrl(candidate);
    if (!cleaned) return '';

    try {
      const parsed = new URL(cleaned);
      let hostname = parsed.hostname.toLowerCase();
      if (hostname.startsWith('www.')) {
        hostname = hostname.slice(4);
      }
      // Keep non-default ports so deduplication matches the background matcher.
      if (parsed.port) hostname += ':' + parsed.port;

      // Paths may be case-sensitive. Preserve their escaped representation too:
      // /a%2Fb is not necessarily the same resource as /a/b.
      let pathname = parsed.pathname;
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
          // Parameter names and values can be significant to the server.
          retainedParams.push([key, value]);
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
      // Never guess a result identity from a URL that cannot be parsed.
      return '';
    }
  }

  /**
   * Single DOM-order pass over title links. The previous container-first strategy
   * only considered the headings fallback if it found ZERO results, which silently
   * missed valid results in mixed Google layouts. It also selected the first h3
   * from outer wrapper containers that may contain multiple results.
   */
  function parseOrganicHeadings(rootDoc, debugInfo) {
    const results = [];
    const seenNormalized = new Set();
    const countedResultContainers = new Set();
    // Google changes the main results wrapper. #center_col is a
    // results-only, bounded fallback; NEVER scan the full document.
    // Prefer the most specific root, but try the next wrapper if it contains
    // no validated organic listings (e.g. an AI-only #rso).
    const roots = ['#rso', '#search', '#center_col']
      .map(selector => ({ selector, node: rootDoc.querySelector(selector) }))
      .filter(candidate => candidate.node);
    if (!roots.length) {
      debugInfo.missingResultsRoot = true;
      return results;
    }

    for (const candidate of roots) {
    const headings = candidate.node.querySelectorAll('h3');
    debugInfo.headingsFound += headings.length;
    debugInfo.rootUsed = candidate.selector;
    for (const heading of headings) {
      if (isInsideExcluded(heading) || isInLabeledAIPanel(heading)) {
        debugInfo.skippedExcluded++;
        continue;
      }
      if (!isRenderedHeading(heading)) {
        debugInfo.skippedHidden++;
        continue;
      }
      // A traditional .g web-result block has ONE primary organic listing.
      // Its extra h3 headings (unknown sitelink designs, related links) must
      // not create extra organic ranks even if they point to a different URL.
      const resultContainer = heading.closest('.g');
      if (resultContainer && countedResultContainers.has(resultContainer)) {
        debugInfo.skippedSecondaryLinks++;
        continue;
      }
      const anchor = heading.closest('a') || heading.querySelector('a');
      if (!anchor || isInsideExcluded(anchor)) {
        debugInfo.skippedExcluded++;
        continue;
      }
      const destination = cleanUrl(anchor.href);
      if (!destination || isGoogleInternal(destination)) {
        debugInfo.skippedInternal++;
        continue;
      }
      const normalizedUrl = normalizeUrl(destination);
      if (!normalizedUrl || seenNormalized.has(normalizedUrl)) {
        debugInfo.skippedDuplicates++;
        continue;
      }
      seenNormalized.add(normalizedUrl);
      if (resultContainer) countedResultContainers.add(resultContainer);
      results.push({
        position: results.length + 1,
        url: destination,
        title: (heading.textContent || '').trim(),
        normalizedUrl
      });
    }
    if (results.length > 0) break;
    }
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
      headingsFound: 0,
      missingResultsRoot: false,
      skippedExcluded: 0,
      skippedSitelinks: 0,
      skippedInternal: 0,
      skippedDuplicates: 0,
      skippedSecondaryLinks: 0,
      skippedHidden: 0,
      rootUsed: null,
      countingPolicy: 'strict-organic-web-v2',
      strategyUsed: 'headings-dom-order'
    };

    const results = parseOrganicHeadings(rootDoc, debugInfo);

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
        // Exact ordered URL list lets a tester compare rank #1, #2 etc.
        // against the same loaded Google results page.
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
