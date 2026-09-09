/**
 * background.js
 * Hardened Service Worker for Local Rank Checker (Manifest V3).
 * 
 * Fixes addressed:
 * - Bug 1: Real controlled sequential SERP pagination with normal Google URLs (start=0, start=10...).
 * - Bug 2: Strict runId session isolation for every async operation.
 * - Bug 3: Guaranteed PAUSE / STOP preservation (never overwritten by late-returning async tasks).
 * - Bug 4: Interruption-safe, non-hanging waitForDelay system.
 * - Bug 5: Complete debug data flow (keyword, startOffset, checkedDepth, parsedResults).
 */

import { matchUrl, MATCH_TYPES, normalizeUrl } from './utils/urlNormalizer.js';
import { calculateChange } from './utils/parser.js';
import {
  getSettings,
  saveSettings,
  getJobState,
  saveJobState,
  resetJobState
} from './utils/storage.js';

let isQueueLoopRunning = false;

/**
 * Generates a unique execution session identifier
 * @returns {string}
 */
function generateRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'run_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
}

/**
 * Structured debug logger (active when debugMode is true)
 * @param {*} data 
 */
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
      // Tab was closed; create new one
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
 * Cancellable, interruption-safe delay system (Fix for Bug 4).
 * Periodically polls storage. Resolves immediately if status becomes PAUSED,
 * STOPPED, BLOCKED, or if runId changes. Never hangs or leaves dangling intervals.
 * 
 * @param {string} runId 
 * @param {number} ms 
 * @returns {Promise<{ completed: boolean, interrupted: boolean, reason?: string }>}
 */
function waitForDelay(runId, ms) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = 250;

    const intervalId = setInterval(async () => {
      try {
        const state = await getJobState();

        // 1. If runId changed, abort immediately
        if (state.runId !== runId) {
          clearInterval(intervalId);
          return resolve({ completed: false, interrupted: true, reason: 'RUN_ID_CHANGED' });
        }

        // 2. If status is STOPPED, abort immediately
        if (state.status === 'STOPPED') {
          clearInterval(intervalId);
          return resolve({ completed: false, interrupted: true, reason: 'STOPPED' });
        }

        // 3. If status is PAUSED or BLOCKED, resolve immediately
        if (state.status === 'PAUSED' || state.status === 'BLOCKED') {
          clearInterval(intervalId);
          return resolve({ completed: false, interrupted: true, reason: state.status });
        }

        // 4. Normal timeout completion
        if (Date.now() - startTime >= ms) {
          clearInterval(intervalId);
          return resolve({ completed: true, interrupted: false });
        }
      } catch (err) {
        clearInterval(intervalId);
        resolve({ completed: false, interrupted: true, reason: 'ERROR' });
      }
    }, checkInterval);
  });
}

/**
 * Verifies if the given runId is still active and status is RUNNING.
 * @param {string} runId 
 * @returns {Promise<boolean>}
 */
async function isSessionActive(runId) {
  if (!runId) return false;
  const state = await getJobState();
  return state.runId === runId && state.status === 'RUNNING';
}

/**
 * Safely sends a runtime message to popup or other views.
 * @param {object} msg 
 */
function broadcastMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Popup may be closed
    });
  } catch (_) {}
}

/**
 * Processes sequential SERP pagination for a single keyword (Fix for Bug 1).
 * Uses normal Google URLs with start=0, start=10, start=20... in the SAME visible tab.
 * Accurately tracks cumulative unique organic results without assuming 10 results per page.
 * 
 * @param {object} item { keyword, targetUrl, previousPosition, id }
 * @param {number} tabId
 * @param {object} settings
 * @param {string} runId
 * @returns {Promise<{ resultItem: object|null, blocked: boolean, interrupted: boolean }>}
 */
async function checkKeywordRanks(item, tabId, settings, runId) {
  const domain = settings.googleDomain || 'google.com';
  const maxDepth = Math.max(10, Math.min(100, Number(settings.maxPosition) || 50));
  const normTarget = normalizeUrl(item.targetUrl);

  const cumulativeResults = [];
  const seenNormalizedUrls = new Set();

  let offset = 0;
  let exactMatch = null;
  let otherDomainMatch = null;
  let consecutiveEmptyPages = 0;

  while (cumulativeResults.length < maxDepth && !exactMatch && consecutiveEmptyPages < 2) {
    // 1. Session Guard Check
    if (!(await isSessionActive(runId))) {
      return { resultItem: null, blocked: false, interrupted: true };
    }

    // 2. Build Normal Google Search URL with pagination offset
    const searchUrl = `https://www.${domain}/search?q=${encodeURIComponent(item.keyword)}&start=${offset}`;

    await debugLog({
      runId,
      keyword: item.keyword,
      targetUrl: item.targetUrl,
      normalizedTarget: normTarget,
      googleUrl: searchUrl,
      currentSerpOffset: offset,
      maxDepth,
      cumulativeCountSoFar: cumulativeResults.length
    });

    // Update storage with active pagination offset
    await saveJobState({
      currentKeyword: item.keyword,
      currentSerpOffset: offset,
      checkedDepth: cumulativeResults.length,
      seenUrls: Array.from(seenNormalizedUrls)
    });

    try {
      // 3. Navigate tab
      await navigateAndWaitForTab(tabId, searchUrl, 20000);

      // Brief dynamic render wait (interruptible)
      const renderWait = await waitForDelay(runId, 1200);
      if (!renderWait.completed) {
        return { resultItem: null, blocked: false, interrupted: true };
      }

      // Re-verify session after async wait
      if (!(await isSessionActive(runId))) {
        return { resultItem: null, blocked: false, interrupted: true };
      }

      // 4. Request extraction from content script with full debug context (Bug 5)
      const response = await sendMessageWithRetry(tabId, {
        action: 'PARSE_SERP',
        keyword: item.keyword,
        startOffset: offset,
        checkedDepth: cumulativeResults.length,
        debug: settings.debugMode,
        timeout: 8000
      });

      // 5. Handle CAPTCHA / Unusual Traffic
      if (response && response.status === 'BLOCKED') {
        await debugLog(`[LRC] Google interruption / CAPTCHA detected on "${item.keyword}".`);
        return { resultItem: null, blocked: true, interrupted: false };
      }

      if (response && response.status === 'SUCCESS') {
        const pageResults = response.results || [];
        let newUniqueCount = 0;

        for (const res of pageResults) {
          const normCandidate = res.normalizedUrl || normalizeUrl(res.url);

          // Deduplicate against already-seen URLs for this keyword
          if (!normCandidate || seenNormalizedUrls.has(normCandidate)) {
            continue;
          }

          seenNormalizedUrls.add(normCandidate);
          newUniqueCount++;

          const rankPosition = cumulativeResults.length + 1;
          const organicEntry = {
            position: rankPosition,
            url: res.url,
            title: res.title,
            normalizedUrl: normCandidate
          };
          cumulativeResults.push(organicEntry);

          // Test exact page match
          const matchCheck = matchUrl(item.targetUrl, res.url);
          if (matchCheck.match && !exactMatch) {
            exactMatch = organicEntry;
            await debugLog(`[LRC] Exact target page MATCH found at position ${rankPosition}: ${organicEntry.url}`);
            break; // Target page found! Stop adding more results on this page
          }

          // Test same domain alternate page (cannibalization)
          if (matchCheck.isSameDomain && !otherDomainMatch) {
            otherDomainMatch = organicEntry;
            await debugLog(`[LRC] Same domain alternate page found at position ${rankPosition}: ${organicEntry.url}`);
          }

          if (cumulativeResults.length >= maxDepth) {
            break;
          }
        }

        await debugLog({
          keyword: item.keyword,
          offset,
          pageResultsCount: pageResults.length,
          newUniqueFoundOnPage: newUniqueCount,
          totalCumulativeCount: cumulativeResults.length,
          exactMatchFound: Boolean(exactMatch),
          otherDomainFound: Boolean(otherDomainMatch)
        });

        if (exactMatch) {
          break; // Found exact target! Stop pagination immediately
        }

        if (newUniqueCount === 0) {
          consecutiveEmptyPages++;
        } else {
          consecutiveEmptyPages = 0;
        }

        // If not found and haven't reached maxDepth, paginate to next page
        if (!exactMatch && cumulativeResults.length < maxDepth && consecutiveEmptyPages < 2) {
          offset += 10;

          // Internal pagination delay (3 seconds, minimum 2 seconds)
          await debugLog(`[LRC] Waiting internal pagination delay (3s) before start=${offset}...`);
          const delayRes = await waitForDelay(runId, 3000);
          if (!delayRes.completed) {
            return { resultItem: null, blocked: false, interrupted: true };
          }
        }
      } else {
        consecutiveEmptyPages++;
      }
    } catch (err) {
      console.error(`[LRC] Error on startOffset=${offset} for "${item.keyword}":`, err);
      consecutiveEmptyPages++;
    }
  }

  // Determine final ranking and honest checked depth
  const checkedDepth = cumulativeResults.length;
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

  return { resultItem, blocked: false, interrupted: false };
}

/**
 * Main queue runner loop. Runs while state.status === 'RUNNING' and runId matches.
 * @param {string} runId 
 */
async function processQueue(runId) {
  if (isQueueLoopRunning) return;
  isQueueLoopRunning = true;

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
        await saveJobState({
          status: 'COMPLETED',
          currentKeyword: null,
          currentSerpOffset: 0,
          checkedDepth: 0,
          seenUrls: []
        });
        broadcastMessage({ action: 'PROGRESS_UPDATE', state: await getJobState() });
        await debugLog('[LRC] All keywords completed.');
        break;
      }

      const item = state.queue[state.currentIndex];
      const index = state.currentIndex;

      await debugLog(`[LRC] Processing keyword ${index + 1}/${state.queue.length}: "${item.keyword}"`);

      // Ensure visible search tab exists
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

      // Check ranks across pagination
      const { resultItem, blocked, interrupted } = await checkKeywordRanks(item, tab.id, settings, runId);

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

      // Re-read fresh state from storage before committing result or changing state (Fix for Bug 2 & 3)
      const latestState = await getJobState();

      // Invalidate if runId changed or user stopped
      if (latestState.runId !== runId) {
        await debugLog('[LRC] runId mismatch after keyword check. Aborting without mutating state.');
        break;
      }
      if (latestState.status === 'STOPPED') {
        await debugLog('[LRC] State is STOPPED. Aborting without mutating state.');
        break;
      }

      const wasPaused = (latestState.status === 'PAUSED' || latestState.status === 'BLOCKED');

      // Formulate final result item
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
        error: interrupted ? 'Operation paused or interrupted.' : 'Failed to retrieve search results.',
        checkedAt: new Date().toISOString()
      };

      const updatedResults = [...(latestState.results || []), finalResult];
      const nextIndex = index + 1;
      const isComplete = nextIndex >= latestState.queue.length;

      // Status transition logic: MUST PRESERVE PAUSED OR BLOCKED!
      let nextStatus;
      if (wasPaused) {
        nextStatus = latestState.status; // Remain PAUSED or BLOCKED! Never overwrite with RUNNING.
      } else if (isComplete) {
        nextStatus = 'COMPLETED';
      } else {
        nextStatus = 'RUNNING';
      }

      await saveJobState({
        results: updatedResults,
        currentIndex: nextIndex,
        status: nextStatus,
        currentKeyword: null,
        currentSerpOffset: 0,
        checkedDepth: 0,
        seenUrls: []
      });

      broadcastMessage({
        action: 'PROGRESS_UPDATE',
        state: await getJobState()
      });

      // If user paused or job completed, DO NOT continue to delay or next keyword
      if (wasPaused || isComplete) {
        break;
      }

      // Enforce inter-keyword delay (minimum 5s, default 8s) using interruptible delay
      const delaySec = Math.max(5, Number(settings.delaySeconds) || 8);
      await debugLog(`[LRC] Waiting ${delaySec}s before next keyword...`);

      const delayRes = await waitForDelay(runId, delaySec * 1000);
      if (!delayRes.completed) {
        await debugLog(`[LRC] Inter-keyword delay ended: ${delayRes.reason}. Halting loop.`);
        break;
      }
    }
  } finally {
    isQueueLoopRunning = false;
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

        // Create a brand new unique execution session runId (Fix for Bug 2)
        const runId = generateRunId();

        const state = await saveJobState({
          runId: runId,
          status: 'RUNNING',
          queue: queue || [],
          currentIndex: 0,
          results: [],
          currentKeyword: null,
          currentSerpOffset: 0,
          checkedDepth: 0,
          seenUrls: [],
          errorMessage: null
        });

        sendResponse({ success: true, state });
        processQueue(runId);
        return;
      }

      if (request.action === 'PAUSE_JOB') {
        // Set status to PAUSED immediately (waitForDelay polls and resolves within 250ms)
        const state = await saveJobState({ status: 'PAUSED' });
        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'RESUME_JOB') {
        const currentState = await getJobState();

        if (currentState.queue && currentState.currentIndex < currentState.queue.length &&
           (currentState.status === 'PAUSED' || currentState.status === 'BLOCKED')) {
          
          // Re-use current runId or generate fresh if missing
          const resumeRunId = currentState.runId || generateRunId();

          const state = await saveJobState({
            runId: resumeRunId,
            status: 'RUNNING',
            errorMessage: null
          });

          sendResponse({ success: true, state });
          processQueue(resumeRunId);
          return;
        }

        sendResponse({ success: false, message: 'Cannot resume: job not paused or queue already completed.' });
        return;
      }

      if (request.action === 'STOP_JOB') {
        // Set status to STOPPED and invalidate runId immediately (Fix for Bug 2 & 3)
        const state = await saveJobState({
          status: 'STOPPED',
          runId: null
        });

        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'CLEAR_JOB') {
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
