import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/serp-layouts.json', import.meta.url), 'utf8'));
const parserSource = fs.readFileSync(new URL('../content/serpParser.js', import.meta.url), 'utf8');

// Minimal DOM implementation that exercises the actual content-script parser.
// Fixtures describe the same structural hierarchy and attributes as an HTML SERP,
// with no npm dependencies or reliance on a live Google response.
class MockElement {
  constructor(node, parent = null) {
    this.tag = (node.tag || 'div').toLowerCase();
    this.id = node.id || '';
    this.classes = (node.class || '').split(/\s+/).filter(Boolean);
    this.attrs = { ...(node.attrs || {}) };
    if (node.href !== undefined) this.attrs.href = node.href;
    this.parent = parent;
    this.text = node.text || '';
    this.children = (node.children || []).map(child => new MockElement(child, this));
  }
  get href() { return this.attrs.href || ''; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  matches(selector) {
    const match = selector.match(/^([a-z][\w-]*)?(#[\w-]+|\.[\w-]+|\[[^\]]+\])?$/i);
    if (!match) throw new Error('Unsupported test selector: ' + selector);
    const [, tag, suffix] = match;
    if (tag && tag.toLowerCase() !== this.tag) return false;
    if (!suffix) return true;
    if (suffix.startsWith('#')) return this.id === suffix.slice(1);
    if (suffix.startsWith('.')) return this.classes.includes(suffix.slice(1));
    const attr = suffix.match(/^\[([\w-]+)(\*?=)"([^"]*)"\]$/);
    if (attr) {
      const value = this.attrs[attr[1]];
      return typeof value === 'string' &&
        (attr[2] === '*=' ? value.includes(attr[3]) : value === attr[3]);
    }
    const exists = suffix.match(/^\[([\w-]+)\]$/);
    if (exists) return Object.prototype.hasOwnProperty.call(this.attrs, exists[1]);
    throw new Error('Unsupported attribute selector: ' + selector);
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    function walk(node) {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    }
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function parserFor(fixture) {
  const root = new MockElement(fixtures[fixture]);
  const sandbox = { Element: MockElement, URL, URLSearchParams, console, window: {}, document: root };
  vm.runInNewContext(parserSource, sandbox, { filename: 'content/serpParser.js' });
  const parser = sandbox.window.serpParser;
  assert.ok(parser);
  return { parser, doc: root };
}

test('mixed-layout organic headings retain DOM order even when only some use div.g wrappers', () => {
  const { parser, doc } = parserFor('mixed-layout');
  const output = parser.extractOrganicResults(doc);
  assert.deepEqual(
    Array.from(output.results, row => row.url),
    [
      'https://example.com/first',
      'https://example.com/second',
      'https://example.com/third',
      'https://example.net/landing?a=1',
      'https://www.youtube.com/watch?v=123'
    ]
  );
  assert.deepEqual(Array.from(output.results, row => row.position), [1, 2, 3, 4, 5]);
  assert.equal(output.checkedDepth, 5);
  assert.equal(output.debugInfo.strategyUsed, 'headings-dom-order');
  assert.equal(output.debugInfo.missingResultsRoot, false);
  assert.ok(output.debugInfo.skippedExcluded >= 4);
  assert.ok(output.debugInfo.skippedDuplicates >= 1);
});

test('search root fallback works when #rso is not present', () => {
  const { parser, doc } = parserFor('search-root-fallback');
  const output = parser.extractOrganicResults(doc);
  assert.equal(output.results.length, 1);
  assert.equal(output.results[0].url, 'https://example.org/ok');
});

test('missing Google results root never scans unrelated page headings', () => {
  const { parser, doc } = parserFor('no-serp-root');
  const output = parser.extractOrganicResults(doc);
  assert.equal(output.results.length, 0);
  assert.equal(output.debugInfo.missingResultsRoot, true);
});

test('case-sensitive paths and percent-encoded slash are not merged during deduplication', () => {
  const { parser, doc } = parserFor('case-distinct-results');
  const output = parser.extractOrganicResults(doc);
  assert.equal(output.results.length, 4);
  assert.deepEqual(
    Array.from(output.results, row => row.normalizedUrl),
    ['example.com/Product', 'example.com/product', 'example.com/a%2Fb', 'example.com/a/b']
  );
});

test('Google redirect wrapper only resolves valid HTTP(S) destinations', () => {
  const { parser } = parserFor('mixed-layout');
  assert.equal(parser.cleanUrl('/url?q=https%3A%2F%2Fexample.com%2Fgood'), 'https://example.com/good');
  assert.equal(parser.cleanUrl('https://www.google.com/url?url=https%3A%2F%2Fexample.org'), 'https://example.org/');
  assert.equal(parser.cleanUrl('https://www.google.com/url?q=javascript%3Aalert(1)'), null);
  assert.equal(parser.cleanUrl('javascript:alert(1)'), null);
  assert.equal(parser.cleanUrl('/search?q=serp'), null);
});

test('Google navigation is excluded but a legitimate YouTube page stays organic', () => {
  const { parser } = parserFor('mixed-layout');
  assert.equal(parser.isGoogleInternal('https://www.google.com/search?q=keyword'), true);
  assert.equal(parser.isGoogleInternal('https://maps.google.com/maps'), true);
  assert.equal(parser.isGoogleInternal('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(parser.isGoogleInternal('https://www.google.com.evil.org/search?q=x'), false);
  assert.equal(parser.isGoogleInternal('https://thirdpartygoogle.com/search?q=x'), false);
});

test('normalization strips tracking params but preserves important query values', () => {
  const { parser } = parserFor('mixed-layout');
  assert.equal(
    parser.normalizeUrl('https://www.Example.com/Product?utm_source=google&color=Red#part'),
    'example.com/Product?color=Red'
  );
});

test('debug mode exposes diagnostic counts and does not change extraction', () => {
  const { parser, doc } = parserFor('mixed-layout');
  const a = parser.extractOrganicResults(doc, { debug: true, keyword: 'keyword' });
  const b = parser.extractOrganicResults(doc, { debug: false });
  assert.deepEqual(Array.from(a.results, row => row.url), Array.from(b.results, row => row.url));
  assert.equal(a.debugInfo.headingsFound, 12);
});
