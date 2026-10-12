/**
 * Baselines must only come from a finished, attributable rank-check run.
 * Calling this again with a captured run ID prevents a stale confirmation
 * dialog from promoting results from a newer or still-running check.
 */
export function canPromoteBaseline(jobState, project, expectedRunId) {
  const projectIds = [project?.id, project?.config?.projectId].filter(Boolean);
  if (!projectIds.length ||
      jobState?.status !== 'COMPLETED' ||
      !Array.isArray(jobState.results) ||
      jobState.results.length === 0 ||
      !projectIds.includes(jobState.projectId)) {
    return false;
  }
  return expectedRunId === undefined || jobState.runId === expectedRunId;
}
