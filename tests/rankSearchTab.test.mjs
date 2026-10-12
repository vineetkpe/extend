import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isReusableRankSearchTab, getSafeRankSearchTab
} from '../utils/rankSearchTab.js';

const rankUrl = (domain = 'google.com') =>
  'https://www.' + domain + '/search?q=client+keyword&start=10';

test('only an exact HTTPS Google Search tab in the selected country is reusable', () => {
  for (const domain of ['google.com', 'google.co.in', 'google.co.uk', 'google.com.br']) {
    assert.equal(isReusableRankSearchTab({ id: 5, url: rankUrl(domain) }, domain), true);
    assert.equal(isReusableRankSearchTab({
      id: 5, url: rankUrl(domain).replace('&start=10', '&start=20')
    }, domain), true);
    for (const suffix of [
      '/', '/maps', '/maps/place/Delhi', '/finance', '/preferences',
      '/url?q=https://target.example', '/searching?q=test', '/search/another',
      '/SEARCH?q=test'
    ]) {
      assert.equal(isReusableRankSearchTab({
        id: 5, url: 'https://www.' + domain + suffix
      }, domain), false, domain + suffix);
    }
  }
});

test('misleading Google-looking URLs or mismatched country hosts never qualify', () => {
  const urls = [
    'https://www.google.com.evil.example/search?q=test',
    'https://www.google.co.in/search?q=test',
    'https://google.com/search?q=test',
    'http://www.google.com/search?q=test',
    'https://www.google.com:8080/search?q=test',
    'https://hacker@www.google.com/search?q=test',
    'https://www.google.com.evil.example/?u=www.google.com/search',
    'javascript:alert(1)', 'not a URL', ''
  ];
  for (const url of urls) {
    assert.equal(isReusableRankSearchTab({ id: 5, url }, 'google.com'), false, url);
  }
  assert.equal(isReusableRankSearchTab({ id: 5, url: rankUrl() },
    'google.com.attacker.example'), false);
});

test('tabs in the middle of an unrelated navigation are not reused', () => {
  const url = rankUrl();
  assert.equal(isReusableRankSearchTab({
    id: 12, url, pendingUrl: 'https://example.com/my-documents'
  }, 'google.com'), false);
  assert.equal(isReusableRankSearchTab({
    id: 12, url, status: 'loading'
  }, 'google.com'), false);
  assert.equal(isReusableRankSearchTab({
    id: 12, url, discarded: true
  }, 'google.com'), false);
});

test('valid saved Search tab is reused without creating, updating or closing anything', async () => {
  const operations = [];
  const tab = { id: 21, url: rankUrl('google.co.uk') };
  const tabs = {
    async get(id) { operations.push(['get', id]); return tab; },
    async create(args) { operations.push(['create', args]); throw Error('Must not create'); },
    async update(id, args) { operations.push(['update', id, args]); },
    async remove(id) { operations.push(['remove', id]); }
  };
  const result = await getSafeRankSearchTab({
    existingTabId: 21, googleDomain: 'google.co.uk', tabs
  });
  assert.equal(result, tab);
  assert.deepEqual(operations, [['get', 21]]);
});

test('user-navigated external, Maps, or wrong-country tab is never overwritten', async () => {
  for (const oldUrl of [
    'https://client.example/dashboard',
    'https://www.google.com/maps/place/Chicago',
    'https://www.google.com/',
    'https://www.google.co.in/search?q=other-client',
    'chrome://settings/',
    'https://www.google.com/search?q=my-query'
  ]) {
    const operations = [];
    const oldTab = { id: 17, url: oldUrl };
    const newTab = { id: 18, url: rankUrl('google.co.uk') };
    const tabs = {
      async get(id) { operations.push(['get', id]); return oldTab; },
      async create(args) { operations.push(['create', args]); return newTab; },
      async update(id, args) { operations.push(['update', id, args]); },
      async remove(id) { operations.push(['remove', id]); }
    };
    const result = await getSafeRankSearchTab({
      existingTabId: 17, googleDomain: 'google.co.uk', tabs
    });
    assert.equal(result.id, 18, oldUrl);
    assert.equal(oldTab.url, oldUrl);
    assert.deepEqual(operations.map(op => op[0]), ['get', 'create'], oldUrl);
    assert.match(operations[1][1].url, /^https:\/\/www\.google\.co\.uk\/search\?/);
    assert.equal(operations[1][1].url.includes('client.example'), false);
    assert.equal(operations[1][1].url.includes('other-client'), false);
  }
});

test('a closed tab is replaced with a selected-country Google Search page', async () => {
  let requestedUrl = null;
  const tabs = {
    async get() { throw new Error('Tab not found'); },
    async create({ url, active }) {
      assert.equal(active, true);
      requestedUrl = url;
      return { id: 44, url };
    }
  };
  const result = await getSafeRankSearchTab({
    existingTabId: 9, googleDomain: 'google.com.br', tabs
  });
  assert.equal(result.id, 44);
  assert.match(requestedUrl, /^https:\/\/www\.google\.com\.br\/search\?/);
});

test('unsupported Google domain fails before any tab is read or created', async () => {
  let calls = 0;
  const tabs = {
    async get() { calls++; },
    async create() { calls++; }
  };
  for (const domain of ['example.com', 'google.com.evil.example', '', '../evil']) {
    await assert.rejects(
      () => getSafeRankSearchTab({
        existingTabId: 3, googleDomain: domain, tabs
      }),
      /Unsupported Google Search country domain/
    );
  }
  assert.equal(calls, 0);
});
