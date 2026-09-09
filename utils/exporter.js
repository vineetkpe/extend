/**
 * exporter.js
 * Utilities to export rank checking results to Excel-friendly TSV (clipboard)
 * and downloadable CSV files.
 */

/**
 * Escapes a field for CSV export according to RFC 4180.
 * @param {*} val 
 * @returns {string}
 */
function escapeCsvField(val) {
  if (val === undefined || val === null) return '""';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

/**
 * Cleans a field for TSV clipboard export (Excel compatible).
 * Removes line breaks and tab characters to prevent breaking columns/rows.
 * @param {*} val 
 * @returns {string}
 */
function cleanTsvField(val) {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\t/g, ' ')
    .trim();
}

/**
 * Generates tab-separated values (TSV) from results for direct Excel paste.
 * @param {Array<object>} results 
 * @returns {string}
 */
export function exportToTsv(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }

  const headers = [
    'Keyword',
    'Target URL',
    'Previous Position',
    'Current Position',
    'Change',
    'Match Type',
    'Status',
    'Checked Depth'
  ];

  const rows = results.map(r => [
    cleanTsvField(r.keyword),
    cleanTsvField(r.targetUrl),
    cleanTsvField(r.previousPosition),
    cleanTsvField(r.currentPosition !== null && r.currentPosition !== undefined ? r.currentPosition : 'Not Found'),
    cleanTsvField(r.change),
    cleanTsvField(r.matchStatus || r.status),
    cleanTsvField(r.status),
    cleanTsvField(r.checkedDepth || 0)
  ].join('\t'));

  return [headers.join('\t'), ...rows].join('\n');
}

/**
 * Generates CSV string from results.
 * @param {Array<object>} results 
 * @returns {string}
 */
export function exportToCsv(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }

  const headers = [
    'keyword',
    'target_url',
    'previous_position',
    'current_position',
    'change',
    'match_status',
    'status',
    'checked_depth',
    'found_url',
    'checked_at'
  ];

  const rows = results.map(r => [
    escapeCsvField(r.keyword),
    escapeCsvField(r.targetUrl),
    escapeCsvField(r.previousPosition),
    escapeCsvField(r.currentPosition !== null && r.currentPosition !== undefined ? r.currentPosition : 'Not Found'),
    escapeCsvField(r.change),
    escapeCsvField(r.matchStatus),
    escapeCsvField(r.status),
    escapeCsvField(r.checkedDepth || 0),
    escapeCsvField(r.foundUrl || ''),
    escapeCsvField(r.checkedAt || new Date().toISOString())
  ].join(','));

  return [headers.join(','), ...rows].join('\r\n');
}
