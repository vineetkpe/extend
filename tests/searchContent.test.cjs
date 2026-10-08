// Run with: node --test tests/searchContent.test.cjs
// Minimal Chrome/content-script simulation for error handling regression tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const code = fs.readFileSync(path.join(__dirname, '../content/searchContent.js'), 'utf8');

function makeHarness({ ready = true, blocked = false, results = [], rootSelector = '#rso' } = {}) {
  let handler;
  const replies = [];
  const dom = {
    title: blocked ? 'Unusual traffic' : 'Search',
    body: { innerText: blocked ? 'unusual traffic from your computer network' : '' },
    querySelector(selector) {
      if (ready && selector === rootSelector) return {};
      return null;
    }
  };
  const context = {
    document: dom,
    window: {
      serpParser: { extractOrganicResults: () => ({ results, checkedDepth: results.length, debugInfo: {} }) }
    },
    chrome: { runtime: { onMessage: { addListener(cb) { handler = cb; } } } },
    setInterval: (callback) => { queueMicrotask(callback); return 1; },
    clearInterval() {},
    Date: ready ? Date : class extends Date { static now() { return ++time; } },
    console
  };
  let time = 99999;
  vm.runInNewContext(code, context, { filename: 'searchContent.js' });
  async function parse() {
    handler({ action: 'PARSE_SERP', timeout: 1 }, {}, response => replies.push(response));
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 1);
    return replies[0];
  }
  return { parse };
}

test('CAPTCHA is BLOCKED, never a ranking', async () => {
  const response = await makeHarness({ blocked: true }).parse();
  assert.equal(response.status, 'BLOCKED');
});
test('missing SERP DOM is an ERROR, never SUCCESS', async () => {
  const response = await makeHarness({ ready: false }).parse();
  assert.equal(response.status, 'ERROR');
  assert.equal(response.reason, 'SERP_TIMEOUT');
});
test('empty extraction is inconclusive, not Not Found', async () => {
  const response = await makeHarness({ results: [] }).parse();
  assert.equal(response.status, 'ERROR');
  assert.equal(response.reason, 'EMPTY_SERP');
});
test('valid nonempty extraction still succeeds', async () => {
  const response = await makeHarness({ results: [{url: 'https://example.org/', position: 1}] }).parse();
  assert.equal(response.status, 'SUCCESS');
  assert.equal(response.results.length, 1);
});

test('modern Google #center_col is accepted as a bounded SERP results container', async () => {
  const response = await makeHarness({
    rootSelector: '#center_col',
    results: [{ url: 'https://organic.example/first', position: 1 }]
  }).parse();
  assert.equal(response.status, 'SUCCESS');
  assert.equal(response.results[0].url, 'https://organic.example/first');
});
