import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanGoogleRedirect, normalizeUrl, extractDomain, matchUrl, MATCH_TYPES
} from '../utils/urlNormalizer.js';

test('host/scheme/www/fragment/tracking differences remain equivalent', () => {
  const first = 'http://www.Example.com/Service?color=Red&utm_source=newsletter#intro';
  const second = 'https://example.com/Service/?color=Red&gclid=abc';
  assert.equal(normalizeUrl(first), 'example.com/Service?color=Red');
  assert.equal(normalizeUrl(first), normalizeUrl(second));
  assert.equal(matchUrl(first, second).type, MATCH_TYPES.EXACT_PAGE);
  assert.equal(matchUrl('example.com', 'https://www.example.com/').match, true);
});

test('exact page paths must preserve case', () => {
  assert.equal(normalizeUrl('https://example.com/Product'), 'example.com/Product');
  assert.equal(normalizeUrl('https://example.com/product'), 'example.com/product');
  assert.deepEqual(
    matchUrl('https://example.com/Product', 'https://example.com/product'),
    { match: false, isSameDomain: true, type: MATCH_TYPES.OTHER_DOMAIN_PAGE }
  );
});

test('percent-escaped path separators and characters cannot collapse into different paths', () => {
  assert.notEqual(
    normalizeUrl('https://example.com/a%2Fb'),
    normalizeUrl('https://example.com/a/b')
  );
  assert.notEqual(
    normalizeUrl('https://example.com/%70roduct'),
    normalizeUrl('https://example.com/product')
  );
  assert.equal(matchUrl('https://example.com/a%2Fb', 'https://example.com/a/b').match, false);
});

test('meaningful query parameter name casing must be preserved', () => {
  assert.equal(normalizeUrl('https://example.com/page?Page=1'), 'example.com/page?Page=1');
  assert.equal(normalizeUrl('https://example.com/page?page=1'), 'example.com/page?page=1');
  assert.equal(matchUrl('https://example.com/page?Page=1', 'https://example.com/page?page=1').match, false);
});

test('query values must not lose significant whitespace or case', () => {
  assert.equal(normalizeUrl('https://example.com/page?q=%20Blue%20'), 'example.com/page?q=+Blue+');
  assert.notEqual(
    normalizeUrl('https://example.com/page?q=%20Blue%20'),
    normalizeUrl('https://example.com/page?q=Blue')
  );
  assert.notEqual(
    normalizeUrl('https://example.com/page?q=Blue'),
    normalizeUrl('https://example.com/page?q=blue')
  );
});

test('query ordering is normalized while repeated values keep their order', () => {
  assert.equal(
    normalizeUrl('https://example.com/page?b=2&a=1'),
    normalizeUrl('https://example.com/page?a=1&b=2')
  );
  assert.notEqual(
    normalizeUrl('https://example.com/page?a=1&a=2'),
    normalizeUrl('https://example.com/page?a=2&a=1')
  );
});

test('non-default ports remain part of exact page identity', () => {
  assert.equal(normalizeUrl('https://example.com:8443/page'), 'example.com:8443/page');
  assert.notEqual(
    normalizeUrl('https://example.com:8443/page'),
    normalizeUrl('https://example.com/page')
  );
  assert.equal(normalizeUrl('https://example.com:443/page'), 'example.com/page');
  assert.equal(normalizeUrl('http://example.com:80/page'), 'example.com/page');
  assert.equal(extractDomain('https://example.com:8443/page'), 'example.com');
});

test('legitimate Google /url redirect wrappers resolve before matching', () => {
  const destination = 'https://example.com/Landing?a=1';
  const wrapped = '/url?q=' + encodeURIComponent(destination);
  assert.equal(cleanGoogleRedirect(wrapped), destination);
  assert.equal(normalizeUrl(wrapped), 'example.com/Landing?a=1');
  assert.equal(
    matchUrl(destination, 'https://www.google.co.in/url?url=' + encodeURIComponent(destination)).match,
    true
  );
});

test('non-Google /url redirect wrappers are never unwrapped as Google redirects', () => {
  const thirdParty = 'https://redirector.example/url?q=' + encodeURIComponent('https://example.com/Target');
  assert.equal(cleanGoogleRedirect(thirdParty), thirdParty);
  assert.notEqual(normalizeUrl(thirdParty), normalizeUrl('https://example.com/Target'));
  assert.equal(matchUrl('https://example.com/Target', thirdParty).match, false);
});

test('unsafe and malformed Google redirect destinations cannot be exact page matches', () => {
  assert.equal(cleanGoogleRedirect('/url?q=javascript%3Aalert(1)'), '');
  assert.equal(normalizeUrl('/url?q=javascript%3Aalert(1)'), '');
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('https://[invalid'), '');
  assert.equal(matchUrl('https://example.com/page', 'javascript:alert(1)').match, false);
});

test('different domains are not considered matches', () => {
  assert.deepEqual(
    matchUrl('https://example.com/page', 'https://another.org/page'),
    { match: false, isSameDomain: false, type: MATCH_TYPES.NOT_FOUND }
  );
});
