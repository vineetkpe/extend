import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleGoogleLocationTab, isGoogleLocationTab, supportedGoogleDomain } from '../utils/locationPreview.js';

test('opens and retains a visible Google Search tab for the requested domain', async () => {
  const changes = [];
  const tabs = {
    async create(args) {
      changes.push(['create', args]);
      return { id: 77, url: args.url };
    },
    async get(id) { return { id, url: 'https://www.google.co.in/search?q=SERPTrack' }; },
    async remove(id) { changes.push(['remove', id]); },
    async update(id, args) { changes.push(['update', id, args]); }
  };
  const output = await getVisibleGoogleLocationTab({
    searchTabId: null,
    googleDomain: 'google.co.in',
    tabs,
    async navigate(id, url) { changes.push(['navigate', id, url]); }
  });
  assert.equal(output.created, true);
  assert.equal(output.tab.id, 77);
  assert.deepEqual(changes[0], ['create', { url: 'about:blank', active: true }]);
  assert.match(changes[1][2], /^https:\/\/www\.google\.co\.in\/search\?/);
  assert.equal(changes.some(row => row[0] === 'remove'), false);
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

test('failed navigation closes only the newly-created blank tab', async () => {
  const closed = [];
  const tabs = {
    async create() { return { id: 99 }; },
    async remove(id) { closed.push(id); }
  };
  await assert.rejects(
    () => getVisibleGoogleLocationTab({
      searchTabId: null, googleDomain: 'google.com', tabs,
      async navigate() { throw new Error('navigation failed'); }
    }),
    /navigation failed/
  );
  assert.deepEqual(closed, [99]);
});


test('only Google Search paths qualify for a reusable location-preview tab', () => {
  for (const domain of ['google.com', 'google.co.in', 'google.com.br']) {
    const origin = 'https://www.' + domain;
    for (const suffix of [
      '/', '/maps', '/maps/place/Delhi', '/finance', '/preferences',
      '/account', '/url?q=https%3A%2F%2Fexample.com',
      '/searching?q=dentist', '/search/other', '/SEARCH?q=dentist'
    ]) {
      assert.equal(
        isGoogleLocationTab({ id: 4, url: origin + suffix }, domain),
        false, domain + suffix
      );
    }
    assert.equal(isGoogleLocationTab({ id: 4, url: origin + '/search?q=dentist' }, domain), true);
    assert.equal(isGoogleLocationTab({ id: 4, url: origin + '/search?start=10&q=dentist' }, domain), true);
  }
});

test('navigated Google Maps tab is retained but not reused for location debugging', async () => {
  const operations = [];
  const originalTab = { id: 21, url: 'https://www.google.com/maps/place/Chicago', active: true };
  const nextTab = { id: 22, url: 'about:blank', active: true };
  const tabs = {
    async get(id) {
      return id === 21 ? { ...originalTab } : { ...nextTab };
    },
    async create(options) {
      operations.push(['create', options]);
      return { ...nextTab };
    },
    async update(id, args) {
      operations.push(['update', id, args]);
      if (id === 22) Object.assign(nextTab, args);
    },
    async remove(id) { operations.push(['remove', id]); }
  };
  const output = await getVisibleGoogleLocationTab({
    searchTabId: 21,
    googleDomain: 'google.com',
    tabs,
    async navigate(id, url) {
      operations.push(['navigate', id, url]);
      nextTab.url = url;
    }
  });
  assert.equal(output.created, true);
  assert.equal(output.tab.id, 22);
  assert.match(output.tab.url, /^https:\/\/www\.google\.com\/search\?/);
  assert.equal(originalTab.url, 'https://www.google.com/maps/place/Chicago');
  assert.equal(operations.some(operation => operation[0] === 'update' && operation[1] === 21), false);
  assert.equal(operations.some(operation => operation[0] === 'remove' && operation[1] === 21), false);
});
