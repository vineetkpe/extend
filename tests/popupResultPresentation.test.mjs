import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  describePopupResult,
  countVerifiedPopupResults
} from '../utils/popupResultPresentation.js';

const pending = {
  keyword: 'advanced surface technology',
  targetUrl: 'https://example.com/',
  previousPosition: 1,
  currentPosition: 'NOT CHECKED',
  displayPosition: 'NOT CHECKED',
  status: 'NOT CHECKED',
  matchStatus: 'NOT_CHECKED',
  checkedDepth: 0,
  change: '—',
  checkedAt: null
};

test('START_JOB placeholder in screenshot shows NOT CHECKED, never Not Found', () => {
  const result = describePopupResult(pending);
  assert.equal(result.kind, 'pending');
  assert.equal(result.rankText, 'NOT CHECKED');
  assert.equal(result.matchText, 'NOT CHECKED');
  assert.equal(result.statusText, 'NOT CHECKED');
  assert.doesNotMatch(result.detail, /checked 0 results/i);
  assert.equal(countVerifiedPopupResults([pending]), 0);
});

test('paused, blocked or stopped queues explain why 0-of-1 ranks have not updated', () => {
  assert.match(describePopupResult(pending, 'PAUSED').detail, /RESUME/);
  assert.match(describePopupResult(pending, 'BLOCKED').detail, /blocked.*RESUME/);
  assert.match(describePopupResult(pending, 'STOPPED').detail, /stopped/);
  assert.equal(describePopupResult(pending, 'PAUSED').statusText, 'NOT CHECKED');
});

test('rank detected after background update replaces pending display with exact rank', () => {
  const initial = [pending];
  const updated = [{
    ...pending,
    currentPosition: 4,
    displayPosition: '4',
    matchStatus: 'EXACT PAGE',
    status: 'EXACT PAGE',
    checkedDepth: 4,
    foundUrl: pending.targetUrl,
    checkedAt: '2026-10-12T12:00:00.000Z',
    change: '↓ 3'
  }];
  assert.equal(countVerifiedPopupResults(initial), 0);
  assert.equal(countVerifiedPopupResults(updated), 1);
  const rendered = describePopupResult(updated[0]);
  assert.equal(rendered.kind, 'exact');
  assert.equal(rendered.rankText, '4');
  assert.equal(rendered.matchText, 'EXACT PAGE');
  assert.equal(rendered.statusText, 'EXACT PAGE');
  assert.equal(rendered.detail, 'Checked depth: 4');
});

test('organic Not Found requires positive scanned depth and confirmed missing target', () => {
  const verifiedMissing = {
    ...pending,
    status: 'TARGET PAGE NOT FOUND',
    matchStatus: 'TARGET PAGE NOT FOUND',
    currentPosition: 'Not Found',
    checkedDepth: 35
  };
  const result = describePopupResult(verifiedMissing);
  assert.equal(result.kind, 'not-found');
  assert.equal(result.rankText, 'Not Found (Top 35)');
  assert.equal(result.statusText, 'TARGET NOT FOUND');
  assert.equal(countVerifiedPopupResults([verifiedMissing]), 1);
});

test('unverified 0-depth missing target never claims an organic check', () => {
  const inconsistent = {
    ...pending,
    status: 'TARGET PAGE NOT FOUND',
    matchStatus: 'TARGET PAGE NOT FOUND',
    currentPosition: 'Not Found',
    checkedDepth: 0
  };
  const result = describePopupResult(inconsistent);
  assert.equal(result.kind, 'error');
  assert.equal(result.rankText, 'UNVERIFIED');
  assert.equal(result.statusText, 'CHECK INCOMPLETE');
  assert.equal(countVerifiedPopupResults([inconsistent]), 0);
});

test('a real extraction error stays ERROR, not Not Found', () => {
  const failed = {
    ...pending,
    status: 'ERROR',
    matchStatus: 'ERROR',
    currentPosition: 'Error',
    error: 'Google results could not be extracted reliably'
  };
  const result = describePopupResult(failed);
  assert.equal(result.kind, 'error');
  assert.equal(result.rankText, 'ERROR');
  assert.equal(result.matchText, 'ERROR');
  assert.match(result.detail, /could not be extracted/);
  assert.equal(countVerifiedPopupResults([failed]), 0);
});

test('other page on same website is distinguished from exact target URL', () => {
  const alternatePage = {
    ...pending,
    status: 'TARGET PAGE NOT FOUND',
    matchStatus: 'OTHER DOMAIN PAGE FOUND',
    currentPosition: 'Not Found',
    checkedDepth: 25,
    otherPagePosition: 8,
    otherPageFound: 'https://example.com/different-page'
  };
  const result = describePopupResult(alternatePage);
  assert.equal(result.kind, 'not-found');
  assert.equal(result.matchText, 'OTHER DOMAIN FOUND');
  assert.equal(result.rankText, 'Not Found (Top 25)');
  assert.equal(result.detail, 'Other page ranks at pos 8');
});

test('provisional two-phase results are pending until their commit finishes', () => {
  const provisional = {
    ...pending,
    status: 'EXACT PAGE',
    matchStatus: 'EXACT PAGE',
    currentPosition: 3,
    checkedDepth: 3,
    __commitToken: 'unverified-candidate'
  };
  assert.equal(describePopupResult(provisional).kind, 'pending');
  assert.equal(countVerifiedPopupResults([provisional]), 0);
});

test('invalid numeric ranks are not presented as verified exact positions', () => {
  for (const position of [0, -1, 3.5, Infinity, NaN, '3']) {
    const bad = {
      ...pending,
      status: 'EXACT PAGE',
      matchStatus: 'EXACT PAGE',
      currentPosition: position,
      checkedDepth: 10
    };
    assert.equal(describePopupResult(bad).kind, 'error', String(position));
  }
});

test('popup renders all row states through central presenter, not stale fallback', () => {
  const source = fs.readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  assert.match(source, /const display = describePopupResult\(r, currentJobState\?\.status\)/);
  assert.match(source, /countVerifiedPopupResults\(validRows\)/);
  assert.match(source, /renderResultsTable\(res\.state\.results\)/);
  assert.match(source, /renderResultsTable\(msg\.state\.results\)/);
  assert.doesNotMatch(source, /currentResults\.length} checked/);
  assert.doesNotMatch(source, /Checked \$\{r\.checkedDepth \|\| 0\} results/);
});
