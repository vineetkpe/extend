/**
 * Safe reconciliation of an interrupted Manifest V3 background service worker.
 * Client job data stays exclusively in chrome.storage.session.
 *
 * This intentionally does NOT restart a job automatically. Chrome can terminate
 * a worker between SERP extraction and result commit; the in-flight keyword must
 * be rechecked after the user explicitly resumes the queue.
 */
import { LOCATION_STATES } from './storage.js';

export const WORKER_RESTART_MESSAGE =
  'The background worker restarted during rank checking. Completed keywords were preserved. Resume to recheck the interrupted keyword.';

export const WORKER_RESTART_INVALID_MESSAGE =
  'The background worker restarted, but the saved queue is incomplete. Please clear the job and start a new check.';

/**
 * Return a storage patch when a persisted RUNNING job was abandoned by a prior
 * service worker instance; return null for every other status.
 *
 * Provisional location-check results carry __commitToken. Those results were
 * written before two-phase location verification finished and are NOT trusted.
 */
export function getWorkerRestartPatch(state) {
  if (!state || state.status !== 'RUNNING') return null;

  const queue = Array.isArray(state.queue) ? state.queue : [];
  const index = state.currentIndex;
  const hasPendingKeyword = typeof state.runId === 'string' && Boolean(state.runId) &&
    Number.isInteger(index) && index >= 0 && index < queue.length;

  const patch = {
    status: hasPendingKeyword ? 'PAUSED' : 'ERROR',
    errorMessage: hasPendingKeyword ? WORKER_RESTART_MESSAGE : WORKER_RESTART_INVALID_MESSAGE,
    lastError: hasPendingKeyword ? WORKER_RESTART_MESSAGE : WORKER_RESTART_INVALID_MESSAGE,
    currentKeyword: null,
    currentSerpOffset: 0,
    checkedDepth: 0,
    seenUrls: []
  };

  if (Array.isArray(state.results)) {
    let changed = false;
    const safeResults = state.results.map(result => {
      if (!result || typeof result !== 'object' ||
          !Object.prototype.hasOwnProperty.call(result, '__commitToken')) {
        return result;
      }

      changed = true;
      // Do not present this unverified candidate as a checked/ranked result.
      const { __commitToken, __runId, __keywordIndex, commitToken, commitRunId, committed, ...safe } = result;
      return {
        ...safe,
        currentPosition: 'NOT CHECKED',
        displayPosition: 'NOT CHECKED',
        change: '—',
        matchStatus: 'NOT_CHECKED',
        status: 'NOT CHECKED',
        checkedDepth: 0,
        foundUrl: null,
        otherPageFound: null,
        otherPagePosition: null,
        error: null,
        checkedAt: null
      };
    });
    if (changed) patch.results = safeResults;
  }

  // An old debugger attachment and location fingerprint cannot be trusted
  // after the service-worker memory was discarded.
  if (state.jobSettings?.useLocation) {
    patch.locationApplied = false;
    patch.locationState = LOCATION_STATES.NEEDS_REAPPLY;
    patch.locationTabId = null;
    patch.appliedLocation = null;
  }

  return patch;
}

export async function reconcileWorkerRestart(readState, saveState) {
  const state = await readState();
  const patch = getWorkerRestartPatch(state);
  if (!patch) return null;
  return saveState(patch);
}
