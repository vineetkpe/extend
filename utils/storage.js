/**
 * storage.js
 * Strict Privacy-First Storage Layer for SERPTrack.
 * 
 * Client SEO Data & Active Runtime:
 * - Persisted ONLY in chrome.storage.session (in-memory for current browser session).
 * - Disappears automatically when Chrome or browser session ends.
 * - Zero client data stored in chrome.storage.local.
 * 
 * Non-Client Settings:
 * - Stored in chrome.storage.local (whitelisted general tool preferences only).
 */

export const STORAGE_KEYS = {
  SETTINGS: 'lrc_settings',          // non-client preferences in chrome.storage.local
  INPUT_TEXT: 'lrc_input_text',      // temporary session text in chrome.storage.session
  JOB_STATE: 'lrc_job_state',        // runtime queue/results in chrome.storage.session
  RESULTS: 'lrc_results',            // runtime results in chrome.storage.session
  PROJECTS: 'lrc_projects',          // session projects in chrome.storage.session
  ACTIVE_PROJECT_ID: 'lrc_active_project_id' // session active project in chrome.storage.session
};

export const LOCATION_STATES = {
  NOT_CONFIGURED: 'NOT CONFIGURED',
  CONFIGURED: 'CONFIGURED',
  APPLYING: 'APPLYING',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED',
  NEEDS_REAPPLY: 'NEEDS REAPPLY'
};

/**
 * Whitelist of allowed non-client preferences permitted in chrome.storage.local.
 * Client names, domains, keywords, URLs, coordinates, results, and history are strictly forbidden.
 */
const ALLOWED_LOCAL_KEYS = new Set([
  'googleDomain',
  'delaySeconds',
  'maxPosition',
  'debugMode'
]);

const DEFAULT_SETTINGS = {
  googleDomain: 'google.com',
  delaySeconds: 8,
  maxPosition: 50,
  debugMode: false
};

const DEFAULT_JOB_STATE = {
  runId: null,
  activeProjectId: null,
  projectId: null,
  status: 'IDLE', // 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'BLOCKED' | 'COMPLETED'
  queue: [],
  currentIndex: 0,
  results: [],
  searchTabId: null,
  currentKeyword: null,
  currentSerpOffset: 0,
  checkedDepth: 0,
  seenUrls: [],
  lastError: null,
  errorMessage: null,
  lastUpdated: null,
  locationConfigured: false,
  locationApplied: false,
  locationState: 'NOT CONFIGURED',
  locationTabId: null,
  locationError: null,
  appliedLocation: null,
  locationDetails: null
};

/**
 * Returns session storage provider with fallback for test mock environments.
 */
export function getSessionStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    return chrome.storage.session;
  }
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return null;
}

/**
 * Returns local storage provider for non-client preferences.
 */
export function getLocalStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return null;
}

/**
 * Retrieves non-client settings from local storage.
 * @returns {Promise<object>}
 */
export async function getSettings() {
  try {
    const store = getLocalStorage();
    if (!store) return { ...DEFAULT_SETTINGS };
    const data = await store.get(STORAGE_KEYS.SETTINGS);
    const raw = data ? data[STORAGE_KEYS.SETTINGS] : null;
    const filtered = {};
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        if (ALLOWED_LOCAL_KEYS.has(key)) {
          filtered[key] = raw[key];
        }
      }
    }
    return { ...DEFAULT_SETTINGS, ...filtered };
  } catch (err) {
    console.error('[Storage] Error reading settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves whitelisted non-client settings to local storage.
 * Strips any accidental client or location data.
 * @param {object} settings 
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  try {
    const store = getLocalStorage();
    if (!store) return;
    const current = await getSettings();
    const updated = { ...current };
    if (settings && typeof settings === 'object') {
      for (const [key, value] of Object.entries(settings)) {
        if (ALLOWED_LOCAL_KEYS.has(key)) {
          updated[key] = value;
        }
      }
    }
    await store.set({ [STORAGE_KEYS.SETTINGS]: updated });
  } catch (err) {
    console.error('[Storage] Error saving settings:', err);
  }
}

/**
 * Retrieves the session input textarea content.
 * @returns {Promise<string>}
 */
export async function getInputText() {
  try {
    const store = getSessionStorage();
    if (!store) return '';
    const data = await store.get(STORAGE_KEYS.INPUT_TEXT);
    return (data && data[STORAGE_KEYS.INPUT_TEXT]) || '';
  } catch (err) {
    console.error('[Storage] Error reading input text:', err);
    return '';
  }
}

/**
 * Saves the session input textarea content in chrome.storage.session.
 * @param {string} text 
 * @returns {Promise<void>}
 */
export async function saveInputText(text) {
  try {
    const store = getSessionStorage();
    if (!store) return;
    await store.set({ [STORAGE_KEYS.INPUT_TEXT]: text });
  } catch (err) {
    console.error('[Storage] Error saving input text:', err);
  }
}

/**
 * Retrieves the active job state from chrome.storage.session.
 * @returns {Promise<object>}
 */
export async function getJobState() {
  try {
    const store = getSessionStorage();
    if (!store) return { ...DEFAULT_JOB_STATE };
    const data = await store.get(STORAGE_KEYS.JOB_STATE);
    return { ...DEFAULT_JOB_STATE, ...(data && data[STORAGE_KEYS.JOB_STATE] ? data[STORAGE_KEYS.JOB_STATE] : {}) };
  } catch (err) {
    console.error('[Storage] Error reading job state:', err);
    return { ...DEFAULT_JOB_STATE };
  }
}

/**
 * Saves or updates active job state in chrome.storage.session.
 * @param {object} stateUpdate 
 * @returns {Promise<object>} updated state
 */
export async function saveJobState(stateUpdate) {
  try {
    const store = getSessionStorage();
    const current = await getJobState();
    const updated = {
      ...current,
      ...stateUpdate,
      lastUpdated: Date.now()
    };
    if (store) {
      await store.set({ [STORAGE_KEYS.JOB_STATE]: updated });
    }
    return updated;
  } catch (err) {
    console.error('[Storage] Error saving job state:', err);
    return { ...DEFAULT_JOB_STATE, ...stateUpdate };
  }
}

/**
 * Resets the session job state to IDLE and clears results.
 * @returns {Promise<void>}
 */
export async function resetJobState() {
  try {
    const store = getSessionStorage();
    if (!store) return;
    await store.set({
      [STORAGE_KEYS.JOB_STATE]: {
        ...DEFAULT_JOB_STATE,
        lastUpdated: Date.now()
      }
    });
  } catch (err) {
    console.error('[Storage] Error resetting job state:', err);
  }
}

/**
 * Clears active job data in chrome.storage.session.
 * @returns {Promise<void>}
 */
export async function clearAllJobData() {
  try {
    const store = getSessionStorage();
    if (!store) return;
    await store.remove([
      STORAGE_KEYS.INPUT_TEXT,
      STORAGE_KEYS.JOB_STATE,
      STORAGE_KEYS.RESULTS
    ]);
  } catch (err) {
    console.error('[Storage] Error clearing job data:', err);
  }
}

/**
 * Wipes ALL session storage data (projects, keywords, results, queues).
 * Leaves harmless local settings untouched.
 * @returns {Promise<void>}
 */
export async function clearSessionData() {
  try {
    const store = getSessionStorage();
    if (!store) return;
    if (typeof store.clear === 'function') {
      await store.clear();
    } else {
      await store.remove([
        STORAGE_KEYS.INPUT_TEXT,
        STORAGE_KEYS.JOB_STATE,
        STORAGE_KEYS.RESULTS,
        STORAGE_KEYS.PROJECTS,
        STORAGE_KEYS.ACTIVE_PROJECT_ID
      ]);
    }
  } catch (err) {
    console.error('[Storage] Error clearing session data:', err);
  }
}
