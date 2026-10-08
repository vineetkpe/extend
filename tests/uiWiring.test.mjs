import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

for (const [name, sourceFile, htmlFile] of [
  ['Dashboard', 'dashboard/dashboard.js', 'dashboard/dashboard.html'],
  ['Popup', 'popup/popup.js', 'popup/popup.html']
]) {
  test(name + ' JS event targets resolve to actual HTML IDs', () => {
    const source = read(sourceFile);
    const markup = read(htmlFile);
    const ids = new Set([...markup.matchAll(/\bid=["']([^"' ]+)/g)].map(hit => hit[1]));
    const refs = [...source.matchAll(/(?:document\.getElementById|(?:getEl|bindButton))\(['"]([^'"]+)['"]/g)]
      .map(hit => hit[1]);
    const missing = [...new Set(refs)].filter(ref => !ids.has(ref));
    assert.deepEqual(missing, [], 'Broken DOM controls in ' + name);
    assert.equal(new Set(ids).size, [...markup.matchAll(/\bid=["']([^"' ]+)/g)].length,
      'Duplicate DOM IDs in ' + name);
  });
}

test('dashboard tab buttons each point to an existing and unique pane', () => {
  const markup = read('dashboard/dashboard.html');
  const ids = new Set([...markup.matchAll(/\bid=["']([^"' ]+)/g)].map(hit => hit[1]));
  const tabs = [...markup.matchAll(/data-tab="([^"]+)"/g)].map(hit => hit[1]);
  assert.deepEqual(tabs, ['tab-results', 'tab-keywords', 'tab-privacy']);
  for (const tab of tabs) assert.ok(ids.has(tab));
});

test('dashboard clears workbook bytes from memory after a successful session reset', () => {
  const source = read('dashboard/dashboard.js');
  assert.match(source, /if \(!response\?\.success\) throw new Error/);
  assert.match(source, /resetWorkbookImport\(\);\s*currentJobState = null/);
});

test('popup no longer restores global keyword text across projects', () => {
  const source = read('popup/popup.js');
  assert.doesNotMatch(source, /\bgetInputText\(/);
  assert.doesNotMatch(source, /\bsaveInputText\(/);
  assert.match(source, /getProjectInputDraft\(activeProject\.id\)/);
});

test('dashboard blocks new, edit, import and delete project changes while job is active', () => {
  const source = read('dashboard/dashboard.js');
  for (const action of ['btnNewProject', 'btnEditProject', 'btnDeleteProject', 'btnImportProject']) {
    assert.match(source, new RegExp('el\\.' + action + '\\.addEventListener\\(\\x27click\\x27, \\(\\) => \\{\\s*if \\(\\!allowProjectMutation\\(\\)\\) return;'));
  }
});

test('popup and dashboard restore Google country, depth and delay per project', () => {
  const popup = read('popup/popup.js');
  const dashboard = read('dashboard/dashboard.js');
  for (const key of ['googleDomain', 'defaultMaxDepth', 'defaultDelaySeconds']) {
    assert.ok(popup.includes(key), 'Popup must use ' + key);
    assert.ok(dashboard.includes(key), 'Dashboard must use ' + key);
  }
  assert.match(popup, /loadProjectSearchSettings\(activeProject\)/);
  assert.match(popup, /updateProject\(projectId, updates\)/);
  assert.match(dashboard, /persistProjectSearchSettings\(\)/);
  assert.match(dashboard, /field\.addEventListener\('change', persistProjectSearchSettings\)/);
});

test('popup and dashboard capture starting project ID before asynchronous worker response', () => {
  for (const sourceFile of ['popup/popup.js', 'dashboard/dashboard.js']) {
    const source = read(sourceFile);
    assert.match(source, /const startedProjectId = activeProject\?\.id \|\| null/);
    assert.match(source, /saveProjectKeywords\(startedProjectId,/);
  }
});
