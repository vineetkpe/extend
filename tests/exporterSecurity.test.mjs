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
