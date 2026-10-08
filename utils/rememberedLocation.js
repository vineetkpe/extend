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
  if (storage) await storage.remove(KEY);
}

export const REMEMBERED_COORDINATES_KEY = KEY;

/** Use project coordinates when valid; otherwise show remembered device defaults. */
export function getLocationForProject(projectConfig, remembered) {
  const project = validateCoordinates(
    projectConfig?.latitude, projectConfig?.longitude, projectConfig?.accuracy
  );
  if (project.valid) {
    return {
      latitude: String(project.latitude),
      longitude: String(project.longitude),
      accuracy: project.accuracy,
      source: 'project'
    };
  }
  const lastUsed = validateCoordinates(
    remembered?.latitude, remembered?.longitude, remembered?.accuracy
  );
  return lastUsed.valid ? {
    latitude: String(lastUsed.latitude),
    longitude: String(lastUsed.longitude),
    accuracy: lastUsed.accuracy,
    source: 'device'
  } : {
    latitude: String(projectConfig?.latitude ?? ''),
    longitude: String(projectConfig?.longitude ?? ''),
    accuracy: Number(projectConfig?.accuracy) || 20,
    source: 'unset'
  };
}
