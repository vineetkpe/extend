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
    'Checked Depth',
    'Other Domain Page'
  ];

  const rows = results.map(r => {
    let otherDomainStr = '';
    if (r.otherPageFound) {
      otherDomainStr = `${r.otherPageFound} (pos ${r.otherPagePosition || '?'})`;
    }

    const currentDisplay = r.displayPosition || (r.currentPosition !== null && r.currentPosition !== undefined ? r.currentPosition : 'Not Found');

    return [
      cleanTsvField(r.keyword),
      cleanTsvField(r.targetUrl),
      cleanTsvField(r.previousPosition),
      cleanTsvField(currentDisplay),
      cleanTsvField(r.change),
      cleanTsvField(r.matchStatus || r.status),
      cleanTsvField(r.status),
      cleanTsvField(r.checkedDepth || 0),
      cleanTsvField(otherDomainStr)
    ].join('\t');
  });

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
    'other_domain_page',
    'checked_at'
  ];

  const rows = results.map(r => {
    let otherDomainStr = '';
    if (r.otherPageFound) {
      otherDomainStr = `${r.otherPageFound} (pos ${r.otherPagePosition || '?'})`;
    }

    const currentDisplay = r.displayPosition || (r.currentPosition !== null && r.currentPosition !== undefined ? r.currentPosition : 'Not Found');

    return [
      escapeCsvField(r.keyword),
      escapeCsvField(r.targetUrl),
      escapeCsvField(r.previousPosition),
      escapeCsvField(currentDisplay),
      escapeCsvField(r.change),
      escapeCsvField(r.matchStatus),
      escapeCsvField(r.status),
      escapeCsvField(r.checkedDepth || 0),
      escapeCsvField(r.foundUrl || ''),
      escapeCsvField(otherDomainStr),
      escapeCsvField(r.checkedAt || new Date().toISOString())
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\r\n');
}

/**
 * Generates a single column of current positions in exact row order for pasting into existing Excel sheets.
 * Exact rank: 4
 * Not found: NOT FOUND
 * Error: ERROR
 * Not checked: NOT CHECKED
 * @param {Array<object>} results 
 * @returns {string}
 */
export function exportToCurrentPositionsOnly(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }

  return results.map(r => {
    if (!r) return 'NOT CHECKED';
    if (r.status === 'ERROR' || r.currentPosition === 'Error') return 'ERROR';
    if (r.status === 'NOT CHECKED' || r.currentPosition === 'NOT CHECKED' || r.currentPosition === '—' || r.currentPosition === null || r.currentPosition === undefined) {
      return 'NOT CHECKED';
    }
    if (typeof r.currentPosition === 'number' || (!isNaN(Number(r.currentPosition)) && r.currentPosition !== '')) {
      return String(r.currentPosition);
    }
    return 'NOT FOUND';
  }).join('\n');
}

/**
 * Sanitizes a project name for use in filenames (e.g. "Prompt Optimizer" -> "prompt-optimizer").
 * @param {string} name 
 * @returns {string}
 */
export function sanitizeProjectFilename(name) {
  if (!name) return 'project';
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

/**
 * Copies text to the system clipboard with robust cross-browser fallbacks.
 * @param {string} text 
 * @returns {Promise<boolean>}
 */
export async function copyToClipboard(text) {
  if (typeof text !== 'string') {
    text = String(text || '');
  }

  // 1. Try modern navigator.clipboard API
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // Fall back to execCommand if permission denied or unavailable
  }

  // 2. Fallback using temporary textarea
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return Boolean(success);
  } catch (err) {
    console.error('Failed to copy to clipboard:', err);
    return false;
  }
}

/**
 * Triggers a browser download of a CSV file using a Blob object URL.
 * @param {string} csvContent 
 * @param {string} filename 
 */
export function downloadCsv(csvContent, filename) {
  try {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'rank_results.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  } catch (err) {
    console.error('Failed to download CSV:', err);
  }
}

