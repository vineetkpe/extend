import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_LOCATION_RULE_ID, buildGoogleXGeoHeader, buildCoordinateUule,
  withClientSearchLocation, makeScopedSearchLocationRule, applyScopedSearchLocation,
  clearScopedSearchLocation
} from '../utils/googleSearchLocationSignal.js';

function decode(header) {
  assert.match(header, /^w /);
  const encoded = header.slice(2).replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

function readVarint(bytes, start) {
  let number = 0n;
  let shift = 0n;
  let index = start;
  while (true) {
    const part = bytes[index++];
    number |= BigInt(part & 127) << shift;
    if (!(part & 128)) break;
    shift += 7n;
  }
  return { value: number, next: index };
}

test('modern X-Geo is valid Chromium protobuf with the exact requested client coordinates', () => {
  const bytes = decode(buildGoogleXGeoHeader({
    latitude: 39.7946857, longitude: -105.0654264, accuracy: 20
  }, 1728720000000));
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [8, 1, 16, 12],
    'Role and producer match Chromium LocationDescriptor');
  assert.equal(bytes[4], 24, 'Timestamp field is varint 3');
  const timestamp = readVarint(bytes, 5);
  assert.equal(timestamp.value, 1728720000000000n);
  assert.equal(bytes[timestamp.next], 42, 'Field 5 embeds LatLng');
  assert.equal(bytes[timestamp.next + 1], 10, 'Two signed fixed32 coordinates');
  const latlng = bytes.slice(timestamp.next + 2);
  assert.equal(latlng[0], 13);
  const view = new DataView(latlng.buffer, latlng.byteOffset, latlng.byteLength);
  assert.equal(view.getInt32(1, true), 397946857);
  assert.equal(latlng[5], 21);
  assert.equal(view.getInt32(6, true), -1050654264);
  assert.equal(latlng[10], 61, 'Field 7 is float radius in millimeters');
  assert.equal(view.getFloat32(11, true), 20000);
});

test('zero coordinates are encoded as actual client location, not default GPS', () => {
  const bytes = decode(buildGoogleXGeoHeader({ latitude: 0, longitude: 0 }, 1728720000000));
  const marker = bytes.indexOf(42);
  const coordinates = new DataView(bytes.buffer, marker + 2);
  assert.equal(coordinates.getInt32(1, true), 0);
  assert.equal(coordinates.getInt32(6, true), 0);
});

test('client Search header is tab-scoped and restricted to exact Google Search URL', () => {
  for (const domain of ['google.com', 'google.co.in', 'google.co.uk', 'google.com.br']) {
    const rule = makeScopedSearchLocationRule(33, domain, {
      latitude: 39.7946857, longitude: -105.0654264
    });
    assert.equal(rule.id, SEARCH_LOCATION_RULE_ID);
    assert.equal(rule.action.type, 'modifyHeaders');
    assert.deepEqual(rule.condition.tabIds, [33]);
    assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    assert.equal(rule.action.requestHeaders[0].header, 'x-geo');
    const pattern = new RegExp(rule.condition.regexFilter);
    assert.equal(pattern.test('https://www.' + domain + '/search?q=client'), true);
    for (const url of [
      'https://www.' + domain + '/maps?q=client',
      'https://www.' + domain + '/searching?q=client',
      'https://www.' + domain + '/search/elsewhere',
      'https://www.' + domain + '.evil.org/search?q=client',
      'https://www.google.com.evil.org/search?q=client',
      'http://www.' + domain + '/search?q=client',
      'https://example.com/search?q=client'
    ]) {
      assert.equal(pattern.test(url), false, url);
    }
  }
});

test('reject invalid coordinates, untrusted Google domains, and invalid tab IDs', () => {
  for (const point of [
    { latitude: '', longitude: 5 }, { latitude: 91, longitude: 1 },
    { latitude: 23, longitude: 181 }, { latitude: NaN, longitude: 8 }
  ]) assert.throws(() => buildGoogleXGeoHeader(point));
  assert.throws(() => makeScopedSearchLocationRule(0, 'google.com', {
    latitude: 2, longitude: 3
  }), /existing Google Search tab/);
  assert.throws(() => makeScopedSearchLocationRule(5, 'google.com.attacker.example', {
    latitude: 2, longitude: 3
  }), /Unsupported Google Search country domain/);
});

test('installing client location replaces prior tab, country and coordinates, with no local data', async () => {
  let rules = [];
  const edits = [];
  const dnr = {
    async updateSessionRules({ removeRuleIds, addRules = [] }) {
      edits.push({ removeRuleIds, addRules });
      rules = rules.filter(r => !removeRuleIds.includes(r.id)).concat(addRules);
    },
    async getSessionRules() { return structuredClone(rules); }
  };
  const first = await applyScopedSearchLocation(dnr, 77, 'google.com', {
    latitude: 28.6139, longitude: 77.209
  });
  assert.deepEqual(rules, [first]);
  const second = await applyScopedSearchLocation(dnr, 88, 'google.co.in', {
    latitude: 19.076, longitude: 72.8777
  });
  assert.deepEqual(rules, [second], 'Old client tab no longer gets injected headers');
  assert.equal(edits[1].removeRuleIds[0], SEARCH_LOCATION_RULE_ID);
  assert.deepEqual(second.condition.tabIds, [88]);
  assert.equal(new RegExp(second.condition.regexFilter).test(
    'https://www.google.co.in/search?q=another+client'), true);
  assert.notEqual(second.action.requestHeaders[0].value, first.action.requestHeaders[0].value);
  await clearScopedSearchLocation(dnr);
  assert.deepEqual(rules, [], 'Reset removes every client-location rule');
});

test('missing rule API and rule not retained by Chrome are explicit failures', async () => {
  await assert.rejects(() => applyScopedSearchLocation(null, 5, 'google.com', {
    latitude: 1, longitude: 2
  }), /permission is missing/);
  const dropping = {
    async updateSessionRules() {},
    async getSessionRules() { return []; }
  };
  await assert.rejects(() => applyScopedSearchLocation(dropping, 5, 'google.com', {
    latitude: 1, longitude: 2
  }), /did not confirm/);
});


test('manifest grants only Google hosts and per-tab network-header capability', async () => {
  const fs = await import('node:fs');
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.equal(manifest.host_permissions.every(host => host.startsWith('https://www.google.')), true);
  assert.equal(manifest.permissions.includes('cookies'), false,
    'Do not modify or read unrelated browser cookies');
  assert.equal(manifest.permissions.includes('webRequestBlocking'), false,
    'Do not use browser-wide request interception');
});


test('each Google Search request carries explicit client UULE and selected country', () => {
  const point = { latitude: 39.7946857, longitude: -105.0654264, accuracy: 20 };
  const token = buildCoordinateUule(point, 1728720000000);
  assert.match(token, /^a\+/);
  const decoded = atob(token.slice(2));
  assert.match(decoded, /role:1 producer:12 provenance:6/);
  assert.match(decoded, /timestamp:1728720000000000/);
  assert.match(decoded, /latitude_e7:397946857/);
  assert.match(decoded, /longitude_e7:-1050654264/);
  const url = withClientSearchLocation(
    'https://www.google.co.in/search?q=roof+repair&start=10',
    'google.co.in', point, 1728720000000
  );
  assert.match(url, /[?&]uule=a\+/);
  assert.equal(new URL(url).searchParams.get('uule'), 'a ' + token.slice(2));
  assert.equal(new URL(url).searchParams.get('gl'), 'in');
  assert.equal(new URL(url).searchParams.get('pws'), '0');
  assert.equal(new URL(url).searchParams.get('q'), 'roof repair');
  assert.equal(new URL(url).searchParams.get('start'), '10');
});

test('google.com does not incorrectly force USA when client coordinates are elsewhere', () => {
  const url = withClientSearchLocation(
    'https://www.google.com/search?q=local+bakery&gl=us',
    'google.com', { latitude: 28.6139, longitude: 77.209 }, 1728720000000
  );
  assert.equal(new URL(url).searchParams.has('gl'), false);
  assert.match(url, /uule=a\+/);
});

test('switching client coordinates replaces old UULE rather than leaving the old location', () => {
  const first = withClientSearchLocation(
    'https://www.google.com/search?q=seo',
    'google.com', { latitude: 39.7946857, longitude: -105.0654264 }, 1728720000000
  );
  const second = withClientSearchLocation(
    first, 'google.com', { latitude: 28.6139, longitude: 77.209 }, 1728720000000
  );
  const uule = new URL(second).searchParams.get('uule');
  assert.equal(new URL(second).searchParams.getAll('uule').length, 1);
  assert.match(atob(uule.slice(2)), /latitude_e7:286139000/);
  assert.doesNotMatch(atob(uule.slice(2)), /397946857/);
});

test('the UULE helper refuses arbitrary URLs and invalid coordinate pairs', () => {
  for (const rawUrl of [
    'https://example.com/search?q=x',
    'https://www.google.com.evil.test/search?q=x',
    'https://www.google.com/maps?q=x',
    'http://www.google.com/search?q=x'
  ]) {
    assert.throws(() => withClientSearchLocation(rawUrl,
      'google.com', { latitude: 1, longitude: 2 }), /selected Google Search/);
  }
  assert.throws(() => withClientSearchLocation(
    'https://www.google.com/search?q=x', 'google.com',
    { latitude: '', longitude: 1 }), /Latitude is required/);
});
