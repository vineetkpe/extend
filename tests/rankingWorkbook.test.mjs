import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { WorkbookZip } from '../utils/workbookZip.js';
import { listRankingWorkbookSheets, inspectRankingWorkbook, buildUpdatedRankingWorkbook } from '../utils/rankingWorkbook.js';

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

const te = new TextEncoder(), td = new TextDecoder();
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStored(files) {
  const localParts = [], centralParts = [];
  let offset = 0, size = 0;
  for (const [name, data] of Object.entries(files)) {
    const file = te.encode(data), fileName = te.encode(name), sum = crc32(file);
    const local = new Uint8Array(30), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, file.length, true);
    lv.setUint32(22, file.length, true);
    lv.setUint16(26, fileName.length, true);
    localParts.push(local, fileName, file);

    const central = new Uint8Array(46), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, file.length, true);
    cv.setUint32(24, file.length, true);
    cv.setUint16(28, fileName.length, true);
    cv.setUint32(42, offset, true);
    centralParts.push(central, fileName);
    offset += 30 + fileName.length + file.length;
    size += 46 + fileName.length;
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, Object.keys(files).length, true);
  view.setUint16(10, Object.keys(files).length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  const output = new Uint8Array([...localParts, ...centralParts, end]
    .reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    output.set(part, pos);
    pos += part.length;
  }
  return output;
}
function fixtureFiles() {
  return {
    '[Content_Types].xml': xmlHeader + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': xmlHeader + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="wb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': xmlHeader + `<workbook xmlns="${ns}" xmlns:r="${relNs}"><sheets><sheet name="Client Information" sheetId="1" r:id="rId1"/><sheet name="Keyword Ranking" sheetId="2" r:id="rId2"/><sheet name="GMB Ranking" sheetId="3" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': xmlHeader + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
    'xl/sharedStrings.xml': xmlHeader + `<sst xmlns="${ns}"><si><t>Keywords</t></si><si><t>Landing Page</t></si><si><t>dryer vent cleaning</t></si><si><t>https://example.com/vent</t></si><si><t>https://example.com/repair</t></si><si><t>NA</t></si><si><t>Lat</t></si><si><t>Long</t></si><si><t>Address</t></si><si><t>Pasadena, CA, USA</t></si><si><t>Unrelated private note</t></si></sst>`,
    'xl/worksheets/sheet1.xml': xmlHeader + `<worksheet xmlns="${ns}"><sheetData><row r="3"><c r="B3" t="s"><v>6</v></c><c r="C3"><v>34.1478</v></c></row><row r="4"><c r="B4" t="s"><v>7</v></c><c r="C4"><v>-118.1445</v></c></row><row r="5"><c r="B5" t="s"><v>8</v></c><c r="C5" t="s"><v>9</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': xmlHeader + `<worksheet xmlns="${ns}"><sheetData><row r="2"><c r="G2" s="26"><v>46300</v></c><c r="H2" s="26"><v>46293</v></c></row><row r="9"><c r="C9" t="s"><v>0</v></c><c r="F9" t="s"><v>1</v></c><c r="G9" s="26"><v>46300</v></c><c r="H9" s="26"><v>46293</v></c></row><row r="10"><c r="C10" t="s"><v>2</v></c><c r="F10" t="s"><v>3</v></c><c r="G10" s="82"><v>4</v></c><c r="H10" s="82"><v>8</v></c></row><row r="11"><c r="C11" t="s"><v>2</v></c><c r="F11" t="s"><v>4</v></c><c r="G11" s="82" t="s"><v>5</v></c></row><row r="12"><c r="B12" t="s"><v>10</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="C2:F2"/></mergeCells><autoFilter ref="$B$92:$H$97"><sortState ref="B92:H97"><sortCondition ref="G92:G97"/></sortState></autoFilter></worksheet>`,
    'xl/worksheets/sheet3.xml': xmlHeader + `<worksheet xmlns="${ns}"><sheetData><row r="2"><c r="F2"><v>46300</v></c></row><row r="3"><c r="F3"><v>1</v></c></row></sheetData></worksheet>`
  };
}
function c(doc, ref) {
  return Array.from(doc.getElementsByTagNameNS(ns, 'c')).find(cell => cell.getAttribute('r') === ref);
}
function cellValue(cell) {
  if (!cell) return null;
  return Array.from(cell.getElementsByTagNameNS(ns, 'v'))[0]?.textContent ??
    Array.from(cell.getElementsByTagNameNS(ns, 't'))[0]?.textContent ?? null;
}
async function fixture() {
  const files = fixtureFiles(), bytes = zipStored(files);
  const inspected = await inspectRankingWorkbook(bytes);
  return { files, bytes, inspected };
}

test('imports organic rows, latest weekly baselines, and Pasadena coordinates', async () => {
  const { inspected } = await fixture();
  assert.equal(inspected.rows.length, 2);
  assert.deepEqual(inspected.rows.map(r => r.id), ['workbook_row_10', 'workbook_row_11']);
  assert.deepEqual(inspected.rows.map(r => r.targetUrl), ['https://example.com/vent', 'https://example.com/repair']);
  assert.deepEqual(inspected.rows.map(r => r.previousPosition), [4, '-']);
  assert.equal(inspected.latestDate, '2026-10-05');
  assert.equal(inspected.location.latitude, '34.1478');
  assert.equal(inspected.location.longitude, '-118.1445');
  assert.equal(inspected.location.hasCoordinates, true);
  assert.equal(inspected.hasGmbSheet, true);
  assert.equal(JSON.stringify(inspected).includes('Unrelated private note'), false);
});

test('exports a new leftmost weekly date and correct organic rankings', async () => {
  const { bytes, inspected } = await fixture();
  const results = [
    { id: 'workbook_row_10', originalIndex: 0, status: 'EXACT PAGE', currentPosition: 2 },
    { id: 'workbook_row_11', originalIndex: 1, status: 'TARGET PAGE NOT FOUND', currentPosition: 'Not Found' }
  ];
  const updated = await buildUpdatedRankingWorkbook(bytes, inspected, results, '2026-10-08');
  const zip = new WorkbookZip(await updated.arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  assert.equal(cellValue(c(doc, 'G9')), '46303');
  assert.equal(cellValue(c(doc, 'H9')), '46300');
  assert.equal(cellValue(c(doc, 'I9')), '46293');
  assert.equal(cellValue(c(doc, 'G2')), '46303');
  assert.equal(cellValue(c(doc, 'H2')), '46300');
  assert.equal(cellValue(c(doc, 'G10')), '2');
  assert.equal(cellValue(c(doc, 'H10')), '4');
  assert.equal(cellValue(c(doc, 'I10')), '8');
  assert.equal(cellValue(c(doc, 'G11')), 'NA');
  assert.equal(cellValue(c(doc, 'H11')), '5');
  assert.equal(cellValue(c(doc, 'F10')), '3'); // landing page reference unchanged
  assert.equal(c(doc, 'G10').getAttribute('s'), '82');
});

test('preserves auto-filter references, old sort fields, and merged cells', async () => {
  const { bytes, inspected } = await fixture();
  const zip = new WorkbookZip(await (await buildUpdatedRankingWorkbook(bytes, inspected, [], '2026-10-08')).arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  const first = name => doc.getElementsByTagNameNS(ns, name).item(0);
  assert.equal(first('autoFilter').getAttribute('ref'), '$B$92:$I$97');
  assert.equal(first('sortState').getAttribute('ref'), 'B92:I97');
  assert.equal(first('sortCondition').getAttribute('ref'), 'H92:H97');
  assert.equal(first('mergeCell').getAttribute('ref'), 'C2:F2');
  assert.equal(cellValue(c(doc, 'G10')), 'NOT CHECKED');
});

test('does not modify other workbook tabs or shared strings', async () => {
  const { bytes, inspected, files } = await fixture();
  const output = await buildUpdatedRankingWorkbook(bytes, inspected, [], '2026-10-08');
  const zip = new WorkbookZip(await output.arrayBuffer());
  assert.equal(td.decode(await zip.read('xl/worksheets/sheet3.xml')), files['xl/worksheets/sheet3.xml']);
  assert.equal(td.decode(await zip.read('xl/worksheets/sheet1.xml')), files['xl/worksheets/sheet1.xml']);
  assert.equal(td.decode(await zip.read('xl/sharedStrings.xml')), files['xl/sharedStrings.xml']);
});

test('an error is explicitly ERROR, never an invented Not Found position', async () => {
  const { bytes, inspected } = await fixture();
  const output = await buildUpdatedRankingWorkbook(bytes, inspected, [
    { id: 'workbook_row_10', originalIndex: 0, status: 'ERROR', currentPosition: 'Error' }
  ], '2026-10-08');
  const zip = new WorkbookZip(await output.arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  assert.equal(cellValue(c(doc, 'G10')), 'ERROR');
});

test('prevents overwriting existing ranking dates', async () => {
  const { bytes, inspected } = await fixture();
  await assert.rejects(
    () => buildUpdatedRankingWorkbook(bytes, inspected, [], '2026-10-05'),
    /later than the latest existing ranking date/
  );
});

test('rejects malformed zip archives instead of trusting uploaded data', () => {
  assert.throws(() => new WorkbookZip(te.encode('not a workbook')), /Invalid or unsupported/);
});

test('rejects formula-bearing ranking sheets to avoid breaking references', async () => {
  const files = fixtureFiles();
  files['xl/worksheets/sheet2.xml'] = files['xl/worksheets/sheet2.xml'].replace(
    '<c r="H10" s="82"><v>8</v></c>', '<c r="H10" s="82"><f>G10*2</f><v>8</v></c>'
  );
  const bytes = zipStored(files);
  await assert.rejects(() => inspectRankingWorkbook(bytes), /formulas/);
});

test('reads real XLSX-style raw-deflate ZIP entries and keeps them valid after export', async () => {
  const files = fixtureFiles();
  const zip = new WorkbookZip(zipStored(files));
  const part = 'xl/worksheets/sheet2.xml';
  const plain = te.encode(files[part]);
  const compressed = new Uint8Array(
    await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()
  );
  const originalEntry = zip.entries.get(part);
  zip.entries.set(part, {
    ...originalEntry, method: 8,
    compressed, crc: crc32(plain), uncompressedSize: plain.length
  });

  const deflated = new Uint8Array(await zip.toBlob().arrayBuffer());
  const inspected = await inspectRankingWorkbook(deflated);
  assert.equal(inspected.rows.length, 2);

  const output = await buildUpdatedRankingWorkbook(deflated, inspected, [
    { id: 'workbook_row_10', originalIndex: 0, currentPosition: 1, status: 'EXACT PAGE' }
  ], '2026-10-08');
  const exported = new WorkbookZip(await output.arrayBuffer());
  const xml = td.decode(await exported.read(part));
  assert.match(xml, /r="G10"/);
  assert.equal(exported.entries.get(part).method, 0);
  assert.equal(td.decode(await exported.read('xl/worksheets/sheet3.xml')), files['xl/worksheets/sheet3.xml']);
});

test('generic website workbook with custom sheet names and common SEO headers auto-imports', async () => {
  const files = fixtureFiles();
  files['xl/workbook.xml'] = files['xl/workbook.xml']
    .replace('Keyword Ranking', 'Agency Report')
    .replace('Client Information', 'Other Notes')
    .replace('GMB Ranking', 'Marketing');
  files['xl/sharedStrings.xml'] = files['xl/sharedStrings.xml']
    .replace('<t>Keywords</t>', '<t>Search Term</t>')
    .replace('<t>Landing Page</t>', '<t>Website</t>');
  const bytes = zipStored(files);
  const sheets = await listRankingWorkbookSheets(bytes);
  assert.deepEqual(sheets, ['Other Notes', 'Agency Report', 'Marketing']);
  const inspected = await inspectRankingWorkbook(bytes);
  assert.equal(inspected.sheetName, 'Agency Report');
  assert.equal(inspected.rows.length, 2);
  assert.equal(inspected.location.hasCoordinates, false);
  assert.equal(inspected.hasGmbSheet, false);
  assert.equal(inspected.rows[0].keyword, 'dryer vent cleaning');

  const output = await buildUpdatedRankingWorkbook(bytes, inspected,
    [{ id: 'workbook_row_10', currentPosition: 7, status: 'EXACT PAGE' }], '2026-10-08');
  const zip = new WorkbookZip(await output.arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  assert.equal(cellValue(c(doc, 'G10')), '7');
  assert.equal(td.decode(await zip.read('xl/worksheets/sheet1.xml')), files['xl/worksheets/sheet1.xml']);
});

test('manual worksheet and column mapping supports nonstandard header labels', async () => {
  const files = fixtureFiles();
  files['xl/workbook.xml'] = files['xl/workbook.xml'].replace('Keyword Ranking', 'Custom Client Site');
  files['xl/sharedStrings.xml'] = files['xl/sharedStrings.xml']
    .replace('<t>Keywords</t>', '<t>What people search for</t>')
    .replace('<t>Landing Page</t>', '<t>Page to track</t>');
  const bytes = zipStored(files);
  await assert.rejects(() => inspectRankingWorkbook(bytes), /choose/i);
  const inspected = await inspectRankingWorkbook(bytes, {
    sheetName: 'Custom Client Site',
    headerRow: 9,
    keywordColumn: 3,
    urlColumn: 6
  });
  assert.equal(inspected.sheetName, 'Custom Client Site');
  assert.equal(inspected.rows.length, 2);
  assert.deepEqual(inspected.rows.map(item => item.previousPosition), [4, '-']);
});

test('a new website workbook with no historical ranking dates accepts its first check', async () => {
  const files = fixtureFiles();
  files['xl/workbook.xml'] = files['xl/workbook.xml']
    .replace('Keyword Ranking', 'Site Keywords').replace('Client Information', 'Not Client Data');
  files['xl/worksheets/sheet2.xml'] = files['xl/worksheets/sheet2.xml']
    .replace(/<c r="G2"[^>]*><v>46300<\/v><\/c>/, '')
    .replace(/<c r="H2"[^>]*><v>46293<\/v><\/c>/, '')
    .replace(/<c r="G9"[^>]*><v>46300<\/v><\/c>/, '')
    .replace(/<c r="H9"[^>]*><v>46293<\/v><\/c>/, '');
  const bytes = zipStored(files);
  const inspected = await inspectRankingWorkbook(bytes);
  assert.equal(inspected.latestDate, null);
  assert.equal(inspected.header.latestColumn, null);
  assert.equal(inspected.header.firstRankColumn, 7);
  assert.deepEqual(inspected.rows.map(item => item.previousPosition), ['-', '-']);
  const output = await buildUpdatedRankingWorkbook(bytes, inspected,
    [{ id: 'workbook_row_10', status: 'EXACT PAGE', currentPosition: 1 }], '2026-10-08');
  const zip = new WorkbookZip(await output.arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  assert.equal(cellValue(c(doc, 'G9')), '46303');
  assert.equal(cellValue(c(doc, 'G10')), '1');
});

test('selecting a worksheet without ranking columns fails clearly', async () => {
  const { bytes } = await fixture();
  await assert.rejects(
    () => inspectRankingWorkbook(bytes, { sheetName: 'GMB Ranking' }),
    /keyword and website URL columns/i
  );
});

test('workbook import refuses unsupported formula sheets before spending time checking keywords', async () => {
  const files = fixtureFiles();
  files['xl/worksheets/sheet2.xml'] = files['xl/worksheets/sheet2.xml']
    .replace('<autoFilter ', '<conditionalFormatting sqref="G10:G11"><cfRule type="expression" priority="1"/></conditionalFormatting><autoFilter ');
  await assert.rejects(() => inspectRankingWorkbook(zipStored(files)), /advanced cell references/);
});

test('export never assigns a result to a different keyword/URL row based on index alone', async () => {
  const { bytes, inspected } = await fixture();
  const results = [
    { id: 'workbook_row_10', originalIndex: 0, keyword: 'unrelated keyword',
      targetUrl: 'https://wrong.example/', currentPosition: 1, status: 'EXACT PAGE' },
    { id: 'workbook_row_11', originalIndex: 0, keyword: 'dryer vent cleaning',
      targetUrl: 'https://example.com/repair', currentPosition: 12, status: 'EXACT PAGE' }
  ];
  const blob = await buildUpdatedRankingWorkbook(bytes, inspected, results, '2026-10-08');
  const zip = new WorkbookZip(await blob.arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  assert.equal(cellValue(c(doc, 'G10')), 'NOT CHECKED');
  assert.equal(cellValue(c(doc, 'G11')), '12');
});

test('id-less legacy results require matching row index, keyword AND target page', async () => {
  const { bytes, inspected } = await fixture();
  const results = [
    { originalIndex: 1, keyword: 'dryer vent cleaning',
      targetUrl: 'https://example.com/vent', currentPosition: 1, status: 'EXACT PAGE' },
    { originalIndex: 0, keyword: 'dryer vent cleaning',
      targetUrl: 'https://example.com/vent', currentPosition: 9, status: 'EXACT PAGE' }
  ];
  const blob = await buildUpdatedRankingWorkbook(bytes, inspected, results, '2026-10-08');
  const zip = new WorkbookZip(await blob.arrayBuffer());
  const doc = new DOMParser().parseFromString(td.decode(await zip.read('xl/worksheets/sheet2.xml')), 'text/xml');
  assert.equal(cellValue(c(doc, 'G10')), '9');
  assert.equal(cellValue(c(doc, 'G11')), 'NOT CHECKED');
});

test('blank client latitude or longitude does not silently become 0,0', async () => {
  const files = fixtureFiles();
  files['xl/worksheets/sheet1.xml'] = files['xl/worksheets/sheet1.xml']
    .replace('<v>34.1478</v>', '<v></v>');
  const inspected = await inspectRankingWorkbook(zipStored(files));
  assert.equal(inspected.location.hasCoordinates, false);
  assert.equal(inspected.location.latitude, '');
  assert.equal(inspected.location.longitude, '');
});
