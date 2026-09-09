/**
 * background.js
 * Hardened Service Worker for SERPTrack (Manifest V3).
 * 
 * Race-condition fixes:
 * 1. Fast Pause → Resume lifecycle race: ensureQueueRunning waits for old loop shutdown before starting a new loop.
 * 2. Stale PAUSED write prevention: interruption handler re-reads storage and never overwrites RUNNING or STOPPED.
 * 3. Duplicate loop prevention: authoritative loop promise token with clean single-loop ownership.
 */

import { matchUrl, MATCH_TYPES, normalizeUrl } from './utils/urlNormalizer.js';
import { calculateChange } from './utils/parser.js';
import {
  validateCoordinates,
  createLocationFingerprint,
  isLocationFingerprintMatch
} from './utils/locationValidator.js';
import {
  getSettings,
  saveSettings,
  getJobState,
  saveJobState,
  resetJobState,
  LOCATION_STATES
} from './utils/storage.js';
import { addProjectSnapshot } from './utils/projectManager.js';

// Queue loop lifecycle management
let activeQueuePromise = null;
let activeRunId = null;

// Debugger session management for Geolocation CDP Override
let activeDebuggerTabId = null;
let activeAppliedLocation = null; // { latitude, longitude, accuracy, tabId }

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
 * Attaches Chrome Debugger to the specified target.
 * @param {object} target { tabId: number }
 * @returns {Promise<void>}
 */
function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve();
    });
  });
}

/**
 * Detaches Chrome Debugger from the specified target safely.
 * @param {object} target { tabId: number }
 * @returns {Promise<void>}
 */
function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      if (chrome.runtime.lastError) {
        // Tab already closed or already detached
      }
      resolve();
    });
  });
}

/**
 * Sends a CDP command to the specified target.
 * @param {object} target { tabId: number }
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>}
 */
function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(result);
    });
  });
}

/**
 * Applies geolocation override to a given tab using Chrome DevTools Protocol (CDP).
 * @param {number} tabId 
 * @param {object} coords { latitude, longitude, accuracy, locationName }
 * @param {string} googleDomain 
 * @returns {Promise<{ success: boolean, coords: object }>}
 */
async function applyGeolocationOverride(tabId, coords, googleDomain = 'google.com') {
  const validation = validateCoordinates(coords.latitude, coords.longitude, coords.accuracy);
  if (!validation.valid) {
    throw new Error(validation.error || 'Invalid coordinates for geolocation override.');
  }

  const target = { tabId };

  // If already attached to a different tab, detach first
  if (activeDebuggerTabId && activeDebuggerTabId !== tabId) {
    await detachDebugger({ tabId: activeDebuggerTabId });
    activeDebuggerTabId = null;
  }

  // Attach to tab if not already attached
  if (activeDebuggerTabId !== tabId) {
    try {
      await attachDebugger(target);
      activeDebuggerTabId = tabId;
      await debugLog(`[LRC Debugger] Attached to tab ${tabId}`);
    } catch (err) {
      if (err.message && err.message.includes('already attached')) {
        activeDebuggerTabId = tabId;
      } else {
        throw new Error(`Failed to attach debugger to search tab: ${err.message}`);
      }
    }
  }

  // Send Emulation.setGeolocationOverride
  await sendDebuggerCommand(target, 'Emulation.setGeolocationOverride', {
    latitude: validation.latitude,
    longitude: validation.longitude,
    accuracy: validation.accuracy
  });

  // Attempt to grant geolocation permissions to Google domain
  try {
    await sendDebuggerCommand(target, 'Browser.grantPermissions', {
      permissions: ['geolocation'],
      origin: `https://www.${googleDomain}`
    });
  } catch (_) {}

  activeAppliedLocation = createLocationFingerprint(tabId, validation.latitude, validation.longitude, validation.accuracy);

  await debugLog({
    action: 'Emulation.setGeolocationOverride',
    tabId,
    latitude: validation.latitude,
    longitude: validation.longitude,
    accuracy: validation.accuracy,
    locationName: coords.locationName || null
  });

  await saveJobState({
    locationConfigured: true,
    locationApplied: true,
    locationState: LOCATION_STATES.ACTIVE,
    locationTabId: tabId,
    locationDetails: {
      latitude: validation.latitude,
      longitude: validation.longitude,
      accuracy: validation.accuracy,
      locationName: coords.locationName || ''
    }
  });

  broadcastMessage({
    action: 'LOCATION_STATUS_UPDATE',
    status: LOCATION_STATES.ACTIVE,
    tabId,
    details: {
      latitude: validation.latitude,
      longitude: validation.longitude,
      accuracy: validation.accuracy,
      locationName: coords.locationName || ''
    }
  });

  return { success: true, coords: validation };
}

/**
 * Clears geolocation override and detaches debugger session.
 * @param {number|null} tabId 
 * @returns {Promise<void>}
 */
async function clearGeolocationOverride(tabId = null) {
  const targetId = tabId || activeDebuggerTabId;
  if (targetId) {
    try {
      await sendDebuggerCommand({ tabId: targetId }, 'Emulation.clearGeolocationOverride', {});
    } catch (_) {}
    try {
      await detachDebugger({ tabId: targetId });
    } catch (_) {}
  }
  activeDebuggerTabId = null;
  activeAppliedLocation = null;

  await saveJobState({
    locationConfigured: false,
    locationApplied: false,
    locationState: LOCATION_STATES.NOT_CONFIGURED,
    locationTabId: null,
    locationDetails: null
  });

  broadcastMessage({
    action: 'LOCATION_STATUS_UPDATE',
    status: LOCATION_STATES.NOT_CONFIGURED
  });

  await debugLog('[LRC Debugger] Geolocation override cleared and debugger detached.');
}

// Track external debugger detachment (e.g. user clicked Cancel on Chrome infobar or tab closed)
chrome.debugger.onDetach.addListener((source, reason) => {
  if (activeDebuggerTabId && activeDebuggerTabId === source.tabId) {
    debugLog(`[LRC Debugger] Detached from tab ${source.tabId}. Reason: ${reason}`);
    activeDebuggerTabId = null;
    activeAppliedLocation = null;
    saveJobState({
      locationApplied: false,
      locationState: LOCATION_STATES.FAILED,
      locationTabId: null
    });
    broadcastMessage({
      action: 'LOCATION_STATUS_UPDATE',
      status: LOCATION_STATES.FAILED,
      reason: reason
    });
  }
});

/**
 * Authoritative location override check and reapply.
 * If useLocation is true, verifies that CDP override is applied with the exact current coordinates
 * and active tabId. If not, applies or reapplies it.
 * If override fails, returns { success: false, error: ... }.
 * 
 * @param {number} tabId
 * @param {string} runId
 * @param {object} settings
 * @returns {Promise<{ success: boolean, applied: boolean, error?: string }>}
 */
async function ensureLocationApplied(tabId, runId, settings) {
  if (!settings || !settings.useLocation) {
    return { success: true, applied: false };
  }

  const coordsValidation = validateCoordinates(settings.latitude, settings.longitude, settings.accuracy);
  if (!coordsValidation.valid) {
    return {
      success: false,
      applied: false,
      error: `Invalid coordinates: ${coordsValidation.error}`
    };
  }

  // Check if already applied to this tab with identical coordinates
  if (
    activeDebuggerTabId === tabId &&
    isLocationFingerprintMatch(activeAppliedLocation, tabId, coordsValidation.latitude, coordsValidation.longitude, coordsValidation.accuracy)
  ) {
    return { success: true, applied: true };
  }

  // Need to apply or reapply
  try {
    await debugLog(`[LRC] ensureLocationApplied: Applying override to tab ${tabId} for lat=${coordsValidation.latitude}, lon=${coordsValidation.longitude}...`);
    await applyGeolocationOverride(tabId, {
      latitude: coordsValidation.latitude,
      longitude: coordsValidation.longitude,
      accuracy: coordsValidation.accuracy,
      locationName: settings.locationName || ''
    }, settings.googleDomain || 'google.com');

    return { success: true, applied: true };
  } catch (err) {
    console.error('[LRC] ensureLocationApplied failed:', err);
    activeAppliedLocation = null;
    await saveJobState({
      locationApplied: false,
      locationState: LOCATION_STATES.FAILED
    });
    broadcastMessage({
      action: 'LOCATION_STATUS_UPDATE',
      status: LOCATION_STATES.FAILED,
      error: err.message
    });
    return {
      success: false,
      applied: false,
      error: err.message || 'CDP Geolocation override failed.'
    };
  }
}

/**
 * Ensures a visible search tab exists, either reusing an existing one or creating a new tab.
 * @param {number|null} existingTabId 
 * @param {object|null} settings
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function ensureSearchTab(existingTabId, settings = null) {
  let tab = null;

  if (existingTabId) {
    try {
      tab = await chrome.tabs.get(existingTabId);
    } catch (_) {
      // Tab was closed; create new one
    }
  }

  if (!tab) {
    tab = await chrome.tabs.create({
      url: 'https://www.google.com',
      active: true
    });
  }

  return tab;
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
 * Cancellable, interruption-safe delay system.
 * Periodically polls storage. Resolves immediately if status becomes PAUSED,
 * STOPPED, BLOCKED, or if runId changes.
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
          return resolve({ completed: false, interrupted: true, reason: 'RUN_INVALIDATED' });
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
 * Checks whether an interruption has occurred in storage for the active runId.
 * @param {string} runId 
 * @returns {Promise<string|null>} Reason string if interrupted, or null if still RUNNING
 */
async function getInterruptionReason(runId) {
  if (!runId) return 'RUN_INVALIDATED';
  const state = await getJobState();
  if (state.runId !== runId) return 'RUN_INVALIDATED';
  if (state.status === 'STOPPED') return 'STOPPED';
  if (state.status === 'PAUSED') return 'PAUSED';
  if (state.status === 'BLOCKED') return 'BLOCKED';
  return null;
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
 * Processes sequential SERP pagination for a single keyword.
 * Returns explicit interruption reason ('PAUSED' | 'STOPPED' | 'BLOCKED' | 'RUN_INVALIDATED')
 * so that cancellations are never confused with technical errors.
 * 
 * @param {object} item { keyword, targetUrl, previousPosition, id }
 * @param {number} tabId
 * @param {object} settings
 * @param {string} runId
 * @returns {Promise<{ resultItem: object|null, interrupted: boolean, reason?: string }>}
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
    const earlyReason = await getInterruptionReason(runId);
    if (earlyReason) {
      return { resultItem: null, interrupted: true, reason: earlyReason };
    }

    // 2. Build Google Search URL with pagination offset
    const searchUrl = `https://www.${domain}/search?q=${encodeURIComponent(item.keyword)}&start=${offset}`;

    await debugLog({
      runId,
      keyword: item.keyword,
      targetUrl: item.targetUrl,
      normalizedTarget: normTarget,
      googleUrl: searchUrl,
      currentSerpOffset: offset,
      maxDepth,
      cumulativeCountSoFar: cumulativeResults.length,
      locationEnabled: Boolean(settings && settings.useLocation),
      latitude: settings && settings.useLocation ? settings.latitude : null,
      longitude: settings && settings.useLocation ? settings.longitude : null,
      accuracy: settings && settings.useLocation ? (settings.accuracy || 20) : null,
      debuggerAttached: activeDebuggerTabId === tabId,
      tabId: tabId,
      overrideApplied: activeDebuggerTabId === tabId
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
        return { resultItem: null, interrupted: true, reason: renderWait.reason || 'PAUSED' };
      }

      // Re-verify session after async wait
      const postNavReason = await getInterruptionReason(runId);
      if (postNavReason) {
        return { resultItem: null, interrupted: true, reason: postNavReason };
      }

      // 4. Request extraction from content script with full debug context
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
        return { resultItem: null, interrupted: true, reason: 'BLOCKED' };
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
            break; // Stop scanning more results on this page
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
            return { resultItem: null, interrupted: true, reason: delayRes.reason || 'PAUSED' };
          }
        }
      } else {
        consecutiveEmptyPages++;
      }
    } catch (err) {
      const errReason = await getInterruptionReason(runId);
      if (errReason) {
        return { resultItem: null, interrupted: true, reason: errReason };
      }
      console.error(`[LRC] Error on startOffset=${offset} for "${item.keyword}":`, err);
      consecutiveEmptyPages++;

      if (consecutiveEmptyPages >= 2 && cumulativeResults.length === 0) {
        // Genuine technical error
        return {
          resultItem: {
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
            error: err.message || 'Page navigation or extraction failed.',
            checkedAt: new Date().toISOString()
          },
          interrupted: false
        };
      }
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

  return { resultItem, interrupted: false };
}

/**
 * Main queue runner loop. Runs while state.status === 'RUNNING' and runId matches.
 * @param {string} runId 
 */
async function runQueueLoop(runId) {
  while (true) {
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
      const activeProjId = state.projectId || (await getSettings()).activeProjectId;
      if (activeProjId && state.results && state.results.length > 0) {
        try {
          await addProjectSnapshot(activeProjId, state.results);
          await debugLog(`[LRC] Auto-saved weekly snapshot for project ${activeProjId}`);
        } catch (snapErr) {
          console.error('[LRC] Failed to auto-save project snapshot:', snapErr);
        }
      }
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
      tab = await ensureSearchTab(state.searchTabId, settings);
      await saveJobState({ searchTabId: tab.id });
    } catch (err) {
      console.error('[LRC] Could not establish search tab:', err);
      await saveJobState({
        status: 'ERROR',
        errorMessage: 'Could not access Google search tab.'
      });
      break;
    }

    // FAIL-CLOSED GUARD: If location simulation is enabled, verify CDP override succeeded
    if (settings && settings.useLocation) {
      const locResult = await ensureLocationApplied(tab.id, runId, settings);
      if (!locResult.success) {
        const errorMsg = 'Location override failed. Rank checking has been stopped to prevent inaccurate local results.';
        await debugLog(`[LRC FAIL-CLOSED] ${errorMsg} Error: ${locResult.error}`);
        await saveJobState({
          status: 'BLOCKED',
          errorMessage: errorMsg,
          currentKeyword: null,
          currentSerpOffset: 0,
          checkedDepth: 0,
          seenUrls: []
        });
        broadcastMessage({
          action: 'JOB_BLOCKED',
          message: errorMsg,
          error: locResult.error
        });
        broadcastMessage({
          action: 'LOCATION_STATUS_UPDATE',
          status: LOCATION_STATES.FAILED,
          error: locResult.error
        });
        break; // HALT IMMEDIATELY. Do not navigate or run checkKeywordRanks!
      }
    }

    // Check ranks across pagination
    const { resultItem, interrupted, reason } = await checkKeywordRanks(item, tab.id, settings, runId);

    // BUG 1 FIX: If interrupted, DO NOT mark keyword as ERROR and DO NOT advance currentIndex!
    if (interrupted) {
      if (reason === 'STOPPED') {
        await debugLog(`[LRC] Keyword check stopped by user. Halting.`);
        break;
      }

      if (reason === 'PAUSED') {
        await debugLog(`[LRC] Keyword check paused on "${item.keyword}". Preserving currentIndex ${index}.`);
        
        // BUG 2 FIX: Re-read state before writing PAUSED.
        // If the user already clicked RESUME (status === 'RUNNING'), DO NOT write PAUSED.
        // If the state is STOPPED or runId changed, DO NOT mutate anything.
        const latestOnPause = await getJobState();
        if (latestOnPause.runId === runId && latestOnPause.status === 'PAUSED') {
          await saveJobState({
            status: 'PAUSED',
            currentKeyword: null,
            currentSerpOffset: 0,
            checkedDepth: 0,
            seenUrls: []
          });
          broadcastMessage({ action: 'PROGRESS_UPDATE', state: await getJobState() });
        } else if (latestOnPause.runId === runId && latestOnPause.status === 'RUNNING') {
          // User already resumed while exiting: clean transient pagination counters without overwriting RUNNING
          await saveJobState({
            currentKeyword: null,
            currentSerpOffset: 0,
            checkedDepth: 0,
            seenUrls: []
          });
        }
        break;
      }

      if (reason === 'BLOCKED') {
        // BUG 2 FIX: Verify state priority before writing BLOCKED (STOPPED & PAUSED have higher priority)
        const checkState = await getJobState();
        if (checkState.runId === runId && checkState.status !== 'STOPPED' && checkState.status !== 'PAUSED') {
          await saveJobState({
            status: 'BLOCKED',
            errorMessage: 'Google interrupted rank checking. The job has been paused.',
            currentKeyword: null,
            currentSerpOffset: 0,
            checkedDepth: 0,
            seenUrls: []
          });
          broadcastMessage({
            action: 'JOB_BLOCKED',
            message: 'Google interrupted rank checking. The job has been paused.'
          });
        }
        break;
      }

      // reason === 'RUN_INVALIDATED'
      break;
    }

    if (!resultItem) {
      break;
    }

    // Re-verify storage state before committing result (BUG 2 & 3 FIX)
    const latestState = await getJobState();

    if (latestState.runId !== runId) {
      await debugLog('[LRC] runId mismatch after keyword check. Aborting without mutating state.');
      break;
    }
    if (latestState.status === 'STOPPED') {
      await debugLog('[LRC] State is STOPPED. Aborting without mutating state.');
      break;
    }

    const wasPaused = (latestState.status === 'PAUSED' || latestState.status === 'BLOCKED');

    // Only commit a finished real result (or real technical failure)
    const updatedResults = [...(latestState.results || [])];
    const itemOriginalIndex = (item.originalIndex !== undefined) ? item.originalIndex : index;
    const finalResultItem = {
      ...resultItem,
      originalIndex: itemOriginalIndex
    };

    while (updatedResults.length <= itemOriginalIndex) {
      updatedResults.push(null);
    }
    updatedResults[itemOriginalIndex] = finalResultItem;

    const nextIndex = index + 1;
    const isComplete = nextIndex >= latestState.queue.length;

    // Status transition: NEVER overwrite PAUSED or BLOCKED with RUNNING
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
      status: nextStatus,
      currentKeyword: null,
      currentSerpOffset: 0,
      checkedDepth: 0,
      seenUrls: []
    });

    if (isComplete && !wasPaused) {
      const activeProjId = latestState.projectId || (await getSettings()).activeProjectId;
      if (activeProjId) {
        try {
          await addProjectSnapshot(activeProjId, updatedResults);
          await debugLog(`[LRC] Auto-saved weekly snapshot for project ${activeProjId}`);
        } catch (snapErr) {
          console.error('[LRC] Failed to auto-save project snapshot:', snapErr);
        }
      }
    }

    broadcastMessage({
      action: 'PROGRESS_UPDATE',
      state: await getJobState()
    });

    if (wasPaused || isComplete) {
      break;
    }

    // Inter-keyword delay
    const delaySec = Math.max(5, Number(settings.delaySeconds) || 8);
    await debugLog(`[LRC] Waiting ${delaySec}s before next keyword...`);

    const delayRes = await waitForDelay(runId, delaySec * 1000);
    if (!delayRes.completed) {
      await debugLog(`[LRC] Inter-keyword delay ended: ${delayRes.reason}. Halting loop.`);
      break;
    }
  }
}

/**
 * Authoritative queue processor lifecycle manager (BUG 1 & DUPLICATE LOOPS FIX).
 * Guarantees at most ONE queue processor exists for a runId.
 * If an old processor is still shutting down (e.g. following PAUSE), waits for it
 * to completely exit, re-verifies storage state (runId matches, status is RUNNING,
 * queue is unfinished), and only then starts exactly one fresh queue loop.
 * 
 * @param {string} runId 
 * @returns {Promise<any>}
 */
async function ensureQueueRunning(runId) {
  // 1. If an existing processor loop is still running or shutting down, wait for it to fully finish
  while (activeQueuePromise) {
    const loopToWait = activeQueuePromise;
    await debugLog(`[LRC] ensureQueueRunning: Waiting for previous loop to finish before starting runId ${runId}...`);
    try {
      await loopToWait;
    } catch (_) {}

    // Guard against potential stale reference
    if (activeQueuePromise === loopToWait) {
      activeQueuePromise = null;
      activeRunId = null;
    }
  }

  // 2. Re-read storage
  const state = await getJobState();

  // 3. Verify state: must match runId, must be RUNNING, and must have unfinished work
  if (
    state.runId !== runId ||
    state.status !== 'RUNNING' ||
    !state.queue ||
    state.currentIndex >= state.queue.length
  ) {
    await debugLog(`[LRC] ensureQueueRunning: State changed or no remaining work (status=${state.status}, runId=${state.runId}). Not starting.`);
    return;
  }

  // 4. Double check if another processor started meanwhile (e.g. rapid double resume)
  if (activeQueuePromise && activeRunId === runId) {
    await debugLog(`[LRC] ensureQueueRunning: Processor already running for runId ${runId}.`);
    return activeQueuePromise;
  }

  // 5. Start exactly one new queue processor with local promise token
  let thisLoopPromise = null;
  thisLoopPromise = runQueueLoop(runId).finally(() => {
    // Only clear if this exact processor is still authoritative
    if (activeQueuePromise === thisLoopPromise) {
      activeQueuePromise = null;
      activeRunId = null;
    }
  });

  activeQueuePromise = thisLoopPromise;
  activeRunId = runId;

  await debugLog(`[LRC] ensureQueueRunning: Started fresh queue loop for runId ${runId}.`);
  return activeQueuePromise;
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
        const { queue, settings, projectId } = request;
        if (settings) {
          await saveSettings(settings);
        }

        // Validate location coordinates if location simulation is enabled
        if (settings && settings.useLocation) {
          const locVal = validateCoordinates(settings.latitude, settings.longitude, settings.accuracy);
          if (!locVal.valid) {
            sendResponse({
              success: false,
              error: locVal.error,
              message: `Location Error: ${locVal.error}`
            });
            return;
          }
        }

        const runId = generateRunId();

        const prefilledResults = (queue || []).map((item, idx) => ({
          id: item.id || `kw_${idx}`,
          originalIndex: idx,
          keyword: item.keyword,
          targetUrl: item.targetUrl,
          previousPosition: item.previousPosition ?? null,
          currentPosition: 'NOT CHECKED',
          displayPosition: 'NOT CHECKED',
          change: '—',
          matchStatus: 'NOT_CHECKED',
          status: 'NOT CHECKED',
          checkedDepth: 0,
          foundUrl: null,
          error: null,
          checkedAt: null
        }));

        const state = await saveJobState({
          runId: runId,
          status: 'RUNNING',
          projectId: projectId || null,
          queue: (queue || []).map((q, idx) => ({ ...q, originalIndex: idx })),
          currentIndex: 0,
          results: prefilledResults,
          currentKeyword: null,
          currentSerpOffset: 0,
          checkedDepth: 0,
          seenUrls: [],
          errorMessage: null
        });

        sendResponse({ success: true, state });
        ensureQueueRunning(runId);
        return;
      }

      if (request.action === 'RETRY_FAILED_JOB') {
        const currentState = await getJobState();

        if (!currentState.results || currentState.results.length === 0) {
          sendResponse({ success: false, message: 'No results to retry.' });
          return;
        }

        const failedItems = [];
        const currentResults = [...currentState.results];

        currentResults.forEach((res, idx) => {
          if (res && (res.status === 'ERROR' || res.matchStatus === 'ERROR')) {
            const origIdx = res.originalIndex !== undefined ? res.originalIndex : idx;
            failedItems.push({
              id: res.id || `kw_${origIdx}`,
              originalIndex: origIdx,
              keyword: res.keyword,
              targetUrl: res.targetUrl,
              previousPosition: res.previousPosition ?? null
            });
            currentResults[origIdx] = {
              ...res,
              status: 'NOT CHECKED',
              currentPosition: 'NOT CHECKED',
              displayPosition: 'NOT CHECKED',
              change: '—',
              error: null
            };
          }
        });

        if (failedItems.length === 0) {
          sendResponse({ success: false, message: 'No failed keywords found to retry.' });
          return;
        }

        const runId = generateRunId();
        const state = await saveJobState({
          runId: runId,
          status: 'RUNNING',
          queue: failedItems,
          currentIndex: 0,
          results: currentResults,
          currentKeyword: null,
          currentSerpOffset: 0,
          checkedDepth: 0,
          seenUrls: [],
          errorMessage: null
        });

        sendResponse({ success: true, state, retryingCount: failedItems.length });
        ensureQueueRunning(runId);
        return;
      }

      if (request.action === 'PAUSE_JOB') {
        const state = await saveJobState({ status: 'PAUSED' });
        sendResponse({ success: true, state });
        return;
      }

      if (request.action === 'RESUME_JOB') {
        const currentState = await getJobState();

        if (currentState.queue && currentState.currentIndex < currentState.queue.length &&
           (currentState.status === 'PAUSED' || currentState.status === 'BLOCKED')) {
          
          const resumeRunId = currentState.runId || generateRunId();

          const state = await saveJobState({
            runId: resumeRunId,
            status: 'RUNNING',
            errorMessage: null
          });

          sendResponse({ success: true, state });
          ensureQueueRunning(resumeRunId);
          return;
        }

        sendResponse({ success: false, message: 'Cannot resume: job not paused or queue already completed.' });
        return;
      }

      if (request.action === 'STOP_JOB') {
        // Invalidate runId to stop in-flight tasks immediately
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
      if (request.action === 'APPLY_LOCATION') {
        const loc = request.location || {};
        const validation = validateCoordinates(loc.latitude, loc.longitude, loc.accuracy);
        if (!validation.valid) {
          sendResponse({ success: false, error: validation.error });
          return;
        }

        await saveSettings({
          useLocation: true,
          latitude: String(validation.latitude),
          longitude: String(validation.longitude),
          accuracy: validation.accuracy,
          locationName: loc.locationName || ''
        });

        const state = await getJobState();
        let targetTabId = state.searchTabId;
        let tab = null;
        if (targetTabId) {
          try {
            tab = await chrome.tabs.get(targetTabId);
          } catch (_) {
            tab = null;
          }
        }

        const settings = await getSettings();
        if (tab) {
          try {
            await applyGeolocationOverride(tab.id, {
              latitude: validation.latitude,
              longitude: validation.longitude,
              accuracy: validation.accuracy,
              locationName: loc.locationName || ''
            }, settings.googleDomain || 'google.com');
            sendResponse({
              success: true,
              applied: true,
              tabId: tab.id,
              details: validation,
              message: `LOCATION: ACTIVE on tab ${tab.id}`
            });
            return;
          } catch (err) {
            sendResponse({ success: false, error: err.message });
            return;
          }
        } else {
          // Tab not created yet; save configured state truthfully
          await saveJobState({
            locationConfigured: true,
            locationApplied: false,
            locationState: LOCATION_STATES.CONFIGURED,
            locationTabId: null,
            locationDetails: {
              latitude: validation.latitude,
              longitude: validation.longitude,
              accuracy: validation.accuracy,
              locationName: loc.locationName || ''
            }
          });
          broadcastMessage({
            action: 'LOCATION_STATUS_UPDATE',
            status: LOCATION_STATES.CONFIGURED,
            details: {
              latitude: validation.latitude,
              longitude: validation.longitude,
              accuracy: validation.accuracy,
              locationName: loc.locationName || ''
            }
          });
          sendResponse({
            success: true,
            applied: false,
            configured: true,
            message: 'LOCATION: CONFIGURED — WILL APPLY WHEN RANK CHECK STARTS'
          });
          return;
        }
      }

      if (request.action === 'RESET_LOCATION') {
        await clearGeolocationOverride();
        await saveSettings({
          useLocation: false
        });
        sendResponse({ success: true });
        return;
      }

      if (request.action === 'TEST_LOCATION') {
        const loc = request.location || {};
        const validation = validateCoordinates(loc.latitude, loc.longitude, loc.accuracy);
        if (!validation.valid) {
          sendResponse({ success: false, error: validation.error });
          return;
        }

        const settings = await getSettings();
        const domain = settings.googleDomain || 'google.com';

        let testTab = null;
        let createdTempTab = false;

        try {
          const state = await getJobState();
          if (state.searchTabId) {
            try {
              testTab = await chrome.tabs.get(state.searchTabId);
            } catch (_) {}
          }

          if (!testTab) {
            testTab = await chrome.tabs.create({
              url: `https://www.${domain}`,
              active: false
            });
            createdTempTab = true;
            await new Promise(r => setTimeout(r, 2000));
          }

          // Attach debugger and set override
          await applyGeolocationOverride(testTab.id, validation, domain);

          // Evaluate navigator.geolocation via CDP Runtime.evaluate
          const evalResult = await sendDebuggerCommand({ tabId: testTab.id }, 'Runtime.evaluate', {
            expression: `new Promise((resolve) => {
              if (!navigator.geolocation) {
                return resolve({ supported: false, error: 'navigator.geolocation not available in this tab.' });
              }
              navigator.geolocation.getCurrentPosition(
                (pos) => resolve({
                  supported: true,
                  lat: pos.coords.latitude,
                  lon: pos.coords.longitude,
                  accuracy: pos.coords.accuracy
                }),
                (err) => resolve({
                  supported: true,
                  error: err.message || 'Position unavailable'
                }),
                { timeout: 7000, maximumAge: 0 }
              );
            })`,
            awaitPromise: true,
            returnByValue: true
          });

          const resValue = evalResult && evalResult.result ? evalResult.result.value : null;

          if (createdTempTab) {
            try {
              await detachDebugger({ tabId: testTab.id });
              await chrome.tabs.remove(testTab.id);
            } catch (_) {}
          }

          if (resValue && resValue.lat !== undefined && resValue.lon !== undefined) {
            const latDiff = Math.abs(resValue.lat - validation.latitude);
            const lonDiff = Math.abs(resValue.lon - validation.longitude);
            if (latDiff < 0.05 && lonDiff < 0.05) {
              sendResponse({
                success: true,
                verified: true,
                latitude: resValue.lat,
                longitude: resValue.lon,
                accuracy: resValue.accuracy,
                message: `Location Override Verified: ${resValue.lat}, ${resValue.lon}`
              });
              return;
            } else {
              sendResponse({
                success: true,
                verified: false,
                latitude: resValue.lat,
                longitude: resValue.lon,
                message: `Override set, but browser reported coordinates ${resValue.lat}, ${resValue.lon}`
              });
              return;
            }
          } else {
            sendResponse({
              success: false,
              error: resValue && resValue.error ? resValue.error : 'Location Override Failed: Geolocation request timed out or was blocked.'
            });
            return;
          }
        } catch (err) {
          if (createdTempTab && testTab) {
            try { await chrome.tabs.remove(testTab.id); } catch (_) {}
          }
          sendResponse({
            success: false,
            error: `Location Override Failed: ${err.message}`
          });
          return;
        }
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
      await saveJobState({ searchTabId: null, locationApplied: false, locationTabId: null });
    }
    if (activeDebuggerTabId === closedTabId) {
      activeDebuggerTabId = null;
      broadcastMessage({
        action: 'LOCATION_STATUS_UPDATE',
        status: 'NEEDS_REAPPLY'
      });
    }
  } catch (_) {}
});
