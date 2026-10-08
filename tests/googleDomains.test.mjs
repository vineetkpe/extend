import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const dashboard = fs.readFileSync(new URL('../dashboard/dashboard.html', import.meta.url), 'utf8');

test('every Google domain available in dashboard has host and search content script permissions', () => {
  const choices = [...dashboard.matchAll(/<option value="(google\.[a-z.]+)"/g)]
    .map(match => match[1]);
  assert.ok(choices.length >= 10, 'Expected multi-country Google Search support');
  for (const domain of choices) {
    assert.ok(manifest.host_permissions.includes('https://www.' + domain + '/*'),
      'Missing host permission for ' + domain);
    assert.ok(manifest.content_scripts.some(cs =>
      cs.matches.includes('https://www.' + domain + '/search*')),
      'Missing parser content script for ' + domain);
  }
});
