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
