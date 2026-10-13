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

function googleLocationPoint(location) {
  const validated = validateCoordinates(
    location?.latitude, location?.longitude, location?.accuracy
  );
  if (!validated.valid) throw new Error(validated.error);
  return validated;
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-').replaceAll('/', '_');
}

function protobufVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n !== 0n) byte |= 128;
    bytes.push(byte);
  } while (n !== 0n);
  return bytes;
}

function fixed32Bytes(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setInt32(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

function float32Bytes(value) {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

/**
 * Current Chromium X-Geo format is "w " + base64url protobuf LocationDescriptor.
 * Fields: role=1, producer=12, timestamp micros, latlng{sfixed32 E7}
 * and radius in millimeters. Earlier SERPTrack sent a legacy text "a "
 * descriptor that some current Google Search paths may ignore.
 */
export function buildGoogleXGeoHeader(location, nowMs = Date.now()) {
  const point = googleLocationPoint(location);
  const latlng = [
    0x0d, ...fixed32Bytes(Math.round(point.latitude * 1e7)),
    0x15, ...fixed32Bytes(Math.round(point.longitude * 1e7))
  ];
  const bytes = [
    0x08, 0x01,  // role: CURRENT_LOCATION
    0x10, 0x0c,  // producer: DEVICE_LOCATION
    0x18, ...protobufVarint(BigInt(nowMs) * 1000n), // timestamp microseconds
    0x2a, latlng.length, ...latlng, // field 5, LatLng
    0x3d, ...float32Bytes(point.accuracy * 1000) // field 7, radius mm
  ];
  return 'w ' + base64Url(bytes);
}

/**
 * Google Search's coordinate-based UULE a+ form supplements X-Geo. It is
 * included in EACH client-located Search request (including pagination),
 * avoiding reliance on an older UULE cookie from the user's own location.
 * URL serialization uses the literal '+' separator, not '%2B'.
 */
export function buildCoordinateUule(location, nowMs = Date.now()) {
  const point = googleLocationPoint(location);
  const text = [
    'role:1',
    'producer:12',
    'provenance:6',
    'timestamp:' + (BigInt(nowMs) * 1000n),
    'latlng{',
    'latitude_e7:' + Math.round(point.latitude * 1e7),
    'longitude_e7:' + Math.round(point.longitude * 1e7),
    '}',
    'radius:' + Math.round(point.accuracy * 1000)
  ].join(' ');
  return 'a+' + btoa(text);
}

const SEARCH_COUNTRY = Object.freeze({
  'google.co.uk': 'gb', 'google.ca': 'ca', 'google.com.au': 'au',
  'google.co.in': 'in', 'google.de': 'de', 'google.fr': 'fr',
  'google.es': 'es', 'google.it': 'it', 'google.co.nz': 'nz',
  'google.ie': 'ie', 'google.com.sg': 'sg', 'google.com.mx': 'mx',
  'google.com.br': 'br'
});

/** Add client location to one eligible Search URL; never modify other sites. */
export function withClientSearchLocation(rawUrl, googleDomain, location, nowMs = Date.now()) {
  const domain = supportedGoogleDomain(googleDomain);
  if (!domain) throw new Error('Unsupported Google Search country domain.');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.' + domain ||
      url.pathname !== '/search') {
    throw new Error('Client location URL must be on the selected Google Search page.');
  }
  // URLSearchParams treats + as a space. Store 'a ' so the serialized request
  // carries 'uule=a+...' rather than an encoded %2B prefix.
  const uule = buildCoordinateUule(location, nowMs);
  url.searchParams.set('uule', 'a ' + uule.slice(2));
  url.searchParams.set('pws', '0');
  if (SEARCH_COUNTRY[domain]) url.searchParams.set('gl', SEARCH_COUNTRY[domain]);
  else url.searchParams.delete('gl'); // google.com is not necessarily a US client
  return url.toString();
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
