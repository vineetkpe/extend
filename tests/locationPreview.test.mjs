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
