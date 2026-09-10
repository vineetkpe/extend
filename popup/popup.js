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
import {
  exportToTsv,
  exportToCsv,
  exportToCurrentPositionsOnly,
  copyToClipboard,
  downloadCsv,
  sanitizeProjectFilename
} from '../utils/exporter.js';
import {
  getInputText,
  saveInputText,
  isSessionStorageAvailable,
  SESSION_STORAGE_UNAVAILABLE_ERROR
} from '../utils/storage.js';
import { validateCoordinates } from '../utils/locationValidator.js';
import {
  getProjects,
  getActiveProject,
  setActiveProjectId,
  updateProject
} from '../utils/projectManager.js';

// Safe DOM element helper
function getEl(id, required = false) {
  const el = document.getElementById(id);
  if (!el && required) {
    console.error(`[Popup Init] Missing expected DOM element: #${id}`);
  }
  return el;
}

// Safe button click binder
function bindButton(id, handler) {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[Popup Init] Button not found for binding: #${id}`);
    return null;
  }
  el.addEventListener('click', handler);
  return el;
}

// Visible error banner display
function showPopupError(msg) {
  const errEl = getEl('errorMessage');
  if (errEl) {
    if (msg) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      errEl.style.display = 'block';
    } else {
      errEl.textContent = '';
      errEl.classList.add('hidden');
      errEl.style.display = 'none';
    }
  }
}

// Active local state
let currentResults = [];
let currentStatus = 'IDLE';
let currentJobState = null;
let activeProject = null;

// DOM references (resolved on init)
let statusBadge = null;
let alertBanner = null;
let alertMessage = null;
let keywordInput = null;
let validationBox = null;
let popupProjectSelect = null;
let btnOpenDashboard = null;
let btnCopyPositionsOnly = null;
let btnPopupClearSession = null;
let googleDomainSelect = null;
let maxPositionSelect = null;
let delaySecondsInput = null;
let debugModeCheckbox = null;
let useLocationCheckbox = null;
let locationStatusIndicator = null;
let locationFieldsGrid = null;
let locationNameInput = null;
let accuracyInput = null;
let latitudeInput = null;
let longitudeInput = null;
let locationValidationMsg = null;
let btnApplyLocation = null;
let btnTestLocation = null;
let btnResetLocation = null;
let btnStart = null;
let btnPause = null;
let btnResume = null;
let btnStop = null;
let btnClear = null;
let progressSection = null;
let progressText = null;
let progressPercent = null;
let progressBar = null;
let resultsCount = null;
let resultsTableBody = null;
let btnCopy = null;
let btnDownloadCsv = null;
let toast = null;

/**
 * Shows temporary toast notification
 */
function showToast(text) {
  if (!toast) toast = getEl('toast');
  if (!toast) return;
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
  if (statusBadge) {
    statusBadge.textContent = currentStatus;
    statusBadge.className = `status-badge status-${currentStatus.toLowerCase()}`;
  }

  // Alert banner for Google interruption / location loss
  if (alertBanner && alertMessage) {
    if (status === 'BLOCKED') {
      alertBanner.classList.remove('hidden');
      alertMessage.textContent = errorMessage || 'Rank checking was interrupted. Job halted.';
    } else {
      alertBanner.classList.add('hidden');
    }
  }

  // Bug 3 Fix: Disable project switching during active, paused, or blocked runs
  if (popupProjectSelect) {
    popupProjectSelect.disabled = ['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentStatus);
  }

  // Button & Input states
  switch (currentStatus) {
    case 'RUNNING':
      if (btnStart) btnStart.disabled = true;
      if (btnPause) {
        btnPause.disabled = false;
        btnPause.classList.remove('hidden');
      }
      if (btnResume) btnResume.classList.add('hidden');
      if (btnStop) btnStop.disabled = false;
      if (btnClear) btnClear.disabled = true;
      if (keywordInput) keywordInput.disabled = true;
      if (googleDomainSelect) googleDomainSelect.disabled = true;
      if (maxPositionSelect) maxPositionSelect.disabled = true;
      if (delaySecondsInput) delaySecondsInput.disabled = true;
      if (debugModeCheckbox) debugModeCheckbox.disabled = true;
      if (useLocationCheckbox) useLocationCheckbox.disabled = true;
      if (btnApplyLocation) btnApplyLocation.disabled = true;
      if (btnTestLocation) btnTestLocation.disabled = true;
      if (btnResetLocation) btnResetLocation.disabled = true;
      break;

    case 'PAUSED':
    case 'BLOCKED':
      if (btnStart) btnStart.disabled = true;
      if (btnPause) btnPause.classList.add('hidden');
      if (btnResume) {
        btnResume.classList.remove('hidden');
        btnResume.disabled = false;
      }
      if (btnStop) btnStop.disabled = false;
      if (btnClear) btnClear.disabled = false;
      if (keywordInput) keywordInput.disabled = false;
      if (googleDomainSelect) googleDomainSelect.disabled = false;
      if (maxPositionSelect) maxPositionSelect.disabled = false;
      if (delaySecondsInput) delaySecondsInput.disabled = false;
      if (debugModeCheckbox) debugModeCheckbox.disabled = false;
      if (useLocationCheckbox) useLocationCheckbox.disabled = false;
      if (btnApplyLocation) btnApplyLocation.disabled = !useLocationCheckbox?.checked;
      if (btnTestLocation) btnTestLocation.disabled = !useLocationCheckbox?.checked;
      if (btnResetLocation) btnResetLocation.disabled = !useLocationCheckbox?.checked;
      break;

    case 'STOPPED':
    case 'COMPLETED':
    case 'IDLE':
    default:
      if (btnStart) btnStart.disabled = false;
      if (btnPause) {
        btnPause.classList.remove('hidden');
        btnPause.disabled = true;
      }
      if (btnResume) btnResume.classList.add('hidden');
      if (btnStop) btnStop.disabled = true;
      if (btnClear) btnClear.disabled = false;
      if (keywordInput) keywordInput.disabled = false;
      if (googleDomainSelect) googleDomainSelect.disabled = false;
      if (maxPositionSelect) maxPositionSelect.disabled = false;
      if (delaySecondsInput) delaySecondsInput.disabled = false;
      if (debugModeCheckbox) debugModeCheckbox.disabled = false;
      if (useLocationCheckbox) useLocationCheckbox.disabled = false;
      if (btnApplyLocation) btnApplyLocation.disabled = !useLocationCheckbox?.checked;
      if (btnTestLocation) btnTestLocation.disabled = !useLocationCheckbox?.checked;
      if (btnResetLocation) btnResetLocation.disabled = !useLocationCheckbox?.checked;
      break;
  }
}

/**
 * Renders the results table with safe DOM nodes.
 * Content Security: Zero innerHTML used for client/user strings.
 * Bug 4 Fix: Never displays another project's results.
 */
function renderResultsTable(results) {
  if (!resultsTableBody) return;

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
    if (resultsCount) resultsCount.textContent = '0 checked';
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
  if (resultsCount) resultsCount.textContent = `${currentResults.length} checked`;

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
  if (!progressSection) return;
  if (!total || total === 0) {
    progressSection.classList.add('hidden');
    return;
  }

  progressSection.classList.remove('hidden');
  const checked = Math.min(currentIndex, total);
  const percent = Math.round((checked / total) * 100);

  if (progressText) progressText.textContent = `Checking keyword ${checked} of ${total}`;
  if (progressPercent) progressPercent.textContent = `${percent}%`;
  if (progressBar) progressBar.style.width = `${percent}%`;
}

/**
 * Validates textarea content, isolates invalid rows, and renders a live parsed preview.
 */
function validateInput() {
  if (!keywordInput) return { valid: [], errors: [] };
  const text = keywordInput.value.trim();
  if (!text) {
    if (validationBox) {
      validationBox.classList.add('hidden');
      validationBox.replaceChildren();
    }
    return { valid: [], errors: [] };
  }

  const parsed = parseInputRows(text);
  if (validationBox) {
    validationBox.classList.remove('hidden');
    validationBox.replaceChildren();

    // 1. Highlight invalid rows if any
    if (parsed.errors.length > 0) {
      const errDiv = document.createElement('div');
      errDiv.className = 'validation-error-header';
      errDiv.style.color = '#e11d48';
      errDiv.style.marginBottom = parsed.valid.length > 0 ? '8px' : '0';

      const strong = document.createElement('strong');
      strong.textContent = `⚠️ Could not understand ${parsed.errors.length} row(s):`;
      errDiv.appendChild(strong);

      const ul = document.createElement('ul');
      ul.style.margin = '4px 0 0 16px';
      ul.style.padding = '0';
      ul.style.color = '#be123c';

      parsed.errors.slice(0, 3).forEach(e => {
        const li = document.createElement('li');
        li.textContent = `Line ${e.line}: ${e.message}`;
        ul.appendChild(li);
      });

      if (parsed.errors.length > 3) {
        const liMore = document.createElement('li');
        liMore.textContent = `...and ${parsed.errors.length - 3} more line(s)`;
        ul.appendChild(liMore);
      }
      errDiv.appendChild(ul);
      validationBox.appendChild(errDiv);
    }

    // 2. Render live preview for valid rows
    if (parsed.valid.length > 0) {
      const previewDiv = document.createElement('div');
      previewDiv.className = 'parsed-preview-container';
      previewDiv.style.padding = '6px 8px';
      previewDiv.style.background = '#f0fdf4';
      previewDiv.style.border = '1px solid #bbf7d0';
      previewDiv.style.borderRadius = '4px';
      previewDiv.style.color = '#15803d';

      if (parsed.valid.length === 1) {
        const r = parsed.valid[0];
        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.style.marginBottom = '4px';
        title.textContent = '✓ Parsed Preview (1 Keyword Ready):';
        previewDiv.appendChild(title);

        const dKw = document.createElement('div');
        const strongKw = document.createElement('strong');
        strongKw.textContent = 'Keyword: ';
        const spanKw = document.createElement('span');
        spanKw.style.color = '#0f172a';
        spanKw.style.fontWeight = '600';
        spanKw.textContent = r.keyword;
        dKw.appendChild(strongKw);
        dKw.appendChild(spanKw);
        previewDiv.appendChild(dKw);

        const dUrl = document.createElement('div');
        const strongUrl = document.createElement('strong');
        strongUrl.textContent = 'URL: ';
        const spanUrl = document.createElement('span');
        spanUrl.style.color = '#2563eb';
        spanUrl.textContent = r.targetUrl;
        dUrl.appendChild(strongUrl);
        dUrl.appendChild(spanUrl);
        previewDiv.appendChild(dUrl);

        const dPos = document.createElement('div');
        const strongPos = document.createElement('strong');
        strongPos.textContent = 'Previous: ';
        const spanPos = document.createElement('span');
        spanPos.style.color = '#0f172a';
        spanPos.textContent = String(r.previousPosition || '-');
        dPos.appendChild(strongPos);
        dPos.appendChild(spanPos);
        previewDiv.appendChild(dPos);
      } else {
        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.style.marginBottom = '4px';
        title.textContent = `✓ Parsed Preview (${parsed.valid.length} Keywords Ready):`;
        previewDiv.appendChild(title);

        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.fontSize = '10px';
        table.style.marginTop = '4px';

        const thead = document.createElement('thead');
        const trH = document.createElement('tr');
        ['Keyword', 'Target URL', 'Prev'].forEach(hText => {
          const th = document.createElement('th');
          th.textContent = hText;
          th.style.textAlign = 'left';
          th.style.padding = '2px 4px';
          th.style.borderBottom = '1px solid #86efac';
          th.style.color = '#166534';
          trH.appendChild(th);
        });
        thead.appendChild(trH);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        parsed.valid.slice(0, 5).forEach(r => {
          const tr = document.createElement('tr');

          const tdKw = document.createElement('td');
          tdKw.textContent = r.keyword;
          tdKw.style.padding = '2px 4px';
          tdKw.style.color = '#0f172a';
          tdKw.style.fontWeight = '600';
          tdKw.style.maxWidth = '110px';
          tdKw.style.overflow = 'hidden';
          tdKw.style.textOverflow = 'ellipsis';
          tdKw.style.whiteSpace = 'nowrap';
          tr.appendChild(tdKw);

          const tdUrl = document.createElement('td');
          tdUrl.textContent = r.targetUrl;
          tdUrl.style.padding = '2px 4px';
          tdUrl.style.color = '#2563eb';
          tdUrl.style.maxWidth = '130px';
          tdUrl.style.overflow = 'hidden';
          tdUrl.style.textOverflow = 'ellipsis';
          tdUrl.style.whiteSpace = 'nowrap';
          tr.appendChild(tdUrl);

          const tdPos = document.createElement('td');
          tdPos.textContent = String(r.previousPosition || '-');
          tdPos.style.padding = '2px 4px';
          tdPos.style.color = '#0f172a';
          tr.appendChild(tdPos);

          tbody.appendChild(tr);
        });

        if (parsed.valid.length > 5) {
          const trMore = document.createElement('tr');
          const tdMore = document.createElement('td');
          tdMore.colSpan = 3;
          tdMore.style.padding = '2px 4px';
          tdMore.style.fontStyle = 'italic';
          tdMore.style.color = '#15803d';
          tdMore.textContent = `...and ${parsed.valid.length - 5} more keywords`;
          trMore.appendChild(tdMore);
          tbody.appendChild(trMore);
        }

        table.appendChild(tbody);
        previewDiv.appendChild(table);
      }

      validationBox.appendChild(previewDiv);
    }
  }

  return parsed;
}

/**
 * Auto-saves harmless general settings
 */
function saveCurrentSettings() {
  if (!googleDomainSelect || !delaySecondsInput) return;
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

/**
 * Initializes state by querying the background worker and loading active project
 */
async function initializeState() {
  if (!isSessionStorageAvailable()) {
    const alertEl = getEl('sessionStorageAlert');
    if (alertEl) {
      alertEl.style.display = 'block';
    }
    showToast(SESSION_STORAGE_UNAVAILABLE_ERROR);
    showPopupError(SESSION_STORAGE_UNAVAILABLE_ERROR);
    if (btnStart) btnStart.disabled = true;
    return;
  }

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
        if (pId === activeProject?.id || pId === activeProject?.config?.projectId) opt.selected = true;
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

      if (activeProject.keywords && activeProject.keywords.length > 0 && keywordInput && !keywordInput.value) {
        const lines = activeProject.keywords.map(k => `${k.keyword}\t${k.targetUrl}\t${k.previousPosition || ''}`);
        keywordInput.value = lines.join('\n');
      }
    }
  } catch (err) {
    console.error('[Popup] Error loading project state:', err);
  }

  // Load cached input text if empty
  try {
    const savedText = await getInputText();
    if (savedText && keywordInput && !keywordInput.value) {
      keywordInput.value = savedText;
    }
  } catch (_) {}

  // Request current state and settings from background
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[Popup] GET_STATE note:', chrome.runtime.lastError.message);
      return;
    }
    if (!response) return;

    const { state, settings } = response;
    currentJobState = state;

    // Apply settings
    if (settings) {
      if (settings.googleDomain && googleDomainSelect) googleDomainSelect.value = settings.googleDomain;
      if (settings.maxPosition && maxPositionSelect) maxPositionSelect.value = String(settings.maxPosition);
      if (settings.delaySeconds && delaySecondsInput) delaySecondsInput.value = settings.delaySeconds;
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

/**
 * Attaches all event listeners safely
 */
function attachEventListeners() {
  // 1. Textarea input auto-save
  if (keywordInput) {
    keywordInput.addEventListener('input', () => {
      saveInputText(keywordInput.value).catch(() => {});
      validateInput();
    });
  }

  // 2. START button handler
  bindButton('btnStart', async () => {
    if (debugModeCheckbox && debugModeCheckbox.checked) {
      console.log('[Popup] START clicked');
    }
    showPopupError('');

    const parsed = validateInput();

    if (parsed.errors.length > 0) {
      showToast('Please fix format errors before starting.');
      showPopupError('Please fix keyword format errors before starting.');
      return;
    }

    if (parsed.valid.length === 0) {
      showToast('Please paste at least one keyword row.');
      showPopupError('Keyword list is empty. Paste keywords before starting.');
      return;
    }

    // If location simulation is enabled, validate coordinates before starting
    if (useLocationCheckbox && useLocationCheckbox.checked) {
      const locValidation = validateCoordinates(latitudeInput?.value, longitudeInput?.value, accuracyInput?.value);
      if (!locValidation.valid) {
        showLocationMessage(locValidation.error, false);
        showToast('Invalid location coordinates. Please fix before starting.');
        showPopupError(`Invalid location coordinates: ${locValidation.error}`);
        return;
      }
    }
    showLocationMessage('', false);

    const settings = {
      googleDomain: googleDomainSelect?.value || 'google.com',
      maxPosition: parseInt(maxPositionSelect ? maxPositionSelect.value : 50, 10) || 50,
      delaySeconds: Math.max(5, parseInt(delaySecondsInput?.value, 10) || 8),
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

    try {
      chrome.runtime.sendMessage({
        action: 'START_JOB',
        queue: parsed.valid,
        settings: settings,
        projectId: activeProject ? activeProject.id : null
      }, (res) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || 'Background service worker unavailable.';
          console.error('[Popup] START_JOB error:', errMsg);
          showPopupError(`Failed to start job: ${errMsg}`);
          showToast(`Error: ${errMsg}`);
          return;
        }
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
          showPopupError(res.error);
          showToast(res.error);
        }
      });
    } catch (err) {
      console.error('[Popup] START_JOB exception:', err);
      showPopupError(`Exception starting job: ${err.message}`);
      showToast(`Error: ${err.message}`);
    }
  });

  // 3. PAUSE button handler
  bindButton('btnPause', () => {
    if (debugModeCheckbox && debugModeCheckbox.checked) {
      console.log('[Popup] PAUSE clicked');
    }
    showPopupError('');
    chrome.runtime.sendMessage({ action: 'PAUSE_JOB' }, (res) => {
      if (chrome.runtime.lastError) {
        showPopupError(`Pause failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (res && res.state) {
        currentJobState = res.state;
        renderStatus(res.state.status);
      }
    });
  });

  // 4. RESUME button handler
  bindButton('btnResume', () => {
    if (debugModeCheckbox && debugModeCheckbox.checked) {
      console.log('[Popup] RESUME clicked');
    }
    showPopupError('');
    chrome.runtime.sendMessage({ action: 'RESUME_JOB' }, (res) => {
      if (chrome.runtime.lastError) {
        showPopupError(`Resume failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (res && res.state) {
        currentJobState = res.state;
        renderStatus(res.state.status);
        showToast('Resuming rank check...');
      } else if (res && !res.success) {
        showToast(res.message || 'Cannot resume.');
        showPopupError(res.message || 'Cannot resume.');
      }
    });
  });

  // 5. STOP button handler
  bindButton('btnStop', () => {
    if (debugModeCheckbox && debugModeCheckbox.checked) {
      console.log('[Popup] STOP clicked');
    }
    showPopupError('');
    chrome.runtime.sendMessage({ action: 'STOP_JOB' }, (res) => {
      if (chrome.runtime.lastError) {
        showPopupError(`Stop failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (res && res.state) {
        currentJobState = res.state;
        renderStatus(res.state.status);
        showToast('Rank checking stopped.');
      }
    });
  });

  // 6. CLEAR button handler — clears immediately and independently
  bindButton('btnClear', () => {
    if (debugModeCheckbox && debugModeCheckbox.checked) {
      console.log('[Popup] CLEAR clicked');
    }
    showPopupError('');

    // Clear textarea and validation box immediately
    if (keywordInput) {
      keywordInput.value = '';
      validateInput();
    }
    saveInputText('').catch(() => {});

    // Clear table and progress immediately
    currentResults = [];
    renderResultsTable([]);
    renderProgress(0, 0);
    showToast('Cleared input and results.');

    // Notify background
    try {
      chrome.runtime.sendMessage({ action: 'CLEAR_JOB' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res && res.state) {
          currentJobState = res.state;
          renderStatus(res.state.status);
        }
      });
    } catch (_) {}
  });

  // 7. Settings auto-save triggers
  if (googleDomainSelect) googleDomainSelect.addEventListener('change', saveCurrentSettings);
  if (maxPositionSelect) maxPositionSelect.addEventListener('change', saveCurrentSettings);
  if (delaySecondsInput) {
    delaySecondsInput.addEventListener('change', () => {
      const val = Math.max(5, parseInt(delaySecondsInput.value, 10) || 8);
      delaySecondsInput.value = val;
      saveCurrentSettings();
    });
  }
  if (debugModeCheckbox) {
    debugModeCheckbox.addEventListener('change', (e) => {
      saveCurrentSettings();
      if (e.target.checked) {
        showToast('Debug logging may display current session SEO data in DevTools.');
      }
    });
  }

  // 8. Location configuration toggles
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

  // 9. Location Actions
  bindButton('btnApplyLocation', async () => {
    const lat = latitudeInput ? latitudeInput.value.trim() : '';
    const lon = longitudeInput ? longitudeInput.value.trim() : '';
    const acc = accuracyInput ? (accuracyInput.value.trim() || '20') : '20';
    const locName = locationNameInput ? locationNameInput.value.trim() : '';

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
      if (chrome.runtime.lastError) {
        showLocationMessage(chrome.runtime.lastError.message, false);
        return;
      }
      if (resp && resp.success) {
        showLocationMessage(resp.message || 'Location configured successfully.', true);
        renderLocationStatus(true, validation, false, true);
      } else {
        showLocationMessage(resp ? resp.error : 'Failed to apply location.', false);
        renderLocationStatus(false, null, false, false, true);
      }
    });
  });

  bindButton('btnTestLocation', () => {
    const lat = latitudeInput ? latitudeInput.value.trim() : '';
    const lon = longitudeInput ? longitudeInput.value.trim() : '';
    const acc = accuracyInput ? (accuracyInput.value.trim() || '20') : '20';
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
      if (chrome.runtime.lastError) {
        showLocationMessage(chrome.runtime.lastError.message, false);
        return;
      }
      if (resp && resp.success) {
        showLocationMessage(resp.message, resp.verified);
      } else {
        showLocationMessage(resp ? resp.error : 'Location test failed.', false);
      }
    });
  });

  bindButton('btnResetLocation', async () => {
    chrome.runtime.sendMessage({ action: 'RESET_LOCATION' }, async () => {
      if (latitudeInput) latitudeInput.value = '';
      if (longitudeInput) longitudeInput.value = '';
      if (locationNameInput) locationNameInput.value = '';
      if (useLocationCheckbox) useLocationCheckbox.checked = false;

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

  // 10. Copy Positions Only handler
  bindButton('btnCopyPositionsOnly', async () => {
    if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.');
      return;
    }
    if (!currentResults || currentResults.length === 0) {
      showToast('No results to copy.');
      return;
    }
    const tsvData = exportToCurrentPositionsOnly(currentResults);
    await copyToClipboard(tsvData);
    showToast(`Copied ${currentResults.length} positions to clipboard!`);
  });

  // 11. Copy All Results handler
  bindButton('btnCopy', async () => {
    if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.');
      return;
    }
    if (!currentResults || currentResults.length === 0) {
      showToast('No results to copy.');
      return;
    }

    const tsvData = exportToTsv(currentResults);
    await copyToClipboard(tsvData);
    showToast('Copied to clipboard! Ready to paste into Excel.');
  });

  // 12. Download CSV handler
  bindButton('btnDownloadCsv', () => {
    if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.');
      return;
    }
    if (!currentResults || currentResults.length === 0) {
      showToast('No results to download.');
      return;
    }

    const csvData = exportToCsv(currentResults);
    const projName = activeProject ? (activeProject.config?.projectName || activeProject.projectName) : 'rankings';
    const filename = `${sanitizeProjectFilename(projName)}_rank_results_${getTodayDateStr()}.csv`;
    downloadCsv(csvData, filename);
    showToast('CSV downloaded.');
  });

  // 13. Open Full Dashboard button
  bindButton('btnOpenDashboard', () => {
    if (debugModeCheckbox && debugModeCheckbox.checked) {
      console.log('[Popup] OPEN DASHBOARD clicked');
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });

  // 14. Clear Session Data button
  bindButton('btnPopupClearSession', async () => {
    if (confirm('Clear all session projects, keywords, and results? Harmless settings will remain.')) {
      await chrome.runtime.sendMessage({ action: 'CLEAR_SESSION_DATA' });
      showToast('Session data cleared.');
      if (keywordInput) keywordInput.value = '';
      currentResults = [];
      renderResultsTable([]);
      if (resultsCount) resultsCount.textContent = '0 checked';
      await initializeState();
    }
  });

  // 15. Project Switcher
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
        const cfg = activeProject.config || activeProject;
        if (useLocationCheckbox) useLocationCheckbox.checked = Boolean(cfg.useLocation);
        if (locationNameInput) locationNameInput.value = cfg.locationName || '';
        if (latitudeInput) latitudeInput.value = cfg.latitude || '';
        if (longitudeInput) longitudeInput.value = cfg.longitude || '';
        if (accuracyInput) accuracyInput.value = cfg.accuracy !== undefined ? cfg.accuracy : 20;

        if (activeProject.keywords && activeProject.keywords.length > 0 && keywordInput) {
          const lines = activeProject.keywords.map(k => `${k.keyword}\t${k.targetUrl}\t${k.previousPosition || ''}`);
          keywordInput.value = lines.join('\n');
          saveInputText(keywordInput.value).catch(() => {});
        }
        renderLocationStatus(false, null, false);
        renderResultsTable(currentJobState ? currentJobState.results : []);
      }
      showToast(`Switched to: ${activeProject?.config?.projectName || 'Project'}`);
    });
  }
}

/**
 * Resolves all DOM elements safely
 */
function initElements() {
  statusBadge = getEl('statusBadge', true);
  alertBanner = getEl('alertBanner');
  alertMessage = getEl('alertMessage');
  keywordInput = getEl('keywordInput', true);
  validationBox = getEl('validationBox');
  popupProjectSelect = getEl('popupProjectSelect');
  btnOpenDashboard = getEl('btnOpenDashboard');
  btnCopyPositionsOnly = getEl('btnCopyPositionsOnly');
  btnPopupClearSession = getEl('btnPopupClearSession');
  googleDomainSelect = getEl('googleDomain');
  maxPositionSelect = getEl('maxPosition');
  delaySecondsInput = getEl('delaySeconds');
  debugModeCheckbox = getEl('debugMode');
  useLocationCheckbox = getEl('useLocation');
  locationStatusIndicator = getEl('locationStatusIndicator');
  locationFieldsGrid = getEl('locationFieldsGrid');
  locationNameInput = getEl('locationName');
  accuracyInput = getEl('accuracy');
  latitudeInput = getEl('latitude');
  longitudeInput = getEl('longitude');
  locationValidationMsg = getEl('locationValidationMsg');
  btnApplyLocation = getEl('btnApplyLocation');
  btnTestLocation = getEl('btnTestLocation');
  btnResetLocation = getEl('btnResetLocation');
  btnStart = getEl('btnStart', true);
  btnPause = getEl('btnPause', true);
  btnResume = getEl('btnResume', true);
  btnStop = getEl('btnStop', true);
  btnClear = getEl('btnClear', true);
  progressSection = getEl('progressSection');
  progressText = getEl('progressText');
  progressPercent = getEl('progressPercent');
  progressBar = getEl('progressBar');
  resultsCount = getEl('resultsCount');
  resultsTableBody = getEl('resultsTableBody', true);
  btnCopy = getEl('btnCopy');
  btnDownloadCsv = getEl('btnDownloadCsv');
  toast = getEl('toast');
}

/**
 * Main entry point
 */
async function initPopup() {
  try {
    initElements();
    attachEventListeners();
    await initializeState();
  } catch (err) {
    console.error('[Popup] Startup error:', err);
    showPopupError(`Popup failed to initialize: ${err.message}`);
  }
}

// Background runtime message listener
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
    initializeState();
  }
});

// Run initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initPopup().catch((err) => {
      console.error('[Popup] Unhandled initialization error:', err);
      showPopupError(`Startup error: ${err.message}`);
    });
  });
} else {
  initPopup().catch((err) => {
    console.error('[Popup] Unhandled initialization error:', err);
    showPopupError(`Startup error: ${err.message}`);
  });
}
