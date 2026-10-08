/**
 * Private per-project keyword drafts, kept exclusively in chrome.storage.session.
 * A single global input_text key can leak one client's paste into another
 * project after a popup/dashboard switch. The project ID isolates each draft.
 */
import { requireSessionStorage } from './storage.js';

const PREFIX = 'serptrack_input_draft_v1_';
const MAX_LENGTH = 100_000;

function key(projectId) {
  if (typeof projectId !== 'string' || !projectId ||
      projectId.length > 150 || /[\x00-\x1f]/.test(projectId)) {
    throw new Error('A valid project is required for keyword drafts.');
  }
  return PREFIX + projectId;
}

export async function getProjectInputDraft(projectId) {
  const store = requireSessionStorage();
  const id = key(projectId);
  const result = await store.get(id);
  return typeof result?.[id] === 'string' ? result[id] : null;
}

export async function saveProjectInputDraft(projectId, text) {
  const store = requireSessionStorage();
  const id = key(projectId);
  if (typeof text !== 'string' || text.length > MAX_LENGTH) {
    throw new Error('Keyword draft must be text under 100,000 characters.');
  }
  await store.set({ [id]: text });
}

export async function clearProjectInputDraft(projectId) {
  await requireSessionStorage().remove(key(projectId));
}

export function formatSavedKeywordRows(keywords) {
  if (!Array.isArray(keywords)) return '';
  return keywords.map(kw =>
    [String(kw.keyword ?? ''), String(kw.targetUrl ?? ''),
     kw.previousPosition === undefined || kw.previousPosition === null ||
     kw.previousPosition === '-' ? '' : String(kw.previousPosition)].join('\t')
  ).join('\n');
}
