import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOrganicPage, ORGANIC_COUNTING_POLICY } from '../utils/organicRank.js';

const result = (suffix, title = suffix) => ({ url: 'https://example.com/' + suffix, title });

test('repeated URL across different result pages is an organic listing, not a removed rank slot', () => {
  const previous = Array.from({ length: 9 }, (_, i) => 'example.com/p' + (i + 1));
  const pageTwo = [
    result('p8', 'Repeated listing on next SERP'),
    result('target', 'Target is second visible organic listing on page two'),
    result('different', 'Third visible organic listing')
  ];
  const output = prepareOrganicPage(pageTwo, previous, 10);
  assert.equal(output.ok, true);
  assert.equal(output.repeatedFromPreviousPage, 1);
  assert.deepEqual(output.listings.map(r => r.normalizedUrl), [
    'example.com/p8', 'example.com/target', 'example.com/different'
  ]);
  assert.equal(previous.length + output.listings.findIndex(r => r.url.endsWith('/target')) + 1, 11,
    'Earlier implementation dropped repeated URL and incorrectly assigned #10');
});

test('Google ignoring start= pagination is an error, not a fabricated rank', () => {
  const previouslySeen = ['example.com/a', 'example.com/b'];
  const output = prepareOrganicPage([result('a'), result('b')], previouslySeen, 10);
  assert.deepEqual(output, { ok: false, reason: 'REPEATED_SERP_PAGE' });
});

test('duplicate headings with same URL on the same page count only one organic listing', () => {
  const output = prepareOrganicPage([
    result('a'), result('a', 'same URL heading again'), result('b')
  ]);
  assert.equal(output.ok, true);
  assert.equal(output.skippedDuplicatesOnPage, 1);
  assert.equal(output.listings.length, 2);
});

test('invalid URLs and empty pages are inconclusive rather than Not Found', () => {
  assert.equal(prepareOrganicPage([], [], 0).reason, 'EMPTY_ORGANIC_PAGE');
  assert.equal(prepareOrganicPage([{ url: 'javascript:alert(1)' }], [], 0).reason,
    'INVALID_ORGANIC_URL');
  assert.equal(prepareOrganicPage([result('a'), { url: null }], [], 0).ok, false);
});

test('organic rank definition is explicit and consistent across pages', () => {
  assert.equal(ORGANIC_COUNTING_POLICY, 'strict-organic-web-v2');
  const first = prepareOrganicPage([result('a'), result('b')]);
  const second = prepareOrganicPage([result('c'), result('d')], first.listings.map(r => r.normalizedUrl), 10);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(
    [...first.listings, ...second.listings].map((_, index) => index + 1),
    [1, 2, 3, 4]
  );
});
