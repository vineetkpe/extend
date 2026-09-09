/**
 * storage.js
 * Wrapper around chrome.storage.local for persisting extension state,
 * keyword queues, settings, and ranking results.
 */

const STORAGE_KEYS = {
  SETTINGS: 'lrc_settings',
  INPUT_TEXT: 'lrc_input_text',
  JOB_STATE: 'lrc_job_state',
  RESULTS: 'lrc_results'
};

const DEFAULT_SETTINGS = {
  googleDomain: 'google.com',
  delaySeconds: 8,
  maxPosition: 100,
  debugMode: false
};

const DEFAULT_JOB_STATE = {
  status: 'IDLE', // 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'BLOCKED' | 'COMPLETED'
  queue: [],
  currentIndex: 0,
  results: [],
  searchTabId: null,
  errorMessage: null,
  lastUpdated: null
};

/**
 * Retrieves settings from storage with defaults.
 * @returns {Promise<object>}
 */
export async function getSettings() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
  } catch (err) {
    console.error('[Storage] Error reading settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves settings to storage.
 * @param {object} settings 
 * @returns {Promise<void>}
 */
export async function saveSettings(settings) {
  try {
    const current = await getSettings();
    const updated = { ...current, ...settings };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
  } catch (err) {
    console.error('[Storage] Error saving settings:', err);
  }
}

/**
 * Retrieves the saved input textarea content.
 * @returns {Promise<string>}
 */
export async function getInputText() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.INPUT_TEXT);
    return data[STORAGE_KEYS.INPUT_TEXT] || '';
  } catch (err) {
    console.error('[Storage] Error reading input text:', err);
    return '';
  }
}

/**
 * Saves the input textarea content.
 * @param {string} text 
 * @returns {Promise<void>}
 */
export async function saveInputText(text) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.INPUT_TEXT]: text });
  } catch (err) {
    console.error('[Storage] Error saving input text:', err);
  }
}

/**
 * Retrieves the current job state.
 * @returns {Promise<object>}
 */
export async function getJobState() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.JOB_STATE);
    return { ...DEFAULT_JOB_STATE, ...(data[STORAGE_KEYS.JOB_STATE] || {}) };
  } catch (err) {
    console.error('[Storage] Error reading job state:', err);
    return { ...DEFAULT_JOB_STATE };
  }
}

/**
 * Saves or updates job state.
 * @param {object} stateUpdate 
 * @returns {Promise<object>} updated state
 */
export async function saveJobState(stateUpdate) {
  try {
    const current = await getJobState();
    const updated = {
      ...current,
      ...stateUpdate,
      lastUpdated: Date.now()
    };
    await chrome.storage.local.set({ [STORAGE_KEYS.JOB_STATE]: updated });
    return updated;
  } catch (err) {
    console.error('[Storage] Error saving job state:', err);
    return { ...DEFAULT_JOB_STATE, ...stateUpdate };
  }
}

/**
 * Resets the job state to IDLE and clears results.
 * Preserves user settings.
 * @returns {Promise<void>}
 */
export async function resetJobState() {
  try {
    await chrome.storage.local.set({
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
 * Clears everything including input text, queue, results, and state.
 * Keeps settings.
 * @returns {Promise<void>}
 */
export async function clearAllJobData() {
  try {
    await chrome.storage.local.remove([
      STORAGE_KEYS.INPUT_TEXT,
      STORAGE_KEYS.JOB_STATE,
      STORAGE_KEYS.RESULTS
    ]);
  } catch (err) {
    console.error('[Storage] Error clearing job data:', err);
  }
}
