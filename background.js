/**
 * background.js
 * Hardened Service Worker for Local Rank Checker (Manifest V3).
 * Manages the keyword ranking queue, multi-page SERP pagination,
 * race-condition-free pause/resume/stop with runId sessions, and honest depth reporting.
 */

import { matchUrl, MATCH_TYPES, normalizeUrl } from './utils/urlNormalizer.js';
import { calculateChange } from './utils/parser.js';
import {
  getSettings,
  saveSettings,
  getJobState,
  saveJobState,
  resetJobState,
  clearAllJobData
} from './utils/storage.js';

// In-memory runtime control variables
let currentDelayTimer = null;
let isProcessingQueue = false;

// Structured debug logger
async function debugLog(data) {
  try {
    const settings = await getSettings();
    if (settings && settings.debugMode) {
      if (typeof data === 'string') {
        console.log(`[LRC Debug] ${data}`);
      } else {
        console.log('[LRC Debug]', data);
      }
    }
  } catch (_) {}
}

/**
 * Ensures a visible search tab exists, either reusing an existing one or creating a new tab.
 * @param {number|null} existingTabId 
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function ensureSearchTab(existingTabId) {
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab) {
        return tab;
      }
    } catch (_) {
      // Tab was closed or not found; create a new one
    }
  }

  const newTab = await chrome.tabs.create({
    url: 'https://www.google.com',
    active: true
  });
  return newTab;
}

/**
 * Navigates the given tab to the search URL and waits for page load to complete.
 * @param {number} tabId 
 * @param {string} searchUrl 
 * @param {number} timeoutMs 
 * @returns {Promise<boolean>}
 */
function navigateAndWaitForTab(tabId, searchUrl, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const onUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve(true);
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdatedListener);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Page load timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdatedListener);

    chrome.tabs.update(tabId, { url: searchUrl }).catch(err => {
      cleanup();
      reject(err);
    });
  });
}

/**
 * Sends a message to the content script with retries.
 * @param {number} tabId 
 * @param {object} message 
 * @param {number} maxAttempts 
 * @returns {Promise<any>}
 */
async function sendMessageWithRetry(tabId, message, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

/**
 * Delays execution for ms, checking every 200ms if runId is still active and status is RUNNING.
 * Returns true if completed normally, false if aborted (paused/stopped).
 * @param {number} ms 
 * @param {string} expectedRunId 
 * @returns {Promise<boolean>}
 */
function interruptibleDelay(ms, expectedRunId) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    if (currentDelayTimer) {
      clearInterval(currentDelayTimer);
    }

    currentDelayTimer = setInterval(async () => {
      const state = await getJobState();
      if (state.runId !== expectedRunId || state.status !== 'RUNNING') {
        clearInterval(currentDelayTimer);
        currentDelayTimer = null;
        resolve(false);
        return;
      }
      if (Date.now() - startTime >= ms) {
        clearInterval(currentDelayTimer);
        currentDelayTimer = null;
        resolve(true);
      }
    }, 200);
  });
}

/**
 * Checks whether the current execution session is still valid and allowed to continue.
 * @param {string} expectedRunId 
 * @returns {Promise<boolean>}
 */
async function isSessionActive(expectedRunId) {
  if (!expectedRunId) return false;
  const state = await getJobState();
  return state.runId === expectedRunId && state.status === 'RUNNING';
}

/**
 * Safely sends a runtime message to popup or other views.
 * @param {object} msg 
 */
function broadcastMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Expected if popup is closed
    });
  } catch (_) {}
}

/**
 * Processes sequential SERP pagination for a single keyword until:
 * 1. Exact target page match is found
 * 2. Max verified organic depth is reached
 * 3. End of search results is reached
 * 4. Google interruption / CAPTCHA occurs
 * 5. Run is paused or stopped
 * 
 * @param {object} item { keyword, targetUrl, previousPosition, id }
 * @param {number} tabId
 * @param {object} settings
 * @param {string} runId
 * @returns {Promise<{ resultItem: object|null, blocked: boolean }>}
 */
async function checkKeywordRanks(item, tabId, settings, runId) {
  const domain = settings.googleDomain || 'google.com';
  const maxDepth = Math.max(10, Math.min(100, Number(settings.maxPosition) || 50));
  const normTarget = normalizeUrl(item.targetUrl);

  const cumulativeOrganicResults = [];
  const seenNormalizedUrls = new Set();

  let startOffset = 0;
  let exactMatch = null;
  let otherDomainMatch = null;
  let consecutiveEmptyPages = 0;

  while (cumulativeOrganicResults.length < maxDepth && !exactMatch && consecutiveEmptyPages < 2) {
    // 1. Session Guard Check
    if (!(await isSessionActive(runId))) {
      return { resultItem: null, blocked: false };
    }

    // 2. Build Google Search URL for the current start offset
    const searchUrl = `https://www.${domain}/search?q=${encodeURIComponent(item.keyword)}&start=${startOffset}`;

    await debugLog({
      runId,
      keyword: item.keyword,
      targetUrl: item.targetUrl,
      normalizedTarget: normTarget,
      googleUrl: searchUrl,
      currentSerpStartOffset: startOffset,
      maxDepth,
      cumulativeCountSoFar: cumulativeOrganicResults.length
    });

    try {
      // 3. Navigate tab
      await navigateAndWaitForTab(tabId, searchUrl, 20000);

      // Brief dynamic render wait
      await new Promise(r => setTimeout(r, 1200));

      // Re-verify session after async wait
      if (!(await isSessionActive(runId))) {
        return { resultItem: null, blocked: false };
      }

      // 4. Request extraction from content script
      const response = await sendMessageWithRetry(tabId, {
        action: 'EXTRACT_SERP',
        keyword: item.keyword,
        startOffset: startOffset,
        debug: settings.debugMode,
        timeout: 8000
      });

      // 5. Handle CAPTCHA / Unusual Traffic
      if (response && response.status === 'BLOCKED') {
        await debugLog(`[LRC] Google interruption detected on "${item.keyword}".`);
        return { resultItem: null, blocked: true };
      }

      if (response && response.status === 'SUCCESS') {
        const pageResults = response.results || [];
        let newUniqueFoundOnPage = 0;

        for (const res of pageResults) {
          const normCandidate = res.normalizedUrl || normalizeUrl(res.url);

          // Deduplicate against already-seen URLs for this keyword
          if (!normCandidate || seenNormalizedUrls.has(normCandidate)) {
            continue;
          }

          seenNormalizedUrls.add(normCandidate);
          newUniqueFoundOnPage++;

          const organicEntry = {
            position: cumulativeOrganicResults.length + 1,
            url: res.url,
            title: res.title,
            normalizedUrl: normCandidate
          };
          cumulativeOrganicResults.push(organicEntry);

          // Test exact page match
          const matchCheck = matchUrl(item.targetUrl, res.url);
          if (matchCheck.match && !exactMatch) {
            exactMatch = organicEntry;
            await debugLog(`[LRC] Exact target page MATCH found at position ${organicEntry.position}: ${organicEntry.url}`);
            break; // Stop scanning more results on this page
          }

          // Test same domain alternate page
          if (matchCheck.isSameDomain && !otherDomainMatch) {
            otherDomainMatch = organicEntry;
            await debugLog(`[LRC] Same domain alternate page found at position ${organicEntry.position}: ${organicEntry.url}`);
          }

          if (cumulativeOrganicResults.length >= maxDepth) {
            break;
          }
        }

        await debugLog({
          keyword: item.keyword,
          pageResultsCount: pageResults.length,
          newUniqueCount: newUniqueFoundOnPage,
          cumulativeCount: cumulativeOrganicResults.length,
          exactMatchFound: Boolean(exactMatch),
          otherDomainFound: Boolean(otherDomainMatch)
        });

        if (exactMatch) {
          break; // Stop pagination immediately
        }

        if (newUniqueFoundOnPage === 0) {
          consecutiveEmptyPages++;
        } else {
          consecutiveEmptyPages = 0;
        }

        // If not found and haven't reached maxDepth, paginate to next page
        if (!exactMatch && cumulativeOrganicResults.length < maxDepth && consecutiveEmptyPages < 2) {
          startOffset += 10;

          // Internal pagination delay (3 seconds, minimum 2 seconds)
          await debugLog(`[LRC] Waiting internal pagination delay (3s) before start=${startOffset}...`);
          const delayOk = await interruptibleDelay(3000, runId);
          if (!delayOk) {
            return { resultItem: null, blocked: false };
          }
        }
      } else {
        // Page extraction returned failure
        consecutiveEmptyPages++;
      }
    } catch (err) {
      console.error(`[LRC] Error on startOffset=${startOffset} for "${item.keyword}":`, err);
      consecutiveEmptyPages++;
    }
  }

  // Determine final ranking and honest checked depth
  const checkedDepth = cumulativeOrganicResults.length;
  let currentPosition = null;
  let displayPosition = '';
  let matchStatus = '';
  let status = '';
  let foundUrl = null;
  let otherPageFound = null;
  let otherPagePosition = null;

  if (exactMatch) {
    currentPosition = exactMatch.position;
    displayPosition = String(exactMatch.position);
    matchStatus = MATCH_TYPES.EXACT_PAGE;
    status = 'EXACT PAGE';
    foundUrl = exactMatch.url;
  } else if (otherDomainMatch) {
    currentPosition = 'Not Found';
    displayPosition = `Not Found in Top ${checkedDepth} Checked`;
    matchStatus = MATCH_TYPES.OTHER_DOMAIN_PAGE;
    status = 'TARGET PAGE NOT FOUND';
    otherPageFound = otherDomainMatch.url;
    otherPagePosition = otherDomainMatch.position;
  } else {
    currentPosition = 'Not Found';
    displayPosition = `Not Found in Top ${checkedDepth} Checked`;
    matchStatus = MATCH_TYPES.NOT_FOUND;
    status = 'TARGET PAGE NOT FOUND';
  }

  const change = calculateChange(item.previousPosition, exactMatch ? exactMatch.position : null);

  const resultItem = {
    id: item.id,
    keyword: item.keyword,
    targetUrl: item.targetUrl,
    previousPosition: item.previousPosition,
    currentPosition: currentPosition,
    displayPosition: displayPosition,
    change: change,
    matchStatus: matchStatus,
    status: status,
    checkedDepth: checkedDepth,
    foundUrl: foundUrl,
    otherPageFound: otherPageFound,
    otherPagePosition: otherPagePosition,
    error: null,
    checkedAt: new Date().toISOString()
  };

  return { resultItem, blocked: false };
}

/**
 * Main queue runner loop. Runs while state.status === 'RUNNING' and runId matches.
 * @param {string} runId 
 */
async function processQueue(runId) {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (true) {
      // Always re-read fresh state from storage to avoid stale in-memory race conditions
      const state = await getJobState();
      const settings = await getSettings();

      // Guard: must match current active runId and status must be RUNNING
      if (state.runId !== runId || state.status !== 'RUNNING') {
        await debugLog(`[LRC] Queue loop halted: status is ${state.status}, active runId is ${state.runId}`);
        break;
      }

      if (state.currentIndex >= state.queue.length) {
        await saveJobState({ status: 'COMPLETED' });
        broadcastMessage({ action: 'PROGRESS_UPDATE', state: await getJobState() });
        await debugLog('[LRC] All keywords completed.');
        break;
      }

      const item = state.queue[state.currentIndex];
      const index = state.currentIndex;

      await debugLog(`[LRC] Processing keyword ${index + 1}/${state.queue.length}: "${item.keyword}"`);

      // Ensure search tab exists
      let tab;
      try {
        tab = await ensureSearchTab(state.searchTabId);
        await saveJobState({ searchTabId: tab.id });
      } catch (err) {
        console.error('[LRC] Could not establish search tab:', err);
        await saveJobState({
          status: 'ERROR',
          errorMessage: 'Could not access Google search tab.'
        });
        break;
      }

      // Check ranks with pagination
      const { resultItem, blocked } = await checkKeywordRanks(item, tab.id, settings, runId);

      // Handle CAPTCHA / Interruption
      if (blocked) {
        await saveJobState({
          status: 'BLOCKED',
          errorMessage: 'Google interrupted rank checking. The job has been paused.'
        });
        broadcastMessage({
          action: 'JOB_BLOCKED',
          message: 'Google interrupted rank checking. The job has been paused.'
        });
        break;
      }

      // Re-read state after async pagination operation
      const latestState = await getJobState();

      // Invalidate if runId changed or user stopped
      if (latestState.runId !== runId) {
        await debugLog('[LRC] runId invalidated during keyword check. Halting.');
        break;
      }
      if (latestState.status === 'STOPPED') {
        await debugLog('[LRC] Job stopped by user. Halting.');
        break;
      }

      const wasPaused = (latestState.status === 'PAUSED' || latestState.status === 'BLOCKED');

      // Formulate final result item (or fallback error)
      const finalResult = resultItem || {
        id: item.id,
        keyword: item.keyword,
        targetUrl: item.targetUrl,
        previousPosition: item.previousPosition,
        currentPosition: 'Error',
        displayPosition: 'Error',
        change: '—',
        matchStatus: 'ERROR',
        status: 'ERROR',
        checkedDepth: 0,
        foundUrl: null,
        error: 'Operation was interrupted or failed to return valid results.',
        checkedAt: new Date().toISOString()
      };

      const updatedResults = [...(latestState.results || []), finalResult];
      const nextIndex = index + 1;
      const isComplete = nextIndex >= latestState.queue.length;

      // Status transition logic (PRESERVE PAUSED / BLOCKED!)
      let nextStatus;
      if (wasPaused) {
        nextStatus = latestState.status;
      } else if (isComplete) {
        nextStatus = 'COMPLETED';
      } else {
        nextStatus = 'RUNNING';
      }

      await saveJobState({
        results: updatedResults,
        currentIndex: nextIndex,
        status: nextStatus
      });

      broadcastMessage({
        action: 'PROGRESS_UPDATE',
        state: await getJobState()
      });

      // If user paused or completed, DO NOT continue to delay or next keyword
      if (wasPaused || isComplete) {
        break;
      }

      // Enforce inter-keyword delay (minimum 5s, default 8s)
      const delaySec = Math.max(5, Number(settings.delaySeconds) || 8);
      await debugLog(`[LRC] Waiting ${delaySec}s before next keyword...`);

      const delayOk = await interruptibleDelay(delaySec * 1000, runId);
      if (!delayOk) {
        await debugLog('[LRC] Inter-keyword delay was interrupted by user state change.');
        break;
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Handle incoming messages from popup
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      if (request.action === 'GET_STATE') {
        const state = await getJobState();
        const settings = await getSettings();
        sendResponse({ state, settings });
        return;
      }

      if (request.action === 'START_JOB') {
        const { queue, settings } = request;
        if (settings) {
          await saveSettings(settings);
        }

        // Cancel any pending timers from previous runs
        if (currentDelayTimer) {
          clearInterval(currentDelayTimer);
          currentDelayTimer = null;
        }

        // Create a unique execution session runId
        const runId = 'run_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

        const state = await saveJobState({
          runId: runId,
          status: 'RUNNING',
          queue: queue || [],
          currentIndex: 0,
          results: [],
          errorMessage: null
        });

        sendResponse({ success: true, state });
        processQueue(runId);
        return;
      }

      if (request.action === 'PAUSE_JOB') {
        if (currentDelayTimer) {
          clearInterval(currentDelayTimer);
          currentDelayTimer = null;
        }

        // Set status to PAUSED immediately
        const state = await saveJobState({ status: 'PAUSED' });
        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'RESUME_JOB') {
        const currentState = await getJobState();

        if (currentState.queue && currentState.currentIndex < currentState.queue.length &&
           (currentState.status === 'PAUSED' || currentState.status === 'BLOCKED')) {
          
          // Re-use or generate session runId
          const resumeRunId = currentState.runId || ('run_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));

          const state = await saveJobState({
            runId: resumeRunId,
            status: 'RUNNING',
            errorMessage: null
          });

          sendResponse({ success: true, state });
          processQueue(resumeRunId);
          return;
        }

        sendResponse({ success: false, message: 'No valid paused job to resume.' });
        return;
      }

      if (request.action === 'STOP_JOB') {
        if (currentDelayTimer) {
          clearInterval(currentDelayTimer);
          currentDelayTimer = null;
        }

        // Invalidate runId to stop in-flight tasks from proceeding
        const state = await saveJobState({
          status: 'STOPPED',
          runId: null
        });

        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'CLEAR_JOB') {
        if (currentDelayTimer) {
          clearInterval(currentDelayTimer);
          currentDelayTimer = null;
        }

        await resetJobState();
        const state = await getJobState();
        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'SAVE_SETTINGS') {
        if (request.settings) {
          await saveSettings(request.settings);
        }
        sendResponse({ success: true });
        return;
      }
    } catch (err) {
      console.error('[LRC] Message handling error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep channel open for async response
});

// Clean up tab reference if user closes the search tab
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  try {
    const state = await getJobState();
    if (state.searchTabId === closedTabId) {
      await saveJobState({ searchTabId: null });
    }
  } catch (_) {}
});
