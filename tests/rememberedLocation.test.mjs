import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRememberedCoordinates, rememberCoordinates, forgetRememberedCoordinates,
  getLocationForProject, REMEMBERED_COORDINATES_KEY
} from '../utils/rememberedLocation.js';

function fakeChrome() {
  const data = {};
  let writes = 0;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(record) { writes++; Object.assign(data, structuredClone(record)); },
        async remove(key) { delete data[key]; }
      }
    }
  };
  return { data, writes: () => writes };
}
test('coordinates survive loading a new popup/dashboard by reading device-only storage', async () => {
  const storage = fakeChrome();
  const saved = await rememberCoordinates({
    latitude: '34.1478', longitude: '-118.1445', accuracy: '20',
    locationName: 'private client', keyword: 'confidential phrase', url: 'https://private.example'
  });
  assert.equal(saved.saved, true);
  assert.deepEqual(await getRememberedCoordinates(), {
    latitude: '34.1478', longitude: '-118.1445', accuracy: 20
  });
  assert.deepEqual(Object.keys(storage.data), [REMEMBERED_COORDINATES_KEY]);
  const serialized = JSON.stringify(storage.data);
  assert.ok(!serialized.includes('private client'));
  assert.ok(!serialized.includes('confidential'));
  assert.ok(!serialized.includes('private.example'));
});
test('different client project uses project-specific session coordinates when present', async () => {
  fakeChrome();
  await rememberCoordinates({ latitude: 34.1478, longitude: -118.1445 });
  const remembered = await getRememberedCoordinates();
  const project = getLocationForProject({
    latitude: '40.7128', longitude: '-74.0060', accuracy: 10, useLocation: true
  }, remembered);
  assert.deepEqual(project, {
    latitude: '40.7128', longitude: '-74.006', accuracy: 10, source: 'project'
  });
});
test('new project shows remembered coordinates but must not auto-enable geolocation', async () => {
  fakeChrome();
  await rememberCoordinates({ latitude: 34.1478, longitude: -118.1445 });
  const fresh = getLocationForProject({ useLocation: false }, await getRememberedCoordinates());
  assert.equal(fresh.source, 'device');
  assert.equal(fresh.latitude, '34.1478');
  assert.equal(Object.hasOwn(fresh, 'useLocation'), false);
});
test('user manual Reset Location deletes saved coordinates and nothing else', async () => {
  const storage = fakeChrome();
  storage.data.keepSettings = { googleDomain: 'google.com' };
  await rememberCoordinates({ latitude: 0, longitude: 0, accuracy: 20 });
  assert.ok(await getRememberedCoordinates());
  await forgetRememberedCoordinates();
  assert.equal(await getRememberedCoordinates(), null);
  assert.deepEqual(storage.data.keepSettings, { googleDomain: 'google.com' });
});
test('invalid or incomplete coordinate drafts cannot overwrite remembered valid pair', async () => {
  const storage = fakeChrome();
  await rememberCoordinates({ latitude: 50.1, longitude: 8.6 });
  const prior = storage.writes();
  assert.equal((await rememberCoordinates({ latitude: '90.8', longitude: '10' })).saved, false);
  assert.equal((await rememberCoordinates({ latitude: '50.1', longitude: '' })).saved, false);
  assert.equal(storage.writes(), prior);
  assert.equal((await getRememberedCoordinates()).latitude, '50.1');
});
