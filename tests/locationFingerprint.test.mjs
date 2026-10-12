import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocationFingerprint, isLocationFingerprintMatch
} from '../utils/locationValidator.js';

test('browser location accuracy above 90m is not mistaken for tab identifier', () => {
  for (const accuracy of [20, 100, 150, 500, 1000]) {
    const fp = createLocationFingerprint(50, 28.6139, 77.2090, accuracy);
    assert.deepEqual(fp, { tabId: 50, latitude: 28.6139, longitude: 77.209, accuracy });
    assert.equal(isLocationFingerprintMatch(fp, 50, 28.6139, 77.209, accuracy), true);
    assert.equal(isLocationFingerprintMatch(fp, 50, 28.6139, 77.209, accuracy + 1), false);
    assert.equal(isLocationFingerprintMatch(fp, 51, 28.6139, 77.209, accuracy), false);
  }
});
