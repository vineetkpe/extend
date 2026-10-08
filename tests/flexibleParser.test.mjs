import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputRows } from '../utils/parser.js';

function simplified(text, options) {
  const parsed = parseInputRows(text, options);
  return {
    data: parsed.valid.map(({ keyword, targetUrl, previousPosition }) => ({
      keyword, targetUrl, previousPosition
    })),
    errors: parsed.errors
  };
}
test('TSV headers allow arbitrary column order and additional campaign columns', () => {
  const input = [
    'Campaign\tPrevious Rank\tWebsite\tKeyword\tNotes',
    'Fall\t7\thttps://example.com/service\tbest handyman services\tIgnore',
    'Fall\t10\texample.net/repair\taffordable repairs\tAnything'
  ].join('\n');
  const { data, errors } = simplified(input);
  assert.equal(errors.length, 0);
  assert.deepEqual(data, [
    { keyword: 'best handyman services', targetUrl: 'https://example.com/service', previousPosition: 7 },
    { keyword: 'affordable repairs', targetUrl: 'https://example.net/repair', previousPosition: 10 }
  ]);
});
test('quoted CSV fields preserve commas in long keyword phrases', () => {
  const { data, errors } = simplified(
    'Keyword,Website,Previous Position,Notes\n"dryer vent, installation",https://example.com/vent,12,"retarget, later"'
  );
  assert.equal(errors.length, 0);
  assert.equal(data[0].keyword, 'dryer vent, installation');
  assert.equal(data[0].previousPosition, 12);
  assert.equal(data.length, 1);
});
test('reversed URL and keyword columns without headers work', () => {
  const { data, errors } = simplified('example.com/shop\tmen shoes\t8\nhttps://site.org/seo\tlocal seo\t2');
  assert.equal(errors.length, 0);
  assert.deepEqual(data.map(row => row.keyword), ['men shoes', 'local seo']);
  assert.deepEqual(data.map(row => row.previousPosition), [8, 2]);
});
test('single-column keywords use explicit default target site, never invent one', () => {
  const input = 'roof repair near me\nbest licensed roofer\nroofing company';
  const noTarget = simplified(input);
  assert.equal(noTarget.data.length, 0);
  assert.equal(noTarget.errors.length, 3);
  const { data, errors } = simplified(input, { defaultTargetUrl: 'example.com' });
  assert.equal(errors.length, 0);
  assert.equal(data.length, 3);
  assert.ok(data.every(row => row.targetUrl === 'https://example.com/'));
});
test('keyword + position in separated cells can share default URL', () => {
  const { data } = simplified('Keyword,Previous Rank\nroof repair,17\nsolar roof,NA', {
    defaultTargetUrl: 'https://example.org'
  });
  assert.deepEqual(data.map(r => r.previousPosition), [17, '-']);
  assert.ok(data.every(r => r.targetUrl === 'https://example.org/'));
});
test('semicolon/pipe delimiter, spaces and old three-column format still work', () => {
  const input = 'local electrician | example.com/electric | 4\ndentist near me;https://example.net/dental;12\ncar detailing example.org/car 15';
  const { data, errors } = simplified(input);
  assert.equal(errors.length, 0);
  assert.deepEqual(data.map(r => r.previousPosition), [4, 12, 15]);
});
test('unknown or missing website produces line-numbered errors and no silent skip', () => {
  const { data, errors } = simplified('Keyword\tWebsite\tPrevious Rank\nvalid\texample.com\t2\ninvalid\tNOT-A-WEBSITE\t3');
  assert.equal(data.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /website/i);
});
test('default target must be a valid URL/domain', () => {
  const { data, errors } = simplified('one keyword', { defaultTargetUrl: 'javascript:alert(1)' });
  assert.equal(data.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 0);
});
test('header maps target URLs correctly even with a numeric ID column', () => {
  const { data, errors } = simplified('ID,Keyword,Website,Ranking\n1,solar panels,business.com/solar,13');
  assert.equal(errors.length, 0);
  assert.equal(data.length, 1);
  assert.equal(data[0].keyword, 'solar panels');
  assert.equal(data[0].previousPosition, 13);
});
