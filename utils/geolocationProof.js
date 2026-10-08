/**
 * Confirms the page-level Geolocation API returns the configured coordinates.
 * This verifies a browser signal only: it DOES NOT spoof IP, Google account
 * history, the Google result-page location footer, or Google Maps ranking.
 */
export function verifyCoordinatesReported(expected, reported, tolerance = 0.0001) {
  if (reported?.latitude === undefined || reported?.latitude === null ||
      reported?.longitude === undefined || reported?.longitude === null ||
      expected?.latitude === undefined || expected?.latitude === null ||
      expected?.longitude === undefined || expected?.longitude === null) {
    return { valid: false, reason: 'MISSING_COORDINATES' };
  }
  const latitude = Number(reported?.latitude);
  const longitude = Number(reported?.longitude);
  const expectedLatitude = Number(expected?.latitude);
  const expectedLongitude = Number(expected?.longitude);
  if (![latitude, longitude, expectedLatitude, expectedLongitude].every(Number.isFinite)) {
    return { valid: false, reason: 'MISSING_COORDINATES' };
  }
  if (Math.abs(latitude - expectedLatitude) > tolerance ||
      Math.abs(longitude - expectedLongitude) > tolerance) {
    return { valid: false, reason: 'COORDINATE_MISMATCH' };
  }
  return { valid: true };
}

export const DEVICE_LOCATION_EXPRESSION = `new Promise(resolve => {
  if (!navigator.geolocation) {
    resolve({ error: 'Geolocation API unavailable' });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    position => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy
    }),
    error => resolve({ error: error.message || 'Permission denied or location unavailable' }),
    { maximumAge: 0, enableHighAccuracy: true, timeout: 5000 }
  );
})`;
