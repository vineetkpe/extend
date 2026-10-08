import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWorkerRestartPatch,
  reconcileWorkerRestart,
  WORKER_RESTART_MESSAGE,
  WORKER_RESTART_INVALID_MESSAGE
} from '../utils/jobRecovery.js';
import { LOCATION_STATES } from '../utils/storage.js';

function running(overrides = {}) {
  return {
    status: 'RUNNING',
    runId: 'run-1',
    queue: [{ id: 'first', originalIndex: 0 }, { id: 'second', originalIndex: 1 }],
    currentIndex: 1,
    results: [
      { keyword: 'first', currentPosition: 5, status: 'EXACT PAGE' },
      { keyword: 'second', currentPosition: 'NOT CHECKED', status: 'NOT CHECKED' }
    ],
    currentKeyword: 'second',
    currentSerpOffset: 20,
    checkedDepth: 13,
    seenUrls: ['example.com'],
    jobSettings: { useLocation: false },
    ...overrides
  };
}

test('preserves completed results and the next queue index while pausing', () => {
  const state = running();
  const patch = getWorkerRestartPatch(state);
  assert.equal(patch.status, 'PAUSED');
  assert.equal(patch.errorMessage, WORKER_RESTART_MESSAGE);
  assert.equal(patch.currentKeyword, null);
  assert.equal(patch.currentSerpOffset, 0);
  assert.equal(patch.checkedDepth, 0);
  assert.deepEqual(patch.seenUrls, []);
  assert.equal(patch.currentIndex, undefined); // untouched in persistent state
  assert.equal(patch.results, undefined); // no rewrite when no candidate was stored
  assert.equal(state.currentIndex, 1);
  assert.equal(state.results[0].currentPosition, 5);
});

test('does not modify PAUSED, BLOCKED, STOPPED, COMPLETED, ERROR, or IDLE jobs', () => {
  for (const status of ['PAUSED', 'BLOCKED', 'STOPPED', 'COMPLETED', 'ERROR', 'IDLE']) {
    assert.equal(getWorkerRestartPatch(running({ status })), null, status);
  }
});

test('location restart requires reapplication and never trusts old attachment', () => {
  const patch = getWorkerRestartPatch(running({
    jobSettings: { useLocation: true, latitude: '12.3', longitude: '45.6' },
    locationApplied: true,
    appliedLocation: { latitude: 12.3, longitude: 45.6 },
    locationTabId: 45
  }));
  assert.equal(patch.status, 'PAUSED');
  assert.equal(patch.locationApplied, false);
  assert.equal(patch.locationState, LOCATION_STATES.NEEDS_REAPPLY);
  assert.equal(patch.appliedLocation, null);
  assert.equal(patch.locationTabId, null);
});

test('rolls back an unverified two-phase location commit without losing confirmed results', () => {
  const stable = { id: 'first', keyword: 'first', currentPosition: 5, status: 'EXACT PAGE', committed: true };
  const candidate = {
    id: 'second', keyword: 'second', targetUrl: 'https://example.com/b',
    previousPosition: 14,
    currentPosition: 3, displayPosition: '3', change: '↑ 11',
    matchStatus: 'EXACT PAGE', status: 'EXACT PAGE',
    foundUrl: 'https://example.com/b', otherPageFound: 'https://example.com/other',
    otherPagePosition: 8, checkedDepth: 10,
    checkedAt: '2026-10-08T07:00:00.000Z',
    __commitToken: 'pending', __runId: 'run-1', __keywordIndex: 1,
    commitToken: 'pending', commitRunId: 'run-1'
  };
  const state = running({ results: [stable, candidate], jobSettings: { useLocation: true } });
  const patch = getWorkerRestartPatch(state);
  assert.equal(patch.results[0], stable);
  assert.equal(patch.results[1].currentPosition, 'NOT CHECKED');
  assert.equal(patch.results[1].displayPosition, 'NOT CHECKED');
  assert.equal(patch.results[1].status, 'NOT CHECKED');
  assert.equal(patch.results[1].matchStatus, 'NOT_CHECKED');
  assert.equal(patch.results[1].previousPosition, 14);
  assert.equal(patch.results[1].foundUrl, null);
  assert.equal(patch.results[1].checkedAt, null);
  assert.equal('__commitToken' in patch.results[1], false);
  assert.equal('commitToken' in patch.results[1], false);
  assert.equal(state.results[1].currentPosition, 3); // does not mutate inputs
});

test('confirmed location results carrying only commitToken remain untouched', () => {
  const finalized = { id: 'first', status: 'EXACT PAGE', currentPosition: 4, committed: true, commitToken: 'saved' };
  const patch = getWorkerRestartPatch(running({ results: [finalized], currentIndex: 0 }));
  assert.equal(patch.results, undefined);
});

test('malformed or exhausted RUNNING jobs become ERROR instead of false COMPLETED', () => {
  for (const invalid of [
    { currentIndex: 2 },
    { currentIndex: -1 },
    { runId: null },
    { queue: [] }
  ]) {
    const patch = getWorkerRestartPatch(running(invalid));
    assert.equal(patch.status, 'ERROR');
    assert.equal(patch.errorMessage, WORKER_RESTART_INVALID_MESSAGE);
  }
});

test('reconcile saves exactly one patch, then does nothing on later restart', async () => {
  let state = running();
  let writes = 0;
  const saved = await reconcileWorkerRestart(
    async () => state,
    async patch => { writes++; state = { ...state, ...patch }; return state; }
  );
  assert.equal(saved.status, 'PAUSED');
  assert.equal(writes, 1);
  assert.equal(await reconcileWorkerRestart(async () => state, async () => { writes++; }), null);
  assert.equal(writes, 1);
});
