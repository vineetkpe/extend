import test from 'node:test';
import assert from 'node:assert/strict';
import {
  importProjectJson, exportProjectJson, createProject
} from '../utils/projectManager.js';
import { STORAGE_KEYS } from '../utils/storage.js';

function fakeSession() {
  const session = {};
  let localWrites = 0;
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(session[key]) }; },
        async set(updates) { Object.assign(session, structuredClone(updates)); }
      },
      local: {
        async get() { return {}; },
        async set() { localWrites++; }
      }
    }
  };
  return { session, localWrites: () => localWrites };
}

function importWithPositions(values) {
  return importProjectJson(JSON.stringify({
    project: {
      projectName: 'Imported SEO Client',
      keywords: values.map((previousPosition, i) => ({
        keyword: 'keyword ' + i,
        targetUrl: 'https://example.com/page-' + i,
        previousPosition
      }))
    }
  }));
}

test('project JSON import does not coerce malformed values into previous ranks', async () => {
  const storage = fakeSession();
  const malformed = [
    true, false, [7], { value: 7 }, '1e3', '0x10', '3.5',
    'Infinity', 'NaN', '12abc', -5, 0, 4.5,
    '0', '9007199254740993', 9007199254740992, '', '-', '—'
  ];
  const imported = await importWithPositions(malformed);
  assert.equal(imported.keywords.length, malformed.length);
  assert.deepEqual(imported.keywords.map(row => row.previousPosition),
    Array(malformed.length).fill(null));
  assert.equal(storage.localWrites(), 0, 'Sensitive client data must not enter local storage');
  assert.ok(storage.session[STORAGE_KEYS.PROJECTS][imported.projectId]);
});

test('project JSON import accepts exact whole ranks and preserves beyond-100 markers', async () => {
  fakeSession();
  const imported = await importWithPositions([1, 100, '008', ' 21 ', '>100', '100+', null]);
  assert.deepEqual(imported.keywords.map(row => row.previousPosition),
    [1, 100, 8, 21, '>100', '>100', null]);
});

test('project export and import preserve historical beyond-100 baselines', async () => {
  const storage = fakeSession();
  const original = await createProject({
    projectName: 'SEO Backup',
    keywords: [
      { keyword: 'roofing', targetUrl: 'https://example.com/roof',
        previousPosition: '>100' },
      { keyword: 'plumbing', targetUrl: 'https://example.com/plumbing',
        previousPosition: 7 },
      { keyword: 'uncertain', targetUrl: 'https://example.com/other',
        previousPosition: '-' }
    ]
  });
  const exported = await exportProjectJson(original.projectId);
  const restored = await importProjectJson(exported, 'Restored SEO Backup');
  assert.deepEqual(restored.keywords.map(row => row.previousPosition), ['>100', 7, null]);
  assert.equal(restored.projectName, 'Restored SEO Backup');
  assert.equal(storage.localWrites(), 0);
});
