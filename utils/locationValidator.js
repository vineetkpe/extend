/**
 * locationValidator.js
 * Validates latitude, longitude, and accuracy for browser geolocation simulation.
 */

/**
 * Validates geographic coordinates and accuracy.
 * 
 * Rules:
 * - Latitude must be a finite number between -90 and +90 (inclusive).
 * - Longitude must be a finite number between -180 and +180 (inclusive).
 * - Accuracy must be a positive finite number (defaults to 20 meters if omitted).
 * 
 * @param {number|string} lat
 * @param {number|string} lon
 * @param {number|string} [accuracy=20]
 * @returns {{ valid: boolean, latitude?: number, longitude?: number, accuracy?: number, error?: string }}
 */
export function validateCoordinates(lat, lon, accuracy = 20) {
  if (lat === null || lat === undefined || String(lat).trim() === '') {
    return { valid: false, error: 'Latitude is required.' };
  }
  if (lon === null || lon === undefined || String(lon).trim() === '') {
    return { valid: false, error: 'Longitude is required.' };
  }

  const numLat = Number(lat);
  const numLon = Number(lon);

  if (!Number.isFinite(numLat)) {
    return { valid: false, error: `Invalid latitude: "${lat}". Must be a valid number.` };
  }
  if (!Number.isFinite(numLon)) {
    return { valid: false, error: `Invalid longitude: "${lon}". Must be a valid number.` };
  }

  if (numLat < -90 || numLat > 90) {
    return { valid: false, error: `Latitude ${numLat} is out of bounds. Must be between -90 and +90.` };
  }
  if (numLon < -180 || numLon > 180) {
    return { valid: false, error: `Longitude ${numLon} is out of bounds. Must be between -180 and +180.` };
  }

  let numAcc = 20;
  if (accuracy !== null && accuracy !== undefined && String(accuracy).trim() !== '') {
    numAcc = Number(accuracy);
    if (!Number.isFinite(numAcc) || numAcc <= 0) {
      return { valid: false, error: 'Accuracy must be a positive number (meters).' };
    }
  }

  return {
    valid: true,
    latitude: numLat,
    longitude: numLon,
    accuracy: numAcc
  };
}

/**
 * Creates a comparable fingerprint for an applied location session.
 * Accepts (tabId, lat, lon, accuracy) or (lat, lon, accuracy, tabId).
 * @param {number|string} tabIdOrLat 
 * @param {number|string} latOrLon 
 * @param {number|string} lonOrAcc 
 * @param {number|string|null} accOrTabId 
 * @returns {object}
 */
export function createLocationFingerprint(tabIdOrLat, latOrLon, lonOrAcc, accOrTabId) {
  let tabId, lat, lon, accuracy;
  // If fourth param is tabId (large integer) and 1st param is coordinate
  if (accOrTabId !== undefined && typeof accOrTabId === 'number' && accOrTabId > 90) {
    lat = tabIdOrLat;
    lon = latOrLon;
    accuracy = lonOrAcc;
    tabId = accOrTabId;
  } else {
    tabId = tabIdOrLat;
    lat = latOrLon;
    lon = lonOrAcc;
    accuracy = accOrTabId;
  }

  return {
    tabId: tabId ? Number(tabId) : null,
    latitude: Number(lat),
    longitude: Number(lon),
    accuracy: Number(accuracy) || 20
  };
}

/**
 * Checks whether the current configured coordinates match the applied location fingerprint.
 * Accepts (fingerprint, tabId, lat, lon, accuracy) or (fingerprint, lat, lon, accuracy, tabId).
 * @param {object|null} fingerprint 
 * @param {number|string} tabIdOrLat 
 * @param {number|string} latOrLon 
 * @param {number|string} lonOrAcc 
 * @param {number|string|null} accOrTabId 
 * @returns {boolean}
 */
export function isLocationFingerprintMatch(fingerprint, tabIdOrLat, latOrLon, lonOrAcc, accOrTabId) {
  if (!fingerprint) return false;
  let tabId, lat, lon, accuracy;
  if (accOrTabId !== undefined && typeof accOrTabId === 'number' && accOrTabId > 90) {
    lat = tabIdOrLat;
    lon = latOrLon;
    accuracy = lonOrAcc;
    tabId = accOrTabId;
  } else {
    tabId = tabIdOrLat;
    lat = latOrLon;
    lon = lonOrAcc;
    accuracy = accOrTabId;
  }

  return (
    fingerprint.tabId === Number(tabId) &&
    fingerprint.latitude === Number(lat) &&
    fingerprint.longitude === Number(lon) &&
    fingerprint.accuracy === (Number(accuracy) || 20)
  );
}
