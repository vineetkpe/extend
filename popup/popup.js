/**
 * popup.js
 * User interface controller for SERPTrack.
 * Communicates with background service worker and renders live state.
 * 
 * Strict Privacy Architecture:
 * - Projects and results reside in session memory only (chrome.storage.session).
 * - Safe DOM text node rendering (Zero unsafe innerHTML).
 * - Project location configuration is saved per project.
 * - Project switching is locked during active, paused, or blocked runs.
 * - Results are strictly bound to project ID.
 */

import { parseInputRows } from '../utils/parser.js';
import { exportToTsv, exportToCsv, exportToCurrentPositionsOnly, copyToClipboard } from '../utils/exporter.js';
import { getInputText, saveInputText } from '../utils/storage.js';
import { validateCoordinates } from '../utils/locationValidator.js';
import { getProjects, getActiveProject, setActiveProjectId, updateProject } from '../utils/projectManager.js';

// DOM Elements
const statusBadge = document.getElementById('statusBadge');
const alertBanner = document.getElementById('alertBanner');
const alertMessage = document.getElementById('alertMessage');
const keywordInput = document.getElementById('keywordInput');
const validationBox = document.getElementById('validationBox');

// Dashboard & Project Switcher Elements
const popupProjectSelect = document.getElementById('popupProjectSelect');
const btnOpenDashboard = document.getElementById('btnOpenDashboard');
const btnCopyPositionsOnly = document.getElementById('btnCopyPositionsOnly');
const btnPopupClearSession = document.getElementById('btnPopupClearSession');

const googleDomainSelect = document.getElementById('googleDomain');
const maxPositionSelect = document.getElementById('maxPosition');
const delaySecondsInput = document.getElementById('delaySeconds');
const debugModeCheckbox = document.getElementById('debugMode');

// Location Simulation DOM Elements
const useLocationCheckbox = document.getElementById('useLocation');
const locationStatusIndicator = document.getElementById('locationStatusIndicator');
const locationFieldsGrid = document.getElementById('locationFieldsGrid');
const locationNameInput = document.getElementById('locationName');
const accuracyInput = document.getElementById('accuracy');
const latitudeInput = document.getElementById('latitude');
const longitudeInput = document.getElementById('longitude');
const locationValidationMsg = document.getElementById('locationValidationMsg');
const btnApplyLocation = document.getElementById('btnApplyLocation');
const btnTestLocation = document.getElementById('btnTestLocation');
const btnResetLocation = document.getElementById('btnResetLocation');

const btnStart = document.getElementById('btnStart');
const btnPause = document.getElementById('btnPause');
const btnResume = document.getElementById('btnResume');
const btnStop = document.getElementById('btnStop');
const btnClear = document.getElementById('btnClear');

const progressSection = document.getElementById('progressSection');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');
const progressBar = document.getElementById('progressBar');

const resultsCount = document.getElementById('resultsCount');
const resultsTableBody = document.getElementById('resultsTableBody');
const btnCopy = document.getElementById('btnCopy');
const btnDownloadCsv = document.getElementById('btnDownloadCsv');
const toast = document.getElementById('toast');

// Active local state
let currentResults = [];
let currentStatus = 'IDLE';
let currentJobState = null;
let activeProject = null;

/**
 * Shows temporary toast notification
 */
function showToast(text) {
  toast.textContent = text;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2500);
}

/**
 * Formats a date string YYYY-MM-DD for file export
 */
function getTodayDateStr() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

/**
 * Renders the location status badge and enables/disables input fields
 */
function renderLocationStatus(isApplied = false, details = null, needsReapply = false, isConfigured = false, isFailed = false) {
  if (!useLocationCheckbox || !locationStatusIndicator) return;

  if (!useLocationCheckbox.checked) {
    locationStatusIndicator.textContent = 'LOCATION: NOT CONFIGURED';
    locationStatusIndicator.className = 'location-status-badge status-not-set';
    if (locationFieldsGrid) locationFieldsGrid.classList.add('disabled-grid');
    if (btnApplyLocation) btnApplyLocation.disabled = true;
    if (btnTestLocation) btnTestLocation.disabled = true;
    if (btnResetLocation) btnResetLocation.disabled = true;
    return;
  }

  // Location simulation is enabled
  if (locationFieldsGrid) locationFieldsGrid.classList.remove('disabled-grid');
  if (btnApplyLocation) btnApplyLocation.disabled = false;
  if (btnTestLocation) btnTestLocation.disabled = false;
  if (btnResetLocation) btnResetLocation.disabled = false;

  if (isFailed) {
    locationStatusIndicator.textContent = 'LOCATION: FAILED';
    locationStatusIndicator.className = 'location-status-badge status-error';
  } else if (needsReapply) {
    locationStatusIndicator.textContent = 'LOCATION NEEDS REAPPLY';
    locationStatusIndicator.className = 'location-status-badge status-warning';
  } else if (isApplied && details && details.latitude !== undefined && details.longitude !== undefined) {
    locationStatusIndicator.textContent = `LOCATION: ACTIVE (${details.latitude}, ${details.longitude})`;
    locationStatusIndicator.className = 'location-status-badge status-active';
  } else if (isConfigured || (details && details.latitude !== undefined)) {
    locationStatusIndicator.textContent = 'LOCATION: CONFIGURED — WILL APPLY WHEN RANK CHECK STARTS';
    locationStatusIndicator.className = 'location-status-badge status-warning';
  } else {
    locationStatusIndicator.textContent = 'LOCATION: NOT CONFIGURED';
    locationStatusIndicator.className = 'location-status-badge status-not-set';
  }
}

/**
 * Displays feedback message under the location fields
 */
function showLocationMessage(msg, isSuccess = false) {
  if (!locationValidationMsg) return;
  if (!msg) {
    locationValidationMsg.classList.add('hidden');
    locationValidationMsg.replaceChildren();
    return;
  }
  locationValidationMsg.classList.remove('hidden');
  if (isSuccess) {
    locationValidationMsg.className = 'location-validation-msg success-msg';
  } else {
    locationValidationMsg.className = 'location-validation-msg';
  }
  locationValidationMsg.textContent = msg;
}

/**
 * Updates UI control buttons and badges based on job status.
 * Bug 3 Fix: Project switching is disabled when RUNNING, PAUSED, or BLOCKED.
 */
function renderStatus(status, errorMessage = null) {
  currentStatus = status || 'IDLE';
  statusBadge.textContent = currentStatus;
  statusBadge.className = `status-badge status-${currentStatus.toLowerCase()}`;

  // Alert banner for Google interruption / location loss
  if (status === 'BLOCKED') {
    alertBanner.classList.remove('hidden');
    alertMessage.textContent = errorMessage || 'Rank checking was interrupted. Job halted.';
  } else {
    alertBanner.classList.add('hidden');
  }

  // Bug 3 Fix: Disable project switching during active, paused, or blocked runs
  if (popupProjectSelect) {
    popupProjectSelect.disabled = ['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentStatus);
  }

  // Button & Input states
  switch (currentStatus) {
    case 'RUNNING':
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnPause.classList.remove('hidden');
      btnResume.classList.add('hidden');
      btnStop.disabled = false;
      btnClear.disabled = true;
      keywordInput.disabled = true;
      googleDomainSelect.disabled = true;
      if (maxPositionSelect) maxPositionSelect.disabled = true;
      delaySecondsInput.disabled = true;
      if (debugModeCheckbox) debugModeCheckbox.disabled = true;
      if (useLocationCheckbox) useLocationCheckbox.disabled = true;
      if (btnApplyLocation) btnApplyLocation.disabled = true;
      if (btnTestLocation) btnTestLocation.disabled = true;
      if (btnResetLocation) btnResetLocation.disabled = true;
      break;

    case 'PAUSED':
    case 'BLOCKED':
      btnStart.disabled = true;
      btnPause.classList.add('hidden');
      btnResume.classList.remove('hidden');
      btnResume.disabled = false;
      btnStop.disabled = false;
      btnClear.disabled = false;
      keywordInput.disabled = false;
      googleDomainSelect.disabled = false;
      if (maxPositionSelect) maxPositionSelect.disabled = false;
      delaySecondsInput.disabled = false;
      if (debugModeCheckbox) debugModeCheckbox.disabled = false;
      if (useLocationCheckbox) useLocationCheckbox.disabled = false;
      if (btnApplyLocation) btnApplyLocation.disabled = !useLocationCheckbox.checked;
      if (btnTestLocation) btnTestLocation.disabled = !useLocationCheckbox.checked;
      if (btnResetLocation) btnResetLocation.disabled = !useLocationCheckbox.checked;
      break;

    case 'STOPPED':
    case 'COMPLETED':
    case 'IDLE':
    default:
      btnStart.disabled = false;
      btnPause.classList.remove('hidden');
      btnPause.disabled = true;
      btnResume.classList.add('hidden');
      btnStop.disabled = true;
      btnClear.disabled = false;
      keywordInput.disabled = false;
      googleDomainSelect.disabled = false;
      if (maxPositionSelect) maxPositionSelect.disabled = false;
      delaySecondsInput.disabled = false;
      if (debugModeCheckbox) debugModeCheckbox.disabled = false;
      if (useLocationCheckbox) useLocationCheckbox.disabled = false;
      if (btnApplyLocation) btnApplyLocation.disabled = !useLocationCheckbox.checked;
      if (btnTestLocation) btnTestLocation.disabled = !useLocationCheckbox.checked;
      if (btnResetLocation) btnResetLocation.disabled = !useLocationCheckbox.checked;
      break;
  }
}

/**
 * Renders the results table with safe DOM nodes.
 * Content Security: Zero innerHTML used for client/user strings.
 * Bug 4 Fix: Never displays another project's results.
 */
function renderResultsTable(results) {
  // Bug 4 Check: Results bound to project ID
  const isProjectMatch = Boolean(
    activeProject && currentJobState && (
      !currentJobState.projectId ||
      currentJobState.projectId === activeProject.id ||
      currentJobState.projectId === activeProject.config?.projectId
    )
  );

  if (currentJobState && currentJobState.projectId && !isProjectMatch) {
    currentResults = [];
    resultsCount.textContent = '0 checked';
    resultsTableBody.replaceChildren();
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'text-center';
    td.textContent = 'Active results belong to a different project.';
    tr.appendChild(td);
    resultsTableBody.appendChild(tr);
    return;
  }

  currentResults = results || [];
  resultsCount.textContent = `${currentResults.length} checked`;

  if (currentResults.length === 0) {
    resultsTableBody.replaceChildren();
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'text-center';
    td.textContent = 'No ranking results yet. Paste keywords and click START.';
    tr.appendChild(td);
    resultsTableBody.appendChild(tr);
    return;
  }

  resultsTableBody.replaceChildren();

  currentResults.forEach(r => {
    if (!r) return;
    const tr = document.createElement('tr');

    // 1. Keyword (safe text node)
    const tdKw = document.createElement('td');
    tdKw.className = 'keyword-cell';
    tdKw.title = r.keyword || '';
    tdKw.textContent = r.keyword || '';
    tr.appendChild(tdKw);

    // 2. Target URL (safe text node)
    const tdUrl = document.createElement('td');
    tdUrl.className = 'url-cell';
    tdUrl.title = r.targetUrl || '';
    tdUrl.textContent = r.targetUrl || '';
    tr.appendChild(tdUrl);

    // 3. Previous
    const tdPrev = document.createElement('td');
    tdPrev.className = 'text-center';
    tdPrev.textContent = String(r.previousPosition || '-');
    tr.appendChild(tdPrev);

    // 4. Current
    const tdCur = document.createElement('td');
    tdCur.className = 'text-center';
    if (r.matchStatus === 'EXACT PAGE') {
      const strong = document.createElement('strong');
      strong.textContent = String(r.currentPosition || '');
      tdCur.appendChild(strong);
    } else {
      const span = document.createElement('span');
      span.className = 'not-found-text';
      if (r.status === 'ERROR') {
        span.textContent = 'Error';
      } else {
        const depthText = r.checkedDepth ? `Not Found (Top ${r.checkedDepth})` : 'Not Found';
        span.textContent = depthText;
      }
      tdCur.appendChild(span);
    }
    tr.appendChild(tdCur);

    // 5. Change
    const tdChange = document.createElement('td');
    let changeClass = 'change-same';
    if (r.change && r.change.includes('↑')) changeClass = 'change-up';
    else if (r.change && r.change.includes('↓')) changeClass = 'change-down';
    tdChange.className = `text-center ${changeClass}`;
    tdChange.textContent = r.change || '—';
    tr.appendChild(tdChange);

    // 6. Match
    const tdMatch = document.createElement('td');
    const matchBadge = document.createElement('span');
    let matchBadgeClass = 'badge-not-found';
    let matchLabel = 'NOT FOUND';

    if (r.matchStatus === 'EXACT PAGE') {
      matchBadgeClass = 'badge-exact';
      matchLabel = 'EXACT PAGE';
    } else if (r.matchStatus === 'OTHER DOMAIN PAGE FOUND') {
      matchBadgeClass = 'badge-other-domain';
      matchLabel = 'OTHER DOMAIN FOUND';
    } else if (r.status === 'ERROR') {
      matchBadgeClass = 'badge-error';
      matchLabel = 'ERROR';
    }
    matchBadge.className = `rank-badge ${matchBadgeClass}`;
    matchBadge.textContent = matchLabel;
    tdMatch.appendChild(matchBadge);

    if (r.matchStatus === 'EXACT PAGE') {
      const sub = document.createElement('span');
      sub.className = 'sub-info';
      sub.textContent = `Checked depth: ${r.checkedDepth || 0}`;
      tdMatch.appendChild(sub);
    } else if (r.matchStatus === 'OTHER DOMAIN PAGE FOUND') {
      const sub = document.createElement('span');
      sub.className = 'sub-info';
      sub.title = r.otherPageFound || '';
      sub.textContent = `Other page ranks at pos ${r.otherPagePosition || '?'}`;
      tdMatch.appendChild(sub);
    } else if (r.status === 'ERROR') {
      const sub = document.createElement('span');
      sub.className = 'sub-info';
      sub.title = r.error || '';
      sub.textContent = r.error || 'Error';
      tdMatch.appendChild(sub);
    } else {
      const sub = document.createElement('span');
      sub.className = 'sub-info';
      sub.textContent = `Checked ${r.checkedDepth || 0} results`;
      tdMatch.appendChild(sub);
    }
    tr.appendChild(tdMatch);

    // 7. Status
    const tdStatus = document.createElement('td');
    const statusBadgeElem = document.createElement('span');
    statusBadgeElem.className = `rank-badge ${matchBadgeClass}`;
    let statusLabel = 'TARGET NOT FOUND';
    if (r.matchStatus === 'EXACT PAGE') statusLabel = 'EXACT PAGE';
    else if (r.status === 'ERROR') statusLabel = 'ERROR';
    statusBadgeElem.textContent = statusLabel;
    tdStatus.appendChild(statusBadgeElem);
    tr.appendChild(tdStatus);

    resultsTableBody.appendChild(tr);
  });
}

/**
 * Updates the progress indicator bar and text
 */
function renderProgress(currentIndex, total) {
  if (!total || total === 0) {
    progressSection.classList.add('hidden');
    return;
  }

  progressSection.classList.remove('hidden');
  const checked = Math.min(currentIndex, total);
  const percent = Math.round((checked / total) * 100);

  progressText.textContent = `Checked keyword ${checked} of ${total}`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
}

/**
 * Validates textarea content and displays error messages with safe DOM nodes
 */
function validateInput() {
  const text = keywordInput.value.trim();
  if (!text) {
    validationBox.classList.add('hidden');
    validationBox.replaceChildren();
    return { valid: [], errors: [] };
  }

  const parsed = parseInputRows(text);
  if (parsed.errors.length > 0) {
    validationBox.classList.remove('hidden');
    validationBox.replaceChildren();

    const strong = document.createElement('strong');
    strong.textContent = 'Format errors detected:';
    validationBox.appendChild(strong);

    const ul = document.createElement('ul');
    ul.style.margin = '4px 0 0 16px';
    ul.style.padding = '0';

    parsed.errors.slice(0, 3).forEach(e => {
      const li = document.createElement('li');
      li.textContent = `Line ${e.line}: ${e.message}`;
      ul.appendChild(li);
    });

    if (parsed.errors.length > 3) {
      const liMore = document.createElement('li');
      liMore.textContent = `...and ${parsed.errors.length - 3} more errors`;
      ul.appendChild(liMore);
    }
    validationBox.appendChild(ul);
  } else {
    validationBox.classList.add('hidden');
    validationBox.replaceChildren();
  }

  return parsed;
}

/**
 * Initializes state by querying the background worker and loading active project
 */
async function initialize() {
  // Populate Project Selector
  try {
    const projects = await getProjects();
    activeProject = await getActiveProject();
    if (popupProjectSelect) {
      popupProjectSelect.replaceChildren();
      Object.keys(projects).forEach(pId => {
        const opt = document.createElement('option');
        opt.value = pId;
        opt.textContent = projects[pId].config?.projectName || projects[pId].projectName || 'Untitled Project';
        if (pId === activeProject.id || pId === activeProject.config?.projectId) opt.selected = true;
        popupProjectSelect.appendChild(opt);
      });
    }

    // Bug 1 Fix: Load active project's location into popup UI
    if (activeProject) {
      const cfg = activeProject.config || activeProject;
      if (useLocationCheckbox) useLocationCheckbox.checked = Boolean(cfg.useLocation);
      if (locationNameInput) locationNameInput.value = cfg.locationName || '';
      if (latitudeInput) latitudeInput.value = cfg.latitude || '';
      if (longitudeInput) longitudeInput.value = cfg.longitude || '';
      if (accuracyInput) accuracyInput.value = cfg.accuracy !== undefined ? cfg.accuracy : 20;

      if (activeProject.keywords && activeProject.keywords.length > 0 && !keywordInput.value) {
        const lines = activeProject.keywords.map(k => `${k.keyword}\t${k.targetUrl}\t${k.previousPosition || ''}`);
        keywordInput.value = lines.join('\n');
      }
    }
  } catch (_) {}

  // Load cached input text if empty
  const savedText = await getInputText();
  if (savedText && !keywordInput.value) {
    keywordInput.value = savedText;
  }

  // Request current state and settings from background
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const { state, settings } = response;
    currentJobState = state;

    // Apply settings
    if (settings) {
      if (settings.googleDomain) googleDomainSelect.value = settings.googleDomain;
      if (settings.maxPosition && maxPositionSelect) maxPositionSelect.value = String(settings.maxPosition);
      if (settings.delaySeconds) delaySecondsInput.value = settings.delaySeconds;
      if (debugModeCheckbox) debugModeCheckbox.checked = Boolean(settings.debugMode);
    }

    // Apply state
    if (state) {
      renderStatus(state.status, state.errorMessage);
      renderResultsTable(state.results);
      if (state.queue && state.queue.length > 0) {
        renderProgress(state.currentIndex, state.queue.length);
      }
      renderLocationStatus(
        Boolean(state.locationApplied),
        state.locationDetails,
        false,
        Boolean(state.locationConfigured),
        state.locationState === 'FAILED'
      );
    } else {
      renderLocationStatus(false, null, false);
    }
  });
}

// Bug 3 Fix: Project switcher listener with run-state lock
if (popupProjectSelect) {
  popupProjectSelect.addEventListener('change', async (e) => {
    if (['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentStatus)) {
      showToast('Cannot switch project while a job is active, paused, or blocked!');
      if (activeProject) {
        e.target.value = activeProject.id;
      }
      return;
    }

    await setActiveProjectId(e.target.value);
    activeProject = await getActiveProject();

    if (activeProject) {
      // Bug 1 Fix: Load exact project location config
      const cfg = activeProject.config || activeProject;
      if (useLocationCheckbox) useLocationCheckbox.checked = Boolean(cfg.useLocation);
      if (locationNameInput) locationNameInput.value = cfg.locationName || '';
      if (latitudeInput) latitudeInput.value = cfg.latitude || '';
      if (longitudeInput) longitudeInput.value = cfg.longitude || '';
      if (accuracyInput) accuracyInput.value = cfg.accuracy !== undefined ? cfg.accuracy : 20;

      if (activeProject.keywords && activeProject.keywords.length > 0) {
        const lines = activeProject.keywords.map(k => `${k.keyword}\t${k.targetUrl}\t${k.previousPosition || ''}`);
        keywordInput.value = lines.join('\n');
        saveInputText(keywordInput.value);
      }
      renderLocationStatus(false, null, false);
      renderResultsTable(currentJobState ? currentJobState.results : []);
    }
    showToast(`Switched to: ${activeProject?.config?.projectName || 'Project'}`);
  });
}

// Open Full Dashboard button
if (btnOpenDashboard) {
  btnOpenDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });
}

// Clear Session Data button in popup
if (btnPopupClearSession) {
  btnPopupClearSession.addEventListener('click', async () => {
    if (confirm('Clear all session projects, keywords, and results? Harmless settings will remain.')) {
      await chrome.runtime.sendMessage({ action: 'CLEAR_SESSION_DATA' });
      showToast('Session data cleared.');
      keywordInput.value = '';
      currentResults = [];
      resultsTableBody.replaceChildren();
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'text-center';
      td.textContent = 'No ranking results yet. Paste keywords and click START.';
      tr.appendChild(td);
      resultsTableBody.appendChild(tr);
      resultsCount.textContent = '0 checked';
      await initialize();
    }
  });
}

// Copy Positions Only handler (Bug 4 Fix: checks project ID match)
if (btnCopyPositionsOnly) {
  btnCopyPositionsOnly.addEventListener('click', () => {
    if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.');
      return;
    }
    if (!currentResults || currentResults.length === 0) {
      showToast('No results to copy.');
      return;
    }
    const tsvData = exportToCurrentPositionsOnly(currentResults);
    copyToClipboard(tsvData);
    showToast(`Copied ${currentResults.length} positions to clipboard!`);
  });
}

// Auto-save input text on change
keywordInput.addEventListener('input', () => {
  saveInputText(keywordInput.value);
  validateInput();
});

// START button handler
btnStart.addEventListener('click', async () => {
  const parsed = validateInput();

  if (parsed.errors.length > 0) {
    showToast('Please fix format errors before starting.');
    return;
  }

  if (parsed.valid.length === 0) {
    showToast('Please paste at least one keyword row.');
    return;
  }

  // If location simulation is enabled, validate coordinates before starting
  if (useLocationCheckbox && useLocationCheckbox.checked) {
    const locValidation = validateCoordinates(latitudeInput.value, longitudeInput.value, accuracyInput.value);
    if (!locValidation.valid) {
      showLocationMessage(locValidation.error, false);
      showToast('Invalid location coordinates. Please fix before starting.');
      return;
    }
  }
  showLocationMessage('', false);

  const settings = {
    googleDomain: googleDomainSelect.value,
    maxPosition: parseInt(maxPositionSelect ? maxPositionSelect.value : 50, 10) || 50,
    delaySeconds: Math.max(5, parseInt(delaySecondsInput.value, 10) || 8),
    debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
    useLocation: useLocationCheckbox ? useLocationCheckbox.checked : false,
    latitude: latitudeInput ? latitudeInput.value.trim() : '',
    longitude: longitudeInput ? longitudeInput.value.trim() : '',
    accuracy: accuracyInput ? (parseInt(accuracyInput.value, 10) || 20) : 20,
    locationName: locationNameInput ? locationNameInput.value.trim() : '',
    activeProjectId: activeProject ? activeProject.id : null
  };

  // Auto-save location into active project
  if (activeProject) {
    await updateProject(activeProject.id, {
      useLocation: settings.useLocation,
      locationName: settings.locationName,
      latitude: settings.latitude,
      longitude: settings.longitude,
      accuracy: settings.accuracy
    });
  }

  chrome.runtime.sendMessage({
    action: 'START_JOB',
    queue: parsed.valid,
    settings: settings,
    projectId: activeProject ? activeProject.id : null
  }, (res) => {
    if (res && res.state) {
      currentJobState = res.state;
      renderStatus(res.state.status);
      renderResultsTable(res.state.results);
      renderProgress(res.state.currentIndex, parsed.valid.length);
      if (res.state.locationApplied) {
        renderLocationStatus(true, res.state.locationDetails, false);
      }
    } else if (res && !res.success && res.error) {
      showLocationMessage(res.error, false);
      showToast(res.error);
    }
  });
});

// PAUSE button handler
btnPause.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'PAUSE_JOB' }, (res) => {
    if (res && res.state) {
      currentJobState = res.state;
      renderStatus(res.state.status);
    }
  });
});

// RESUME button handler
btnResume.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'RESUME_JOB' }, (res) => {
    if (res && res.state) {
      currentJobState = res.state;
      renderStatus(res.state.status);
      showToast('Resuming rank check...');
    } else if (res && !res.success) {
      showToast(res.message || 'Cannot resume.');
    }
  });
});

// STOP button handler
btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP_JOB' }, (res) => {
    if (res && res.state) {
      currentJobState = res.state;
      renderStatus(res.state.status);
      showToast('Rank checking stopped.');
    }
  });
});

// CLEAR button handler
btnClear.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'CLEAR_JOB' }, (res) => {
    if (res && res.state) {
      currentJobState = res.state;
      renderStatus(res.state.status);
      renderResultsTable([]);
      renderProgress(0, 0);
      showToast('Results cleared.');
    }
  });
});

// Settings auto-save
function saveCurrentSettings() {
  const settings = {
    googleDomain: googleDomainSelect.value,
    maxPosition: parseInt(maxPositionSelect ? maxPositionSelect.value : 50, 10) || 50,
    delaySeconds: Math.max(5, parseInt(delaySecondsInput.value, 10) || 8),
    debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false
  };
  chrome.runtime.sendMessage({
    action: 'SAVE_SETTINGS',
    settings: settings
  });
}

googleDomainSelect.addEventListener('change', saveCurrentSettings);
if (maxPositionSelect) maxPositionSelect.addEventListener('change', saveCurrentSettings);
delaySecondsInput.addEventListener('change', () => {
  const val = Math.max(5, parseInt(delaySecondsInput.value, 10) || 8);
  delaySecondsInput.value = val;
  saveCurrentSettings();
});

if (debugModeCheckbox) {
  debugModeCheckbox.addEventListener('change', (e) => {
    saveCurrentSettings();
    if (e.target.checked) {
      showToast('Debug logging may display current session SEO data in DevTools.');
    }
  });
}

// Location inputs event listeners
if (useLocationCheckbox) {
  useLocationCheckbox.addEventListener('change', async (e) => {
    renderLocationStatus(false, null, false);
    showLocationMessage('', false);
    if (activeProject) {
      await updateProject(activeProject.id, { useLocation: e.target.checked });
      activeProject.config.useLocation = e.target.checked;
    }
  });
}

// Location Actions
if (btnApplyLocation) {
  btnApplyLocation.addEventListener('click', async () => {
    const lat = latitudeInput.value.trim();
    const lon = longitudeInput.value.trim();
    const acc = accuracyInput.value.trim() || '20';
    const locName = locationNameInput.value.trim();

    const validation = validateCoordinates(lat, lon, acc);
    if (!validation.valid) {
      showLocationMessage(validation.error, false);
      return;
    }

    if (activeProject) {
      await updateProject(activeProject.id, {
        useLocation: true,
        latitude: String(validation.latitude),
        longitude: String(validation.longitude),
        accuracy: validation.accuracy,
        locationName: locName
      });
      activeProject.config.useLocation = true;
      activeProject.config.latitude = String(validation.latitude);
      activeProject.config.longitude = String(validation.longitude);
      activeProject.config.accuracy = validation.accuracy;
      activeProject.config.locationName = locName;
    }

    chrome.runtime.sendMessage({
      action: 'APPLY_LOCATION',
      location: {
        latitude: validation.latitude,
        longitude: validation.longitude,
        accuracy: validation.accuracy,
        locationName: locName
      }
    }, (resp) => {
      if (resp && resp.success) {
        showLocationMessage(resp.message || 'Location configured successfully.', true);
        renderLocationStatus(true, validation, false, true);
      } else {
        showLocationMessage(resp ? resp.error : 'Failed to apply location.', false);
        renderLocationStatus(false, null, false, false, true);
      }
    });
  });
}

if (btnTestLocation) {
  btnTestLocation.addEventListener('click', () => {
    const lat = latitudeInput.value.trim();
    const lon = longitudeInput.value.trim();
    const acc = accuracyInput.value.trim() || '20';
    const validation = validateCoordinates(lat, lon, acc);
    if (!validation.valid) {
      showLocationMessage(validation.error, false);
      return;
    }

    showLocationMessage('Testing location override in Google tab...', true);
    chrome.runtime.sendMessage({
      action: 'TEST_LOCATION',
      location: {
        latitude: validation.latitude,
        longitude: validation.longitude,
        accuracy: validation.accuracy
      }
    }, (resp) => {
      if (resp && resp.success) {
        showLocationMessage(resp.message, resp.verified);
      } else {
        showLocationMessage(resp ? resp.error : 'Location test failed.', false);
      }
    });
  });
}

if (btnResetLocation) {
  btnResetLocation.addEventListener('click', async () => {
    chrome.runtime.sendMessage({ action: 'RESET_LOCATION' }, async () => {
      latitudeInput.value = '';
      longitudeInput.value = '';
      locationNameInput.value = '';
      useLocationCheckbox.checked = false;

      if (activeProject) {
        await updateProject(activeProject.id, {
          useLocation: false,
          latitude: '',
          longitude: '',
          locationName: ''
        });
        activeProject.config.useLocation = false;
        activeProject.config.latitude = '';
        activeProject.config.longitude = '';
        activeProject.config.locationName = '';
      }

      renderLocationStatus(false, null, false);
      showLocationMessage('Location override reset.', true);
    });
  });
}

// COPY RESULTS button handler (Bug 4 Fix: checks project match)
btnCopy.addEventListener('click', async () => {
  if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
    showToast('Action disabled: results belong to a different project.');
    return;
  }
  if (!currentResults || currentResults.length === 0) {
    showToast('No results to copy.');
    return;
  }

  const tsvData = exportToTsv(currentResults);
  copyToClipboard(tsvData);
  showToast('Copied to clipboard! Ready to paste into Excel.');
});

// DOWNLOAD CSV button handler (Bug 4 Fix: checks project match)
btnDownloadCsv.addEventListener('click', () => {
  if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
    showToast('Action disabled: results belong to a different project.');
    return;
  }
  if (!currentResults || currentResults.length === 0) {
    showToast('No results to download.');
    return;
  }

  const csvData = exportToCsv(currentResults);
  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const projName = activeProject ? (activeProject.config?.projectName || activeProject.projectName) : 'rankings';
  a.download = `${projName}_rank_results_${getTodayDateStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV downloaded.');
});

// Listen for live broadcasts from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PROGRESS_UPDATE' && msg.state) {
    currentJobState = msg.state;
    renderStatus(msg.state.status);
    renderResultsTable(msg.state.results);
    if (msg.state.queue) {
      renderProgress(msg.state.currentIndex, msg.state.queue.length);
    }
  } else if (msg.action === 'JOB_BLOCKED') {
    renderStatus('BLOCKED', msg.message);
  } else if (msg.action === 'LOCATION_STATUS_UPDATE') {
    if (msg.status === 'ACTIVE') {
      renderLocationStatus(true, msg.details, false, false, false);
    } else if (msg.status === 'CONFIGURED') {
      renderLocationStatus(false, msg.details, false, true, false);
    } else if (msg.status === 'FAILED') {
      renderLocationStatus(false, null, false, false, true);
    } else if (msg.status === 'NEEDS_REAPPLY') {
      renderLocationStatus(false, null, true, false, false);
    } else {
      renderLocationStatus(false, null, false, false, false);
    }
  } else if (msg.action === 'SESSION_CLEARED') {
    initialize();
  }
});

// Run initialization on popup open
initialize();
