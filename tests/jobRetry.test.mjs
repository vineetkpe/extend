import test from 'node:test';
import assert from 'node:assert/strict';
import { mayStartNewJob, mayRetryFailedJob, makeFailedRetryPlan } from '../utils/jobRetry.js';

const errorResult = (originalIndex, id, keyword) => ({
  originalIndex, id, keyword,
  targetUrl: 'https://example.com/' + id,
  previousPosition: 18, currentPosition: 'Error', displayPosition: 'Error',
  matchStatus: 'ERROR', status: 'ERROR', checkedDepth: 0,
  checkedAt: '2026-10-08T00:00:00Z', error: 'SERP timeout'
});
const completed = () => ({
  status: 'COMPLETED',
  results: [
    { id: 'a', originalIndex: 0, keyword: 'done',
      targetUrl: 'https://example.com/a', currentPosition: 3,
      matchStatus: 'EXACT PAGE', status: 'EXACT PAGE' },
    errorResult(1, 'b', 'failed'),
    { id: 'c', originalIndex: 2, keyword: 'done again',
      targetUrl: 'https://example.com/c', currentPosition: 'Not Found',
      status: 'TARGET PAGE NOT FOUND' },
    errorResult(3, 'd', 'failed again')
  ]
});

test('start refuses RUNNING, PAUSED and BLOCKED jobs to prevent overwrites', () => {
  for (const status of ['RUNNING', 'PAUSED', 'BLOCKED']) {
    assert.equal(mayStartNewJob({ status }), false);
  }
  for (const status of ['IDLE', 'COMPLETED', 'STOPPED', 'ERROR']) {
    assert.equal(mayStartNewJob({ status }), true);
  }
});

test('retry only allowed once the previous queue has finished', () => {
  for (const status of ['RUNNING', 'PAUSED', 'BLOCKED', 'STOPPED', 'ERROR', 'IDLE']) {
    const state = completed();
    state.status = status;
    assert.equal(mayRetryFailedJob(state), false);
    const retry = makeFailedRetryPlan(state);
    assert.equal(retry.allowed, false);
    assert.match(retry.error, /Finish the current job/);
  }
});

test('retry queues only failed keywords while retaining other result positions', () => {
  const state = completed();
  const before = structuredClone(state);
  const retry = makeFailedRetryPlan(state);
  assert.equal(retry.allowed, true);
  assert.deepEqual(retry.queue.map(row => row.originalIndex), [1, 3]);
  assert.deepEqual(retry.queue.map(row => row.id), ['b', 'd']);
  assert.equal(retry.results.length, 4);
  assert.equal(retry.results[0].currentPosition, 3);
  assert.equal(retry.results[2].status, 'TARGET PAGE NOT FOUND');
  assert.equal(retry.results[1].status, 'NOT CHECKED');
  assert.equal(retry.results[1].matchStatus, 'NOT_CHECKED');
  assert.equal(retry.results[1].currentPosition, 'NOT CHECKED');
  assert.equal(retry.results[1].error, null);
  assert.equal(retry.results[1].checkedAt, null);
  assert.deepEqual(state, before, 'planning must not mutate live session state');
});

test('inconsistent originalIndex metadata cannot write into another row', () => {
  const state = completed();
  state.results[1].originalIndex = 0;
  state.results[3].originalIndex = 999;
  const retry = makeFailedRetryPlan(state);
  assert.deepEqual(retry.queue.map(item => item.originalIndex), [1, 3]);
  assert.equal(retry.results[0].id, 'a');
  assert.equal(retry.results[2].id, 'c');
});

test('retry refuses no failed results or malformed failed entries', () => {
  const state = completed();
  state.results[1].status = 'EXACT PAGE';
  state.results[1].matchStatus = 'EXACT PAGE';
  state.results[3] = { status: 'ERROR', keyword: 'broken', targetUrl: '' };
  assert.equal(makeFailedRetryPlan(state).allowed, false);
});

test('multiple failed matches with same keyword but different URL keep original row ids', () => {
  const state = completed();
  state.results[1].keyword = 'same keyword';
  state.results[3].keyword = 'same keyword';
  const retry = makeFailedRetryPlan(state);
  assert.equal(retry.queue[0].id, 'b');
  assert.equal(retry.queue[1].id, 'd');
  assert.notEqual(retry.queue[0].targetUrl, retry.queue[1].targetUrl);
});
