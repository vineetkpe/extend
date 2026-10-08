import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS, LOCATION_STATES } from '../utils/storage.js';

test('GET_STATE waits for a cold worker to reconcile persisted RUNNING state', async () => {
  let onMessage;
  let writes = 0;
  let tabUpdates = 0;
  const saved = {
    [STORAGE_KEYS.JOB_STATE]: {
      runId: 'interrupted-run',
      status: 'RUNNING',
      projectId: 'agency-client',
      queue: [
        { id: 'one', originalIndex: 0, keyword: 'one' },
        { id: 'two', originalIndex: 1, keyword: 'two' }
      ],
      currentIndex: 1,
      results: [
        { id: 'one', currentPosition: 3, status: 'EXACT PAGE', committed: true },
        {
          id: 'two', currentPosition: 7, status: 'EXACT PAGE',
          __commitToken: 'staged-commit', __runId: 'interrupted-run',
          __keywordIndex: 1
        }
      ],
      currentKeyword: 'two',
      currentSerpOffset: 10,
      checkedDepth: 11,
      seenUrls: ['example.com'],
      jobSettings: { useLocation: true, latitude: '12', longitude: '77', accuracy: 20 },
      locationState: LOCATION_STATES.ACTIVE,
      locationApplied: true,
      locationTabId: 33,
      appliedLocation: { latitude: 12, longitude: 77, tabId: 33 }
    }
  };

  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(saved[key]) }; },
        async set(values) { writes++; Object.assign(saved, structuredClone(values)); }
      },
      local: {
        async get() { return {}; },
        async set() {}
      }
    },
    runtime: {
      onMessage: { addListener(callback) { onMessage = callback; } },
      sendMessage: async () => undefined
    },
    debugger: { onDetach: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      async update() { tabUpdates++; throw new Error('Recovery must not navigate.'); }
    }
  };

  // A newly evaluated background module represents a fresh service worker.
  await import('../background.js?cold-worker-restart-integration');
  assert.equal(typeof onMessage, 'function');

  const response = await new Promise(resolve => {
    assert.equal(onMessage({ action: 'GET_STATE' }, {}, resolve), true);
  });

  assert.equal(response.state.status, 'PAUSED');
  assert.equal(response.state.runId, 'interrupted-run');
  assert.equal(response.state.projectId, 'agency-client');
  assert.equal(response.state.currentIndex, 1);
  assert.equal(response.state.results[0].currentPosition, 3);
  assert.equal(response.state.results[1].currentPosition, 'NOT CHECKED');
  assert.equal(response.state.locationApplied, false);
  assert.equal(response.state.locationState, LOCATION_STATES.NEEDS_REAPPLY);
  assert.equal(response.state.currentKeyword, null);
  assert.equal(writes, 1);
  assert.equal(tabUpdates, 0);

  const second = await new Promise(resolve => {
    onMessage({ action: 'GET_STATE' }, {}, resolve);
  });
  assert.equal(second.state.status, 'PAUSED');
  assert.equal(writes, 1);
});
