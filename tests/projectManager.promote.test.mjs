import test from 'node:test';
import assert from 'node:assert/strict';
import { promoteCurrentToPrevious } from '../utils/projectManager.js';
import { STORAGE_KEYS } from '../utils/storage.js';

const projectId = 'client_1';

function withSessionKeywords(keywords) {
  const stored = {
    [STORAGE_KEYS.PROJECTS]: {
      [projectId]: {
        config: { projectId, projectName: 'Sample client' },
        keywords: structuredClone(keywords)
      }
    }
  };

  globalThis.chrome = {
    storage: {
      session: {
        async get(key) {
          return { [key]: structuredClone(stored[key]) };
        },
        async set(updates) {
          Object.assign(stored, structuredClone(updates));
        }
      }
    }
  };
  return stored;
}

const row = (id, keyword, targetUrl, previousPosition = 99) =>
  ({ id, keyword, targetUrl, previousPosition });

const result = (id, keyword, targetUrl, currentPosition) =>
  ({ id, keyword, targetUrl, currentPosition });

test('same keyword, different target URLs: no history crossover', async () => {
  const keywords = [
    row('a', 'dentist near me', 'https://example.com/service/a', 45),
    row('b', 'dentist near me', 'https://example.com/service/b', 50)
  ];
  const stored = withSessionKeywords(keywords);
  const updated = await promoteCurrentToPrevious(projectId, [
    result('b', 'dentist near me', keywords[1].targetUrl, 8),
    result('a', 'dentist near me', keywords[0].targetUrl, 2)
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [2, 8]);
  assert.deepEqual(stored[STORAGE_KEYS.PROJECTS][projectId].keywords.map(k => k.previousPosition), [2, 8]);
});

test('two identical keyword + target pairs honor stable IDs first', async () => {
  const keyword = 'same keyword';
  const target = 'https://example.com/page';
  withSessionKeywords([row('first', keyword, target), row('second', keyword, target)]);
  const updated = await promoteCurrentToPrevious(projectId, [
    result('second', keyword, target, 4),
    result('first', keyword, target, 11)
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [11, 4]);
});

test('legacy missing IDs use keyword and exact target URL (never keyword alone)', async () => {
  withSessionKeywords([
    { keyword: 'KeyWord ', targetUrl: 'https://example.com/One', previousPosition: 20 },
    { keyword: 'keyword', targetUrl: 'https://example.com/Two', previousPosition: 30 }
  ]);
  const updated = await promoteCurrentToPrevious(projectId, [
    { keyword: 'keyword', targetUrl: 'https://example.com/Two', currentPosition: 9 },
    { keyword: ' keyword ', targetUrl: 'https://example.com/One', currentPosition: 3 }
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [3, 9]);
});

test('a result for another page never updates an unmatched target', async () => {
  const keywords = [row('one', 'dentist', 'https://example.com/Capitalized', 12)];
  withSessionKeywords(keywords);
  const updated = await promoteCurrentToPrevious(projectId, [
    result('one', 'dentist', 'https://example.com/capitalized', 1)
  ]);
  assert.equal(updated[0].previousPosition, 12);
  assert.equal(updated[0].lastCheckedAt, undefined);
});

test('exact-ID rows are reserved before legacy fallback rows consume results', async () => {
  const keyword = 'plumber';
  const targetUrl = 'https://example.com/service';
  withSessionKeywords([
    { keyword, targetUrl, previousPosition: 22 },
    row('identified', keyword, targetUrl, 17)
  ]);
  const updated = await promoteCurrentToPrevious(projectId, [
    result('identified', keyword, targetUrl, 5),
    { keyword, targetUrl, currentPosition: 6 }
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [6, 5]);
});

test('a result cannot be used twice for indistinguishable legacy rows', async () => {
  const keyword = 'plumber';
  const targetUrl = 'https://example.com/service';
  withSessionKeywords([
    { keyword, targetUrl, previousPosition: 30 },
    { keyword, targetUrl, previousPosition: 40 }
  ]);
  const updated = await promoteCurrentToPrevious(projectId, [
    { keyword, targetUrl, currentPosition: 7 }
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [7, 40]);
});

test('technical errors, incomplete checks and null results preserve historical baselines', async () => {
  const site = 'https://example.org/page';
  withSessionKeywords([
    row('error', 'error keyword', site, 11),
    row('unchecked', 'unchecked keyword', site, 23),
    row('null', 'null keyword', site, 49),
    row('aborted', 'aborted keyword', site, 31)
  ]);
  const updated = await promoteCurrentToPrevious(projectId, [
    { ...result('error', 'error keyword', site, 'Error'), status: 'ERROR', matchStatus: 'ERROR' },
    { ...result('unchecked', 'unchecked keyword', site, 'NOT CHECKED'), status: 'NOT CHECKED' },
    { ...result('null', 'null keyword', site, null), status: 'PAUSED' },
    { ...result('aborted', 'aborted keyword', site, 'Not Found'), status: 'ERROR' }
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [11, 23, 49, 31]);
  assert.ok(updated.every(k => k.lastCheckedAt === undefined));
});

test('an explicitly verified Not Found result updates baseline to an unranked marker', async () => {
  const site = 'https://example.com/page';
  withSessionKeywords([row('a', 'dentist', site, 6)]);
  const updated = await promoteCurrentToPrevious(projectId, [{
    ...result('a', 'dentist', site, 'Not Found'),
    status: 'TARGET PAGE NOT FOUND', matchStatus: 'TARGET PAGE NOT FOUND',
    checkedAt: '2026-10-08T00:00:00Z'
  }]);
  assert.equal(updated[0].previousPosition, '-');
  assert.equal(updated[0].lastCheckedAt, '2026-10-08T00:00:00Z');
});

test('a malformed unverified negative result cannot erase a rank', async () => {
  const site = 'https://example.com/page';
  withSessionKeywords([row('a', 'dentist', site, 6)]);
  const updated = await promoteCurrentToPrevious(projectId, [
    result('a', 'dentist', site, 'Not Found')
  ]);
  assert.equal(updated[0].previousPosition, 6);
});

test('valid numeric results are promoted, even for duplicate keywords at different pages', async () => {
  withSessionKeywords([
    row('a', 'same', 'https://example.com/A', 30),
    row('b', 'same', 'https://example.com/B', 20)
  ]);
  const updated = await promoteCurrentToPrevious(projectId, [
    { ...result('a', 'same', 'https://example.com/A', 4), status: 'EXACT PAGE' },
    { ...result('b', 'same', 'https://example.com/B', 8), status: 'EXACT PAGE' }
  ]);
  assert.deepEqual(updated.map(k => k.previousPosition), [4, 8]);
});
