/**
 * Imports a weekly SEO workbook and updates only its ORGANIC "Keyword Ranking"
 * sheet. Preserves other tabs, original ZIP parts and historical rank columns.
 * No workbook bytes leave the browser or enter chrome.storage.*.
 */
import { WorkbookZip } from './workbookZip.js';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function xmlChildren(parent, tag) {
  return Array.from(parent?.childNodes || []).filter(child =>
    child.nodeType === 1 && child.localName === tag
  );
}
function allElements(root, tag) {
  return Array.from(root.getElementsByTagNameNS(MAIN_NS, tag));
}
function parseXml(source, context) {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid workbook XML: ' + context);
  }
  return doc;
}
async function readXml(zip, path) {
  return parseXml(decoder.decode(await zip.read(path)), path);
}
function sheetPath(workbook, rels, sheetName) {
  const sheet = allElements(workbook, 'sheet').find(node => node.getAttribute('name') === sheetName);
  if (!sheet) throw new Error('Workbook is missing the "' + sheetName + '" tab.');
  const id = sheet.getAttributeNS(REL_NS, 'id') || sheet.getAttribute('r:id');
  const relation = Array.from(rels.getElementsByTagName('*'))
    .find(node => node.localName === 'Relationship' && node.getAttribute('Id') === id);
  if (!relation) throw new Error('Cannot locate worksheet data for ' + sheetName);
  const path = new URL(relation.getAttribute('Target'), 'https://xlsx.invalid/xl/').pathname.slice(1);
  if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) throw new Error('Invalid workbook worksheet path.');
  return path;
}
function columnNumber(reference) {
  const part = String(reference || '').match(/^\$?([A-Z]+)/i);
  if (!part) return 0;
  let col = 0;
  for (const ch of part[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return col;
}
function columnLetters(index) {
  if (!Number.isInteger(index) || index < 1 || index > 16384) {
    throw new Error('XLSX column limit exceeded.');
  }
  let chars = '';
  while (index) { index--; chars = String.fromCharCode(65 + index % 26) + chars; index = Math.floor(index / 26); }
  return chars;
}
function directCells(row) {
  return xmlChildren(row, 'c');
}
function cellsByColumn(row) {
  return new Map(directCells(row).map(cell => [columnNumber(cell.getAttribute('r')), cell]));
}
function cellValue(cell, sharedStrings) {
  if (!cell) return null;
  const kind = cell.getAttribute('t');
  if (kind === 'inlineStr') return allElements(cell, 't').map(node => node.textContent).join('');
  const value = xmlChildren(cell, 'v')[0]?.textContent;
  if (kind === 's') return sharedStrings[Number(value)] ?? '';
  if (kind === 'str' || kind === 'e') return value ?? '';
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}
async function sharedStringsFor(zip) {
  if (!zip.has('xl/sharedStrings.xml')) return [];
  const doc = await readXml(zip, 'xl/sharedStrings.xml');
  return allElements(doc, 'si').map(si => allElements(si, 't').map(t => t.textContent).join(''));
}
function getHeaderMapping(sheet, strings) {
  const rows = allElements(sheet, 'row');
  for (const row of rows) {
    const byColumn = cellsByColumn(row);
    let keywordColumn = 0, urlColumn = 0;
    for (const [column, cell] of byColumn) {
      const val = String(cellValue(cell, strings) ?? '').trim().toLowerCase();
      if (val === 'keywords' || val === 'keyword') keywordColumn = column;
      if (val === 'landing page' || val === 'target url') urlColumn = column;
    }
    if (!keywordColumn || !urlColumn) continue;
    const dates = Array.from(byColumn, ([column, cell]) => ({
      column, date: cellValue(cell, strings)
    })).filter(item => item.column > urlColumn &&
      typeof item.date === 'number' && item.date > 40000 && item.date < 70000);
    if (!dates.length) throw new Error('Keyword Ranking has no dated ranking-history columns.');
    dates.sort((a, b) => b.date - a.date);
    const latest = dates[0];
    return {
      headerRow: Number(row.getAttribute('r')),
      keywordColumn,
      urlColumn,
      firstRankColumn: Math.min(...dates.map(d => d.column)),
      latestColumn: latest.column,
      latestDateSerial: latest.date
    };
  }
  throw new Error('Could not find Keywords and Landing Page headers in the Keyword Ranking tab.');
}
function excelSerial(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) throw new Error('Select a valid YYYY-MM-DD ranking date.');
  const timestamp = Date.parse(dateString + 'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== dateString) {
    throw new Error('Select a valid ranking date.');
  }
  return Math.floor(timestamp / 86400000) + 25569;
}
function excelDate(serial) {
  return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
}
function getClientLocation(clientDoc, strings) {
  const values = {};
  for (const row of allElements(clientDoc, 'row')) {
    const cells = cellsByColumn(row);
    const label = String(cellValue(cells.get(2), strings) || '').toLowerCase().trim();
    const val = cellValue(cells.get(3), strings);
    if (label) values[label] = val;
  }
  const matching = predicate => Object.entries(values).find(([k]) => predicate(k))?.[1];
  const latitude = Number(matching(k => /^lat(?:itude)?\b/.test(k)));
  const longitude = Number(matching(k => /^(?:long|longitude|lng)\b/.test(k)));
  const valid = Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
  return {
    locationName: String(matching(k => k.startsWith('address')) || ''),
    latitude: valid ? String(latitude) : '',
    longitude: valid ? String(longitude) : '',
    hasCoordinates: valid
  };
}
function normalizePrevious(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return '-';
}

/**
 * Returns per-row queue entries plus only the workbook metadata needed for
 * updating a later export. Does not store/return unrelated tabs or client data.
 */
export async function inspectRankingWorkbook(bytes) {
  const zip = new WorkbookZip(bytes);
  const workbook = await readXml(zip, 'xl/workbook.xml');
  const rels = await readXml(zip, 'xl/_rels/workbook.xml.rels');
  const strings = await sharedStringsFor(zip);
  const organicPath = sheetPath(workbook, rels, 'Keyword Ranking');
  const organic = await readXml(zip, organicPath);
  const header = getHeaderMapping(organic, strings);
  const rows = [];
  for (const row of allElements(organic, 'row')) {
    const rowNumber = Number(row.getAttribute('r'));
    if (rowNumber <= header.headerRow) continue;
    const cells = cellsByColumn(row);
    const keyword = String(cellValue(cells.get(header.keywordColumn), strings) ?? '').trim();
    const url = String(cellValue(cells.get(header.urlColumn), strings) ?? '').trim();
    if (!keyword || !url || !/^https?:\/\//i.test(url)) continue;
    const previousPosition = normalizePrevious(cellValue(cells.get(header.latestColumn), strings));
    rows.push({
      id: 'workbook_row_' + rowNumber,
      originalIndex: rows.length,
      sheetRow: rowNumber,
      keyword,
      targetUrl: url,
      previousPosition
    });
  }
  if (!rows.length) throw new Error('No keyword + landing-page pairs were found.');
  const clientPath = sheetPath(workbook, rels, 'Client Information');
  const clientDoc = await readXml(zip, clientPath);
  const location = getClientLocation(clientDoc, strings);
  const hasGmbSheet = allElements(workbook, 'sheet').some(
    node => node.getAttribute('name') === 'GMB Ranking'
  );
  return {
    rows,
    location,
    hasGmbSheet,
    latestDate: excelDate(header.latestDateSerial),
    latestDateSerial: header.latestDateSerial,
    organicSheet: organicPath,
    header
  };
}
function setCellValue(doc, cell, value) {
  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === 1 && ['v', 'is', 'f'].includes(child.localName)) {
      cell.removeChild(child);
    }
  }
  if (value === null || value === undefined) {
    cell.removeAttribute('t');
    return;
  }
  if (typeof value === 'number') {
    cell.removeAttribute('t');
    const v = doc.createElementNS(MAIN_NS, 'v');
    v.textContent = String(value);
    cell.appendChild(v);
  } else {
    cell.setAttribute('t', 'inlineStr');
    const container = doc.createElementNS(MAIN_NS, 'is');
    const t = doc.createElementNS(MAIN_NS, 't');
    t.textContent = String(value);
    container.appendChild(t);
    cell.appendChild(container);
  }
}
function assertSafeToInsert(sheet, firstColumn) {
  // Don't risk corrupting workbooks with formulas or references that need
  // Excel's column-insertion formula rewriting.
  if (allElements(sheet, 'f').length || allElements(sheet, 'tablePart').length) {
    throw new Error('This workbook uses formulas/tables in Keyword Ranking; safe column insertion is not supported.');
  }
  const sheetsWithReferences = ['conditionalFormatting', 'dataValidation', 'hyperlink'];
  if (sheetsWithReferences.some(tag => allElements(sheet, tag).length)) {
    throw new Error('Keyword Ranking contains advanced cell references; please export CSV or use a simpler workbook.');
  }
  for (const merge of allElements(sheet, 'mergeCell')) {
    const range = merge.getAttribute('ref') || '';
    const parts = range.split(':');
    const first = columnNumber(parts[0]), last = columnNumber(parts[1] || parts[0]);
    if (first < firstColumn && last >= firstColumn) {
      throw new Error('Merged cells cross the new ranking column; cannot insert safely.');
    }
  }
}
function shiftReference(ref, firstColumn) {
  return String(ref || '').replace(/\$?([A-Z]{1,3})\$?(\d+)/gi, whole =>
    columnNumber(whole) >= firstColumn
      ? whole.replace(/[A-Z]{1,3}/i, match => columnLetters(columnNumber(match) + 1))
      : whole
  );
}
function createNewDateCell(doc, row, firstColumn) {
  const rowNumber = Number(row.getAttribute('r'));
  const nextCell = directCells(row).find(cell => columnNumber(cell.getAttribute('r')) === firstColumn + 1);
  const cell = doc.createElementNS(MAIN_NS, 'c');
  cell.setAttribute('r', columnLetters(firstColumn) + rowNumber);
  if (nextCell?.hasAttribute('s')) cell.setAttribute('s', nextCell.getAttribute('s'));
  if (nextCell) row.insertBefore(cell, nextCell);
  else row.appendChild(cell);
  return cell;
}
function rankingValue(result) {
  if (!result) return 'NOT CHECKED';
  if (result.status === 'ERROR' || result.matchStatus === 'ERROR') return 'ERROR';
  if (typeof result.currentPosition === 'number' &&
      Number.isFinite(result.currentPosition) && result.currentPosition > 0) {
    return result.currentPosition;
  }
  if (['TARGET PAGE NOT FOUND', 'Not Found'].includes(result.status) ||
      result.currentPosition === 'Not Found') return 'NA';
  return 'NOT CHECKED';
}

/**
 * Creates a downloadable UPDATED COPY of the uploaded workbook.
 * Existing weekly history shifts one column right, a new date enters at the
 * left of the history, and only organic keyword result rows receive ranks.
 */
export async function buildUpdatedRankingWorkbook(bytes, inspected, results, asOfDate) {
  const dateValue = excelSerial(asOfDate);
  if (dateValue <= inspected.latestDateSerial) {
    throw new Error('The new check date must be later than the latest existing ranking date (' + inspected.latestDate + ').');
  }
  const zip = new WorkbookZip(bytes);
  const sheet = await readXml(zip, inspected.organicSheet);
  const { firstRankColumn, headerRow, latestDateSerial } = inspected.header;
  assertSafeToInsert(sheet, firstRankColumn);
  const resultsById = new Map((results || []).filter(Boolean).map(r => [String(r.id), r]));
  const resultsByIndex = new Map((results || []).filter(Boolean).map((r, i) => [
    Number.isInteger(r.originalIndex) ? r.originalIndex : i, r
  ]));
  const rowToResult = new Map(inspected.rows.map((item, i) => [
    item.sheetRow, resultsById.get(item.id) || resultsByIndex.get(i)
  ]));

  for (const row of allElements(sheet, 'row')) {
    const rowNumber = Number(row.getAttribute('r'));
    const currentCells = directCells(row);
    // Move cells from right to left without changing their element order/styles.
    const oldFirst = currentCells.find(cell => columnNumber(cell.getAttribute('r')) === firstRankColumn);
    const oldFirstValue = cellValue(oldFirst, []);
    for (const cell of currentCells) {
      const col = columnNumber(cell.getAttribute('r'));
      if (col >= firstRankColumn) cell.setAttribute('r', columnLetters(col + 1) + rowNumber);
    }

    // Add a styled blank/date/rank cell where the original first week lived.
    if (oldFirst || rowNumber === headerRow || rowToResult.has(rowNumber)) {
      const cell = createNewDateCell(sheet, row, firstRankColumn);
      if (rowNumber === headerRow ||
          (rowNumber < headerRow && oldFirstValue === latestDateSerial)) {
        setCellValue(sheet, cell, dateValue);
      } else if (rowToResult.has(rowNumber)) {
        setCellValue(sheet, cell, rankingValue(rowToResult.get(rowNumber)));
      }
    }
  }

  // Keep merged ranges and explicit column widths aligned when they lie to
  // the right of the insertion point. Merges crossing the boundary were
  // rejected above.
  for (const merge of allElements(sheet, 'mergeCell')) {
    merge.setAttribute('ref', shiftReference(merge.getAttribute('ref'), firstRankColumn));
  }
  for (const col of allElements(sheet, 'col')) {
    const first = Number(col.getAttribute('min')), last = Number(col.getAttribute('max'));
    if (first >= firstRankColumn) {
      col.setAttribute('min', String(first + 1));
      col.setAttribute('max', String(last + 1));
    } else if (last >= firstRankColumn) {
      throw new Error('A column formatting span crosses the ranking history boundary.');
    }
  }
  for (const dimension of allElements(sheet, 'dimension')) {
    dimension.setAttribute('ref', shiftReference(dimension.getAttribute('ref'), firstRankColumn));
  }
  // Preserve workbook filters and existing sort conditions when shifting
  // historical ranking columns (e.g. a sort originally on G92:G97).
  for (const filter of allElements(sheet, 'autoFilter')) {
    const nodes = [filter, ...Array.from(filter.getElementsByTagName('*'))];
    for (const node of nodes) {
      if (node.hasAttribute('ref')) {
        node.setAttribute('ref', shiftReference(node.getAttribute('ref'), firstRankColumn));
      }
    }
  }

  zip.replace(inspected.organicSheet, encoder.encode(new XMLSerializer().serializeToString(sheet)));
  return zip.toBlob();
}
