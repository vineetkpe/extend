/**
 * Device-only remembered coordinates. The user explicitly requested that
 * coordinates survive popup/dashboard switches and browser restarts until
 * Reset Location. No client names, sites, keywords or rank data are persisted.
 *
 * This is a last-used default, NEVER a confirmed Google ranking location.
 * Each project retains its own active-run/location setting in session storage;
 * we do not automatically enable geolocation for another client.
 */
import { validateCoordinates } from './locationValidator.js';

const KEY = 'serptrack_remembered_device_coordinates_v1';
// Draft contains only numeric coordinate text (never project/client identity).
// Unlike a verified pair it may contain just latitude while longitude is
// being copied; retain it through popup closure and browser restart.
const DRAFT_KEY = 'serptrack_coordinate_input_draft_v1';

function coordinateField(value, limit) {
  const text = String(value ?? '').trim();
  if (text.length > 24 || !/^-?(?:\d{0,3})(?:\.\d{0,14})?$/.test(text)) return null;
  if (text && text !== '-' && (Number.isNaN(Number(text)) ||
      Math.abs(Number(text)) > limit)) return null;
  return text;
}

export async function rememberCoordinateDraft(value) {
  const latitude = coordinateField(value?.latitude, 90);
  const longitude = coordinateField(value?.longitude, 180);
  const accuracy = String(value?.accuracy ?? '20').trim() || '20';
  if (latitude === null || longitude === null ||
      !/^\d{1,5}(?:\.\d{1,6})?$/.test(accuracy) || !(Number(accuracy) > 0)) {
    return { saved: false, error: 'Coordinate draft must contain only valid numeric fields.' };
  }
  const storage = localStore();
  if (!storage) return { saved: false, error: 'Local device storage is unavailable.' };
  await storage.set({ [DRAFT_KEY]: { latitude, longitude, accuracy } });
  return { saved: true };
}

export async function getRememberedCoordinateDraft() {
  const storage = localStore();
  if (!storage) return null;
  try {
    const draft = (await storage.get(DRAFT_KEY))?.[DRAFT_KEY];
    if (!draft) return null;
    const latitude = coordinateField(draft.latitude, 90);
    const longitude = coordinateField(draft.longitude, 180);
    const accuracy = String(draft.accuracy ?? '20');
    return latitude !== null && longitude !== null &&
      /^\d{1,5}(?:\.\d{1,6})?$/.test(accuracy) && Number(accuracy) > 0
      ? { latitude, longitude, accuracy } : null;
  } catch (error) {
    console.error('[Location preference] Could not read coordinate draft:', error);
    return null;
  }
}
export const REMEMBERED_COORDINATE_DRAFT_KEY = DRAFT_KEY;

function localStore() {
  return typeof chrome !== 'undefined' ? chrome.storage?.local : null;
}

export async function getRememberedCoordinates() {
  const storage = localStore();
  if (!storage) return null;
  try {
    const record = (await storage.get(KEY))?.[KEY];
    if (!record || typeof record !== 'object') return null;
    const validated = validateCoordinates(record.latitude, record.longitude, record.accuracy);
    return validated.valid ? {
      latitude: String(validated.latitude),
      longitude: String(validated.longitude),
      accuracy: validated.accuracy
    } : null;
  } catch (error) {
    console.error('[Location preference] Could not read local coordinates:', error);
    return null;
  }
}

export async function rememberCoordinates(value) {
  const validated = validateCoordinates(value?.latitude, value?.longitude, value?.accuracy);
  if (!validated.valid) return { saved: false, error: validated.error };
  const storage = localStore();
  if (!storage) return { saved: false, error: 'Local device storage is unavailable.' };
  const record = {
    latitude: validated.latitude,
    longitude: validated.longitude,
    accuracy: validated.accuracy
  };
  await storage.set({ [KEY]: record });
  return { saved: true, coordinates: record };
}

export async function forgetRememberedCoordinates() {
  const storage = localStore();
  if (storage) await storage.remove([KEY, DRAFT_KEY]);
}

export const REMEMBERED_COORDINATES_KEY = KEY;

/** Restore partial project edits before falling back to device-only defaults. */
export function getLocationForProject(projectConfig, remembered, draft = null) {
  const latitude = String(projectConfig?.latitude ?? '');
  const longitude = String(projectConfig?.longitude ?? '');
  const project = validateCoordinates(latitude, longitude, projectConfig?.accuracy);
  if (project.valid) {
    return {
      // Retain exactly what was typed in an edited draft, but preserve the
      // legacy normalized display for already-saved project coordinates.
      latitude: projectConfig?.locationDraftEdited ? latitude : String(project.latitude),
      longitude: projectConfig?.locationDraftEdited ? longitude : String(project.longitude),
      accuracy: project.accuracy, source: 'project'
    };
  }
  // Never replace a partly typed project coordinate with another client's
  // last complete pair; that could silently change the desired location.
  if (projectConfig?.locationDraftEdited || latitude.trim() || longitude.trim()) {
    return {
      latitude, longitude, accuracy: projectConfig?.accuracy ?? 20,
      source: 'project-draft'
    };
  }
  if (draft) return { ...draft, source: 'device-draft' };
  const lastUsed = validateCoordinates(
    remembered?.latitude, remembered?.longitude, remembered?.accuracy
  );
  return lastUsed.valid ? {
    latitude: String(lastUsed.latitude),
    longitude: String(lastUsed.longitude),
    accuracy: lastUsed.accuracy,
    source: 'device'
  } : { latitude: '', longitude: '', accuracy: 20, source: 'unset' };
}
