/**
 * popup.js
 * User interface controller for SERPTrack.
 * Communicates with background service worker and renders live state.
 */

import { parseInputRows } from '../utils/parser.js';
import { exportToTsv, exportToCsv, exportToCurrentPositionsOnly, copyToClipboard } from '../utils/exporter.js';
import { getInputText, saveInputText } from '../utils/storage.js';
import { validateCoordinates } from '../utils/locationValidator.js';
import { getProjects, getActiveProject, setActiveProjectId } from '../utils/projectManager.js';

// DOM Elements
const statusBadge = document.getElementById('statusBadge');
const alertBanner = document.getElementById('alertBanner');
const alertMessage = document.getElementById('alertMessage');
const keywordInput = document.getElementById('keywordInput');
const validationBox = document.getElementById('validationBox');

// Dashboard & Project Switcher Elements (Milestone 3)
const popupProjectSelect = document.getElementById('popupProjectSelect');
const btnOpenDashboard = document.getElementById('btnOpenDashboard');
const btnCopyPositionsOnly = document.getElementById('btnCopyPositionsOnly');

const googleDomainSelect = document.getElementById('googleDomain');
const maxPositionSelect = document.getElementById('maxPosition');
const delaySecondsInput = document.getElementById('delaySeconds');
const debugModeCheckbox = document.getElementById('debugMode');

// Location Simulation DOM Elements (Milestone 2)
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

/**
 * Shows temporary toast notification
 */
function showToast(text) {
  toast.textContent = text;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2200);
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
 * @param {boolean} isApplied 
 * @param {object|null} details 
 * @param {boolean} needsReapply 
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
 * @param {string} msg 
 * @param {boolean} isSuccess 
 */
function showLocationMessage(msg, isSuccess = false) {
  if (!locationValidationMsg) return;
  if (!msg) {
    locationValidationMsg.classList.add('hidden');
    locationValidationMsg.innerHTML = '';
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
 * Updates UI control buttons and badges based on job status
 */
function renderStatus(status, errorMessage = null) {
  currentStatus = status || 'IDLE';
  statusBadge.textContent = currentStatus;
  statusBadge.className = `status-badge status-${currentStatus.toLowerCase()}`;

  // Alert banner for Google interruption / CAPTCHA
  if (status === 'BLOCKED') {
    alertBanner.classList.remove('hidden');
    alertMessage.textContent = errorMessage || 'Google interrupted rank checking. The job has been paused.';
  } else {
    alertBanner.classList.add('hidden');
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
 * Renders the results table with honest depth and clear cannibalization status
 */
function renderResultsTable(results) {
  currentResults = results || [];
  resultsCount.textContent = `${currentResults.length} checked`;

  if (currentResults.length === 0) {
    resultsTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="7" class="text-center">No ranking results yet. Paste keywords and click START.</td>
      </tr>
    `;
    return;
  }

  resultsTableBody.innerHTML = currentResults.map(r => {
    // Determine change class
    let changeClass = 'change-same';
    if (r.change && r.change.includes('↑')) {
      changeClass = 'change-up';
    } else if (r.change && r.change.includes('↓')) {
      changeClass = 'change-down';
    }

    let matchBadgeClass = 'badge-not-found';
    let matchLabel = 'NOT FOUND';
    let statusLabel = 'NOT FOUND';
    let currentCellHtml = '';
    let subInfo = '';

    if (r.matchStatus === 'EXACT PAGE') {
      matchBadgeClass = 'badge-exact';
      matchLabel = 'EXACT PAGE';
      statusLabel = 'EXACT PAGE';
      currentCellHtml = `<strong>${escapeHtml(String(r.currentPosition))}</strong>`;
      subInfo = `<span class="sub-info">Checked depth: ${r.checkedDepth || 0}</span>`;
    } else if (r.matchStatus === 'OTHER DOMAIN PAGE FOUND') {
      matchBadgeClass = 'badge-other-domain';
      matchLabel = 'OTHER DOMAIN FOUND';
      statusLabel = 'TARGET NOT FOUND';
      const depthText = r.checkedDepth ? `Not Found (Top ${r.checkedDepth})` : 'Not Found';
      currentCellHtml = `<span class="not-found-text">${escapeHtml(depthText)}</span>`;
      subInfo = `<span class="sub-info" title="${escapeHtml(r.otherPageFound || '')}">Other page ranks at pos ${r.otherPagePosition || '?'}</span>`;
    } else if (r.status === 'ERROR') {
      matchBadgeClass = 'badge-error';
      matchLabel = 'ERROR';
      statusLabel = 'ERROR';
      currentCellHtml = `<span class="not-found-text">Error</span>`;
      subInfo = `<span class="sub-info" title="${escapeHtml(r.error || '')}">${escapeHtml(r.error || 'Error')}</span>`;
    } else {
      matchBadgeClass = 'badge-not-found';
      matchLabel = 'NOT FOUND';
      statusLabel = 'TARGET NOT FOUND';
      const depthText = r.checkedDepth ? `Not Found (Top ${r.checkedDepth})` : 'Not Found';
      currentCellHtml = `<span class="not-found-text">${escapeHtml(depthText)}</span>`;
      subInfo = `<span class="sub-info">Checked ${r.checkedDepth || 0} results</span>`;
    }

    return `
      <tr>
        <td class="keyword-cell" title="${escapeHtml(r.keyword)}">${escapeHtml(r.keyword)}</td>
        <td class="url-cell" title="${escapeHtml(r.targetUrl)}">${escapeHtml(r.targetUrl)}</td>
        <td class="text-center">${escapeHtml(String(r.previousPosition || '-'))}</td>
        <td class="text-center">${currentCellHtml}</td>
        <td class="text-center ${changeClass}">${escapeHtml(r.change || '—')}</td>
        <td>
          <span class="rank-badge ${matchBadgeClass}">${escapeHtml(matchLabel)}</span>
          ${subInfo}
        </td>
        <td>
          <span class="rank-badge ${matchBadgeClass}">${escapeHtml(statusLabel)}</span>
        </td>
      </tr>
    `;
  }).join('');
}

/**
 * Escapes HTML entities for safe table rendering
 */
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Updates progress bar and text
 */
function renderProgress(currentIndex, total) {
  if (!total || total === 0 || currentStatus === 'IDLE') {
    progressSection.classList.add('hidden');
    return;
  }

  progressSection.classList.remove('hidden');
  const displayIndex = Math.min(currentIndex + 1, total);
  const isFinished = currentIndex >= total || currentStatus === 'COMPLETED';

  if (isFinished) {
    progressText.textContent = `Completed ${total} of ${total} keywords`;
    progressPercent.textContent = '100%';
    progressBar.style.width = '100%';
  } else {
    const percent = Math.round((currentIndex / total) * 100);
    progressText.textContent = `Checking keyword ${displayIndex} of ${total}`;
    progressPercent.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
  }
}

/**
 * Validates textarea content and displays error messages if invalid
 */
function validateInput() {
  const text = keywordInput.value.trim();
  if (!text) {
    validationBox.classList.add('hidden');
    validationBox.innerHTML = '';
    return { valid: [], errors: [] };
  }

  const parsed = parseInputRows(text);
  if (parsed.errors.length > 0) {
    validationBox.classList.remove('hidden');
    validationBox.innerHTML = `
      <strong>Format errors detected:</strong>
      <ul style="margin: 4px 0 0 16px; padding: 0;">
        ${parsed.errors.slice(0, 3).map(e => `<li>Line ${e.line}: ${escapeHtml(e.message)}</li>`).join('')}
        ${parsed.errors.length > 3 ? `<li>...and ${parsed.errors.length - 3} more errors</li>` : ''}
      </ul>
    `;
  } else {
    validationBox.classList.add('hidden');
    validationBox.innerHTML = '';
  }

  return parsed;
}

/**
 * Initializes state by querying the background worker
 */
async function initialize() {
  // Populate Project Selector (Milestone 3)
  try {
    const projects = await getProjects();
    const activeProj = await getActiveProject();
    if (popupProjectSelect) {
      popupProjectSelect.innerHTML = '';
      Object.keys(projects).forEach(pId => {
        const opt = document.createElement('option');
        opt.value = pId;
        opt.textContent = projects[pId].config?.projectName || projects[pId].projectName || 'Untitled Project';
        if (pId === activeProj.id || pId === activeProj.config?.projectId) opt.selected = true;
        popupProjectSelect.appendChild(opt);
      });
    }
  } catch (_) {}

  // Load cached input text
  const savedText = await getInputText();
  if (savedText && !keywordInput.value) {
    keywordInput.value = savedText;
  }

  // Request current state and settings from background
  chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError || !response) return;

    const { state, settings } = response;

    // Apply settings
    if (settings) {
      if (settings.googleDomain) googleDomainSelect.value = settings.googleDomain;
      if (settings.maxPosition && maxPositionSelect) maxPositionSelect.value = String(settings.maxPosition);
      if (settings.delaySeconds) delaySecondsInput.value = settings.delaySeconds;
      if (debugModeCheckbox) debugModeCheckbox.checked = Boolean(settings.debugMode);

      if (settings.useLocation !== undefined && useLocationCheckbox) {
        useLocationCheckbox.checked = Boolean(settings.useLocation);
      }
      if (settings.locationName !== undefined && locationNameInput) {
        locationNameInput.value = settings.locationName || '';
      }
      if (settings.accuracy !== undefined && accuracyInput) {
        accuracyInput.value = settings.accuracy || 20;
      }
      if (settings.latitude !== undefined && latitudeInput) {
        latitudeInput.value = settings.latitude || '';
      }
      if (settings.longitude !== undefined && longitudeInput) {
        longitudeInput.value = settings.longitude || '';
      }
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

// Project switcher listener in popup
if (popupProjectSelect) {
  popupProjectSelect.addEventListener('change', async (e) => {
    if (currentStatus === 'RUNNING') {
      showToast('Cannot switch project while a job is running!');
      const activeProj = await getActiveProject();
      e.target.value = activeProj.id;
      return;
    }
    await setActiveProjectId(e.target.value);
    const active = await getActiveProject();
    if (active && active.keywords && active.keywords.length > 0) {
      const lines = active.keywords.map(k => `${k.keyword}\t${k.targetUrl}\t${k.previousPosition || ''}`);
      keywordInput.value = lines.join('\n');
      saveInputText(keywordInput.value);
    }
    showToast(`Switched project: ${active.config?.projectName || 'Project'}`);
    initialize();
  });
}

// Open Dashboard button handler
if (btnOpenDashboard) {
  btnOpenDashboard.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  });
}

// Copy Positions Only handler
if (btnCopyPositionsOnly) {
  btnCopyPositionsOnly.addEventListener('click', () => {
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
btnStart.addEventListener('click', () => {
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
    locationName: locationNameInput ? locationNameInput.value.trim() : ''
  };

  chrome.runtime.sendMessage({
    action: 'START_JOB',
    queue: parsed.valid,
    settings: settings
  }, (res) => {
    if (res && res.state) {
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
      renderStatus(res.state.status);
    }
  });
});

// RESUME button handler
btnResume.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'RESUME_JOB' }, (res) => {
    if (res && res.state) {
      renderStatus(res.state.status);
    }
  });
});

// STOP button handler
btnStop.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'STOP_JOB' }, (res) => {
    if (res && res.state) {
      renderStatus(res.state.status);
    }
  });
});

// CLEAR button handler
btnClear.addEventListener('click', () => {
  if (confirm('Clear all ranking results and current progress?')) {
    chrome.runtime.sendMessage({ action: 'CLEAR_JOB' }, (res) => {
      if (res && res.state) {
        renderStatus(res.state.status);
        renderResultsTable([]);
        renderProgress(0, 0);
        showToast('Results cleared.');
      }
    });
  }
});

// Save settings on change
function saveCurrentSettings() {
  const settings = {
    googleDomain: googleDomainSelect.value,
    maxPosition: parseInt(maxPositionSelect ? maxPositionSelect.value : 50, 10) || 50,
    delaySeconds: Math.max(5, parseInt(delaySecondsInput.value, 10) || 8),
    debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
    useLocation: useLocationCheckbox ? useLocationCheckbox.checked : false,
    latitude: latitudeInput ? latitudeInput.value.trim() : '',
    longitude: longitudeInput ? longitudeInput.value.trim() : '',
    accuracy: accuracyInput ? (parseInt(accuracyInput.value, 10) || 20) : 20,
    locationName: locationNameInput ? locationNameInput.value.trim() : ''
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
if (debugModeCheckbox) debugModeCheckbox.addEventListener('change', saveCurrentSettings);

// Location inputs event listeners
if (useLocationCheckbox) {
  useLocationCheckbox.addEventListener('change', () => {
    renderLocationStatus(false, null, false);
    saveCurrentSettings();
    showLocationMessage('', false);
  });
}

if (latitudeInput) {
  latitudeInput.addEventListener('input', () => {
    showLocationMessage('', false);
    saveCurrentSettings();
  });
}
if (longitudeInput) {
  longitudeInput.addEventListener('input', () => {
    showLocationMessage('', false);
    saveCurrentSettings();
  });
}
if (accuracyInput) {
  accuracyInput.addEventListener('change', saveCurrentSettings);
}
if (locationNameInput) {
  locationNameInput.addEventListener('input', saveCurrentSettings);
}

// APPLY LOCATION button handler
if (btnApplyLocation) {
  btnApplyLocation.addEventListener('click', () => {
    const lat = latitudeInput.value.trim();
    const lon = longitudeInput.value.trim();
    const acc = accuracyInput.value.trim();
    const locName = locationNameInput.value.trim();

    const val = validateCoordinates(lat, lon, acc);
    if (!val.valid) {
      showLocationMessage(val.error, false);
      showToast('Validation Error: ' + val.error);
      return;
    }

    showLocationMessage('', false);
    chrome.runtime.sendMessage({
      action: 'APPLY_LOCATION',
      location: {
        latitude: val.latitude,
        longitude: val.longitude,
        accuracy: val.accuracy,
        locationName: locName
      }
    }, (res) => {
      if (res && res.success) {
        renderLocationStatus(true, { latitude: val.latitude, longitude: val.longitude });
        showLocationMessage(`Location override active: ${val.latitude}, ${val.longitude}`, true);
        showToast('Location override applied.');
      } else {
        const errMsg = (res && res.error) ? res.error : 'Failed to apply location override.';
        showLocationMessage(errMsg, false);
        showToast(errMsg);
      }
    });
  });
}

// RESET LOCATION button handler
if (btnResetLocation) {
  btnResetLocation.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'RESET_LOCATION' }, (res) => {
      if (res && res.success) {
        if (useLocationCheckbox) useLocationCheckbox.checked = false;
        renderLocationStatus(false, null, false);
        showLocationMessage('Location override removed.', true);
        showToast('Location override removed.');
        setTimeout(() => showLocationMessage('', false), 2500);
      }
    });
  });
}

// TEST LOCATION button handler
if (btnTestLocation) {
  btnTestLocation.addEventListener('click', () => {
    const lat = latitudeInput.value.trim();
    const lon = longitudeInput.value.trim();
    const acc = accuracyInput.value.trim();

    const val = validateCoordinates(lat, lon, acc);
    if (!val.valid) {
      showLocationMessage(val.error, false);
      showToast(val.error);
      return;
    }

    btnTestLocation.disabled = true;
    btnTestLocation.textContent = 'TESTING...';
    showLocationMessage('Applying coordinates and verifying browser geolocation...', true);

    chrome.runtime.sendMessage({
      action: 'TEST_LOCATION',
      location: {
        latitude: val.latitude,
        longitude: val.longitude,
        accuracy: val.accuracy
      }
    }, (res) => {
      btnTestLocation.disabled = false;
      btnTestLocation.textContent = 'TEST LOCATION';

      if (res && res.success && res.verified) {
        renderLocationStatus(true, { latitude: res.latitude, longitude: res.longitude });
        showLocationMessage(`Location Override Applied (Verified: ${res.latitude}, ${res.longitude})`, true);
        showToast('Location Override Applied');
      } else if (res && res.success && !res.verified) {
        showLocationMessage(`Location set, but browser reported coordinates: ${res.latitude}, ${res.longitude}`, false);
        showToast('Location Override Failed');
      } else {
        const err = (res && res.error) ? res.error : 'Location Override Failed';
        showLocationMessage(err, false);
        showToast('Location Override Failed');
      }
    });
  });
}

// COPY RESULTS button handler (Excel TSV clipboard copy)
btnCopy.addEventListener('click', async () => {
  if (!currentResults || currentResults.length === 0) {
    showToast('No results to copy.');
    return;
  }

  const tsvData = exportToTsv(currentResults);
  try {
    await navigator.clipboard.writeText(tsvData);
    showToast('Copied to clipboard! Ready to paste into Excel.');
  } catch (err) {
    const tempEl = document.createElement('textarea');
    tempEl.value = tsvData;
    document.body.appendChild(tempEl);
    tempEl.select();
    document.execCommand('copy');
    document.body.removeChild(tempEl);
    showToast('Copied to clipboard! Ready to paste into Excel.');
  }
});

// DOWNLOAD CSV button handler
btnDownloadCsv.addEventListener('click', () => {
  if (!currentResults || currentResults.length === 0) {
    showToast('No results to download.');
    return;
  }

  const csvData = exportToCsv(currentResults);
  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rank_results_${getTodayDateStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV downloaded.');
});

// Listen for live broadcasts from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PROGRESS_UPDATE' && msg.state) {
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
  }
});

// Run initialization on popup open
initialize();
