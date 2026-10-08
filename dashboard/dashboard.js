/**
 * dashboard.js
 * Pro Dashboard Controller for SERPTrack.
 * 
 * Strict Privacy-First Architecture:
 * - Projects and results reside in session memory only (chrome.storage.session).
 * - Safe DOM text node rendering (Zero unsafe innerHTML).
 * - Project location configuration is saved per project.
 * - Project switching is locked during active, paused, or blocked runs.
 * - Results are strictly bound to project ID.
 */

import {
  exportToCsv,
  exportToTsv,
  exportToCurrentPositionsOnly,
  downloadCsv,
  copyToClipboard,
  sanitizeProjectFilename
} from '../utils/exporter.js';

import { parseInputRows } from '../utils/parser.js';
import { listRankingWorkbookSheets, inspectRankingWorkbook, buildUpdatedRankingWorkbook } from '../utils/rankingWorkbook.js';

import {
  getProjects,
  getActiveProject,
  getActiveProjectId,
  setActiveProjectId,
  createProject,
  updateProject,
  deleteProject,
  getProjectById,
  saveProjectKeywords,
  promoteCurrentToPrevious,
  exportProjectJson,
  importProjectJson
} from '../utils/projectManager.js';

import { validateCoordinates } from '../utils/locationValidator.js';
import { getRememberedCoordinates, getLocationForProject, rememberCoordinates, forgetRememberedCoordinates } from '../utils/rememberedLocation.js';
import {
  LOCATION_STATES,
  isSessionStorageAvailable,
  SESSION_STORAGE_UNAVAILABLE_ERROR
} from '../utils/storage.js';

// Application State
let activeProject = null;
let allProjectsMap = {};
let currentJobState = null;
let pendingConfirmCallback = null;
// The original XLSX contains unrelated client information and possibly secrets.
// It is held ONLY in this dashboard's memory, never in Chrome storage/GitHub.
let importedWorkbook = null;
let pendingWorkbookUpload = null; // bytes retained in memory for manual worksheet mapping

function xlsxColumnNumber(raw) {
  const text = String(raw || '').trim().toUpperCase();
  if (!text) return undefined;
  if (!/^[A-Z]{1,3}$/.test(text)) throw new Error('Column must be letters A–XFD.');
  let value = 0;
  for (const character of text) value = value * 26 + character.charCodeAt(0) - 64;
  if (value > 16384) throw new Error('Column must be between A and XFD.');
  return value;
}
function xlsxColumnLetters(number) {
  let n = Number(number) || 0;
  if (!n) return '';
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + n % 26) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function todayLocalDate() {
  const today = new Date();
  const part = value => String(value).padStart(2, '0');
  return today.getFullYear() + '-' + part(today.getMonth() + 1) + '-' + part(today.getDate());
}
function canExportWorkbook() {
  return Boolean(importedWorkbook && importedWorkbook.startedRunId &&
    currentJobState && currentJobState.status === 'COMPLETED' &&
    currentJobState.runId === importedWorkbook.startedRunId &&
    currentJobState.projectId === importedWorkbook.projectId &&
    Array.isArray(currentJobState.results));
}
function syncWorkbookDownloadButton() {
  if (el.btnDownloadWorkbook) el.btnDownloadWorkbook.disabled = !canExportWorkbook();
}
function resetWorkbookImport() {
  importedWorkbook = null;
  pendingWorkbookUpload = null;
  if (el.workbookSheet) el.workbookSheet.replaceChildren();
  for (const field of [el.workbookHeaderRow, el.workbookKeywordCol, el.workbookUrlCol, el.workbookBaselineCol]) {
    if (field) field.value = '';
  }
  if (el.btnApplyWorkbookMap) el.btnApplyWorkbookMap.disabled = true;
  if (el.workbookFile) el.workbookFile.value = '';
  if (el.workbookStatus) el.workbookStatus.textContent = 'No workbook loaded. Raw Excel data is never uploaded or persisted.';
  if (el.btnClearWorkbook) el.btnClearWorkbook.disabled = true;
  if (el.keywordsTextarea) el.keywordsTextarea.readOnly = false;
  if (el.btnSaveKeywords) el.btnSaveKeywords.disabled = false;
  if (el.btnLoadSample) el.btnLoadSample.disabled = false;
  syncWorkbookDownloadButton();
}

// DOM Element Selectors
const el = {
  projectSelect: document.getElementById('project-select'),
  btnNewProject: document.getElementById('btn-new-project'),
  btnEditProject: document.getElementById('btn-edit-project'),
  btnDeleteProject: document.getElementById('btn-delete-project'),
  btnExportProject: document.getElementById('btn-export-project'),
  btnImportProject: document.getElementById('btn-import-project'),
  btnClearSession: document.getElementById('btn-clear-session'),
  btnPrivacyClear: document.getElementById('btn-privacy-clear'),

  // Location elements
  useLocationToggle: document.getElementById('use-location-toggle'),
  locationFieldsContainer: document.getElementById('location-fields-container'),
  locName: document.getElementById('loc-name'),
  locLat: document.getElementById('loc-lat'),
  locLon: document.getElementById('loc-lon'),
  locAcc: document.getElementById('loc-acc'),
  btnApplyLocation: document.getElementById('btn-apply-location'),
  btnTestLocation: document.getElementById('btn-test-location'),
  btnClearLocation: document.getElementById('btn-clear-location'),
  locationStatusBadge: document.getElementById('location-status-badge'),
  locationMsg: document.getElementById('location-msg'),

  // Search & Execution parameters
  googleDomain: document.getElementById('google-domain'),
  maxDepth: document.getElementById('max-depth'),
  delaySeconds: document.getElementById('delay-seconds'),
  jobStatusBadge: document.getElementById('job-status-badge'),
  btnStart: document.getElementById('btn-start'),
  btnPause: document.getElementById('btn-pause'),
  btnResume: document.getElementById('btn-resume'),
  btnStop: document.getElementById('btn-stop'),
  btnClear: document.getElementById('btn-clear'),
  jobBannerMsg: document.getElementById('job-banner-msg'),

  // Progress Section
  progressCard: document.getElementById('progress-card'),
  progProjectName: document.getElementById('prog-project-name'),
  progFraction: document.getElementById('prog-fraction'),
  progActivity: document.getElementById('prog-activity'),
  progressBarFill: document.getElementById('progress-bar-fill'),
  statTotal: document.getElementById('stat-total'),
  statFound: document.getElementById('stat-found'),
  statNotFound: document.getElementById('stat-notfound'),
  statError: document.getElementById('stat-error'),

  // Tabs & Badges
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanes: document.querySelectorAll('.tab-pane'),
  resultsCountBadge: document.getElementById('results-count-badge'),
  keywordsCountBadge: document.getElementById('keywords-count-badge'),

  // Results Table
  resultsTbody: document.getElementById('results-tbody'),
  btnCopyPositions: document.getElementById('btn-copy-positions'),
  btnCopyAll: document.getElementById('btn-copy-all'),
  btnDownloadCsv: document.getElementById('btn-download-csv'),
  btnDownloadWorkbook: document.getElementById('btn-download-workbook'),
  btnRetryFailed: document.getElementById('btn-retry-failed'),
  btnUseAsPrevious: document.getElementById('btn-use-as-previous'),

  // Keywords Tab
  keywordsTextarea: document.getElementById('keywords-textarea'),
  defaultTargetSite: document.getElementById('default-target-site'),
  workbookFile: document.getElementById('workbook-file'),
  workbookDate: document.getElementById('workbook-date'),
  workbookStatus: document.getElementById('workbook-import-status'),
  workbookSheet: document.getElementById('workbook-sheet'),
  workbookHeaderRow: document.getElementById('workbook-header-row'),
  workbookKeywordCol: document.getElementById('workbook-keyword-col'),
  workbookUrlCol: document.getElementById('workbook-url-col'),
  workbookBaselineCol: document.getElementById('workbook-baseline-col'),
  btnApplyWorkbookMap: document.getElementById('btn-apply-workbook-map'),
  btnClearWorkbook: document.getElementById('btn-clear-workbook'),
  keywordCountLabel: document.getElementById('keyword-count-label'),
  btnLoadSample: document.getElementById('btn-load-sample'),
  btnSaveKeywords: document.getElementById('btn-save-keywords'),

  // Modals
  projectModal: document.getElementById('project-modal'),
  modalProjectTitle: document.getElementById('modal-project-title'),
  modalProjectName: document.getElementById('modal-project-name'),
  modalProjectDomain: document.getElementById('modal-project-domain'),
  modalProjectGoogle: document.getElementById('modal-project-google'),
  modalProjectDelay: document.getElementById('modal-project-delay'),
  modalProjectDepth: document.getElementById('modal-project-depth'),
  modalProjectUseLocation: document.getElementById('modal-project-use-location'),
  modalProjectLocName: document.getElementById('modal-project-loc-name'),
  modalProjectLat: document.getElementById('modal-project-lat'),
  modalProjectLon: document.getElementById('modal-project-lon'),
  modalProjectAcc: document.getElementById('modal-project-acc'),
  btnSaveProjectModal: document.getElementById('btn-save-project-modal'),
  btnCancelProjectModal: document.getElementById('btn-cancel-project-modal'),
  btnCloseProjectModal: document.getElementById('btn-close-project-modal'),

  confirmModal: document.getElementById('confirm-modal'),
  confirmModalTitle: document.getElementById('confirm-modal-title'),
  confirmModalMessage: document.getElementById('confirm-modal-message'),
  btnAcceptConfirm: document.getElementById('btn-accept-confirm'),
  btnCancelConfirm: document.getElementById('btn-cancel-confirm'),
  btnCloseConfirmModal: document.getElementById('btn-close-confirm-modal'),

  importModal: document.getElementById('import-modal'),
  importJsonFile: document.getElementById('import-json-file'),
  importJsonText: document.getElementById('import-json-text'),
  btnSubmitImportModal: document.getElementById('btn-submit-import-modal'),
  btnCancelImportModal: document.getElementById('btn-cancel-import-modal'),
  btnCloseImportModal: document.getElementById('btn-close-import-modal'),

  toastContainer: document.getElementById('toast-container')
};

/**
 * Shows a toast message on screen.
 * @param {string} msg 
 * @param {'success'|'error'|'info'} type 
 */
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/**
 * Opens confirmation modal with customized title and message.
 * @param {string} title 
 * @param {string} message 
 * @param {Function} onConfirm 
 */
function openConfirmModal(title, message, onConfirm) {
  el.confirmModalTitle.textContent = title;
  el.confirmModalMessage.textContent = message;
  pendingConfirmCallback = onConfirm;
  el.confirmModal.style.display = 'flex';
}

function closeConfirmModal() {
  el.confirmModal.style.display = 'none';
  pendingConfirmCallback = null;
}

/**
 * Initializes the dashboard.
 */
async function initDashboard() {
  if (!isSessionStorageAvailable()) {
    const alertEl = document.getElementById('session-storage-alert');
    if (alertEl) {
      alertEl.style.display = 'flex';
    }
    showToast(SESSION_STORAGE_UNAVAILABLE_ERROR, 'error');
    if (el.btnStart) el.btnStart.disabled = true;
    if (el.btnNewProject) el.btnNewProject.disabled = true;
    if (el.btnImportProject) el.btnImportProject.disabled = true;
    if (el.btnEditProject) el.btnEditProject.disabled = true;
    if (el.btnDeleteProject) el.btnDeleteProject.disabled = true;
    return;
  }

  await refreshProjectsList();
  if (el.workbookDate) el.workbookDate.value = todayLocalDate();
  setupEventListeners();
  await syncBackgroundState();
  setInterval(syncBackgroundState, 2000);
}

/**
 * Loads projects from session storage and populates project selector dropdown.
 */
async function refreshProjectsList() {
  allProjectsMap = await getProjects();
  activeProject = await getActiveProject();

  el.projectSelect.replaceChildren();
  Object.keys(allProjectsMap).forEach(pId => {
    const proj = allProjectsMap[pId];
    const option = document.createElement('option');
    option.value = pId;
    option.textContent = proj.config?.projectName || proj.projectName || 'Untitled Project';
    if (pId === activeProject.id || pId === activeProject.config?.projectId) {
      option.selected = true;
    }
    el.projectSelect.appendChild(option);
  });

  await loadActiveProjectIntoUI(activeProject);
}

/**
 * Loads active project configuration and keywords into UI fields.
 * Bug 1 Fix: Explicitly loads that project's exact location configuration.
 * @param {object} proj 
 */
async function loadActiveProjectIntoUI(proj) {
  if (!proj) return;
  const cfg = proj.config || proj;

  el.progProjectName.textContent = `Project: ${cfg.projectName || 'Default Client'}`;

  // Geolocation simulation per project
  const saved = getLocationForProject(cfg, await getRememberedCoordinates());
  el.useLocationToggle.checked = Boolean(cfg.useLocation && saved.source === 'project');
  el.locName.value = cfg.locationName || '';
  el.locLat.value = saved.latitude;
  el.locLon.value = saved.longitude;
  el.locAcc.value = saved.accuracy;

  // Search parameters
  el.googleDomain.value = cfg.googleDomain || 'google.com';
  el.maxDepth.value = String(cfg.defaultMaxDepth || 50);
  el.delaySeconds.value = String(cfg.defaultDelaySeconds || 8);

  // Keywords
  if (el.defaultTargetSite) el.defaultTargetSite.value = cfg.domain || '';
  const keywords = proj.keywords || [];
  renderKeywordsTextarea(keywords);
}

/**
 * Renders keywords in tab-separated format into the textarea.
 * @param {Array<object>} keywords 
 */
function renderKeywordsTextarea(keywords) {
  if (!keywords || keywords.length === 0) {
    el.keywordsTextarea.value = '';
    el.keywordCountLabel.textContent = '0 keywords in project';
    el.keywordsCountBadge.textContent = '0';
    renderKeywordsPreview();
    return;
  }

  const lines = keywords.map(kw => {
    const prev = (kw.previousPosition !== null && kw.previousPosition !== undefined && kw.previousPosition !== '—' && kw.previousPosition !== '-')
      ? kw.previousPosition
      : '';
    return `${kw.keyword}\t${kw.targetUrl}\t${prev}`;
  });

  el.keywordsTextarea.value = lines.join('\n');
  el.keywordCountLabel.textContent = `${keywords.length} keywords in project`;
  el.keywordsCountBadge.textContent = String(keywords.length);
  renderKeywordsPreview();
}

/**
 * Parses user input in keywords textarea using the authoritative smart parser.
 * Format: keyword [TAB/comma/space] targetUrl [TAB/comma/space] previousPosition
 * @returns {Array<object>}
 */
function parseKeywordsFromTextarea() {
  const text = el.keywordsTextarea.value || '';
  const { valid } = parseInputRows(text, { defaultTargetUrl: el.defaultTargetSite?.value || '' });
  return valid;
}

/**
 * Renders live parsed preview for dashboard keyword queue tab.
 */
function renderKeywordsPreview() {
  const previewBox = document.getElementById('keywords-preview-box');
  if (!previewBox || !el.keywordsTextarea) return;

  const text = el.keywordsTextarea.value || '';
  if (!text.trim()) {
    previewBox.style.display = 'none';
    previewBox.replaceChildren();
    if (el.keywordCountLabel) el.keywordCountLabel.textContent = '0 keywords detected';
    return;
  }

  const { valid, errors } = parseInputRows(text, { defaultTargetUrl: el.defaultTargetSite?.value || '' });
  if (el.keywordCountLabel) {
    el.keywordCountLabel.textContent = `${valid.length} keyword(s) detected${errors.length > 0 ? ` (${errors.length} invalid)` : ''}`;
  }

  previewBox.style.display = 'block';
  previewBox.replaceChildren();

  // 1. Errors if any
  if (errors.length > 0) {
    const errCard = document.createElement('div');
    errCard.style.background = 'rgba(239, 68, 68, 0.15)';
    errCard.style.border = '1px solid #ef4444';
    errCard.style.borderRadius = '6px';
    errCard.style.padding = '8px 12px';
    errCard.style.marginBottom = valid.length > 0 ? '10px' : '0';
    errCard.style.color = '#fca5a5';
    errCard.style.fontSize = '12px';

    const errTitle = document.createElement('div');
    errTitle.style.fontWeight = '700';
    errTitle.style.marginBottom = '4px';
    errTitle.textContent = `⚠️ Could not understand ${errors.length} row(s):`;
    errCard.appendChild(errTitle);

    const ul = document.createElement('ul');
    ul.style.margin = '4px 0 0 16px';
    ul.style.padding = '0';

    errors.slice(0, 5).forEach(e => {
      const li = document.createElement('li');
      li.textContent = `Line ${e.line}: ${e.message}`;
      ul.appendChild(li);
    });

    if (errors.length > 5) {
      const liMore = document.createElement('li');
      liMore.textContent = `...and ${errors.length - 5} more lines`;
      ul.appendChild(liMore);
    }
    errCard.appendChild(ul);
    previewBox.appendChild(errCard);
  }

  // 2. Valid rows preview table
  if (valid.length > 0) {
    const validCard = document.createElement('div');
    validCard.style.background = 'rgba(34, 197, 94, 0.1)';
    validCard.style.border = '1px solid #22c55e';
    validCard.style.borderRadius = '6px';
    validCard.style.padding = '10px 12px';
    validCard.style.color = '#86efac';
    validCard.style.fontSize = '12px';

    const title = document.createElement('div');
    title.style.fontWeight = '700';
    title.style.marginBottom = '6px';
    title.textContent = `✓ Parsed Preview: ${valid.length} Keyword(s) Ready to Check`;
    validCard.appendChild(title);

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '11px';

    const thead = document.createElement('thead');
    const trH = document.createElement('tr');
    ['#', 'Keyword', 'Target URL', 'Previous Position'].forEach(hText => {
      const th = document.createElement('th');
      th.textContent = hText;
      th.style.textAlign = 'left';
      th.style.padding = '4px 8px';
      th.style.borderBottom = '1px solid #15803d';
      th.style.color = '#4ade80';
      trH.appendChild(th);
    });
    thead.appendChild(trH);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    valid.slice(0, 8).forEach((r, idx) => {
      const tr = document.createElement('tr');

      const tdIdx = document.createElement('td');
      tdIdx.textContent = String(idx + 1);
      tdIdx.style.padding = '4px 8px';
      tdIdx.style.color = '#94a3b8';
      tr.appendChild(tdIdx);

      const tdKw = document.createElement('td');
      tdKw.textContent = r.keyword;
      tdKw.style.padding = '4px 8px';
      tdKw.style.color = '#ffffff';
      tdKw.style.fontWeight = '600';
      tr.appendChild(tdKw);

      const tdUrl = document.createElement('td');
      tdUrl.textContent = r.targetUrl;
      tdUrl.style.padding = '4px 8px';
      tdUrl.style.color = '#60a5fa';
      tr.appendChild(tdUrl);

      const tdPos = document.createElement('td');
      tdPos.textContent = String(r.previousPosition || '-');
      tdPos.style.padding = '4px 8px';
      tdPos.style.color = '#e2e8f0';
      tr.appendChild(tdPos);

      tbody.appendChild(tr);
    });

    if (valid.length > 8) {
      const trMore = document.createElement('tr');
      const tdMore = document.createElement('td');
      tdMore.colSpan = 4;
      tdMore.style.padding = '4px 8px';
      tdMore.style.fontStyle = 'italic';
      tdMore.style.color = '#86efac';
      tdMore.textContent = `...and ${valid.length - 8} more keywords`;
      trMore.appendChild(tdMore);
      tbody.appendChild(trMore);
    }

    table.appendChild(tbody);
    validCard.appendChild(table);
    previewBox.appendChild(validCard);
  }
}

/**
 * Updates truthful location status badge.
 * @param {string} state 'NOT_CONFIGURED' | 'CONFIGURED' | 'ACTIVE' | 'FAILED'
 * @param {object|null} details 
 * @param {number|null} tabId
 */
function updateLocationStatusBadge(state, details = null, tabId = null) {
  el.locationStatusBadge.className = 'badge';

  if (state === LOCATION_STATES.ACTIVE || state === 'ACTIVE') {
    el.locationStatusBadge.classList.add('badge-active');
    el.locationStatusBadge.textContent = tabId ? `LOCATION: ACTIVE (Tab ${tabId})` : 'LOCATION: ACTIVE';
    el.locationMsg.textContent = details
      ? `Browser device coordinates: ${details.latitude}, ${details.longitude} (±${details.accuracy || 20}m). Google may still show an IP-based location.`
      : 'Browser location override is active only in the Google search tab.';
    el.locationMsg.style.color = 'var(--green-text)';
  } else if (state === LOCATION_STATES.CONFIGURED || state === 'CONFIGURED') {
    el.locationStatusBadge.classList.add('badge-configured');
    el.locationStatusBadge.textContent = 'LOCATION: CONFIGURED — WILL APPLY WHEN RANK CHECK STARTS';
    el.locationMsg.textContent = 'Coordinates saved. Will override browser tab upon start.';
    el.locationMsg.style.color = 'var(--yellow-text)';
  } else if (state === LOCATION_STATES.FAILED || state === 'FAILED') {
    el.locationStatusBadge.classList.add('badge-failed');
    el.locationStatusBadge.textContent = 'LOCATION: OVERRIDE FAILED';
    el.locationMsg.textContent = 'CDP Geolocation override failed or detached. Check tab permissions.';
    el.locationMsg.style.color = 'var(--red-text)';
  } else {
    el.locationStatusBadge.classList.add('badge-not-configured');
    el.locationStatusBadge.textContent = 'LOCATION: NOT CONFIGURED';
    el.locationMsg.textContent = '';
  }
}

/**
 * Queries service worker for current job state and updates UI.
 */
async function syncBackgroundState() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_STATE' });
    if (response && response.state) {
      currentJobState = response.state;
      renderJobState(response.state);
      syncWorkbookDownloadButton();

      // Location state display
      if (response.state.locationState) {
        updateLocationStatusBadge(
          response.state.locationState,
          response.state.locationDetails,
          response.state.locationTabId
        );
      } else if (response.state.locationApplied) {
        updateLocationStatusBadge('ACTIVE', response.state.locationDetails, response.state.locationTabId);
      } else if (response.state.locationConfigured) {
        updateLocationStatusBadge('CONFIGURED', response.state.locationDetails);
      } else {
        updateLocationStatusBadge('NOT_CONFIGURED');
      }
    }
  } catch (_) {}
}

/**
 * Renders job state.
 * Bug 3 Fix: Disables project switching when RUNNING, PAUSED, or BLOCKED.
 * Bug 4 Fix: Binds results to active project ID.
 * @param {object} state 
 */
function renderJobState(state) {
  if (!state) return;

  const status = state.status || 'IDLE';
  el.jobStatusBadge.className = 'badge';

  // Bug 3 Fix: Disable project switching during RUNNING, PAUSED, and BLOCKED
  const isJobActiveOrBlocked = ['RUNNING', 'PAUSED', 'BLOCKED'].includes(status);
  el.projectSelect.disabled = isJobActiveOrBlocked;

  if (status === 'RUNNING') {
    el.jobStatusBadge.classList.add('badge-running');
    el.jobStatusBadge.textContent = 'STATUS: RUNNING';
    el.btnStart.style.display = 'none';
    el.btnPause.style.display = 'inline-flex';
    el.btnResume.style.display = 'none';
    el.btnStop.style.display = 'inline-flex';
  } else if (status === 'PAUSED') {
    el.jobStatusBadge.classList.add('badge-configured');
    el.jobStatusBadge.textContent = 'STATUS: PAUSED';
    el.btnStart.style.display = 'none';
    el.btnPause.style.display = 'none';
    el.btnResume.style.display = 'inline-flex';
    el.btnStop.style.display = 'inline-flex';
  } else if (status === 'BLOCKED') {
    el.jobStatusBadge.classList.add('badge-failed');
    el.jobStatusBadge.textContent = 'STATUS: BLOCKED / HALTED';
    el.btnStart.style.display = 'none';
    el.btnPause.style.display = 'none';
    el.btnResume.style.display = 'inline-flex';
    el.btnStop.style.display = 'inline-flex';
  } else if (status === 'COMPLETED') {
    el.jobStatusBadge.classList.add('badge-completed');
    el.jobStatusBadge.textContent = 'STATUS: COMPLETED';
    el.btnStart.style.display = 'inline-flex';
    el.btnPause.style.display = 'none';
    el.btnResume.style.display = 'none';
    el.btnStop.style.display = 'none';
  } else {
    el.jobStatusBadge.classList.add('badge-idle');
    el.jobStatusBadge.textContent = `STATUS: ${status}`;
    el.btnStart.style.display = 'inline-flex';
    el.btnPause.style.display = 'none';
    el.btnResume.style.display = 'none';
    el.btnStop.style.display = 'none';
  }

  // Error Banner
  if (state.errorMessage) {
    el.jobBannerMsg.style.display = 'block';
    el.jobBannerMsg.className = 'banner-msg blocked';
    el.jobBannerMsg.textContent = state.errorMessage;
  } else {
    el.jobBannerMsg.style.display = 'none';
  }

  // Progress metrics
  const total = state.queue ? state.queue.length : 0;
  const currentIdx = state.currentIndex || 0;
  const pct = total > 0 ? Math.round((currentIdx / total) * 100) : 0;

  el.progFraction.textContent = `${currentIdx} / ${total} Keywords Checked (${pct}%)`;
  el.progressBarFill.style.width = `${pct}%`;

  if (status === 'RUNNING' && state.currentKeyword) {
    const offsetStr = state.currentSerpOffset ? ` (page offset start=${state.currentSerpOffset})` : '';
    el.progActivity.textContent = `Checking: "${state.currentKeyword}"${offsetStr}...`;
  } else if (status === 'COMPLETED') {
    el.progActivity.textContent = 'Batch completed successfully.';
  } else if (status === 'PAUSED') {
    el.progActivity.textContent = 'Paused. Click RESUME to continue.';
  } else if (status === 'BLOCKED') {
    el.progActivity.textContent = 'Halted. Resolve interruption and click RESUME.';
  } else {
    el.progActivity.textContent = 'Ready to start.';
  }

  // Counters
  const results = state.results || [];
  let found = 0;
  let notFound = 0;
  let errors = 0;

  results.forEach(r => {
    if (r) {
      if (r.status === 'ERROR' || r.matchStatus === 'ERROR') errors++;
      else if (typeof r.currentPosition === 'number') found++;
      else if (r.currentPosition === 'Not Found') notFound++;
    }
  });

  el.statTotal.textContent = String(total);
  el.statFound.textContent = String(found);
  el.statNotFound.textContent = String(notFound);
  el.statError.textContent = String(errors);

  // Bug 4 Fix: Enforce results are bound to active project ID before enabling actions
  const isProjectMatch = Boolean(
    activeProject && (
      !state.projectId || 
      state.projectId === activeProject.id || 
      state.projectId === activeProject.config?.projectId
    )
  );
  const hasResultsForProject = results.length > 0 && isProjectMatch;

  el.btnCopyPositions.disabled = !hasResultsForProject;
  el.btnCopyAll.disabled = !hasResultsForProject;
  el.btnDownloadCsv.disabled = !hasResultsForProject;
  el.btnUseAsPrevious.disabled = !hasResultsForProject;
  el.btnRetryFailed.disabled = !hasResultsForProject || errors === 0;

  // Render results table with project ID isolation
  renderResultsTable(results);
}

/**
 * An auditable organic rank must have an inspectable ordered URL list.
 * All values render as plain text, never injected as HTML.
 */
function openOrganicRankAudit(item) {
  const audit = Array.isArray(item.organicAudit) ? item.organicAudit : [];
  if (!audit.length) return;
  const dialog = document.createElement('dialog');
  dialog.style.maxWidth = 'min(820px, 94vw)';
  dialog.style.maxHeight = '85vh';
  dialog.style.overflow = 'auto';
  dialog.style.padding = '22px';
  dialog.style.borderRadius = '12px';

  const heading = document.createElement('h3');
  heading.textContent = 'Counted organic listings: ' + (item.keyword || '');
  dialog.appendChild(heading);

  const note = document.createElement('p');
  note.textContent = 'Only these URL listings contributed to the reported rank. AI Overviews, ads, packs and carousels should not appear here. This list describes the Google page SERPTrack analyzed, which may differ from your own search session.';
  note.style.fontSize = '13px';
  dialog.appendChild(note);

  const list = document.createElement('ol');
  list.style.paddingLeft = '32px';
  for (const entry of audit) {
    const row = document.createElement('li');
    row.style.marginBottom = '10px';
    row.style.overflowWrap = 'anywhere';
    row.textContent = (entry.title || '(untitled)') + ' — ' + entry.url;
    list.appendChild(row);
  }
  dialog.appendChild(list);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-primary btn-sm';
  button.textContent = 'Close';
  button.addEventListener('click', () => dialog.close());
  dialog.appendChild(button);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
}

/**
 * Renders the results table with safe DOM text nodes.
 * Content Security: Zero innerHTML used for client/user data.
 * Bug 4 Fix: Never displays another project's results.
 * @param {Array<object>} results 
 */
function renderResultsTable(results) {
  // Bug 4 Check: If active results belong to a different project, do not display them
  const isProjectMatch = Boolean(
    activeProject && currentJobState && (
      !currentJobState.projectId ||
      currentJobState.projectId === activeProject.id ||
      currentJobState.projectId === activeProject.config?.projectId
    )
  );

  if (currentJobState && currentJobState.projectId && !isProjectMatch) {
    el.resultsCountBadge.textContent = '0';
    el.resultsTbody.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'empty-state';
    td.textContent = 'Active results belong to a different project. Click START RANK CHECK to run a check for this project.';
    tr.appendChild(td);
    el.resultsTbody.appendChild(tr);
    return;
  }

  el.resultsCountBadge.textContent = String(results ? results.length : 0);

  if (!results || results.length === 0) {
    el.resultsTbody.replaceChildren();
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'empty-state';
    td.textContent = 'No rank checks run yet. Enter keywords in the "Keyword Queue" tab and click "START RANK CHECK".';
    tr.appendChild(td);
    el.resultsTbody.appendChild(tr);
    return;
  }

  el.resultsTbody.replaceChildren();

  results.forEach((item, idx) => {
    if (!item) return;

    const tr = document.createElement('tr');
    const rowNum = (item.originalIndex !== undefined ? item.originalIndex : idx) + 1;

    // 1. Row number
    const tdNum = document.createElement('td');
    tdNum.style.color = 'var(--text-muted)';
    tdNum.style.fontFamily = 'var(--font-mono)';
    tdNum.textContent = String(rowNum);
    tr.appendChild(tdNum);

    // 2. Keyword (safe text node)
    const tdKw = document.createElement('td');
    tdKw.style.fontWeight = '600';
    tdKw.textContent = item.keyword || '';
    tr.appendChild(tdKw);

    // 3. Target URL (safe text node)
    const tdUrl = document.createElement('td');
    const smallUrl = document.createElement('small');
    smallUrl.style.color = 'var(--text-secondary)';
    smallUrl.style.wordBreak = 'break-all';
    smallUrl.textContent = item.targetUrl || '';
    tdUrl.appendChild(smallUrl);
    tr.appendChild(tdUrl);

    // 4. Previous Position
    const tdPrev = document.createElement('td');
    tdPrev.style.fontFamily = 'var(--font-mono)';
    tdPrev.style.textAlign = 'center';
    tdPrev.textContent = (item.previousPosition !== null && item.previousPosition !== undefined && item.previousPosition !== '—')
      ? String(item.previousPosition)
      : '—';
    tr.appendChild(tdPrev);

    // 5. Current Position rank pill
    const tdCur = document.createElement('td');
    tdCur.style.textAlign = 'center';
    const pill = document.createElement('span');
    let rankPillClass = 'rank-pill rank-other';
    let currentPosText = item.displayPosition || item.currentPosition || 'NOT CHECKED';

    if (item.status === 'NOT CHECKED') {
      rankPillClass = 'rank-pill rank-notchecked';
      currentPosText = 'NOT CHECKED';
    } else if (item.status === 'ERROR' || item.matchStatus === 'ERROR') {
      rankPillClass = 'rank-pill rank-error';
      currentPosText = 'ERROR';
    } else if (typeof item.currentPosition === 'number') {
      if (item.currentPosition <= 3) rankPillClass = 'rank-pill rank-top3';
      else if (item.currentPosition <= 10) rankPillClass = 'rank-pill rank-top10';
      else rankPillClass = 'rank-pill rank-other';
    } else {
      rankPillClass = 'rank-pill rank-notfound';
    }
    pill.className = rankPillClass;
    pill.textContent = String(currentPosText);
    tdCur.appendChild(pill);
    if (Array.isArray(item.organicAudit) && item.organicAudit.length > 0) {
      const auditButton = document.createElement('button');
      auditButton.type = 'button';
      auditButton.className = 'btn btn-secondary btn-sm';
      auditButton.textContent = 'Audit';
      auditButton.title = 'Show each organic URL counted toward this rank';
      auditButton.style.display = 'block';
      auditButton.style.margin = '4px auto 0';
      auditButton.addEventListener('click', () => openOrganicRankAudit(item));
      tdCur.appendChild(auditButton);
    }
    tr.appendChild(tdCur);

    // 6. Change
    const tdChange = document.createElement('td');
    tdChange.style.textAlign = 'center';
    const changeSpan = document.createElement('span');
    let changeClass = 'change-same';
    const changeText = item.change || '—';
    if (changeText.includes('↑')) changeClass = 'change-up';
    else if (changeText.includes('↓')) changeClass = 'change-down';
    changeSpan.className = changeClass;
    changeSpan.textContent = changeText;
    tdChange.appendChild(changeSpan);
    tr.appendChild(tdChange);

    // 7. Status / Depth
    const tdStatus = document.createElement('td');
    tdStatus.style.fontSize = '11px';
    tdStatus.style.color = 'var(--text-secondary)';
    let statusDepthText = item.status || '—';
    if (item.checkedDepth > 0) {
      statusDepthText += ` (Top ${item.checkedDepth})`;
    }
    tdStatus.textContent = statusDepthText;
    tr.appendChild(tdStatus);

    // 8. Found URL / Cannibalization / Error (Safe DOM nodes only)
    const tdDetails = document.createElement('td');
    let hasDetails = false;

    if (item.foundUrl) {
      hasDetails = true;
      const link = document.createElement('a');
      link.href = item.foundUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.color = 'var(--accent-blue-hover)';
      link.style.textDecoration = 'none';
      link.style.wordBreak = 'break-all';
      link.textContent = item.foundUrl;
      tdDetails.appendChild(link);
    }

    if (item.otherPageFound) {
      hasDetails = true;
      const canDiv = document.createElement('div');
      canDiv.style.marginTop = '4px';
      const flag = document.createElement('span');
      flag.className = 'cannibalization-flag';
      flag.textContent = `Cannibalization: Position ${item.otherPagePosition || '?'}`;
      canDiv.appendChild(flag);
      canDiv.appendChild(document.createElement('br'));
      const canSmall = document.createElement('small');
      canSmall.style.color = 'var(--text-muted)';
      canSmall.style.wordBreak = 'break-all';
      canSmall.textContent = item.otherPageFound;
      canDiv.appendChild(canSmall);
      tdDetails.appendChild(canDiv);
    }

    if (item.error) {
      hasDetails = true;
      const errSpan = document.createElement('span');
      errSpan.style.color = 'var(--red-text)';
      errSpan.style.fontSize = '11px';
      errSpan.textContent = item.error;
      tdDetails.appendChild(errSpan);
    }

    if (!hasDetails) {
      const dash = document.createElement('span');
      dash.style.color = 'var(--text-muted)';
      dash.textContent = '—';
      tdDetails.appendChild(dash);
    }

    tr.appendChild(tdDetails);
    el.resultsTbody.appendChild(tr);
  });
}

/**
 * Wires up UI event listeners.
 */
function setupEventListeners() {
  function allowProjectMutation() {
    if (currentJobState && ['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentJobState.status)) {
      showToast('Stop the active or paused rank check before changing projects.', 'error');
      return false;
    }
    return true;
  }

  // Keep country, depth and delay specific to the selected client.
  async function persistProjectSearchSettings() {
    if (!activeProject) return;
    const updates = {
      googleDomain: el.googleDomain.value,
      defaultMaxDepth: Number(el.maxDepth.value) || 50,
      defaultDelaySeconds: Math.max(5, Number(el.delaySeconds.value) || 8)
    };
    const projectId = activeProject.id;
    try {
      const updated = await updateProject(projectId, updates);
      if (activeProject?.id === projectId) activeProject = updated;
    } catch (error) {
      showToast('Could not save search settings: ' + error.message, 'error');
    }
  }
  for (const field of [el.googleDomain, el.maxDepth, el.delaySeconds]) {
    field.addEventListener('change', persistProjectSearchSettings);
  }

  // Tab switching
  el.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      el.tabBtns.forEach(b => b.classList.remove('active'));
      el.tabPanes.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const targetPane = document.getElementById(btn.dataset.tab);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // Bug 3 Fix: Project selector switch protected during active, paused, or blocked runs
  el.projectSelect.addEventListener('change', async (e) => {
    const selectedId = e.target.value;
    if (currentJobState && ['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentJobState.status)) {
      showToast('Cannot switch project while a rank check is active, paused, or blocked. Click STOP first!', 'error');
      if (activeProject) {
        e.target.value = activeProject.id;
      }
      return;
    }
    resetWorkbookImport();
    await setActiveProjectId(selectedId);
    activeProject = await getActiveProject();
    await loadActiveProjectIntoUI(activeProject);
    showToast(`Switched to project: ${activeProject.config?.projectName || 'Project'}`, 'info');
  });

  // Bug 1 Fix: Project New/Edit reliably saves location per project
  el.btnNewProject.addEventListener('click', () => {
    if (!allowProjectMutation()) return;
    el.modalProjectTitle.textContent = 'New Client Project';
    el.modalProjectName.value = '';
    el.modalProjectDomain.value = '';
    el.modalProjectGoogle.value = 'google.com';
    el.modalProjectDelay.value = '8';
    el.modalProjectDepth.value = '50';
    if (el.modalProjectUseLocation) el.modalProjectUseLocation.checked = false;
    if (el.modalProjectLocName) el.modalProjectLocName.value = '';
    if (el.modalProjectLat) el.modalProjectLat.value = '';
    if (el.modalProjectLon) el.modalProjectLon.value = '';
    if (el.modalProjectAcc) el.modalProjectAcc.value = '20';
    el.btnSaveProjectModal.dataset.mode = 'create';
    el.projectModal.style.display = 'flex';
  });

  el.btnEditProject.addEventListener('click', () => {
    if (!allowProjectMutation()) return;
    if (!activeProject) return;
    const cfg = activeProject.config || activeProject;
    el.modalProjectTitle.textContent = 'Edit Client Project';
    el.modalProjectName.value = cfg.projectName || '';
    el.modalProjectDomain.value = cfg.domain || '';
    el.modalProjectGoogle.value = cfg.googleDomain || 'google.com';
    el.modalProjectDelay.value = String(cfg.defaultDelaySeconds || 8);
    el.modalProjectDepth.value = String(cfg.defaultMaxDepth || 50);
    if (el.modalProjectUseLocation) el.modalProjectUseLocation.checked = Boolean(cfg.useLocation);
    if (el.modalProjectLocName) el.modalProjectLocName.value = cfg.locationName || '';
    if (el.modalProjectLat) el.modalProjectLat.value = cfg.latitude || '';
    if (el.modalProjectLon) el.modalProjectLon.value = cfg.longitude || '';
    if (el.modalProjectAcc) el.modalProjectAcc.value = String(cfg.accuracy !== undefined ? cfg.accuracy : 20);
    el.btnSaveProjectModal.dataset.mode = 'edit';
    el.projectModal.style.display = 'flex';
  });

  el.btnCancelProjectModal.addEventListener('click', () => { el.projectModal.style.display = 'none'; });
  el.btnCloseProjectModal.addEventListener('click', () => { el.projectModal.style.display = 'none'; });

  el.btnSaveProjectModal.addEventListener('click', async () => {
    if (!allowProjectMutation()) return;
    const name = el.modalProjectName.value.trim();
    if (!name) {
      showToast('Project name is required.', 'error');
      return;
    }

    const useLoc = el.modalProjectUseLocation ? el.modalProjectUseLocation.checked : false;
    const locName = el.modalProjectLocName ? el.modalProjectLocName.value.trim() : '';
    let lat = el.modalProjectLat ? el.modalProjectLat.value.trim() : '';
    let lon = el.modalProjectLon ? el.modalProjectLon.value.trim() : '';
    let acc = el.modalProjectAcc ? (Number(el.modalProjectAcc.value) || 20) : 20;

    if (useLoc) {
      const val = validateCoordinates(lat, lon, acc);
      if (!val.valid) {
        showToast(val.error, 'error');
        return;
      }
      lat = String(val.latitude);
      lon = String(val.longitude);
      acc = val.accuracy;
    }

    const mode = el.btnSaveProjectModal.dataset.mode;
    const projectData = {
      projectName: name,
      domain: el.modalProjectDomain.value.trim(),
      googleDomain: el.modalProjectGoogle.value,
      defaultDelaySeconds: Math.max(5, Number(el.modalProjectDelay.value) || 8),
      defaultMaxDepth: Number(el.modalProjectDepth.value) || 50,
      useLocation: useLoc,
      locationName: locName,
      latitude: lat,
      longitude: lon,
      accuracy: acc
    };

    if (mode === 'create') {
      const created = await createProject(projectData);
      showToast(`Created project: ${created.config?.projectName || name}`, 'success');
    } else {
      await updateProject(activeProject.id, projectData);
      showToast(`Updated project: ${name}`, 'success');
    }

    resetWorkbookImport();
    el.projectModal.style.display = 'none';
    await refreshProjectsList();
  });

  el.btnDeleteProject.addEventListener('click', () => {
    if (!allowProjectMutation()) return;
    if (!activeProject) return;
    openConfirmModal(
      'Delete Project',
      `Are you sure you want to delete session project "${activeProject.config?.projectName}"? All session keywords for this project will be removed.`,
      async () => {
        if (!allowProjectMutation()) return;
        try {
          resetWorkbookImport();
          await deleteProject(activeProject.id);
          showToast('Project deleted.', 'success');
          await refreshProjectsList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    );
  });

  // Export Project JSON (Local file download only)
  el.btnExportProject.addEventListener('click', async () => {
    if (!activeProject) return;
    try {
      const jsonStr = await exportProjectJson(activeProject.id);
      const filename = `${sanitizeProjectFilename(activeProject.config?.projectName || 'project')}_session_export.json`;
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${filename} locally.`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Import Project JSON (Safe local validation)
  el.btnImportProject.addEventListener('click', () => {
    if (!allowProjectMutation()) return;
    el.importJsonFile.value = '';
    el.importJsonText.value = '';
    el.importModal.style.display = 'flex';
  });

  el.btnCancelImportModal.addEventListener('click', () => { el.importModal.style.display = 'none'; });
  el.btnCloseImportModal.addEventListener('click', () => { el.importModal.style.display = 'none'; });

  el.importJsonFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        el.importJsonText.value = event.target.result;
      };
      reader.readAsText(file);
    }
  });

  el.btnSubmitImportModal.addEventListener('click', async () => {
    if (!allowProjectMutation()) return;
    const jsonStr = el.importJsonText.value.trim();
    if (!jsonStr) {
      showToast('Please select a file or paste project JSON.', 'error');
      return;
    }
    try {
      const imported = await importProjectJson(jsonStr);
      resetWorkbookImport();
      showToast(`Imported project: ${imported.config?.projectName || 'Project'}`, 'success');
      el.importModal.style.display = 'none';
      await refreshProjectsList();
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    }
  });

  // Clear Session Data Button
  const handleClearSession = () => {
    openConfirmModal(
      'Clear Session Data',
      'This will stop any active rank check, detach the location simulation debugger, and wipe all projects, keywords, and results from current browser session memory. Harmless preferences will remain. Proceed?',
      async () => {
        try {
          const response = await chrome.runtime.sendMessage({ action: 'CLEAR_SESSION_DATA' });
          if (!response?.success) throw new Error(response?.error || 'Session cleanup was not confirmed.');
          resetWorkbookImport();
          currentJobState = null;
          showToast('Session data cleared successfully.', 'info');
          await refreshProjectsList();
          await syncBackgroundState();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    );
  };

  if (el.btnClearSession) el.btnClearSession.addEventListener('click', handleClearSession);
  if (el.btnPrivacyClear) el.btnPrivacyClear.addEventListener('click', handleClearSession);

  // Confirmation Modal buttons
  el.btnAcceptConfirm.addEventListener('click', () => {
    if (pendingConfirmCallback) pendingConfirmCallback();
    closeConfirmModal();
  });
  el.btnCancelConfirm.addEventListener('click', closeConfirmModal);
  el.btnCloseConfirmModal.addEventListener('click', closeConfirmModal);

  async function persistEditedLocation() {
    if (!activeProject) return;
    const validation = validateCoordinates(el.locLat.value, el.locLon.value, el.locAcc.value);
    if (!validation.valid) return;
    try {
      const saved = await rememberCoordinates(validation);
      if (!saved.saved) throw new Error(saved.error);
      const config = {
        latitude: String(validation.latitude),
        longitude: String(validation.longitude),
        accuracy: validation.accuracy,
        locationName: el.locName.value.trim()
      };
      await updateProject(activeProject.id, config);
      Object.assign(activeProject.config || activeProject, config);
    } catch (error) {
      showToast('Could not remember location: ' + error.message, 'error');
    }
  }

  for (const field of [el.locLat, el.locLon, el.locAcc, el.locName]) {
    field.addEventListener('change', persistEditedLocation);
  }

  // Location Simulation Actions
  el.useLocationToggle.addEventListener('change', async (e) => {
    if (activeProject) {
      if (e.target.checked) await persistEditedLocation();
      await updateProject(activeProject.id, { useLocation: e.target.checked });
      activeProject.config.useLocation = e.target.checked;
    }
  });

  el.btnApplyLocation.addEventListener('click', async () => {
    const lat = el.locLat.value.trim();
    const lon = el.locLon.value.trim();
    const acc = el.locAcc.value.trim() || '20';
    const locName = el.locName.value.trim();

    const validation = validateCoordinates(lat, lon, acc);
    if (!validation.valid) {
      showToast(validation.error, 'error');
      return;
    }

    try {
      await persistEditedLocation();
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

      const resp = await chrome.runtime.sendMessage({
        action: 'APPLY_LOCATION',
        location: {
          latitude: validation.latitude,
          longitude: validation.longitude,
          accuracy: validation.accuracy,
          locationName: locName
        }
      });

      if (resp && resp.success) {
        showToast(resp.message || 'Location configured successfully.', 'success');
        await syncBackgroundState();
      } else {
        showToast(resp ? resp.error : 'Failed to apply location.', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnTestLocation.addEventListener('click', async () => {
    const lat = el.locLat.value.trim();
    const lon = el.locLon.value.trim();
    const acc = el.locAcc.value.trim() || '20';
    const validation = validateCoordinates(lat, lon, acc);
    if (!validation.valid) {
      showToast(validation.error, 'error');
      return;
    }

    showToast('Testing location override in Google tab...', 'info');
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'TEST_LOCATION',
        location: {
          latitude: validation.latitude,
          longitude: validation.longitude,
          accuracy: validation.accuracy
        }
      });

      if (resp && resp.success) {
        el.locationMsg.textContent = resp.message;
        el.locationMsg.style.color = 'var(--green-text)';
        showToast('Google tab opened. Device coordinates verified; IP location may differ.', 'success');
        await syncBackgroundState();
      } else {
        el.locationMsg.textContent = resp?.error || 'Location test failed.';
        el.locationMsg.style.color = 'var(--red-text)';
        showToast(el.locationMsg.textContent, 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnClearLocation.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'RESET_LOCATION' });
      await forgetRememberedCoordinates();
      el.locLat.value = '';
      el.locLon.value = '';
      el.locName.value = '';
      el.useLocationToggle.checked = false;

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

      showToast('Location override reset.', 'info');
      await syncBackgroundState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Workbook mode accepts any worksheet and supports explicit column mapping.
  // The complete uploaded .xlsx is kept only in this dashboard's memory.
  async function useWorkbookMapping(options = {}) {
    if (!pendingWorkbookUpload) throw new Error('Select a workbook first.');
    const { bytes, filename } = pendingWorkbookUpload;
    const inspected = await inspectRankingWorkbook(bytes, options);
    importedWorkbook = {
      bytes, inspected, filename,
      projectId: activeProject ? activeProject.id : null,
      startedRunId: null
    };
    el.workbookSheet.value = inspected.sheetName;
    el.workbookHeaderRow.value = String(inspected.header.headerRow);
    el.workbookKeywordCol.value = xlsxColumnLetters(inspected.header.keywordColumn);
    el.workbookUrlCol.value = xlsxColumnLetters(inspected.header.urlColumn);
    el.workbookBaselineCol.value = xlsxColumnLetters(inspected.header.latestColumn);
    renderKeywordsTextarea(inspected.rows);
    el.keywordsTextarea.readOnly = true;
    el.btnSaveKeywords.disabled = true;
    el.btnLoadSample.disabled = true;
    el.btnClearWorkbook.disabled = false;
    if (inspected.location.hasCoordinates) {
      el.useLocationToggle.checked = true;
      el.locLat.value = inspected.location.latitude;
      el.locLon.value = inspected.location.longitude;
      el.locName.value = inspected.location.locationName;
      el.locAcc.value = '20';
      await persistEditedLocation();
    }
    el.workbookStatus.textContent =
      filename + ': ' + inspected.rows.length + ' website keywords imported from "' +
      inspected.sheetName + '". Previous dated ranking: ' +
      (inspected.latestDate || 'none (first tracking run)') + '. ' +
      (inspected.location.hasCoordinates ? 'Optional location coordinates were loaded. ' :
        'Enter optional coordinates manually if required. ') +
      'Check rankings, then download an updated copy. Other worksheets remain unchanged.';
    syncWorkbookDownloadButton();
    showToast('Imported ' + inspected.rows.length + ' keywords for any website.', 'success');
  }

  el.workbookFile.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (currentJobState && ['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentJobState.status)) {
      showToast('Finish or stop the current check before switching workbooks.', 'error');
      event.target.value = '';
      return;
    }
    resetWorkbookImport();
    if (!/\.xlsx$/i.test(file.name)) {
      showToast('Choose a local .xlsx workbook.', 'error');
      return;
    }
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Workbook exceeds 20 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sheets = await listRankingWorkbookSheets(bytes);
      pendingWorkbookUpload = { bytes, filename: file.name };
      el.workbookSheet.replaceChildren();
      for (const name of sheets) {
        const option = document.createElement('option');
        option.textContent = name;
        option.value = name;
        el.workbookSheet.appendChild(option);
      }
      el.btnApplyWorkbookMap.disabled = false;
      el.btnClearWorkbook.disabled = false;
      try {
        await useWorkbookMapping();
      } catch (error) {
        // Keep bytes available for manual worksheet/column mapping.
        importedWorkbook = null;
        el.workbookStatus.textContent = error.message +
          ' — choose a worksheet, header row, keyword and URL column letters, then click Load with This Mapping.';
        showToast('Choose worksheet and columns to import this workbook.', 'info');
      }
    } catch (error) {
      resetWorkbookImport();
      showToast('Could not read workbook: ' + error.message, 'error');
    }
  });

  el.btnApplyWorkbookMap.addEventListener('click', async () => {
    if (!pendingWorkbookUpload) return;
    if (currentJobState && ['RUNNING', 'PAUSED', 'BLOCKED'].includes(currentJobState.status)) {
      showToast('Stop the active check before remapping an imported workbook.', 'error');
      return;
    }
    try {
      await useWorkbookMapping({
        sheetName: el.workbookSheet.value,
        headerRow: Number(el.workbookHeaderRow.value) || undefined,
        keywordColumn: xlsxColumnNumber(el.workbookKeywordCol.value),
        urlColumn: xlsxColumnNumber(el.workbookUrlCol.value),
        baselineColumn: xlsxColumnNumber(el.workbookBaselineCol.value)
      });
    } catch (error) {
      importedWorkbook = null;
      el.workbookStatus.textContent = 'Mapping failed: ' + error.message;
      showToast('Mapping failed: ' + error.message, 'error');
    }
  });

  el.btnClearWorkbook.addEventListener('click', () => {
    resetWorkbookImport();
    if (activeProject) renderKeywordsTextarea(activeProject.keywords || []);
    showToast('Returned to manual keyword input.', 'info');
  });

  el.btnDownloadWorkbook.addEventListener('click', async () => {
    if (!canExportWorkbook()) {
      showToast('Finish the workbook keyword check before exporting.', 'error');
      return;
    }
    try {
      const { bytes, inspected, filename } = importedWorkbook;
      const date = el.workbookDate.value || todayLocalDate();
      const updated = await buildUpdatedRankingWorkbook(bytes, inspected, currentJobState.results, date);
      const url = URL.createObjectURL(updated);
      const anchor = document.createElement('a');
      const stem = filename.replace(/\.xlsx$/i, '').replace(/[^a-zA-Z0-9._ -]/g, '_');
      anchor.href = url;
      anchor.download = stem + ' - Organic Rankings ' + date + '.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      showToast('Updated Excel copy downloaded. Existing weekly history and GMB data preserved.', 'success');
    } catch (error) {
      showToast('Workbook export failed: ' + error.message, 'error');
    }
  });

  // A single optional website supports plain keyword-only lists. It belongs to
  // the session project, not device-persistent settings.
  el.defaultTargetSite.addEventListener('input', renderKeywordsPreview);
  el.defaultTargetSite.addEventListener('change', async () => {
    if (activeProject && !pendingWorkbookUpload) {
      await updateProject(activeProject.id, { domain: el.defaultTargetSite.value.trim() });
      activeProject.config.domain = el.defaultTargetSite.value.trim();
    }
  });

  // Keywords Textarea Live Preview & Input
  el.keywordsTextarea.addEventListener('input', () => {
    renderKeywordsPreview();
  });

  // Keywords Textarea & Batch Save
  el.btnSaveKeywords.addEventListener('click', async () => {
    if (!activeProject) return;
    if (pendingWorkbookUpload) {
      showToast('Workbook mode uses the original row mapping. Clear the workbook to edit keywords.', 'error');
      return;
    }
    const { valid, errors } = parseInputRows(el.keywordsTextarea.value || '', {
      defaultTargetUrl: el.defaultTargetSite.value.trim()
    });
    if (errors.length > 0) {
      showToast('Fix ' + errors.length + ' invalid keyword row(s) before saving.', 'error');
      renderKeywordsPreview();
      return;
    }
    await saveProjectKeywords(activeProject.id, valid);
    activeProject.keywords = valid;
    showToast(`Saved ${valid.length} keywords to session project.`, 'success');
    el.keywordsCountBadge.textContent = String(valid.length);
    el.keywordCountLabel.textContent = `${valid.length} keywords in project`;
    renderKeywordsPreview();
  });

  el.btnLoadSample.addEventListener('click', () => {
    if (pendingWorkbookUpload) return;
    const samples = [
      'dentist near me\thttps://example.com/services\t5',
      'emergency dentist\thttps://example.com/emergency\t12',
      'teeth whitening cost\thttps://example.com/cosmetic\t',
      'dental implants\thttps://example.com/implants\t8',
      'root canal specialist\thttps://example.com/endodontics\t25',
      'invisalign provider\thttps://example.com/orthodontics\t3',
      'pediatric dentist\thttps://example.com/kids\t',
      'wisdom teeth removal\thttps://example.com/surgery\t15',
      'cosmetic dentistry\thttps://example.com/cosmetic\t9',
      'walk in dentist\thttps://example.com/urgent\t42',
      'porcelain veneers\thttps://example.com/veneers\t6',
      'dentures near me\thttps://example.com/dentures\t',
      'sedation dentistry\thttps://example.com/sedation\t19',
      'family dentist\thttps://example.com/family\t4',
      'gum disease treatment\thttps://example.com/periodontics\t',
      'tooth extraction cost\thttps://example.com/extractions\t31',
      'affordable dental care\thttps://example.com/financing\t',
      'dental crowns\thttps://example.com/crowns\t11',
      'teeth cleaning\thttps://example.com/hygiene\t2',
      'holistic dentist\thttps://example.com/holistic\t'
    ];
    el.keywordsTextarea.value = samples.join('\n');
    renderKeywordsPreview();
    showToast('Loaded 20 sample keyword rows.', 'info');
  });

  // Job Controls (Start, Pause, Resume, Stop, Clear)
  el.btnStart.addEventListener('click', async () => {
    if (pendingWorkbookUpload && !importedWorkbook) {
      showToast('Complete the keyword/URL column mapping before starting.', 'error');
      return;
    }
    const parsed = importedWorkbook
      ? { valid: importedWorkbook.inspected.rows, errors: [] }
      : parseInputRows(el.keywordsTextarea.value || '', {
          defaultTargetUrl: el.defaultTargetSite.value.trim()
        });
    const { valid, errors } = parsed;
    if (errors.length > 0) {
      showToast('Fix ' + errors.length + ' invalid keyword row(s) before starting.', 'error');
      document.querySelector('[data-tab="tab-keywords"]')?.click();
      renderKeywordsPreview();
      return;
    }
    if (valid.length === 0) {
      showToast('Please enter at least 1 valid keyword row.', 'error');
      document.querySelector('[data-tab="tab-keywords"]')?.click();
      return;
    }
    const rows = valid;

    const settings = {
      googleDomain: el.googleDomain.value,
      maxPosition: Number(el.maxDepth.value) || 50,
      delaySeconds: Math.max(5, Number(el.delaySeconds.value) || 8),
      useLocation: el.useLocationToggle.checked,
      latitude: el.locLat.value.trim(),
      longitude: el.locLon.value.trim(),
      accuracy: Number(el.locAcc.value) || 20,
      locationName: el.locName.value.trim(),
      activeProjectId: activeProject ? activeProject.id : null
    };

    if (settings.useLocation) {
      const locVal = validateCoordinates(settings.latitude, settings.longitude, settings.accuracy);
      if (!locVal.valid) {
        showToast(`Location Error: ${locVal.error}`, 'error');
        return;
      }
    }

    const startedProjectId = activeProject?.id || null;
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'START_JOB',
        queue: rows,
        settings,
        projectId: startedProjectId
      });

      if (resp && resp.success) {
        if (startedProjectId) {
          await saveProjectKeywords(startedProjectId, rows);
          if (activeProject?.id === startedProjectId) activeProject.keywords = rows;
        }
        if (importedWorkbook) importedWorkbook.startedRunId = resp.state?.runId || null;
        syncWorkbookDownloadButton();
        showToast(`Rank check started for ${rows.length} keywords.`, 'success');
        document.querySelector('[data-tab="tab-results"]')?.click();
        await syncBackgroundState();
      } else {
        showToast(resp ? resp.message || resp.error : 'Failed to start.', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnPause.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'PAUSE_JOB' });
      showToast('Pausing rank check...', 'info');
      await syncBackgroundState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnResume.addEventListener('click', async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'RESUME_JOB' });
      if (resp && resp.success) {
        showToast('Resumed rank check.', 'success');
        await syncBackgroundState();
      } else {
        showToast(resp ? resp.message : 'Cannot resume.', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnStop.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'STOP_JOB' });
      showToast('Stopped rank check.', 'info');
      await syncBackgroundState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnClear.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'CLEAR_JOB' });
      showToast('Cleared results.', 'info');
      await syncBackgroundState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Bug 4 Fix: Enforce results are bound to active project ID before copying/exporting
  el.btnCopyPositions.addEventListener('click', () => {
    if (!currentJobState || !currentJobState.results || currentJobState.results.length === 0) {
      showToast('No results to copy.', 'error');
      return;
    }
    if (currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.', 'error');
      return;
    }
    const tsvData = exportToCurrentPositionsOnly(currentJobState.results);
    copyToClipboard(tsvData);
    showToast(`Copied ${currentJobState.results.length} positions to clipboard! Ready to paste into Excel.`, 'success');
  });

  el.btnCopyAll.addEventListener('click', () => {
    if (!currentJobState || !currentJobState.results || currentJobState.results.length === 0) {
      showToast('No results to copy.', 'error');
      return;
    }
    if (currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.', 'error');
      return;
    }
    const tsvData = exportToTsv(currentJobState.results);
    copyToClipboard(tsvData);
    showToast('Copied full results table as TSV.', 'success');
  });

  el.btnDownloadCsv.addEventListener('click', () => {
    if (!currentJobState || !currentJobState.results || currentJobState.results.length === 0) {
      showToast('No results to download.', 'error');
      return;
    }
    if (currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.', 'error');
      return;
    }
    const csvData = exportToCsv(currentJobState.results);
    const dateStr = new Date().toISOString().split('T')[0];
    const projName = activeProject ? (activeProject.config?.projectName || activeProject.projectName) : 'rankings';
    const filename = `${sanitizeProjectFilename(projName)}_rankings_${dateStr}.csv`;
    downloadCsv(csvData, filename);
    showToast(`Downloaded CSV: ${filename}`, 'success');
  });

  // Retry Failed keywords (Bug 4 Fix: sends projectId to verify match)
  el.btnRetryFailed.addEventListener('click', async () => {
    if (currentJobState && currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.', 'error');
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'RETRY_FAILED_JOB',
        projectId: activeProject ? activeProject.id : null
      });
      if (resp && resp.success) {
        if (importedWorkbook) importedWorkbook.startedRunId = resp.state?.runId || null;
        syncWorkbookDownloadButton();
        showToast(`Retrying ${resp.retryingCount} failed keywords...`, 'info');
        await syncBackgroundState();
      } else {
        showToast(resp ? resp.message : 'No failed keywords to retry.', 'info');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Use Current as Previous (Baseline promotion) (Bug 4 Fix)
  el.btnUseAsPrevious.addEventListener('click', () => {
    if (!activeProject) return;
    if (!currentJobState || !currentJobState.results || currentJobState.results.length === 0) {
      showToast('No current results available to set as previous.', 'error');
      return;
    }
    if (currentJobState.projectId && activeProject && currentJobState.projectId !== activeProject.id) {
      showToast('Action disabled: results belong to a different project.', 'error');
      return;
    }

    const projName = activeProject.config?.projectName || 'Current Project';
    openConfirmModal(
      'Use Current as Previous Baseline',
      `Promote current ranking results as the new baseline previous positions for "${projName}"? Future checks will compare against these positions.`,
      async () => {
        try {
          const updated = await promoteCurrentToPrevious(activeProject.id, currentJobState.results);
          activeProject.keywords = updated;
          renderKeywordsTextarea(updated);
          showToast(`Baseline updated for ${updated.length} keywords!`, 'success');
        } catch (err) {
          showToast(`Promotion failed: ${err.message}`, 'error');
        }
      }
    );
  });

  // Background runtime message listener
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'PROGRESS_UPDATE' && msg.state) {
      currentJobState = msg.state;
      renderJobState(msg.state);
      syncWorkbookDownloadButton();
    }
    if (msg.action === 'LOCATION_STATUS_UPDATE') {
      updateLocationStatusBadge(msg.status, msg.details, msg.tabId);
    }
    if (msg.action === 'JOB_BLOCKED') {
      showToast(`Rank check halted: ${msg.message}`, 'error');
      syncBackgroundState();
    }
    if (msg.action === 'SESSION_CLEARED') {
      resetWorkbookImport();
      refreshProjectsList();
      syncBackgroundState();
    }
  });
}

// Start application
document.addEventListener('DOMContentLoaded', initDashboard);
