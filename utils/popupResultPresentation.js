/**
 * Truthful state labels for the popup's preallocated ranking rows.
 * START_JOB fills every result slot with NOT CHECKED before any Google page
 * has been read. A pending or unverified result must never be shown as
 * "Not Found", since that falsely implies the target URL was checked.
 *
 * Pure UI presentation only: does not change matching or ranking evidence.
 */
export function describePopupResult(row) {
  const depth = Number.isSafeInteger(row?.checkedDepth) && row.checkedDepth > 0
    ? row.checkedDepth : 0;
  const pending = !row ||
    row.status === 'NOT CHECKED' ||
    row.matchStatus === 'NOT_CHECKED' ||
    row.currentPosition === 'NOT CHECKED' ||
    Boolean(row.__commitToken);

  if (pending) {
    return {
      kind: 'pending',
      rankText: 'NOT CHECKED',
      matchText: 'NOT CHECKED',
      statusText: 'NOT CHECKED',
      detail: 'Waiting for a verified Google result',
      badgeClass: 'badge-not-checked'
    };
  }

  if (row.status === 'ERROR' || row.matchStatus === 'ERROR' ||
      row.currentPosition === 'Error') {
    return {
      kind: 'error',
      rankText: 'ERROR',
      matchText: 'ERROR',
      statusText: 'ERROR',
      detail: row.error || 'Could not verify an organic ranking',
      badgeClass: 'badge-error'
    };
  }

  const exactRank = row.currentPosition;
  if (row.matchStatus === 'EXACT PAGE' && row.status === 'EXACT PAGE' &&
      Number.isSafeInteger(exactRank) && exactRank > 0 && depth >= exactRank) {
    return {
      kind: 'exact',
      rankText: String(exactRank),
      matchText: 'EXACT PAGE',
      statusText: 'EXACT PAGE',
      detail: 'Checked depth: ' + depth,
      badgeClass: 'badge-exact'
    };
  }

  if (row.status === 'TARGET PAGE NOT FOUND' &&
      row.currentPosition === 'Not Found' && depth > 0) {
    const otherPage = row.matchStatus === 'OTHER DOMAIN PAGE FOUND';
    return {
      kind: 'not-found',
      rankText: 'Not Found (Top ' + depth + ')',
      matchText: otherPage ? 'OTHER DOMAIN FOUND' : 'NOT FOUND',
      statusText: 'TARGET NOT FOUND',
      detail: otherPage
        ? 'Other page ranks at pos ' + (row.otherPagePosition || '?')
        : 'Checked ' + depth + ' organic results',
      detailTitle: otherPage ? row.otherPageFound || '' : '',
      badgeClass: otherPage ? 'badge-other-domain' : 'badge-not-found'
    };
  }

  // Contradictory or legacy incomplete data is never proof of a missing URL.
  return {
    kind: 'error',
    rankText: 'UNVERIFIED',
    matchText: 'UNVERIFIED',
    statusText: 'CHECK INCOMPLETE',
    detail: 'No verified ranking evidence. Recheck this keyword.',
    badgeClass: 'badge-error'
  };
}

export function countVerifiedPopupResults(results) {
  if (!Array.isArray(results)) return 0;
  return results.filter(row => {
    const kind = describePopupResult(row).kind;
    return kind === 'exact' || kind === 'not-found';
  }).length;
}
