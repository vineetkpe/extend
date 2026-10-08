import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCoordinatesReported, DEVICE_LOCATION_EXPRESSION } from '../utils/geolocationProof.js';

test('accepts an exact page-level browser device geolocation response', () => {
  assert.deepEqual(
    verifyCoordinatesReported({ latitude: 34.1478, longitude: -118.1445 },
                              { latitude: 34.1478, longitude: -118.1445 }),
    { valid: true }
  );
});

test('rejects an IP-derived/real device location distinct from requested coordinates', () => {
  assert.deepEqual(
    verifyCoordinatesReported({ latitude: 34.1478, longitude: -118.1445 },
                              { latitude: 28.6139, longitude: 77.2090 }),
    { valid: false, reason: 'COORDINATE_MISMATCH' }
  );
});

test('rejects missing, null, non-numeric and malformed geolocation values', () => {
  for (const reported of [null, undefined, {}, { latitude: null, longitude: 0 },
    { latitude: 'not a number', longitude: 0 }]) {
    // Missing numeric fields must NOT coerce to zero.
    const result = verifyCoordinatesReported({ latitude: 0, longitude: 0 }, reported);
    assert.equal(result.valid, false);
  }
});

test('permits tiny floating-point rounding but not a different city', () => {
  assert.equal(
    verifyCoordinatesReported({ latitude: 37.7749, longitude: -122.4194 },
                              { latitude: 37.774901, longitude: -122.419403 }).valid,
    true
  );
  assert.equal(
    verifyCoordinatesReported({ latitude: 37.7749, longitude: -122.4194 },
                              { latitude: 37.7752, longitude: -122.4194 }).valid,
    false
  );
});

test('CDP evaluation actually requests fresh navigator.geolocation, not cached state', () => {
  assert.match(DEVICE_LOCATION_EXPRESSION, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(DEVICE_LOCATION_EXPRESSION, /maximumAge: 0/);
  assert.match(DEVICE_LOCATION_EXPRESSION, /timeout: 5000/);
});
