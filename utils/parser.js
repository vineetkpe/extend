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
 * Validates whether a token represents a ranking position.
 * Accepts: 1-100, >100, 100+, <10, -, —, n/a, not found, none, error.
 * @param {string} str 
 * @returns {boolean}
 */
export function isPositionToken(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (/^>?[0-9]+\+?$/i.test(s)) return true;
  if (/^<[0-9]+$/i.test(s)) return true;
  if (/^[-—]$/.test(s)) return true;
  if (/^(n\/?a|not found|none|error)$/i.test(s)) return true;
  return false;
}

/**
 * Normalizes a target URL or raw domain to a valid, clean web URL with scheme.
 * Examples:
 * - "getpromptoptimizer.com" => "https://getpromptoptimizer.com/"
 * - "example.com/page" => "https://example.com/page"
 * - "http://example.com" => "http://example.com/"
 * 
 * @param {string} raw 
 * @returns {string}
 */
export function normalizeTargetUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim();

  // Strip wrapping quotes
  trimmed = trimmed.replace(/^["']+|["']+$/g, '');

  // Add https:// if scheme is missing
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = 'https://' + trimmed;
  }

  // If URL has no path, append trailing slash
  try {
    const u = new URL(trimmed);
    if (!u.pathname || u.pathname === '') {
      u.pathname = '/';
    }
    return u.toString();
  } catch (_) {
    if (!trimmed.slice(8).includes('/')) {
      return trimmed + '/';
    }
    return trimmed;
  }
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
  if (!str || str === '-' || str === '—' || /^(n\/?a|not found|none)$/i.test(str)) return '-';

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
 * Splits a line by delimiter while respecting double-quoted segments.
 * @param {string} str 
 * @param {string} delimiter 
 * @returns {Array<string>}
 */
function splitRespectingQuotes(str, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Smart single line parser using Right-to-Left extraction.
 * 
 * Supports all formats automatically without requiring delimiter selection:
 * 1. prompt optimizer <TAB> https://getpromptoptimizer.com/ <TAB> 89
 * 2. prompt optimizer, https://getpromptoptimizer.com/, 89
 * 3. prompt optimizer | https://getpromptoptimizer.com/ | 89
 * 4. prompt optimizer; https://getpromptoptimizer.com/; 89
 * 5. prompt optimizer https://getpromptoptimizer.com/ 89 (space separated)
 * 6. prompt optimizer getpromptoptimizer.com 89 (auto normalizes domain)
 * 7. prompt optimizer https://getpromptoptimizer.com/ (omitted position)
 * 
 * Preserves multi-word keywords with unlimited spaces exactly.
 * 
 * @param {string} line 
 * @returns {{ keyword: string, targetUrl: string, previousPosition: number|string } | { error: string, isHeader?: boolean }}
 */
export function parseSingleLine(line) {
  if (!line || typeof line !== 'string') {
    return { error: 'Empty line' };
  }

  let text = line.trim();
  if (!text) return { error: 'Empty line' };

  // Detect and skip header row
  const lower = text.toLowerCase();
  if (lower.startsWith('keyword') && (lower.includes('url') || lower.includes('domain') || lower.includes('position'))) {
    return { isHeader: true };
  }

  // 1. Try explicit delimiters (TAB, pipe, semicolon, comma)
  let delimiter = null;
  if (text.includes('\t')) delimiter = '\t';
  else if (text.includes('|')) delimiter = '|';
  else if (text.includes(';')) delimiter = ';';
  else if (text.includes(',')) delimiter = ',';

  if (delimiter) {
    const rawParts = splitRespectingQuotes(text, delimiter)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (rawParts.length >= 2) {
      let kw = '';
      let rawUrl = '';
      let rawPos = '-';

      if (rawParts.length >= 3) {
        if (isPositionToken(rawParts[rawParts.length - 1])) {
          rawPos = rawParts[rawParts.length - 1];
          rawUrl = rawParts[rawParts.length - 2];
          kw = rawParts.slice(0, rawParts.length - 2).join(' ');
        } else {
          rawUrl = rawParts[rawParts.length - 1];
          kw = rawParts.slice(0, rawParts.length - 1).join(' ');
        }
      } else if (rawParts.length === 2) {
        kw = rawParts[0];
        rawUrl = rawParts[1];
      }

      kw = kw.replace(/^["']+|["']+$/g, '').trim();
      rawUrl = rawUrl.replace(/^["']+|["']+$/g, '').trim();

      if (kw && isValidUrlOrDomain(rawUrl)) {
        return {
          keyword: kw,
          targetUrl: normalizeTargetUrl(rawUrl),
          previousPosition: normalizePreviousPosition(rawPos)
        };
      }
    }
  }

  // 2. Right-to-Left fallback (for space-separated or mixed delimiters)
  text = text.replace(/^[|;, \t]+|[|;, \t]+$/g, '');

  let rawPosition = '-';
  let rawUrl = '';
  let rawKeyword = '';

  // Step A: Extract rightmost position token if present
  const posRegex = /(?:[\s,;|]+)(>100|100\+|<[0-9]+|[0-9]+|[-—]|n\/?a|not found)$/i;
  const posMatch = text.match(posRegex);

  let textBeforePos = text;
  if (posMatch) {
    rawPosition = posMatch[1];
    textBeforePos = text.slice(0, posMatch.index).trim();
  }

  textBeforePos = textBeforePos.replace(/[|;, \t]+$/g, '');

  // Step B: Extract target URL / domain token from the right
  const tokens = textBeforePos.split(/[\s,;|]+/);
  if (tokens.length >= 2) {
    const candidateUrl = tokens[tokens.length - 1];
    if (isValidUrlOrDomain(candidateUrl)) {
      rawUrl = candidateUrl;
      const urlIdx = textBeforePos.lastIndexOf(candidateUrl);
      rawKeyword = textBeforePos.slice(0, urlIdx).replace(/^[|;, \t]+|[|;, \t]+$/g, '');
    }
  }

  if (!rawUrl) {
    const urlMatch = textBeforePos.match(/(https?:\/\/[^\s,;|]+|www\.[^\s,;|]+|[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+[\w\-\._~:\/?#[\]@!$&'()*+,;=]*)$/i);
    if (urlMatch && isValidUrlOrDomain(urlMatch[1])) {
      rawUrl = urlMatch[1];
      rawKeyword = textBeforePos.slice(0, urlMatch.index).replace(/^[|;, \t]+|[|;, \t]+$/g, '');
    }
  }

  rawKeyword = rawKeyword.replace(/^["']+|["']+$/g, '').trim();

  if (!rawKeyword || !rawUrl || !isValidUrlOrDomain(rawUrl)) {
    return {
      error: 'Could not understand this row. Please check keyword, URL and previous position.'
    };
  }

  return {
    keyword: rawKeyword,
    targetUrl: normalizeTargetUrl(rawUrl),
    previousPosition: normalizePreviousPosition(rawPosition)
  };
}

/**
 * Parses raw input text pasted from Excel (TSV), CSV, or space-separated rows.
 * Preserves multi-word keywords and auto-normalizes domains.
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
    if (!trimmedLine) return; // Skip blank lines

    const parsed = parseSingleLine(trimmedLine);
    if (parsed.isHeader) {
      return; // Skip header row
    }

    if (parsed.error) {
      errors.push({
        line: lineNum,
        raw: trimmedLine,
        message: parsed.error
      });
      return;
    }

    valid.push({
      id: `row_${lineNum}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      originalIndex: valid.length,
      line: lineNum,
      keyword: parsed.keyword,
      targetUrl: parsed.targetUrl,
      previousPosition: parsed.previousPosition
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
