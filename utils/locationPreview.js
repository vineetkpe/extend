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
    // The location debugger is only for Google Search, not Maps, Finance,
    // account settings or the Google homepage on the same hostname.
    return address.protocol === 'https:' &&
      address.hostname.toLowerCase() === 'www.' + googleDomain &&
      address.pathname === '/search';
  } catch (_) {
    return false;
  }
}

/**
 * @param {{ searchTabId?: number, googleDomain: string, tabs: object }} options
 * Return new tabs blank: the caller must install X-Geo + CDP GPS BEFORE
 * sending the first Google Search request. Otherwise the user briefly sees
 * their own region's results while the location override is still pending.
 */
export async function getVisibleGoogleLocationTab({ searchTabId, googleDomain, tabs }) {
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
  // Opening a Search URL here would send an unlocalized request before the
  // request-header rule and GPS override exist. Leave the tab blank until
  // activateVisibleGoogleLocation configures both signals.
  const tab = await tabs.create({ url: 'about:blank', active: true });
  return { tab, created: true };
}
