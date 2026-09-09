/**
 * projectManager.js
 * Local client/project management system for SERPTrack.
 * Handles projects, keyword queues, weekly snapshots, and import/export.
 * All data remains 100% local in chrome.storage.local.
 */

import { STORAGE_KEYS } from './storage.js';

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
  keywords: [],
  snapshots: []
};

/**
 * Retrieves all projects from local storage. Initializes default project if empty.
 * @returns {Promise<Object<string, object>>}
 */
export async function getProjects() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.PROJECTS);
    let projects = data[STORAGE_KEYS.PROJECTS];
    if (!projects || Object.keys(projects).length === 0) {
      projects = { [DEFAULT_PROJECT_ID]: { ...DEFAULT_PROJECT } };
      await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
    }
    // Ensure all projects have id and convenience properties
    Object.keys(projects).forEach(pId => {
      if (projects[pId] && projects[pId].config) {
        projects[pId].id = pId;
        projects[pId].projectId = pId;
      }
    });
    return projects;
  } catch (err) {
    console.error('[Projects] Error reading projects:', err);
    return { [DEFAULT_PROJECT_ID]: { ...DEFAULT_PROJECT } };
  }
}

/**
 * Retrieves the currently active project ID.
 * @returns {Promise<string>}
 */
export async function getActiveProjectId() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_PROJECT_ID);
    return data[STORAGE_KEYS.ACTIVE_PROJECT_ID] || DEFAULT_PROJECT_ID;
  } catch (err) {
    return DEFAULT_PROJECT_ID;
  }
}

/**
 * Sets the active project ID.
 * @param {string} projectId 
 * @returns {Promise<void>}
 */
export async function setActiveProjectId(projectId) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_PROJECT_ID]: projectId });
  } catch (err) {
    console.error('[Projects] Error saving active project ID:', err);
  }
}

export const setActiveProject = setActiveProjectId;

/**
 * Retrieves the active project object.
 * @returns {Promise<object>}
 */
export async function getActiveProject() {
  const projects = await getProjects();
  let activeId = await getActiveProjectId();
  if (!projects[activeId]) {
    activeId = Object.keys(projects)[0] || DEFAULT_PROJECT_ID;
    await setActiveProjectId(activeId);
  }
  const proj = projects[activeId];
  return {
    ...proj,
    id: activeId,
    project: proj,
    activeProjectId: activeId,
    projects
  };
}

/**
 * Creates a new project and sets it active.
 * @param {object} projectData
 * @returns {Promise<object>} created project
 */
export async function createProject(projectData) {
  const projects = await getProjects();
  const projectId = 'proj_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

  const cfg = {
    projectId,
    projectName: (projectData.projectName || 'New Project').trim(),
    domain: (projectData.domain || '').trim(),
    googleDomain: projectData.googleDomain || 'google.com',
    useLocation: Boolean(projectData.useLocation),
    latitude: projectData.latitude !== undefined ? String(projectData.latitude) : '',
    longitude: projectData.longitude !== undefined ? String(projectData.longitude) : '',
    accuracy: Number(projectData.accuracy) || 20,
    locationName: (projectData.locationName || '').trim(),
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
    latitude: cfg.latitude,
    longitude: cfg.longitude,
    accuracy: cfg.accuracy,
    locationName: cfg.locationName,
    defaultDelaySeconds: cfg.defaultDelaySeconds,
    defaultMaxDepth: cfg.defaultMaxDepth,
    config: cfg,
    keywords: projectData.keywords || [],
    snapshots: []
  };

  projects[projectId] = newProject;
  await chrome.storage.local.set({
    [STORAGE_KEYS.PROJECTS]: projects,
    [STORAGE_KEYS.ACTIVE_PROJECT_ID]: projectId
  });

  return newProject;
}

/**
 * Retrieves a single project by ID.
 * @param {string} projectId 
 * @returns {Promise<object|null>}
 */
export async function getProjectById(projectId) {
  const projects = await getProjects();
  const proj = projects[projectId];
  if (!proj) return null;
  return {
    ...proj,
    id: projectId,
    projectId,
    projectName: proj.config?.projectName || proj.projectName || '',
    domain: proj.config?.domain || proj.domain || '',
    useLocation: proj.config?.useLocation !== undefined ? proj.config.useLocation : Boolean(proj.useLocation),
    latitude: proj.config?.latitude !== undefined ? proj.config.latitude : (proj.latitude || ''),
    longitude: proj.config?.longitude !== undefined ? proj.config.longitude : (proj.longitude || ''),
    accuracy: proj.config?.accuracy || proj.accuracy || 20,
    locationName: proj.config?.locationName || proj.locationName || '',
    defaultDelaySeconds: proj.config?.defaultDelaySeconds || proj.defaultDelaySeconds || 8,
    defaultMaxDepth: proj.config?.defaultMaxDepth || proj.defaultMaxDepth || 50
  };
}

/**
 * Saves a full project object (config, keywords, snapshots).
 * @param {object} project 
 * @returns {Promise<void>}
 */
export async function saveProject(project) {
  const pId = project.id || project.projectId || project.config?.projectId;
  if (!pId) return;
  const projects = await getProjects();
  const existing = projects[pId] || { config: {}, keywords: [], snapshots: [] };
  const updatedConfig = {
    ...existing.config,
    ...(project.config || {}),
    projectId: pId,
    updatedAt: new Date().toISOString()
  };
  if (project.projectName !== undefined) updatedConfig.projectName = project.projectName;
  if (project.domain !== undefined) updatedConfig.domain = project.domain;
  if (project.googleDomain !== undefined) updatedConfig.googleDomain = project.googleDomain;
  if (project.useLocation !== undefined) updatedConfig.useLocation = project.useLocation;
  if (project.latitude !== undefined) updatedConfig.latitude = project.latitude;
  if (project.longitude !== undefined) updatedConfig.longitude = project.longitude;
  if (project.accuracy !== undefined) updatedConfig.accuracy = project.accuracy;
  if (project.locationName !== undefined) updatedConfig.locationName = project.locationName;
  if (project.defaultDelaySeconds !== undefined) updatedConfig.defaultDelaySeconds = project.defaultDelaySeconds;
  if (project.defaultMaxDepth !== undefined) updatedConfig.defaultMaxDepth = project.defaultMaxDepth;

  projects[pId] = {
    ...existing,
    ...project,
    id: pId,
    projectId: pId,
    projectName: updatedConfig.projectName,
    domain: updatedConfig.domain,
    googleDomain: updatedConfig.googleDomain,
    useLocation: updatedConfig.useLocation,
    latitude: updatedConfig.latitude,
    longitude: updatedConfig.longitude,
    accuracy: updatedConfig.accuracy,
    locationName: updatedConfig.locationName,
    defaultDelaySeconds: updatedConfig.defaultDelaySeconds,
    defaultMaxDepth: updatedConfig.defaultMaxDepth,
    config: updatedConfig,
    keywords: project.keywords !== undefined ? project.keywords : existing.keywords,
    snapshots: project.snapshots !== undefined ? project.snapshots : existing.snapshots
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
}

/**
 * Updates an existing project's configuration.
 * @param {string} projectId 
 * @param {object} configUpdates 
 * @returns {Promise<object>} updated project
 */
export async function updateProject(projectId, configUpdates) {
  const projects = await getProjects();
  if (!projects[projectId]) {
    throw new Error(`Project ${projectId} not found.`);
  }

  projects[projectId].config = {
    ...projects[projectId].config,
    ...configUpdates,
    updatedAt: new Date().toISOString()
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
  return projects[projectId];
}

/**
 * Deletes a project. Fails if only 1 project remains.
 * @param {string} projectId 
 * @returns {Promise<{ success: boolean, newActiveId?: string }>}
 */
export async function deleteProject(projectId) {
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

  await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
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
 * Saves or replaces keyword rows for a project.
 * @param {string} projectId 
 * @param {Array<object>} keywordRows 
 * @returns {Promise<void>}
 */
export async function saveProjectKeywords(projectId, keywordRows) {
  const projects = await getProjects();
  if (!projects[projectId]) return;

  projects[projectId].keywords = keywordRows || [];
  projects[projectId].config.updatedAt = new Date().toISOString();

  await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
}

export const setProjectKeywords = saveProjectKeywords;

/**
 * Retrieves snapshot history for a project.
 * @param {string} projectId 
 * @returns {Promise<Array<object>>}
 */
export async function getProjectSnapshots(projectId) {
  const project = await getProjectById(projectId);
  return project ? (project.snapshots || []) : [];
}

/**
 * Adds a weekly snapshot to a project, capping at 12 snapshots.
 * Automatically generates a summary if raw results are passed.
 * @param {string} projectId 
 * @param {object|Array} snapshotOrResults 
 * @returns {Promise<void>}
 */
export async function addProjectSnapshot(projectId, snapshotOrResults) {
  const projects = await getProjects();
  if (!projects[projectId]) return;

  let summary = {};
  let results = [];

  if (Array.isArray(snapshotOrResults)) {
    results = snapshotOrResults;
    let found = 0;
    let notFound = 0;
    let errors = 0;
    results.forEach(r => {
      if (r) {
        if (r.status === 'ERROR' || r.matchStatus === 'ERROR') {
          errors++;
        } else if (typeof r.currentPosition === 'number') {
          found++;
        } else {
          notFound++;
        }
      }
    });
    summary = { total: results.length, found, notFound, errors };
  } else if (snapshotOrResults && typeof snapshotOrResults === 'object') {
    summary = snapshotOrResults.summary || {};
    results = snapshotOrResults.results || [];
  }

  const currentSnapshots = projects[projectId].snapshots || [];
  const updatedSnapshots = [
    {
      snapshotId: 'snap_' + Date.now(),
      projectId,
      checkedAt: new Date().toISOString(),
      summary,
      results
    },
    ...currentSnapshots
  ].slice(0, 12); // Keep maximum 12 local snapshots

  projects[projectId].snapshots = updatedSnapshots;
  projects[projectId].config.updatedAt = new Date().toISOString();

  await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
}

/**
 * Promotes current ranking results to previous positions for the next check.
 * @param {string} projectId 
 * @param {Array<object>} currentResults 
 * @returns {Promise<Array<object>>} updated keywords
 */
export async function promoteCurrentToPrevious(projectId, currentResults = []) {
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
  projects[projectId].config.updatedAt = new Date().toISOString();

  await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
  return updatedKeywords;
}

/**
 * Exports a project configuration, keywords, and snapshots as clean, portable JSON.
 * @param {string} projectId 
 * @returns {Promise<string>} JSON string
 */
export async function exportProjectJson(projectId) {
  const projects = await getProjects();
  const proj = projects[projectId];
  if (!proj) throw new Error('Project not found.');

  const exportObj = {
    schemaVersion: '1.0',
    exportType: 'SERPTRACK_PROJECT',
    exportedAt: new Date().toISOString(),
    project: {
      projectName: proj.config.projectName,
      domain: proj.config.domain,
      googleDomain: proj.config.googleDomain,
      useLocation: proj.config.useLocation,
      latitude: proj.config.latitude,
      longitude: proj.config.longitude,
      accuracy: proj.config.accuracy,
      locationName: proj.config.locationName,
      defaultDelaySeconds: proj.config.defaultDelaySeconds,
      defaultMaxDepth: proj.config.defaultMaxDepth,
      config: {
        projectName: proj.config.projectName,
        domain: proj.config.domain,
        googleDomain: proj.config.googleDomain,
        useLocation: proj.config.useLocation,
        latitude: proj.config.latitude,
        longitude: proj.config.longitude,
        accuracy: proj.config.accuracy,
        locationName: proj.config.locationName,
        defaultDelaySeconds: proj.config.defaultDelaySeconds,
        defaultMaxDepth: proj.config.defaultMaxDepth
      },
      keywords: (proj.keywords || []).map(k => ({
        keyword: k.keyword,
        targetUrl: k.targetUrl,
        previousPosition: k.previousPosition
      })),
      snapshots: proj.snapshots || []
    }
  };

  return JSON.stringify(exportObj, null, 2);
}

/**
 * Imports a project from JSON string with validation and sanitization.
 * @param {string} jsonString 
 * @param {string} [customName]
 * @returns {Promise<object>} imported project
 */
export async function importProjectJson(jsonString, customName = '') {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new Error('Invalid JSON format.');
  }

  if (!parsed || !parsed.project || !parsed.project.config) {
    throw new Error('Invalid project file structure.');
  }

  const pCfg = parsed.project.config;
  const pKeywords = Array.isArray(parsed.project.keywords) ? parsed.project.keywords : [];
  const pSnapshots = Array.isArray(parsed.project.snapshots) ? parsed.project.snapshots : [];

  const sanitizedKeywords = pKeywords.map((k, idx) => ({
    keywordId: 'kw_' + idx + '_' + Date.now(),
    keyword: String(k.keyword || '').trim(),
    targetUrl: String(k.targetUrl || '').trim(),
    previousPosition: k.previousPosition !== undefined ? k.previousPosition : null,
    lastCurrentPosition: null,
    lastCheckedAt: null
  })).filter(k => k.keyword && k.targetUrl);

  const importedProject = await createProject({
    projectName: customName ? customName.trim() : ((pCfg.projectName || 'Imported Project') + ' (Imported)'),
    domain: pCfg.domain || '',
    googleDomain: pCfg.googleDomain || 'google.com',
    useLocation: Boolean(pCfg.useLocation),
    latitude: pCfg.latitude || '',
    longitude: pCfg.longitude || '',
    accuracy: Number(pCfg.accuracy) || 20,
    locationName: pCfg.locationName || '',
    defaultDelaySeconds: Math.max(5, Number(pCfg.defaultDelaySeconds) || 8),
    defaultMaxDepth: Number(pCfg.defaultMaxDepth) || 50,
    keywords: sanitizedKeywords
  });

  if (pSnapshots.length > 0) {
    const projects = await getProjects();
    projects[importedProject.config.projectId].snapshots = pSnapshots.slice(0, 12);
    await chrome.storage.local.set({ [STORAGE_KEYS.PROJECTS]: projects });
    importedProject.snapshots = pSnapshots.slice(0, 12);
  }

  return importedProject;
}
