import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleGoogleLocationTab, isGoogleLocationTab, supportedGoogleDomain } from '../utils/locationPreview.js';

test('opens a blank visible tab without searching before the client override', async () => {
  const changes = [];
  const tabs = {
    async create(args) {
      changes.push(['create', args]);
      return { id: 77, url: args.url };
    },
    async get(id) {
      changes.push(['get', id]);
      throw new Error('New preview must not read another tab.');
    },
    async remove(id) { changes.push(['remove', id]); },
    async update(id, args) { changes.push(['update', id, args]); }
  };
  const output = await getVisibleGoogleLocationTab({
    searchTabId: null,
    googleDomain: 'google.co.in',
    tabs
  });
  assert.equal(output.created, true);
  assert.equal(output.tab.id, 77);
  assert.equal(output.tab.url, 'about:blank');
  assert.deepEqual(changes, [['create', { url: 'about:blank', active: true }]],
    'No unlocalized Google Search request is allowed before GPS and X-Geo.');
});

test('reuses same Google domain tab and focuses it instead of closing or navigating', async () => {
  const changes = [];
  const tabs = {
    async get(id) { return { id, url: 'https://www.google.com/search?q=roofing' }; },
    async update(id, args) { changes.push(['update', id, args]); },
    async create() { throw new Error('Must not create tab when existing tab works'); }
  };
  const result = await getVisibleGoogleLocationTab({
    searchTabId: 11, googleDomain: 'google.com', tabs,
    async navigate() { throw new Error('Must not navigate existing search tab'); }
  });
  assert.equal(result.tab.id, 11);
  assert.equal(result.created, false);
  assert.deepEqual(changes, [['update', 11, { active: true }]]);
});

test('never applies Google debugger location to an unrelated external tab', async () => {
  assert.equal(isGoogleLocationTab({ id: 1, url: 'https://example.com/search' }, 'google.com'), false);
  assert.equal(isGoogleLocationTab({ id: 2, url: 'https://www.google.com.evil.com' }, 'google.com'), false);
  assert.equal(isGoogleLocationTab({ id: 3, url: 'http://www.google.com/search' }, 'google.com'), false);
  assert.equal(isGoogleLocationTab({ id: 4, url: 'https://www.google.com/search' }, 'google.com'), true);
  assert.equal(supportedGoogleDomain('evil.example'), null);
});

test('stale tab or another website gets a separate Google-only preview tab', async () => {
  let created = 0;
  const tabs = {
    async get(id) {
      if (id === 4) return { id: 4, url: 'https://example.org/' };
      return { id: 5, url: 'https://www.google.com/search?q=preview' };
    },
    async create() { created++; return { id: 5 }; },
    async remove() {}
  };
  const result = await getVisibleGoogleLocationTab({
    searchTabId: 4, googleDomain: 'google.com', tabs,
    async navigate() {}
  });
  assert.equal(result.created, true);
  assert.equal(created, 1);
  assert.equal(result.tab.id, 5);
});

test('preview allocation never navigates before client coordinates are installed', async () => {
  const calls = [];
  const tabs = {
    async create(args) {
      calls.push(['create', args]);
      return { id: 99, url: args.url };
    },
    async update() { throw new Error('Must not load a search before GPS.'); },
    async remove() { throw new Error('Must not close the user tab.'); }
  };
  const result = await getVisibleGoogleLocationTab({
    searchTabId: null, googleDomain: 'google.com', tabs
  });
  assert.equal(result.tab.url, 'about:blank');
  assert.equal(calls.length, 1);
});


test('only exact Google Search paths qualify for applying client geolocation', () => {
  const allowed = ['google.com', 'google.co.in', 'google.com.br'];
  for (const domain of allowed) {
    const origin = 'https://www.' + domain;
    assert.equal(isGoogleLocationTab({ id: 11, url: origin + '/search?q=dentist' }, domain), true);
    for (const path of ['/', '/maps', '/finance', '/searching?q=dentist', '/search/other']) {
      assert.equal(isGoogleLocationTab({ id: 11, url: origin + path }, domain), false,
        domain + path + ' must not receive Search location debugger');
    }
  }
});

test('malformed country selection is rejected before even opening a blank tab', async () => {
  let calls = 0;
  await assert.rejects(
    () => getVisibleGoogleLocationTab({
      googleDomain: 'google.com.evil.example',
      tabs: { async create() { calls++; } }
    }),
    /Unsupported Google country domain/
  );
  assert.equal(calls, 0);
});
