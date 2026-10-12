import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportToCsv, exportToTsv, exportToCurrentPositionsOnly,
  neutralizeSpreadsheetFormula
} from '../utils/exporter.js';

function makeResult(keyword, changes = {}) {
  return {
    keyword, targetUrl: 'https://example.com',
    previousPosition: 10, currentPosition: 3, displayPosition: '3',
    change: '↑ 7', matchStatus: 'EXACT PAGE', status: 'EXACT PAGE',
    checkedDepth: 10, foundUrl: 'https://example.com',
    checkedAt: '2026-10-08T00:00:00Z', ...changes
  };
}

test('CSV guards all common spreadsheet formula prefixes even when quoted', () => {
  for (const formula of ['=1+1', '+SUM(1,2)', '-CMD("calc")', '@SUM(1,2)']) {
    const csv = exportToCsv([makeResult(formula)]);
    assert.ok(csv.includes(`"'${formula.replaceAll('"', '""')}"`),
      'Formula must be prefixed with a literal apostrophe: ' + formula);
  }
});

test('CSV handles leading whitespace, tabs and line breaks before formula', () => {
  for (const payload of ['  =HYPERLINK("https://example.org")', '\t=1+1', '\r\n@SUM(1)']) {
    assert.equal(neutralizeSpreadsheetFormula(payload)[0], "'");
  }
});

test('TSV neutralizes formula payloads after removing line/column delimiters', () => {
  for (const payload of ['=1+1', '\n+SUM(1)', '\t-10+RAND()', ' @SUM(1)']) {
    const tsv = exportToTsv([makeResult(payload)]);
    const firstBodyRow = tsv.split('\n')[1].split('\t');
    assert.ok(firstBodyRow[0].startsWith("'"), 'Unsafe TSV cell: ' + firstBodyRow[0]);
  }
});

test('legitimate numeric rankings, safe negative number values and hyphen sentinel retain usable form', () => {
  assert.equal(neutralizeSpreadsheetFormula(3), '3');
  assert.equal(neutralizeSpreadsheetFormula(-14), '-14');
  assert.equal(neutralizeSpreadsheetFormula('-'), '-');
  assert.equal(neutralizeSpreadsheetFormula('safe keyword'), 'safe keyword');
  const csv = exportToCsv([makeResult('safe keyword')]);
  assert.ok(csv.includes('"safe keyword"'));
  assert.ok(csv.includes('"3"'));
  assert.equal(exportToCurrentPositionsOnly([makeResult('safe keyword')]), '3');
});

test('CSV quoting still handles embedded quotes and newlines after sanitization', () => {
  const csv = exportToCsv([makeResult('=IF(TRUE,"hi","bye")\n')]);
  assert.ok(csv.includes(`"'=IF(TRUE,""hi"",""bye"")`));
  assert.equal(csv.split('\r\n').length, 2);
});


test('Excel-paste positions fail closed for technical errors even when rank data is stale', () => {
  const rows = [
    makeResult('matched error', { matchStatus: 'ERROR', currentPosition: 4 }),
    makeResult('status error', { status: 'ERROR', currentPosition: 'Not Found' }),
    makeResult('unchecked match', { matchStatus: 'NOT_CHECKED', currentPosition: 3 }),
    makeResult('unchecked status', { status: 'NOT CHECKED', currentPosition: 5 })
  ];
  assert.equal(exportToCurrentPositionsOnly(rows),
    'ERROR\\nERROR\\nNOT CHECKED\\nNOT CHECKED'.replaceAll('\\n', '\n'));
});

test('Excel-paste positions accept only positive whole-number organic ranks', () => {
  const invalid = [0, -2, 1.5, Number.NaN, Infinity, '0', '-3', '2.5', 'junk'];
  const rows = invalid.map((value, index) =>
    makeResult('invalid ' + index, { currentPosition: value }));
  assert.deepEqual(exportToCurrentPositionsOnly(rows).split('\n'),
    invalid.map(() => 'NOT CHECKED'));
  assert.equal(exportToCurrentPositionsOnly([
    makeResult('first', { currentPosition: 1 }),
    makeResult('serialized rank', { currentPosition: ' 12 ' })
  ]), '1\n12');
});

test('Excel-paste positions report NOT FOUND only when explicitly verified', () => {
  assert.equal(exportToCurrentPositionsOnly([
    makeResult('verified', {
      status: 'TARGET PAGE NOT FOUND',
      currentPosition: 'Not Found'
    }),
    makeResult('verified alternative', {
      status: 'EXACT PAGE',
      matchStatus: 'OTHER DOMAIN PAGE FOUND',
      currentPosition: 'Not Found'
    }),
    makeResult('unverified', { currentPosition: 'Not Found' }),
    makeResult('missing', { currentPosition: null }),
    null
  ]), 'NOT FOUND\nNOT FOUND\nNOT CHECKED\nNOT CHECKED\nNOT CHECKED');
});


test('CSV leaves missing or null check timestamps blank instead of inventing the export time', () => {
  const csv = exportToCsv([
    makeResult('not checked', {
      status: 'NOT CHECKED',
      matchStatus: 'NOT_CHECKED',
      currentPosition: 'NOT CHECKED',
      displayPosition: 'NOT CHECKED',
      checkedAt: null
    }),
    makeResult('missing timestamp', { checkedAt: undefined }),
    makeResult('empty timestamp', { checkedAt: '' })
  ]);
  const [header, ...rows] = csv.split('\r\n');
  assert.ok(header.endsWith('checked_at'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.ok(row.endsWith(',""'), 'Unknown check time must remain blank: ' + row);
  }
});

test('CSV preserves the actual check time for checked keywords', () => {
  const timestamp = '2026-10-08T09:30:00Z';
  const csv = exportToCsv([makeResult('verified rank', { checkedAt: timestamp })]);
  assert.ok(csv.split('\r\n')[1].endsWith(',"' + timestamp + '"'));
});
