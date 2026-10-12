/**
 * Google Search's X-Geo device-location hint, based on the technique used by
 * GS Location Changer. Unlike that extension's browser-wide rule, SERPTrack
 * scopes its header to ONE managed Google Search tab and one allowed domain.
 *
 * This is a server-side location hint, not proof of Google's ranking region.
 * A separate CDP geolocation override and page-coordinate verification still
 * gate any claimed client-location rank.
 */
import { validateCoordinates } from './locationValidator.js';
import { supportedGoogleDomain } from './locationPreview.js';

export const SEARCH_LOCATION_RULE_ID = 9831;

export function buildGoogleXGeoHeader(location) {
  const validated = validateCoordinates(
    location?.latitude, location?.longitude, location?.accuracy
  );
  if (!validated.valid) throw new Error(validated.error);
  // E7 integer coordinates. Do not use an OR-default idiom in the reference
  // extension: 0 latitude or 0 longitude are legitimate.
  const latE7 = Math.round(validated.latitude * 1e7);
  const lonE7 = Math.round(validated.longitude * 1e7);
  const value = [
    'role: CURRENT_LOCATION',
    'producer: DEVICE_LOCATION',
    'radius: 65000',
    'latlng <',
    ' latitude_e7: ' + latE7,
    ' longitude_e7: ' + lonE7,
    '>'
  ].join('\n');
  return 'a ' + btoa(value);
}

export function makeScopedSearchLocationRule(tabId, googleDomain, location) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) {
    throw new Error('Client location needs an existing Google Search tab.');
  }
  const domain = supportedGoogleDomain(googleDomain);
  if (!domain) throw new Error('Unsupported Google Search country domain.');
  const escapedDomain = domain.replaceAll('.', '\\.');
  return {
    id: SEARCH_LOCATION_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{
        header: 'x-geo',
        operation: 'set',
        value: buildGoogleXGeoHeader(location)
      }]
    },
    condition: {
      regexFilter: '^https://www\\.' + escapedDomain + '/search(?:\\?|$)',
      resourceTypes: ['main_frame'],
      tabIds: [tabId]
    }
  };
}

export async function applyScopedSearchLocation(dnr, tabId, googleDomain, location) {
  if (!dnr?.updateSessionRules || !dnr?.getSessionRules) {
    throw new Error('Chrome Google Search location-header permission is missing. Reload the extension.');
  }
  const rule = makeScopedSearchLocationRule(tabId, googleDomain, location);
  await dnr.updateSessionRules({
    removeRuleIds: [SEARCH_LOCATION_RULE_ID],
    addRules: [rule]
  });
  const installed = (await dnr.getSessionRules())
    .find(candidate => candidate.id === SEARCH_LOCATION_RULE_ID);
  if (!installed || installed.action?.requestHeaders?.[0]?.value !==
      rule.action.requestHeaders[0].value ||
      installed.condition?.tabIds?.[0] !== tabId ||
      installed.condition?.regexFilter !== rule.condition.regexFilter) {
    throw new Error('Chrome did not confirm the client-only Google Search location header.');
  }
  return rule;
}

export async function clearScopedSearchLocation(dnr) {
  if (dnr?.updateSessionRules) {
    await dnr.updateSessionRules({ removeRuleIds: [SEARCH_LOCATION_RULE_ID] });
  }
}
