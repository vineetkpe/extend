/**
 * parser.js
 * Parses and validates user input (Excel TSV, CSV) and calculates rank change.
 */

/**
 * Validates whether a string resembles a valid URL or web domain.
 * @param {string} str 
 * @returns {boolean}
 */
export function isValidUrlOrDomain(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (trimmed.length < 3) return false;

  // Strict URL security: reject dangerous schemes
  if (/^(javascript|data|file|chrome|chrome-extension|about|blob|vbscript):/i.test(trimmed)) {
    return false;
  }

  // If starts with scheme, only allow http: and https:
  if (/^[a-zA-Z0-9+.-]+:\/\//.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) {
      return false;
    }
    try {
      const u = new URL(trimmed);
      return Boolean(u.hostname && u.hostname.includes('.'));
    } catch {
      return false;
    }
  }

  // If domain or domain/path, ensure it contains at least one dot and valid hostname characters
  const domainPart = trimmed.split('/')[0].split('?')[0];
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return domainRegex.test(domainPart);
}

/**
 * Normalizes previous position value.
 * Accepts: 1-100, ">100", "100+", "-", or empty.
 * @param {string|number} val 
 * @returns {number|string} parsed position number or string representation
 */
export function normalizePreviousPosition(val) {
  if (val === undefined || val === null) return '-';
  const str = String(val).trim();
  if (!str || str === '-') return '-';

  if (/^>100$/i.test(str) || /^100\+$/i.test(str)) {
    return '>100';
  }

  const num = parseInt(str, 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  return str;
}

/**
 * Parses raw input text pasted from Excel (TSV) or CSV.
 * Format per line: keyword [tab/comma] target_url [tab/comma] previous_position
 * 
 * @param {string} text 
 * @returns {{ valid: Array<object>, errors: Array<object> }}
 */
export function parseInputRows(text) {
  if (!text || typeof text !== 'string') {
    return { valid: [], errors: [] };
  }

  const lines = text.split(/\r?\n/);
  const valid = [];
  const errors = [];

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    const trimmedLine = line.trim();
    if (!trimmedLine) return; // Ignore blank lines

    // Detect delimiter: tab takes precedence
    let parts = [];
    if (trimmedLine.includes('\t')) {
      parts = trimmedLine.split('\t').map(p => p.trim());
    } else if (trimmedLine.includes(',')) {
      // Basic CSV split ignoring commas inside quotes
      const matches = trimmedLine.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g);
      if (matches) {
        parts = matches.map(m => m.replace(/^"|"$/g, '').trim());
      } else {
        parts = trimmedLine.split(',').map(p => p.trim());
      }
    } else {
      // Fallback: split by multiple spaces (e.g. 2 or more spaces)
      parts = trimmedLine.split(/\s{2,}/).map(p => p.trim());
    }

    // Must have at least keyword and target_url
    if (parts.length < 2) {
      errors.push({
        line: lineNum,
        raw: trimmedLine,
        message: 'Must contain at least keyword and target URL (separated by tab or comma).'
      });
      return;
    }

    const keyword = parts[0];
    const targetUrl = parts[1];
    const rawPrevPos = parts[2] !== undefined ? parts[2] : '-';

    if (!keyword) {
      errors.push({
        line: lineNum,
        raw: trimmedLine,
        message: 'Keyword cannot be empty.'
      });
      return;
    }

    if (!isValidUrlOrDomain(targetUrl)) {
      errors.push({
        line: lineNum,
        raw: trimmedLine,
        message: `Invalid target URL or domain: "${targetUrl}".`
      });
      return;
    }

    const previousPosition = normalizePreviousPosition(rawPrevPos);

    valid.push({
      id: `row_${lineNum}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      line: lineNum,
      keyword,
      targetUrl,
      previousPosition
    });
  });

  return { valid, errors };
}

/**
 * Calculates ranking change representation.
 * Ranking #1 is better than ranking #10.
 * 
 * Rules:
 * Previous: 8, Current: 4  => "↑ 4"
 * Previous: 4, Current: 9  => "↓ 5"
 * Previous: 5, Current: 5  => "—"
 * Previous: 8, Current: Not Found => "↓"
 * Previous: >100, Current: 15 => "↑"
 * Previous: >100, Current: Not Found => "—"
 * 
 * @param {number|string} prevPos 
 * @param {number|string|null} currPos 
 * @returns {string} Change indicator: e.g. "↑ 4", "↓ 5", "—", "↑", "↓"
 */
export function calculateChange(prevPos, currPos) {
  const isCurrNumeric = typeof currPos === 'number' && !isNaN(currPos);
  const isPrevNumeric = typeof prevPos === 'number' && !isNaN(prevPos);

  if (isCurrNumeric && isPrevNumeric) {
    const diff = prevPos - currPos;
    if (diff > 0) {
      return `↑ ${diff}`;
    } else if (diff < 0) {
      return `↓ ${Math.abs(diff)}`;
    } else {
      return '—';
    }
  }

  // If current is numeric, but previous was not found or >100
  if (isCurrNumeric) {
    return '↑';
  }

  // If current is NOT found / error
  if (!isCurrNumeric) {
    if (isPrevNumeric) {
      // It had a position previously, but now not found
      return '↓';
    } else {
      // Neither had a numeric position
      return '—';
    }
  }

  return '—';
}
