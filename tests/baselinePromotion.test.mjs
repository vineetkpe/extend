import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canPromoteBaseline } from '../utils/baselinePromotion.js';

const project = { id: 'client-one', config: { projectId: 'client-one' } };
const complete = {
  status: 'COMPLETED',
  projectId: 'client-one',
  runId: 'run-one',
  results: [{ keyword: 'keyword', currentPosition: 4 }]
};

test('baseline promotion requires a finished rank-check batch', () => {
  assert.equal(canPromoteBaseline(complete, project), true);
  for (const status of ['IDLE', 'RUNNING', 'PAUSED', 'BLOCKED', 'STOPPED']) {
    assert.equal(canPromoteBaseline({ ...complete, status }, project), false, status);
  }
});

test('baseline promotion refuses missing, empty, and unowned results', () => {
  assert.equal(canPromoteBaseline({ ...complete, results: [] }, project), false);
  assert.equal(canPromoteBaseline({ ...complete, results: null }, project), false);
  assert.equal(canPromoteBaseline({ ...complete, projectId: null }, project), false);
  assert.equal(canPromoteBaseline({ ...complete, projectId: 'client-two' }, project), false);
  assert.equal(canPromoteBaseline(complete, null), false);
});

test('a confirmation for an earlier run cannot promote newer results', () => {
  assert.equal(canPromoteBaseline(complete, project, 'run-one'), true);
  assert.equal(canPromoteBaseline({ ...complete, runId: 'run-two' }, project, 'run-one'), false);
});

test('dashboard disables promotion until complete and rechecks live run before writing', () => {
  const dashboard = fs.readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
  assert.match(dashboard, /btnUseAsPrevious\.disabled = !canPromoteBaseline\(state, activeProject\)/);
  assert.match(dashboard, /if \(!canPromoteBaseline\(currentJobState, activeProject\)\)/);
  assert.match(dashboard, /sendMessage\(\{ action: 'GET_STATE' \}\)/);
  assert.match(dashboard, /canPromoteBaseline\(latestState, activeProject, selectedRunId\)/);
  assert.match(dashboard, /promoteCurrentToPrevious\(selectedProjectId, latestState\.results\)/);
});
