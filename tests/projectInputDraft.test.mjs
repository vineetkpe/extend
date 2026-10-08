import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getProjectInputDraft, saveProjectInputDraft, clearProjectInputDraft,
  formatSavedKeywordRows
} from '../utils/projectInputDraft.js';

function fakeSession() {
  const values = {};
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: values[key] }; },
        async set(data) { Object.assign(values, data); },
        async remove(key) { delete values[key]; },
        async clear() { Object.keys(values).forEach(key => delete values[key]); }
      },
      local: {
        async get() { return {}; },
        async set() {}
      }
    }
  };
  return values;
}

test('client-specific drafts cannot leak another project keyword or website', async () => {
  const records = fakeSession();
  await saveProjectInputDraft('client-A', 'dentist\thttps://private-a.example\t4');
  await saveProjectInputDraft('client-B', 'roofer\thttps://private-b.example\t8');
  assert.match(await getProjectInputDraft('client-A'), /private-a/);
  assert.doesNotMatch(await getProjectInputDraft('client-A'), /private-b/);
  assert.match(await getProjectInputDraft('client-B'), /private-b/);
  assert.equal(await getProjectInputDraft('empty-project'), null);
  assert.equal(Object.keys(records).length, 2);
});

test('switching to a project with an explicitly cleared draft stays empty', async () => {
  fakeSession();
  await saveProjectInputDraft('client-A', '');
  assert.equal(await getProjectInputDraft('client-A'), '');
});

test('clearing one project draft does not clear another client', async () => {
  fakeSession();
  await saveProjectInputDraft('one', 'keyword one');
  await saveProjectInputDraft('two', 'keyword two');
  await clearProjectInputDraft('one');
  assert.equal(await getProjectInputDraft('one'), null);
  assert.equal(await getProjectInputDraft('two'), 'keyword two');
});

test('popup keyword formatting preserves zero and avoids undefined previous ranks', () => {
  const rows = [
    { keyword: 'dentist', targetUrl: 'https://example.org/', previousPosition: 0 },
    { keyword: 'lawyer', targetUrl: 'https://example.org/legal', previousPosition: '-' },
    { keyword: 'plumber', targetUrl: 'https://example.org/plumbing', previousPosition: null }
  ];
  assert.equal(formatSavedKeywordRows(rows), [
    'dentist\thttps://example.org/\t0',
    'lawyer\thttps://example.org/legal\t',
    'plumber\thttps://example.org/plumbing\t'
  ].join('\n'));
});

test('drafts are limited in size and require a valid project identity', async () => {
  fakeSession();
  await assert.rejects(() => saveProjectInputDraft('', 'keyword'), /valid project/);
  await assert.rejects(() => saveProjectInputDraft('one', 'x'.repeat(100001)), /under 100,000/);
  assert.equal(await getProjectInputDraft('one'), null);
});

test('all keyword drafts disappear with session storage clear', async () => {
  fakeSession();
  await saveProjectInputDraft('a', 'client secret');
  await chrome.storage.session.clear();
  assert.equal(await getProjectInputDraft('a'), null);
});
