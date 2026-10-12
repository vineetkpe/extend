import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { supportedGoogleDomain } from '../utils/locationPreview.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

function countryOptions(html, id) {
  const select = html.match(new RegExp(
    '<select\\s+id="' + id + '"[^>]*>([\\s\\S]*?)<\\/select>'
  ));
  assert.ok(select, 'Missing Google country selector: ' + id);
  return [...select[1].matchAll(/<option\b([^>]*)>([^<]+)<\/option>/g)]
    .map(([, attrs, label]) => {
      const value = attrs.match(/\bvalue="([^"]+)"/);
      assert.ok(value, 'Missing option value in ' + id);
      return {
        domain: value[1],
        label: label.trim(),
        selected: /\bselected\b/.test(attrs)
      };
    });
}

test('popup, main dashboard and project editor offer the same 14 Google countries', () => {
  const popup = read('popup/popup.html');
  const dashboard = read('dashboard/dashboard.html');
  const selectors = [
    countryOptions(popup, 'googleDomain'),
    countryOptions(dashboard, 'google-domain'),
    countryOptions(dashboard, 'modal-project-google')
  ];
  const expected = selectors[1].map(x => ({ domain: x.domain, label: x.label }));
  assert.equal(expected.length, 14, 'All currently supported countries must be present');
  for (const options of selectors) {
    assert.deepEqual(options.map(x => ({ domain: x.domain, label: x.label })), expected,
      'UI dropdowns must use the same countries, labels and ordering');
    assert.equal(new Set(options.map(x => x.domain)).size, expected.length,
      'No duplicate Google country options');
  }
  assert.deepEqual(selectors[0].filter(x => x.selected).map(x => x.domain), ['google.com'],
    'Default popup choice should remain google.com');
});

test('every UI country is allowed by runtime, manifest host access and SERP content scripts', () => {
  const domains = countryOptions(read('popup/popup.html'), 'googleDomain')
    .map(x => x.domain);
  const hosts = manifest.host_permissions
    .filter(x => /^https:\/\/www\.google\./.test(x))
    .map(x => x.replace(/^https:\/\/www\./, '').replace(/\/\*$/, ''));
  const contentMatches = manifest.content_scripts
    .flatMap(script => script.matches)
    .filter(x => /^https:\/\/www\.google\./.test(x))
    .map(x => x.replace(/^https:\/\/www\./, '').replace(/\/search\*$/, ''));
  assert.deepEqual([...hosts].sort(), [...domains].sort(), 'All permitted hosts must be selectable');
  assert.deepEqual([...contentMatches].sort(), [...domains].sort(),
    'All Google search content script domains must be selectable');
  for (const domain of domains) {
    assert.equal(supportedGoogleDomain(domain), domain,
      'Runtime location allowlist must recognize ' + domain);
  }
});

test('both UIs save and reload the selected project-specific country, not a fixed default', () => {
  const popupJs = read('popup/popup.js');
  const dashboardJs = read('dashboard/dashboard.js');
  assert.match(popupJs, /googleDomainSelect\.value = cfg\.googleDomain \|\| 'google\.com'/);
  assert.match(popupJs, /googleDomain: googleDomainSelect\.value/);
  assert.match(popupJs, /googleDomainSelect\.addEventListener\('change', saveCurrentSettings\)/);
  assert.match(dashboardJs, /el\.googleDomain\.value = cfg\.googleDomain \|\| 'google\.com'/);
  assert.match(dashboardJs, /el\.modalProjectGoogle\.value = cfg\.googleDomain \|\| 'google\.com'/);
  assert.match(dashboardJs, /googleDomain: el\.modalProjectGoogle\.value/);
  assert.match(dashboardJs, /googleDomain: el\.googleDomain\.value/);
});
