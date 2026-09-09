/**
 * projectManager.js
 * Session Project Management System for SERPTrack.
 * 
 * Strict Privacy-First Architecture:
 * - Projects, keywords, and queues reside strictly in chrome.storage.session.
 * - Client SEO data disappears automatically when the browser session ends.
 * - Automatic persistent snapshot history is removed.
 * - Export generates a local JSON file on the user's computer.
 * - Import parses JSON with prototype-pollution guards and strict schema/URL validation.
 */

import { STORAGE_KEYS, getSessionStorage, requireSessionStorage, SESSION_STORAGE_UNAVAILABLE_ERROR } from './storage.js';
import { isValidUrlOrDomain } from './parser.js';
import { validateCoordinates } from './locationValidator.js';

const DEFAULT_PROJECT_ID = 'default_project';

const DEFAULT_PROJECT = {
  config: {
    projectId: DEFAULT_PROJECT_ID,
    projectName: 'Default Client',
    domain: '',
    googleDomain: 'google.com',
    useLocation: false,
    latitude: '',
    longitude: '',
    accuracy: 20,
    locationName: '',
    defaultDelaySeconds: 8,
    defaultMaxDepth: 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  keywords: []
};

/**
 * Checks recursively for prototype pollution keys in parsed JSON.
 * @param {*} val
 * @returns {boolean} true if forbidden keys exist
 */
export function hasPrototypePollutionKeys(val) {
  if (!val || typeof val !== 'object') return false;
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    return true;
  }
  for (const key of Object.getOwnPropertyNames(val)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return true;
    }
    if (typeof val[key] === 'object' && val[key] !== null) {
      if (hasPrototypePollutionKeys(val[key])) return true;
    }
  }
  return false;
}

/**
 * Validates a target URL against dangerous protocol schemes.
 * Only http: and https: protocols are permitted.
 * @param {string} urlStr 
 * @returns {boolean}
 */
export function isSafeTargetUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  if (/^(javascript|data|file|chrome|chrome-extension|about|blob|vbscript):/i.test(trimmed)) {
    return false;
  }
  return isValidUrlOrDomain(trimmed);
}

/**
 * Retrieves all projects from session storage. Initializes default session project if empty.
 * Fails closed if session storage is unavailable.
 * @returns {Promise<Object<string, object>>}
 */
export async function getProjects() {
  const store = requireSessionStorage();

  const data = await store.get(STORAGE_KEYS.PROJECTS);
  let projects = data ? data[STORAGE_KEYS.PROJECTS] : null;

  if (!projects || typeof projects !== 'object' || Object.keys(projects).length === 0) {
    projects = { [DEFAULT_PROJECT_ID]: { ...DEFAULT_PROJECT } };
    await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
  }

  // Ensure all projects have consistent properties
  Object.keys(projects).forEach(pId => {
    if (projects[pId] && projects[pId].config) {
      projects[pId].id = pId;
      projects[pId].projectId = pId;
    }
  });

  return projects;
}

/**
 * Saves projects map directly to session storage.
 * @param {Object<string, object>} projects
 * @returns {Promise<Object<string, object>>}
 */
export async function saveProjects(projects) {
  const store = requireSessionStorage();
  await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
  return projects;
}

/**
 * Retrieves the currently active project ID from session storage.
 * @returns {Promise<string>}
 */
export async function getActiveProjectId() {
  const store = requireSessionStorage();
  const data = await store.get(STORAGE_KEYS.ACTIVE_PROJECT_ID);
  return (data && data[STORAGE_KEYS.ACTIVE_PROJECT_ID]) || DEFAULT_PROJECT_ID;
}

/**
 * Sets the active project ID in session storage.
 * @param {string} projectId 
 * @returns {Promise<void>}
 */
export async function setActiveProjectId(projectId) {
  const store = requireSessionStorage();
  await store.set({ [STORAGE_KEYS.ACTIVE_PROJECT_ID]: projectId });
}

export const setActiveProject = setActiveProjectId;

/**
 * Retrieves the active project object from session storage.
 * @returns {Promise<object>}
 */
export async function getActiveProject() {
  const projects = await getProjects();
  let activeId = await getActiveProjectId();
  if (!projects[activeId]) {
    activeId = Object.keys(projects)[0] || DEFAULT_PROJECT_ID;
    await setActiveProjectId(activeId);
  }
  const proj = projects[activeId] || DEFAULT_PROJECT;
  const cfg = proj.config || proj;

  return {
    ...proj,
    id: activeId,
    projectId: activeId,
    projectName: cfg.projectName || 'Default Client',
    domain: cfg.domain || '',
    googleDomain: cfg.googleDomain || 'google.com',
    useLocation: Boolean(cfg.useLocation),
    locationName: cfg.locationName || '',
    latitude: cfg.latitude || '',
    longitude: cfg.longitude || '',
    accuracy: cfg.accuracy !== undefined ? cfg.accuracy : 20,
    defaultDelaySeconds: cfg.defaultDelaySeconds || 8,
    defaultMaxDepth: cfg.defaultMaxDepth || 50,
    project: proj,
    activeProjectId: activeId,
    projects
  };
}

/**
 * Creates a new project in session storage and sets it active.
 * Reliably stores all location parameters.
 * @param {object} projectData
 * @returns {Promise<object>} created project
 */
export async function createProject(projectData) {
  const store = requireSessionStorage();
  const projects = await getProjects();
  const projectId = 'proj_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const cfg = {
    projectId,
    projectName: String(projectData.projectName || 'New Project').trim(),
    domain: String(projectData.domain || '').trim(),
    googleDomain: projectData.googleDomain || 'google.com',
    useLocation: Boolean(projectData.useLocation),
    locationName: String(projectData.locationName || '').trim(),
    latitude: projectData.latitude !== undefined && projectData.latitude !== null ? String(projectData.latitude).trim() : '',
    longitude: projectData.longitude !== undefined && projectData.longitude !== null ? String(projectData.longitude).trim() : '',
    accuracy: Number(projectData.accuracy) || 20,
    defaultDelaySeconds: Math.max(5, Number(projectData.defaultDelaySeconds) || 8),
    defaultMaxDepth: Number(projectData.defaultMaxDepth) || 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const newProject = {
    id: projectId,
    projectId,
    projectName: cfg.projectName,
    domain: cfg.domain,
    googleDomain: cfg.googleDomain,
    useLocation: cfg.useLocation,
    locationName: cfg.locationName,
    latitude: cfg.latitude,
    longitude: cfg.longitude,
    accuracy: cfg.accuracy,
    defaultDelaySeconds: cfg.defaultDelaySeconds,
    defaultMaxDepth: cfg.defaultMaxDepth,
    config: cfg,
    keywords: Array.isArray(projectData.keywords) ? projectData.keywords : []
  };

  projects[projectId] = newProject;
  await store.set({
    [STORAGE_KEYS.PROJECTS]: projects,
    [STORAGE_KEYS.ACTIVE_PROJECT_ID]: projectId
  });

  return newProject;
}

/**
 * Retrieves a single project by ID from session storage.
 * @param {string} projectId 
 * @returns {Promise<object|null>}
 */
export async function getProjectById(projectId) {
  const projects = await getProjects();
  const proj = projects[projectId];
  if (!proj) return null;
  const cfg = proj.config || proj;

  return {
    ...proj,
    id: projectId,
    projectId,
    projectName: cfg.projectName || '',
    domain: cfg.domain || '',
    googleDomain: cfg.googleDomain || 'google.com',
    useLocation: cfg.useLocation !== undefined ? Boolean(cfg.useLocation) : false,
    locationName: cfg.locationName || '',
    latitude: cfg.latitude || '',
    longitude: cfg.longitude || '',
    accuracy: cfg.accuracy !== undefined ? cfg.accuracy : 20,
    defaultDelaySeconds: cfg.defaultDelaySeconds || 8,
    defaultMaxDepth: cfg.defaultMaxDepth || 50,
    config: cfg
  };
}

/**
 * Saves or updates a project in session storage.
 * Reliably stores per-project location fields.
 * @param {object} project 
 * @returns {Promise<void>}
 */
export async function saveProject(project) {
  const pId = project.id || project.projectId || project.config?.projectId;
  if (!pId) return;
  const store = requireSessionStorage();
  const projects = await getProjects();
  const existing = projects[pId] || { config: {}, keywords: [] };

  const existingCfg = existing.config || {};
  const incomingCfg = project.config || {};

  const updatedConfig = {
    ...existingCfg,
    ...incomingCfg,
    projectId: pId,
    projectName: project.projectName !== undefined ? project.projectName : (incomingCfg.projectName !== undefined ? incomingCfg.projectName : existingCfg.projectName || ''),
    domain: project.domain !== undefined ? project.domain : (incomingCfg.domain !== undefined ? incomingCfg.domain : existingCfg.domain || ''),
    googleDomain: project.googleDomain || incomingCfg.googleDomain || existingCfg.googleDomain || 'google.com',
    useLocation: project.useLocation !== undefined ? Boolean(project.useLocation) : (incomingCfg.useLocation !== undefined ? Boolean(incomingCfg.useLocation) : Boolean(existingCfg.useLocation)),
    locationName: project.locationName !== undefined ? project.locationName : (incomingCfg.locationName !== undefined ? incomingCfg.locationName : existingCfg.locationName || ''),
    latitude: project.latitude !== undefined ? String(project.latitude).trim() : (incomingCfg.latitude !== undefined ? String(incomingCfg.latitude).trim() : (existingCfg.latitude || '')),
    longitude: project.longitude !== undefined ? String(project.longitude).trim() : (incomingCfg.longitude !== undefined ? String(incomingCfg.longitude).trim() : (existingCfg.longitude || '')),
    accuracy: project.accuracy !== undefined ? Number(project.accuracy) : (incomingCfg.accuracy !== undefined ? Number(incomingCfg.accuracy) : (existingCfg.accuracy || 20)),
    defaultDelaySeconds: project.defaultDelaySeconds || incomingCfg.defaultDelaySeconds || existingCfg.defaultDelaySeconds || 8,
    defaultMaxDepth: project.defaultMaxDepth || incomingCfg.defaultMaxDepth || existingCfg.defaultMaxDepth || 50,
    updatedAt: new Date().toISOString()
  };

  projects[pId] = {
    ...existing,
    ...project,
    id: pId,
    projectId: pId,
    projectName: updatedConfig.projectName,
    domain: updatedConfig.domain,
    googleDomain: updatedConfig.googleDomain,
    useLocation: updatedConfig.useLocation,
    locationName: updatedConfig.locationName,
    latitude: updatedConfig.latitude,
    longitude: updatedConfig.longitude,
    accuracy: updatedConfig.accuracy,
    defaultDelaySeconds: updatedConfig.defaultDelaySeconds,
    defaultMaxDepth: updatedConfig.defaultMaxDepth,
    config: updatedConfig,
    keywords: project.keywords !== undefined ? project.keywords : (existing.keywords || [])
  };

  await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
}

/**
 * Updates an existing project's configuration in session storage.
 * @param {string} projectId 
 * @param {object} configUpdates 
 * @returns {Promise<object>} updated project
 */
export async function updateProject(projectId, configUpdates) {
  const store = requireSessionStorage();
  const projects = await getProjects();
  if (!projects[projectId]) {
    throw new Error(`Project ${projectId} not found.`);
  }

  const existingConfig = projects[projectId].config || {};
  const mergedConfig = {
    ...existingConfig,
    ...configUpdates,
    updatedAt: new Date().toISOString()
  };

  projects[projectId].config = mergedConfig;
  projects[projectId].projectName = mergedConfig.projectName;
  projects[projectId].domain = mergedConfig.domain;
  projects[projectId].googleDomain = mergedConfig.googleDomain;
  projects[projectId].useLocation = Boolean(mergedConfig.useLocation);
  projects[projectId].locationName = mergedConfig.locationName || '';
  projects[projectId].latitude = mergedConfig.latitude || '';
  projects[projectId].longitude = mergedConfig.longitude || '';
  projects[projectId].accuracy = mergedConfig.accuracy !== undefined ? mergedConfig.accuracy : 20;
  projects[projectId].defaultDelaySeconds = mergedConfig.defaultDelaySeconds;
  projects[projectId].defaultMaxDepth = mergedConfig.defaultMaxDepth;

  await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
  return projects[projectId];
}

/**
 * Deletes a project from session storage. Fails if only 1 project remains.
 * @param {string} projectId 
 * @returns {Promise<{ success: boolean, newActiveId?: string }>}
 */
export async function deleteProject(projectId) {
  const store = requireSessionStorage();
  const projects = await getProjects();
  const keys = Object.keys(projects);
  if (keys.length <= 1) {
    throw new Error('Cannot delete the only remaining project.');
  }

  delete projects[projectId];
  let activeId = await getActiveProjectId();
  if (activeId === projectId) {
    activeId = Object.keys(projects)[0];
    await setActiveProjectId(activeId);
  }

  await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
  return { success: true, newActiveId: activeId };
}

/**
 * Retrieves keyword rows for a project.
 * @param {string} projectId 
 * @returns {Promise<Array<object>>}
 */
export async function getProjectKeywords(projectId) {
  const project = await getProjectById(projectId);
  return project ? (project.keywords || []) : [];
}

/**
 * Saves or replaces keyword rows for a project in session storage.
 * @param {string} projectId 
 * @param {Array<object>} keywordRows 
 * @returns {Promise<void>}
 */
export async function saveProjectKeywords(projectId, keywordRows) {
  const store = requireSessionStorage();
  const projects = await getProjects();
  if (!projects[projectId]) return;

  projects[projectId].keywords = keywordRows || [];
  if (projects[projectId].config) {
    projects[projectId].config.updatedAt = new Date().toISOString();
  }

  await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
}

export const setProjectKeywords = saveProjectKeywords;

/**
 * Promotes current ranking results to previous positions for the next check.
 * @param {string} projectId 
 * @param {Array<object>} currentResults 
 * @returns {Promise<Array<object>>} updated keywords
 */
export async function promoteCurrentToPrevious(projectId, currentResults = []) {
  const store = requireSessionStorage();
  const projects = await getProjects();
  if (!projects[projectId]) return [];

  const existingKeywords = projects[projectId].keywords || [];
  const resultMap = new Map();
  for (const r of currentResults) {
    if (r && r.keyword) {
      resultMap.set(r.keyword.trim().toLowerCase(), r);
    }
  }

  const updatedKeywords = existingKeywords.map(kw => {
    const res = resultMap.get(kw.keyword.trim().toLowerCase());
    if (res && res.currentPosition !== undefined && res.currentPosition !== null) {
      const prevPos = typeof res.currentPosition === 'number' ? res.currentPosition : null;
      return {
        ...kw,
        previousPosition: prevPos,
        lastCurrentPosition: null,
        lastCheckedAt: new Date().toISOString()
      };
    }
    return kw;
  });

  projects[projectId].keywords = updatedKeywords;
  if (projects[projectId].config) {
    projects[projectId].config.updatedAt = new Date().toISOString();
  }

  await store.set({ [STORAGE_KEYS.PROJECTS]: projects });
  return updatedKeywords;
}

/**
 * Deprecated: Automatic snapshot persistence removed in privacy-first architecture.
 * Ranking data is not retained across sessions; users can export CSV/JSON locally.
 */
export async function addProjectSnapshot() {
  // No-op: automatic snapshot persistence removed for privacy architecture
}

/**
 * Exports project configuration and keywords as clean, portable JSON.
 * User downloads file locally; no data transmitted anywhere.
 * @param {string} projectId 
 * @returns {Promise<string>} JSON string
 */
export async function exportProjectJson(projectId) {
  const projects = await getProjects();
  const proj = projects[projectId];
  if (!proj) throw new Error('Project not found.');

  const cfg = proj.config || proj;

  const exportObj = {
    schemaVersion: '2.0',
    exportType: 'SERPTRACK_PROJECT',
    exportedAt: new Date().toISOString(),
    project: {
      projectName: cfg.projectName || '',
      domain: cfg.domain || '',
      googleDomain: cfg.googleDomain || 'google.com',
      useLocation: Boolean(cfg.useLocation),
      locationName: cfg.locationName || '',
      latitude: cfg.latitude || '',
      longitude: cfg.longitude || '',
      accuracy: cfg.accuracy !== undefined ? cfg.accuracy : 20,
      defaultDelaySeconds: cfg.defaultDelaySeconds || 8,
      defaultMaxDepth: cfg.defaultMaxDepth || 50,
      config: {
        projectName: cfg.projectName || '',
        domain: cfg.domain || '',
        googleDomain: cfg.googleDomain || 'google.com',
        useLocation: Boolean(cfg.useLocation),
        locationName: cfg.locationName || '',
        latitude: cfg.latitude || '',
        longitude: cfg.longitude || '',
        accuracy: cfg.accuracy !== undefined ? cfg.accuracy : 20,
        defaultDelaySeconds: cfg.defaultDelaySeconds || 8,
        defaultMaxDepth: cfg.defaultMaxDepth || 50
      },
      keywords: (proj.keywords || []).map(k => ({
        keyword: String(k.keyword || '').trim(),
        targetUrl: String(k.targetUrl || '').trim(),
        previousPosition: k.previousPosition !== undefined ? k.previousPosition : null
      }))
    }
  };

  return JSON.stringify(exportObj, null, 2);
}

/**
 * Imports a project from JSON string with strict validation and sanitization.
 * Enforces prototype-pollution safety and URL scheme restrictions.
 * Saved only into session storage.
 * 
 * @param {string} jsonString 
 * @param {string} [customName]
 * @returns {Promise<object>} imported project
 */
export async function importProjectJson(jsonString, customName = '') {
  requireSessionStorage();
  if (typeof jsonString !== 'string' || !jsonString.trim()) {
    throw new Error('Project JSON string is empty.');
  }

  // Pre-parse Prototype Pollution Protection
  if (/"(?:__proto__|constructor|prototype)"\s*:/i.test(jsonString)) {
    throw new Error('Security Error: Invalid object keys detected in JSON import.');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error('Invalid JSON format.');
  }

  // Prototype Pollution Protection
  if (hasPrototypePollutionKeys(parsed)) {
    throw new Error('Security Error: Invalid object keys detected in JSON import.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid project file structure.');
  }

  const projObj = parsed.project || parsed;
  const pCfg = projObj.config || projObj;

  if (!pCfg || typeof pCfg !== 'object') {
    throw new Error('Invalid project configuration in import file.');
  }

  const rawKeywords = Array.isArray(projObj.keywords) ? projObj.keywords : [];

  // Strictly sanitize keywords and enforce safe URLs (reject javascript:, data:, etc.)
  const sanitizedKeywords = [];
  for (let idx = 0; idx < rawKeywords.length; idx++) {
    const k = rawKeywords[idx];
    if (!k || typeof k !== 'object') continue;

    const kw = String(k.keyword || '').trim();
    const targetUrl = String(k.targetUrl || '').trim();

    if (!kw || !targetUrl) continue;

    // Strict URL validation
    if (!isSafeTargetUrl(targetUrl)) {
      continue; // Skip dangerous or invalid URLs
    }

    let prevPos = null;
    if (k.previousPosition !== undefined && k.previousPosition !== null && k.previousPosition !== '—' && k.previousPosition !== '-') {
      const num = Number(k.previousPosition);
      if (!isNaN(num) && num > 0) prevPos = num;
    }

    sanitizedKeywords.push({
      id: `kw_${idx}_${Date.now()}`,
      keyword: kw,
      targetUrl: targetUrl,
      previousPosition: prevPos,
      lastCurrentPosition: null,
      lastCheckedAt: null
    });
  }

  // Location validation if useLocation is true
  const useLocation = Boolean(pCfg.useLocation);
  let lat = pCfg.latitude !== undefined ? String(pCfg.latitude).trim() : '';
  let lon = pCfg.longitude !== undefined ? String(pCfg.longitude).trim() : '';
  let acc = Number(pCfg.accuracy) || 20;

  if (useLocation && (lat || lon)) {
    const val = validateCoordinates(lat, lon, acc);
    if (val.valid) {
      lat = String(val.latitude);
      lon = String(val.longitude);
      acc = val.accuracy;
    }
  }

  const importedProject = await createProject({
    projectName: customName ? customName.trim() : ((pCfg.projectName || 'Imported Project') + ' (Imported)'),
    domain: String(pCfg.domain || '').trim(),
    googleDomain: pCfg.googleDomain || 'google.com',
    useLocation: useLocation,
    locationName: String(pCfg.locationName || '').trim(),
    latitude: lat,
    longitude: lon,
    accuracy: acc,
    defaultDelaySeconds: Math.max(5, Number(pCfg.defaultDelaySeconds) || 8),
    defaultMaxDepth: Number(pCfg.defaultMaxDepth) || 50,
    keywords: sanitizedKeywords
  });

  return importedProject;
}
