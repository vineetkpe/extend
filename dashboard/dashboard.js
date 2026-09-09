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
import { LOCATION_STATES } from '../utils/storage.js';

// Application State
let activeProject = null;
let allProjectsMap = {};
let currentJobState = null;
let pendingConfirmCallback = null;

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
  btnRetryFailed: document.getElementById('btn-retry-failed'),
  btnUseAsPrevious: document.getElementById('btn-use-as-previous'),

  // Keywords Tab
  keywordsTextarea: document.getElementById('keywords-textarea'),
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
  await refreshProjectsList();
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

  loadActiveProjectIntoUI(activeProject);
}

/**
 * Loads active project configuration and keywords into UI fields.
 * Bug 1 Fix: Explicitly loads that project's exact location configuration.
 * @param {object} proj 
 */
function loadActiveProjectIntoUI(proj) {
  if (!proj) return;
  const cfg = proj.config || proj;

  el.progProjectName.textContent = `Project: ${cfg.projectName || 'Default Client'}`;

  // Geolocation simulation per project
  el.useLocationToggle.checked = Boolean(cfg.useLocation);
  el.locName.value = cfg.locationName || '';
  el.locLat.value = cfg.latitude || '';
  el.locLon.value = cfg.longitude || '';
  el.locAcc.value = cfg.accuracy !== undefined ? cfg.accuracy : 20;

  // Search parameters
  el.googleDomain.value = cfg.googleDomain || 'google.com';
  el.maxDepth.value = String(cfg.defaultMaxDepth || 50);
  el.delaySeconds.value = String(cfg.defaultDelaySeconds || 8);

  // Keywords
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
}

/**
 * Parses user input in keywords textarea.
 * Format: keyword [TAB] targetUrl [TAB] previousPosition
 * @returns {Array<object>}
 */
function parseKeywordsFromTextarea() {
  const text = el.keywordsTextarea.value || '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const rows = [];

  lines.forEach((line, idx) => {
    const parts = line.includes('\t') ? line.split('\t') : line.split(',');
    const keyword = (parts[0] || '').trim();
    const targetUrl = (parts[1] || '').trim();
    const rawPrev = (parts[2] || '').trim();

    if (keyword && targetUrl) {
      let prevPos = null;
      if (rawPrev !== '' && rawPrev !== '—' && rawPrev !== '-' && rawPrev.toLowerCase() !== 'not found') {
        const num = Number(rawPrev);
        if (!isNaN(num) && num > 0) prevPos = num;
      }
      rows.push({
        id: `kw_${idx}_${Date.now()}`,
        originalIndex: idx,
        keyword,
        targetUrl,
        previousPosition: prevPos
      });
    }
  });

  return rows;
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
    el.locationMsg.textContent = details ? `Simulating ${details.latitude}, ${details.longitude} (±${details.accuracy || 20}m)` : '';
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
    await setActiveProjectId(selectedId);
    activeProject = await getActiveProject();
    loadActiveProjectIntoUI(activeProject);
    showToast(`Switched to project: ${activeProject.config?.projectName || 'Project'}`, 'info');
  });

  // Bug 1 Fix: Project New/Edit reliably saves location per project
  el.btnNewProject.addEventListener('click', () => {
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

    if (useLoc && (lat || lon)) {
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

    el.projectModal.style.display = 'none';
    await refreshProjectsList();
  });

  el.btnDeleteProject.addEventListener('click', () => {
    if (!activeProject) return;
    openConfirmModal(
      'Delete Project',
      `Are you sure you want to delete session project "${activeProject.config?.projectName}"? All session keywords for this project will be removed.`,
      async () => {
        try {
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
    const jsonStr = el.importJsonText.value.trim();
    if (!jsonStr) {
      showToast('Please select a file or paste project JSON.', 'error');
      return;
    }
    try {
      const imported = await importProjectJson(jsonStr);
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
          await chrome.runtime.sendMessage({ action: 'CLEAR_SESSION_DATA' });
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

  // Location Simulation Actions
  el.useLocationToggle.addEventListener('change', async (e) => {
    if (activeProject) {
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
        showToast(resp.message, resp.verified ? 'success' : 'info');
      } else {
        showToast(resp ? resp.error : 'Location test failed.', 'error');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  el.btnClearLocation.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'RESET_LOCATION' });
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

  // Keywords Textarea & Batch Save
  el.btnSaveKeywords.addEventListener('click', async () => {
    if (!activeProject) return;
    const rows = parseKeywordsFromTextarea();
    await saveProjectKeywords(activeProject.id, rows);
    activeProject.keywords = rows;
    showToast(`Saved ${rows.length} keywords to session project.`, 'success');
    el.keywordsCountBadge.textContent = String(rows.length);
    el.keywordCountLabel.textContent = `${rows.length} keywords in project`;
  });

  el.btnLoadSample.addEventListener('click', () => {
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
    el.keywordCountLabel.textContent = `${samples.length} sample keywords loaded`;
    showToast('Loaded 20 sample keyword rows.', 'info');
  });

  // Job Controls (Start, Pause, Resume, Stop, Clear)
  el.btnStart.addEventListener('click', async () => {
    const rows = parseKeywordsFromTextarea();
    if (rows.length === 0) {
      showToast('Please enter at least 1 keyword row.', 'error');
      document.querySelector('[data-tab="tab-keywords"]')?.click();
      return;
    }

    if (activeProject) {
      await saveProjectKeywords(activeProject.id, rows);
    }

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

    try {
      const resp = await chrome.runtime.sendMessage({
        action: 'START_JOB',
        queue: rows,
        settings,
        projectId: activeProject ? activeProject.id : null
      });

      if (resp && resp.success) {
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
    }
    if (msg.action === 'LOCATION_STATUS_UPDATE') {
      updateLocationStatusBadge(msg.status, msg.details, msg.tabId);
    }
    if (msg.action === 'JOB_BLOCKED') {
      showToast(`Rank check halted: ${msg.message}`, 'error');
      syncBackgroundState();
    }
    if (msg.action === 'SESSION_CLEARED') {
      refreshProjectsList();
      syncBackgroundState();
    }
  });
}

// Start application
document.addEventListener('DOMContentLoaded', initDashboard);
