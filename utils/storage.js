/**
 * storage.js
 * Strict Privacy-First Storage Layer for SERPTrack.
 * 
 * Client SEO Data & Active Runtime:
 * - Persisted ONLY in chrome.storage.session (in-memory for current browser session).
 * - Disappears automatically when Chrome or browser session ends.
 * - Zero client data stored in chrome.storage.local.
 * - If chrome.storage.session is unavailable, fails closed (NO fallback to local storage).
 * 
 * Non-Client Settings:
 * - Stored in chrome.storage.local (whitelisted general tool preferences only).
 */

export const STORAGE_KEYS = {
  SETTINGS: 'lrc_settings',          // non-client preferences in chrome.storage.local
  INPUT_TEXT: 'lrc_input_text',      // temporary session text in chrome.storage.session
  JOB_STATE: 'lrc_job_state',        // runtime queue/results/jobSettings in chrome.storage.session
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

export const SESSION_STORAGE_UNAVAILABLE_ERROR =
  'Private session storage is not available in this browser version. Client data will not be stored. Please use a supported Chrome version.';

/**
 * Checks if chrome.storage.session is available in the current runtime environment.
 * @returns {boolean}
 */
export function isSessionStorageAvailable() {
  return typeof chrome !== 'undefined' &&
    Boolean(chrome.storage && chrome.storage.session);
}

/**
 * Returns session storage provider.
 * Strictly returns chrome.storage.session or null.
 * NEVER falls back to chrome.storage.local or any persistent storage.
 * @returns {chrome.storage.StorageArea|null}
 */
export function getSessionStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
    return chrome.storage.session;
  }
  return null;
}

/**
 * Asserts session storage availability or throws a fail-closed privacy error.
 * @returns {chrome.storage.StorageArea}
 */
export function assertSessionStorage() {
  const store = getSessionStorage();
  if (!store) {
    throw new Error(SESSION_STORAGE_UNAVAILABLE_ERROR);
  }
  return store;
}

/**
 * Returns local storage provider for non-client preferences.
 * @returns {chrome.storage.StorageArea|null}
 */
export function getLocalStorage() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return chrome.storage.local;
  }
  return null;
}

/**
 * Whitelist of allowed non-client preferences permitted in chrome.storage.local.
 * Client names, domains, keywords, URLs, coordinates, results, and history are strictly forbidden.
 */
export const ALLOWED_LOCAL_PREFS = [
  'googleDomain',
  'delaySeconds',
  'maxPosition',
  'debugMode',
  'defaultGoogleDomain',
  'defaultDelaySeconds',
  'defaultMaxPosition'
];

const ALLOWED_LOCAL_KEYS = new Set(ALLOWED_LOCAL_PREFS);

export const DEFAULT_PREFERENCES = {
  googleDomain: 'google.com',
  delaySeconds: 8,
  maxPosition: 50,
  debugMode: false
};

export const DEFAULT_SETTINGS = DEFAULT_PREFERENCES;

/**
 * Default immutable job configuration stored in runtimeState.jobSettings.
 */
export const DEFAULT_JOB_SETTINGS = {
  googleDomain: 'google.com',
  delaySeconds: 8,
  maxPosition: 50,
  debugMode: false,
  useLocation: false,
  latitude: '',
  longitude: '',
  accuracy: 20,
  locationName: ''
};

export const DEFAULT_JOB_STATE = {
  runId: null,
  activeProjectId: null,
  projectId: null,
  status: 'IDLE', // 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'BLOCKED' | 'COMPLETED'
  queue: [],
  currentIndex: 0,
  results: [],
  jobSettings: { ...DEFAULT_JOB_SETTINGS },
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
 * Retrieves non-client general preferences from chrome.storage.local.
 * @returns {Promise<object>}
 */
export async function getPreferences() {
  try {
    const store = getLocalStorage();
    if (!store) return { ...DEFAULT_PREFERENCES };
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
    return { ...DEFAULT_PREFERENCES, ...filtered };
  } catch (err) {
    console.error('[Storage] Error reading preferences:', err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Saves whitelisted non-client preferences to chrome.storage.local.
 * Strips any client or location data.
 * @param {object} prefs 
 * @returns {Promise<void>}
 */
export async function savePreferences(prefs) {
  try {
    const store = getLocalStorage();
    if (!store) return;
    const current = await getPreferences();
    const updated = { ...current };
    if (prefs && typeof prefs === 'object') {
      for (const [key, value] of Object.entries(prefs)) {
        if (ALLOWED_LOCAL_KEYS.has(key)) {
          updated[key] = value;
        }
      }
    }
    await store.set({ [STORAGE_KEYS.SETTINGS]: updated });
  } catch (err) {
    console.error('[Storage] Error saving preferences:', err);
  }
}

// Aliases for compatibility
export const getSettings = getPreferences;
export const saveSettings = savePreferences;

/**
 * Retrieves the session input textarea content from chrome.storage.session.
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
  const store = assertSessionStorage();
  await store.set({ [STORAGE_KEYS.INPUT_TEXT]: text });
}

/**
 * Retrieves the active runtime state from chrome.storage.session.
 * @returns {Promise<object>}
 */
export async function getRuntimeState() {
  try {
    const store = getSessionStorage();
    if (!store) return { ...DEFAULT_JOB_STATE };
    const data = await store.get(STORAGE_KEYS.JOB_STATE);
    const raw = data && data[STORAGE_KEYS.JOB_STATE];
    if (!raw) return { ...DEFAULT_JOB_STATE };
    return {
      ...DEFAULT_JOB_STATE,
      ...raw,
      jobSettings: {
        ...DEFAULT_JOB_SETTINGS,
        ...(raw.jobSettings || {})
      }
    };
  } catch (err) {
    console.error('[Storage] Error reading runtime state:', err);
    return { ...DEFAULT_JOB_STATE };
  }
}

/**
 * Saves or updates active runtime state in chrome.storage.session.
 * Preserves or merges jobSettings snapshot.
 * @param {object} stateUpdate 
 * @returns {Promise<object>} updated state
 */
export async function saveRuntimeState(stateUpdate) {
  const store = assertSessionStorage();
  const current = await getRuntimeState();
  const updated = {
    ...current,
    ...stateUpdate,
    jobSettings: stateUpdate && stateUpdate.jobSettings
      ? { ...DEFAULT_JOB_SETTINGS, ...stateUpdate.jobSettings }
      : (current.jobSettings ? { ...current.jobSettings } : { ...DEFAULT_JOB_SETTINGS }),
    lastUpdated: Date.now()
  };
  await store.set({ [STORAGE_KEYS.JOB_STATE]: updated });
  return updated;
}

// Aliases for compatibility
export const getJobState = getRuntimeState;
export const saveJobState = saveRuntimeState;

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
