import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_LOCATION_RULE_ID, buildGoogleXGeoHeader,
  makeScopedSearchLocationRule, applyScopedSearchLocation,
  clearScopedSearchLocation
} from '../utils/googleSearchLocationSignal.js';

function decode(header) {
  assert.match(header, /^a /);
  return atob(header.slice(2));
}

test('X-Geo contains the requested client coordinates as E7 integers', () => {
  const header = buildGoogleXGeoHeader({
    latitude: 39.7946857, longitude: -105.0654264, accuracy: 20
  });
  const decoded = decode(header);
  assert.match(decoded, /^role: CURRENT_LOCATION\nproducer: DEVICE_LOCATION\nradius: 65000\n/);
  assert.match(decoded, /latitude_e7: 397946857/);
  assert.match(decoded, /longitude_e7: -1050654264/);
});

test('equator and prime-meridian coordinates do not fall back to somebody else location', () => {
  const decoded = decode(buildGoogleXGeoHeader({ latitude: 0, longitude: 0 }));
  assert.match(decoded, /latitude_e7: 0\n/);
  assert.match(decoded, /longitude_e7: 0\n/);
  assert.doesNotMatch(decoded, /525109360|134104990/);
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
