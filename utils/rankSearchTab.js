/**
 * Only use a Chrome tab for rank checks while it remains on the exact
 * supported Google Search host/path. A previously saved tab may have been
 * navigated by the user to an unrelated website, Maps, or another country.
 * Never overwrite such a tab with a client keyword search.
 */
import { supportedGoogleDomain } from './locationPreview.js';

export function isReusableRankSearchTab(tab, googleDomain) {
  if (!Number.isSafeInteger(tab?.id) || tab.id <= 0 ||
      typeof tab.url !== 'string' || !supportedGoogleDomain(googleDomain)) {
    return false;
  }
  try {
    const url = new URL(tab.url);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'www.' + googleDomain &&
      url.pathname === '/search' &&
      !url.username && !url.password && !url.port;
  } catch (_) {
    return false;
  }
}

/**
 * Reuse only the remembered Google Search tab. Do not touch user-navigated
 * tabs; open a new dedicated Search page on the selected country domain.
 * The initial query is fixed and contains no client data. The rank-checker
 * navigates this new tab to the real keyword only after its location guard.
 */
export async function getSafeRankSearchTab({ existingTabId, googleDomain, tabs }) {
  if (!supportedGoogleDomain(googleDomain)) {
    throw new Error('Unsupported Google Search country domain.');
  }

  if (Number.isSafeInteger(existingTabId) && existingTabId > 0) {
    try {
      const existing = await tabs.get(existingTabId);
      if (isReusableRankSearchTab(existing, googleDomain)) return existing;
    } catch (_) {
      // The saved tab was closed or inaccessible; use a new Search tab.
    }
  }

  return tabs.create({
    url: 'https://www.' + googleDomain +
      '/search?q=' + encodeURIComponent('SERPTrack search ready'),
    active: true
  });
}
