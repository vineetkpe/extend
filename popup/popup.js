/**
 * popup.js
 * User interface controller for Local Rank Checker.
 * Communicates with background service worker and renders live state.
 */

import { parseInputRows } from '../utils/parser.js';
import { exportToTsv, exportToCsv } from '../utils/exporter.js';
import { getInputText, saveInputText } from '../utils/storage.js';

// DOM Elements
const statusBadge = document.getElementById('statusBadge');
const alertBanner = document.getElementById('alertBanner');
const alertMessage = document.getElementById('alertMessage');
const keywordInput = document.getElementById('keywordInput');
const validationBox = document.getElementById('validationBox');

const googleDomainSelect = document.getElementById('googleDomain');
const delaySecondsInput = document.getElementById('delaySeconds');

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
 * Updates UI control buttons and badges based on job status
 */
function renderStatus(status, errorMessage = null) {
  currentStatus = status || 'IDLE';
  statusBadge.textContent = currentStatus;
  statusBadge.className = `status-badge status-${currentStatus.toLowerCase()}`;

  // Reset alert banner
  if (status === 'BLOCKED') {
    alertBanner.classList.remove('hidden');
    alertMessage.textContent = errorMessage || 'Google interrupted rank checking. The job has been paused.';
  } else {
    alertBanner.classList.add('hidden');
  }

  // Button states
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
      delaySecondsInput.disabled = true;
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
      delaySecondsInput.disabled = false;
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
      delaySecondsInput.disabled = false;
      break;
  }
}

/**
 * Renders the results table from results array
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

    // Determine match badge class
    let matchBadgeClass = 'badge-not-found';
    let matchLabel = r.matchStatus || r.status || 'NOT FOUND';

    if (r.matchStatus === 'EXACT PAGE') {
      matchBadgeClass = 'badge-exact';
      matchLabel = 'EXACT PAGE';
    } else if (r.matchStatus === 'OTHER DOMAIN PAGE FOUND') {
      matchBadgeClass = 'badge-other-domain';
      matchLabel = 'OTHER DOMAIN PAGE';
    } else if (r.status === 'ERROR') {
      matchBadgeClass = 'badge-error';
      matchLabel = 'ERROR';
    }

    // Optional subtitle for cannibalization / other page
    let subInfo = '';
    if (r.otherPageFound) {
      subInfo = `<span class="sub-info" title="${escapeHtml(r.otherPageFound)}">Domain ranks at pos ${r.otherPagePosition || '?'}</span>`;
    } else if (r.error) {
      subInfo = `<span class="sub-info" title="${escapeHtml(r.error)}">${escapeHtml(r.error)}</span>`;
    }

    const currentDisplay = r.currentPosition !== null && r.currentPosition !== undefined
      ? r.currentPosition
      : 'Not Found';

    return `
      <tr>
        <td class="keyword-cell" title="${escapeHtml(r.keyword)}">${escapeHtml(r.keyword)}</td>
        <td class="url-cell" title="${escapeHtml(r.targetUrl)}">${escapeHtml(r.targetUrl)}</td>
        <td class="text-center">${escapeHtml(String(r.previousPosition || '-'))}</td>
        <td class="text-center"><strong>${escapeHtml(String(currentDisplay))}</strong></td>
        <td class="text-center ${changeClass}">${escapeHtml(r.change || '—')}</td>
        <td>
          <span class="rank-badge ${matchBadgeClass}">${escapeHtml(matchLabel)}</span>
          ${subInfo}
        </td>
        <td>
          <span class="rank-badge ${matchBadgeClass}">${escapeHtml(r.status || matchLabel)}</span>
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
      if (settings.delaySeconds) delaySecondsInput.value = settings.delaySeconds;
    }

    // Apply state
    if (state) {
      renderStatus(state.status, state.errorMessage);
      renderResultsTable(state.results);
      if (state.queue && state.queue.length > 0) {
        renderProgress(state.currentIndex, state.queue.length);
      }
    }
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

  const settings = {
    googleDomain: googleDomainSelect.value,
    delaySeconds: Math.max(5, parseInt(delaySecondsInput.value, 10) || 8)
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
googleDomainSelect.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    action: 'SAVE_SETTINGS',
    settings: { googleDomain: googleDomainSelect.value }
  });
});

delaySecondsInput.addEventListener('change', () => {
  const val = Math.max(5, parseInt(delaySecondsInput.value, 10) || 8);
  delaySecondsInput.value = val;
  chrome.runtime.sendMessage({
    action: 'SAVE_SETTINGS',
    settings: { delaySeconds: val }
  });
});

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
    // Fallback using textarea execCommand
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
  }
});

// Run initialization on popup open
initialize();
