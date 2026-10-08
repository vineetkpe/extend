/**
 * Strict batch-admission and failed-keyword retry planner.
 * These functions are intentionally pure so queue integrity can be tested
 * without running the Chrome service worker.
 */
const NON_REPLACEABLE_STATUSES = new Set(['RUNNING', 'PAUSED', 'BLOCKED']);

export function mayStartNewJob(state) {
  return !NON_REPLACEABLE_STATUSES.has(state?.status);
}

export function mayRetryFailedJob(state) {
  // A partial, paused, blocked or stopped queue must not be discarded.
  return state?.status === 'COMPLETED' && Array.isArray(state.results);
}

export function makeFailedRetryPlan(state) {
  if (!mayRetryFailedJob(state)) {
    return { allowed: false, error: 'Finish the current job before retrying failed keywords.' };
  }
  const nextResults = [...state.results];
  const queue = [];

  state.results.forEach((result, index) => {
    if (!result || (result.status !== 'ERROR' && result.matchStatus !== 'ERROR')) return;
    if (typeof result.keyword !== 'string' || !result.keyword.trim() ||
        typeof result.targetUrl !== 'string' || !result.targetUrl.trim()) return;

    // Results are stored in original spreadsheet order, not retry queue order.
    // The array index is authoritative even when a legacy result has bad metadata.
    queue.push({
      id: result.id || `kw_${index}`,
      originalIndex: index,
      keyword: result.keyword,
      targetUrl: result.targetUrl,
      previousPosition: result.previousPosition ?? null
    });
    nextResults[index] = {
      ...result,
      originalIndex: index,
      status: 'NOT CHECKED',
      matchStatus: 'NOT_CHECKED',
      currentPosition: 'NOT CHECKED',
      displayPosition: 'NOT CHECKED',
      change: '—',
      checkedDepth: 0,
      foundUrl: null,
      otherPageFound: null,
      otherPagePosition: null,
      checkedAt: null,
      error: null
    };
  });

  return queue.length
    ? { allowed: true, queue, results: nextResults }
    : { allowed: false, error: 'No failed keywords found to retry.' };
}
