/**
 * A location override is scoped to a single Chrome tab. Keep the tab visible
 * for manual verification instead of closing a temporary test page.
 * Do not attach the debugger to arbitrary websites or the entire browser.
 */
const GOOGLE_DOMAINS = new Set([
  'google.com', 'google.co.uk', 'google.ca', 'google.com.au',
  'google.co.in', 'google.de', 'google.fr', 'google.es',
  'google.it', 'google.co.nz', 'google.ie', 'google.com.sg',
  'google.com.mx', 'google.com.br'
]);

export function supportedGoogleDomain(domain) {
  return GOOGLE_DOMAINS.has(domain) ? domain : null;
}

export function isGoogleLocationTab(tab, googleDomain) {
  if (!tab?.id || !tab?.url || !supportedGoogleDomain(googleDomain)) return false;
  try {
    const address = new URL(tab.url);
    return address.protocol === 'https:' &&
      address.hostname.toLowerCase() === 'www.' + googleDomain;
  } catch (_) {
    return false;
  }
}

/**
 * @param {{ searchTabId?: number, googleDomain: string,
 *            tabs: object, navigate: function }} options
 */
export async function getVisibleGoogleLocationTab({ searchTabId, googleDomain, tabs, navigate }) {
  if (!supportedGoogleDomain(googleDomain)) {
    throw new Error('Unsupported Google country domain.');
  }
  if (searchTabId) {
    try {
      const existing = await tabs.get(searchTabId);
      if (isGoogleLocationTab(existing, googleDomain)) {
        await tabs.update(existing.id, { active: true });
        return { tab: existing, created: false };
      }
    } catch (_) {
      // The previous search tab was closed; use a dedicated Google tab.
    }
  }
  const tab = await tabs.create({ url: 'about:blank', active: true });
  try {
    await navigate(tab.id, 'https://www.' + googleDomain +
      '/search?q=' + encodeURIComponent('SERPTrack device location test'));
    return { tab: await tabs.get(tab.id), created: true };
  } catch (error) {
    // A failed navigation must not leave an unused blank tab behind.
    try { await tabs.remove(tab.id); } catch (_) {}
    throw error;
  }
}
