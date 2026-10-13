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


test('both location editors save on input before the popup can close on blur', () => {
  const popup = read('popup/popup.js');
  const dashboard = read('dashboard/dashboard.js');
  assert.match(popup, /element\.addEventListener\('input', persistEditedLocation\)/);
  assert.match(dashboard, /field\.addEventListener\('input', persistEditedLocation\)/);
  for (const source of [popup, dashboard]) {
    assert.match(source, /rememberCoordinateDraft\(/);
    assert.match(source, /getRememberedCoordinateDraft\(/);
    assert.match(source, /locationDraftEdited: true/);
  }
});

test('popup and dashboard describe exactly which three keyword columns to paste', () => {
  const popup = read('popup/popup.html');
  const dashboard = read('dashboard/dashboard.html');
  assert.match(popup, /1\. Keyword \/ search phrase/);
  assert.match(popup, /2\. Target website URL/);
  assert.match(popup, /3\. Previous organic rank \(optional\)/);
  assert.match(dashboard, /Column 1: Keyword \/ search phrase/);
  assert.match(dashboard, /Column 2: Target website \/ landing page URL/);
  assert.match(dashboard, /Column 3: Previous organic rank \(optional\)/);
  assert.match(popup, /aria-describedby="keywordColumnGuide"/);
  assert.match(dashboard, /aria-describedby="dashboardKeywordColumnGuide"/);
});


test('successful Apply Location enables client-coordinate ranking in both screens', () => {
  const popup = read('popup/popup.js');
  const dashboard = read('dashboard/dashboard.js');
  const popupApply = popup.slice(popup.indexOf("bindButton('btnApplyLocation'"),
    popup.indexOf("bindButton('btnTestLocation'"));
  const dashApply = dashboard.slice(dashboard.indexOf("el.btnApplyLocation.addEventListener"),
    dashboard.indexOf("el.btnTestLocation.addEventListener"));
  assert.match(popupApply, /if \(resp && resp\.success\) \{[\s\S]*useLocationCheckbox\.checked = true/);
  assert.match(dashApply, /if \(resp && resp\.success\) \{[\s\S]*el\.useLocationToggle\.checked = true/);
  assert.match(popup, /useLocation: useLocationCheckbox \? useLocationCheckbox\.checked : false/);
  assert.match(dashboard, /useLocation: el\.useLocationToggle\.checked/);
  assert.match(read('dashboard/dashboard.html'),
    /Use Client Coordinates for Google Ranking Checks/);
});

test('client-location search URL is used on both preview and ranking pagination', () => {
  const worker = read('background.js');
  assert.match(worker, /withClientSearchLocation\(currentTab\.url, domain, location\)/);
  assert.match(worker, /const searchUrl = settings\?\.useLocation\s*\?\s*withClientSearchLocation\(baseSearchUrl, domain, settings\)\s*:\s*baseSearchUrl/);
});
