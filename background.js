/**
 * background.js
 * Service worker managing the keyword ranking workflow queue,
 * tab navigation, delay timing, error recovery, and persistence.
 */

import { matchUrl, MATCH_TYPES } from './utils/urlNormalizer.js';
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
let isProcessingKeyword = false;

// Log helper for debug mode
async function debugLog(...args) {
  try {
    const settings = await getSettings();
    if (settings && settings.debugMode) {
      console.log('[LRC Service Worker]', ...args);
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
      // Tab was closed or not found; will create a new one
    }
  }

  // Create new active tab
  const newTab = await chrome.tabs.create({
    url: 'https://www.google.com',
    active: true
  });
  return newTab;
}

/**
 * Navigates the given tab to the search URL and waits for page load to finish.
 * @param {number} tabId 
 * @param {string} searchUrl 
 * @param {number} timeoutMs 
 * @returns {Promise<boolean>}
 */
function navigateAndWaitForTab(tabId, searchUrl, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const onUpdatedListener = (updatedTabId, changeInfo, tab) => {
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
 * Sends a message to the content script with retries in case the script is still initializing.
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
      // Short delay before retry
      await new Promise(r => setTimeout(r, 600));
    }
  }
}

/**
 * Delays execution for ms, checking every 200ms if job status changed (paused/stopped).
 * @param {number} ms 
 * @returns {Promise<boolean>} true if delay completed normally, false if aborted
 */
function interruptibleDelay(ms) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    currentDelayTimer = setInterval(async () => {
      const state = await getJobState();
      if (state.status !== 'RUNNING') {
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
 * Main queue runner loop. Runs while status === 'RUNNING' and currentIndex < queue.length.
 */
async function processQueue() {
  if (isProcessingKeyword) return;
  isProcessingKeyword = true;

  try {
    let state = await getJobState();
    const settings = await getSettings();

    while (state.status === 'RUNNING' && state.currentIndex < state.queue.length) {
      const item = state.queue[state.currentIndex];
      const index = state.currentIndex;

      await debugLog(`Checking keyword ${index + 1} of ${state.queue.length}: "${item.keyword}"`);

      // 1. Ensure search tab exists
      let tab;
      try {
        tab = await ensureSearchTab(state.searchTabId);
        state.searchTabId = tab.id;
        await saveJobState({ searchTabId: tab.id });
      } catch (err) {
        console.error('[LRC] Could not establish search tab:', err);
        await saveJobState({
          status: 'ERROR',
          errorMessage: 'Could not create or access Google search tab.'
        });
        break;
      }

      // 2. Build Google Search URL
      // Use num=100 to request up to 100 results on one page
      const domain = settings.googleDomain || 'google.com';
      const maxPos = settings.maxPosition || 100;
      const searchUrl = `https://www.${domain}/search?q=${encodeURIComponent(item.keyword)}&num=${maxPos}`;

      let resultItem = null;

      try {
        // 3. Navigate and wait for page complete
        await navigateAndWaitForTab(tab.id, searchUrl, 20000);

        // 4. Brief cooldown for dynamic SERP JS execution
        await new Promise(r => setTimeout(r, 1200));

        // 5. Send extract message to content script
        const response = await sendMessageWithRetry(tab.id, {
          action: 'EXTRACT_SERP',
          debug: settings.debugMode,
          timeout: 8000
        });

        // 6. Check for Google CAPTCHA / bot interruptions
        if (response && response.status === 'BLOCKED') {
          await debugLog('Google CAPTCHA or interruption detected!');
          await saveJobState({
            status: 'BLOCKED',
            errorMessage: 'Google interrupted rank checking. The job has been paused.'
          });
          broadcastMessage({
            action: 'JOB_BLOCKED',
            message: 'Google interrupted rank checking. The job has been paused.'
          });
          break; // Halt execution so user can resolve manually
        }

        if (response && response.status === 'SUCCESS') {
          const organicResults = response.results || [];
          const checkedDepth = organicResults.length;

          await debugLog(`Parsed ${checkedDepth} organic results for "${item.keyword}".`);

          // Match Logic
          // Priority 1: Exact page match
          let exactMatch = null;
          for (const res of organicResults) {
            const m = matchUrl(item.targetUrl, res.url);
            if (m.match) {
              exactMatch = res;
              break;
            }
          }

          // Priority 2: Same domain alternate page match (DO NOT report as target page rank!)
          let otherDomainMatch = null;
          if (!exactMatch) {
            for (const res of organicResults) {
              const m = matchUrl(item.targetUrl, res.url);
              if (m.isSameDomain) {
                otherDomainMatch = res;
                break;
              }
            }
          }

          let currentPosition = null;
          let matchStatus = '';
          let status = '';
          let foundUrl = null;
          let otherPageFound = null;
          let otherPagePosition = null;

          if (exactMatch) {
            currentPosition = exactMatch.position;
            matchStatus = MATCH_TYPES.EXACT_PAGE;
            status = 'EXACT PAGE';
            foundUrl = exactMatch.url;
          } else if (otherDomainMatch) {
            currentPosition = 'Not Found';
            matchStatus = MATCH_TYPES.OTHER_DOMAIN_PAGE;
            status = 'OTHER DOMAIN PAGE FOUND';
            foundUrl = null;
            otherPageFound = otherDomainMatch.url;
            otherPagePosition = otherDomainMatch.position;
          } else {
            currentPosition = 'Not Found';
            matchStatus = MATCH_TYPES.NOT_FOUND;
            status = 'NOT FOUND';
            foundUrl = null;
          }

          const change = calculateChange(item.previousPosition, currentPosition);

          resultItem = {
            id: item.id,
            keyword: item.keyword,
            targetUrl: item.targetUrl,
            previousPosition: item.previousPosition,
            currentPosition: currentPosition,
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
        } else {
          // Content script reported an error or empty response
          resultItem = {
            id: item.id,
            keyword: item.keyword,
            targetUrl: item.targetUrl,
            previousPosition: item.previousPosition,
            currentPosition: 'Error',
            change: '—',
            matchStatus: 'ERROR',
            status: 'ERROR',
            checkedDepth: 0,
            foundUrl: null,
            error: (response && response.message) || 'Failed to parse search results.',
            checkedAt: new Date().toISOString()
          };
        }
      } catch (stepError) {
        console.error(`[LRC] Error processing keyword "${item.keyword}":`, stepError);
        resultItem = {
          id: item.id,
          keyword: item.keyword,
          targetUrl: item.targetUrl,
          previousPosition: item.previousPosition,
          currentPosition: 'Error',
          change: '—',
          matchStatus: 'ERROR',
          status: 'ERROR',
          checkedDepth: 0,
          foundUrl: null,
          error: stepError.message || 'Error occurred during search navigation.',
          checkedAt: new Date().toISOString()
        };
      }

      // Append result to results array
      const currentResults = state.results || [];
      const updatedResults = [...currentResults, resultItem];
      const nextIndex = index + 1;

      // Check if job completed
      const isComplete = nextIndex >= state.queue.length;
      const nextStatus = isComplete ? 'COMPLETED' : 'RUNNING';

      state = await saveJobState({
        currentIndex: nextIndex,
        results: updatedResults,
        status: nextStatus
      });

      broadcastMessage({
        action: 'PROGRESS_UPDATE',
        state: state
      });

      if (isComplete) {
        await debugLog('All keywords processed. Job completed.');
        break;
      }

      // Check if user paused or stopped while processing was completing
      if (state.status !== 'RUNNING') {
        break;
      }

      // 7. Enforce Delay Before Next Keyword
      const delaySec = Math.max(5, Number(settings.delaySeconds) || 8);
      await debugLog(`Waiting ${delaySec} seconds before next keyword...`);

      const delayFinished = await interruptibleDelay(delaySec * 1000);
      if (!delayFinished) {
        await debugLog('Delay interrupted by state change.');
        break;
      }

      // Refresh state to ensure still RUNNING
      state = await getJobState();
    }
  } finally {
    isProcessingKeyword = false;
  }
}

/**
 * Safely sends a message to any open popup/views without throwing if popup is closed.
 * @param {object} msg 
 */
function broadcastMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Expected: popup may not be open
    });
  } catch (_) {}
}

/**
 * Handle user commands and popup messages
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

        const state = await saveJobState({
          status: 'RUNNING',
          queue: queue || [],
          currentIndex: 0,
          results: [],
          errorMessage: null
        });

        sendResponse({ success: true, state });
        processQueue();
        return;
      }

      if (request.action === 'PAUSE_JOB') {
        if (currentDelayTimer) {
          clearInterval(currentDelayTimer);
          currentDelayTimer = null;
        }
        const state = await saveJobState({ status: 'PAUSED' });
        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'RESUME_JOB') {
        const state = await saveJobState({
          status: 'RUNNING',
          errorMessage: null
        });
        sendResponse({ success: true, state });
        processQueue();
        return;
      }

      if (request.action === 'STOP_JOB') {
        if (currentDelayTimer) {
          clearInterval(currentDelayTimer);
          currentDelayTimer = null;
        }
        const state = await saveJobState({ status: 'STOPPED' });
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

  return true; // Keep message channel open for async response
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
