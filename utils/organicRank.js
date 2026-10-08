/**
 * One position equals one visible standalone organic web listing.
 * In particular, seeing the same URL on *different* Google result pages
 * is not grounds to remove its listing slot from the organic rank count.
 * Content script excludes AI citations, sitelinks and SERP feature modules.
 */
import { normalizeUrl } from './urlNormalizer.js';

export const ORGANIC_COUNTING_POLICY = 'strict-organic-web-v1';

export function prepareOrganicPage(pageResults, previouslySeen = [], startOffset = 0) {
  if (!Array.isArray(pageResults) || !pageResults.length) {
    return { ok: false, reason: 'EMPTY_ORGANIC_PAGE' };
  }
  const prior = new Set(previouslySeen);
  const inPage = new Set();
  const listings = [];
  let repeatedFromPreviousPage = 0;
  let skippedDuplicatesOnPage = 0;
  for (const result of pageResults) {
    const url = typeof result?.url === 'string' ? result.url : '';
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return { ok: false, reason: 'INVALID_ORGANIC_URL' };
    }
    if (inPage.has(normalizedUrl)) {
      skippedDuplicatesOnPage++;
      continue;
    }
    inPage.add(normalizedUrl);
    if (prior.has(normalizedUrl)) repeatedFromPreviousPage++;
    listings.push({
      url,
      title: typeof result.title === 'string' ? result.title : '',
      normalizedUrl
    });
  }

  if (!listings.length) return { ok: false, reason: 'EMPTY_ORGANIC_PAGE' };
  if (startOffset > 0 && repeatedFromPreviousPage === listings.length) {
    // Google may ignore ?start= pagination. Replaying that page would produce
    // falsely confident results; fail closed rather than manufacture ranks.
    return { ok: false, reason: 'REPEATED_SERP_PAGE' };
  }

  return {
    ok: true,
    listings,
    repeatedFromPreviousPage,
    skippedDuplicatesOnPage
  };
}
