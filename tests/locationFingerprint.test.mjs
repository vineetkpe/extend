import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocationFingerprint, isLocationFingerprintMatch
} from '../utils/locationValidator.js';

test('accuracy above 90 meters is not mistaken for a browser tab ID', () => {
  for (const accuracy of [100, 150, 500, 1000]) {
    const fingerprint = createLocationFingerprint(50, 34.1478, -118.1445, accuracy);
    assert.deepEqual(fingerprint, {
      tabId: 50,
      latitude: 34.1478,
      longitude: -118.1445,
      accuracy
    }, 'Accuracy ' + accuracy + ' meters');
    assert.equal(isLocationFingerprintMatch(
      fingerprint, 50, 34.1478, -118.1445, accuracy
    ), true);
  }
});

test('the tab ID stays distinct from the accuracy for large tab IDs too', () => {
  const fingerprint = createLocationFingerprint(725, 40.7128, -74.006, 200);
  assert.deepEqual(fingerprint, {
    tabId: 725, latitude: 40.7128, longitude: -74.006, accuracy: 200
  });
  assert.equal(isLocationFingerprintMatch(fingerprint, 725, 40.7128, -74.006, 200), true);
  assert.equal(isLocationFingerprintMatch(fingerprint, 200, 40.7128, -74.006, 725), false);
});

test('location fingerprint refuses changes to tab, coordinates, or accuracy', () => {
  const original = createLocationFingerprint(50, 34.1478, -118.1445, 150);
  assert.equal(isLocationFingerprintMatch(original, 51, 34.1478, -118.1445, 150), false);
  assert.equal(isLocationFingerprintMatch(original, 50, 34.148, -118.1445, 150), false);
  assert.equal(isLocationFingerprintMatch(original, 50, 34.1478, -118.14, 150), false);
  assert.equal(isLocationFingerprintMatch(original, 50, 34.1478, -118.1445, 151), false);
  assert.equal(isLocationFingerprintMatch(null, 50, 34.1478, -118.1445, 150), false);
});

test('ordinary 20-meter settings still produce the same fingerprint', () => {
  const fingerprint = createLocationFingerprint(50, '0', '0', 20);
  assert.deepEqual(fingerprint, { tabId: 50, latitude: 0, longitude: 0, accuracy: 20 });
  assert.equal(isLocationFingerprintMatch(fingerprint, 50, 0, 0, 20), true);
});