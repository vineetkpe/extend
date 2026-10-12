import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRememberedCoordinates, rememberCoordinates, forgetRememberedCoordinates,
  getLocationForProject, REMEMBERED_COORDINATES_KEY,
  rememberCoordinateDraft, getRememberedCoordinateDraft, REMEMBERED_COORDINATE_DRAFT_KEY
} from '../utils/rememberedLocation.js';

function fakeChrome() {
  const data = {};
  let writes = 0;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(record) { writes++; Object.assign(data, structuredClone(record)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
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


test('latitude typed alone survives popup closure while longitude is being copied', async () => {
  const storage = fakeChrome();
  assert.equal((await rememberCoordinateDraft({
    latitude: '28.6139', longitude: '', accuracy: '20'
  })).saved, true);
  const restored = await getRememberedCoordinateDraft();
  assert.deepEqual(restored, { latitude: '28.6139', longitude: '', accuracy: '20' });
  assert.deepEqual(getLocationForProject({}, null, restored), {
    latitude: '28.6139', longitude: '', accuracy: '20', source: 'device-draft'
  });
  assert.equal(await getRememberedCoordinates(), null, 'Partial pair must not be applied as verified GPS');
  assert.deepEqual(Object.keys(storage.data), [REMEMBERED_COORDINATE_DRAFT_KEY]);
  const storedText = JSON.stringify(storage.data);
  assert.ok(!storedText.includes('projectName'));
  assert.ok(!storedText.includes('locationName'));
});

test('longitude can be entered after restoring latitude without deleting the earlier entry', async () => {
  fakeChrome();
  await rememberCoordinateDraft({ latitude: '28.6139', longitude: '' });
  const before = await getRememberedCoordinateDraft();
  assert.equal(before.latitude, '28.6139');
  const saved = await rememberCoordinateDraft({
    latitude: before.latitude, longitude: '77.2090', accuracy: '20'
  });
  assert.equal(saved.saved, true);
  assert.deepEqual(await getRememberedCoordinateDraft(), {
    latitude: '28.6139', longitude: '77.2090', accuracy: '20'
  });
  const complete = await rememberCoordinates({
    latitude: before.latitude, longitude: '77.2090', accuracy: '20'
  });
  assert.equal(complete.saved, true);
  assert.equal((await getRememberedCoordinates()).longitude, '77.209');
});

test('partially entered project coordinates always win over previous device defaults', async () => {
  fakeChrome();
  await rememberCoordinates({ latitude: 40.7128, longitude: -74.006 });
  const remembered = await getRememberedCoordinates();
  const partial = getLocationForProject({
    latitude: '28.6139', longitude: '', accuracy: 20,
    locationDraftEdited: true, useLocation: true
  }, remembered);
  assert.deepEqual(partial, {
    latitude: '28.6139', longitude: '', accuracy: 20, source: 'project-draft'
  });
  assert.equal(Object.hasOwn(partial, 'useLocation'), false);
  assert.deepEqual(getLocationForProject({
    latitude: '', longitude: '', locationDraftEdited: true
  }, remembered), {
    latitude: '', longitude: '', accuracy: 20, source: 'project-draft'
  }, 'Explicitly cleared fields must not resurrect old coordinates');
});

test('manual Reset Location removes incomplete drafts and saved verified coordinates', async () => {
  const storage = fakeChrome();
  await rememberCoordinates({ latitude: 28.6139, longitude: 77.209 });
  await rememberCoordinateDraft({ latitude: '34.1', longitude: '' });
  assert.ok(storage.data[REMEMBERED_COORDINATE_DRAFT_KEY]);
  await forgetRememberedCoordinates();
  assert.equal(await getRememberedCoordinateDraft(), null);
  assert.equal(await getRememberedCoordinates(), null);
  assert.deepEqual(storage.data, {});
});

test('only coordinate-shaped text may be stored persistently in an incomplete draft', async () => {
  const storage = fakeChrome();
  assert.equal((await rememberCoordinateDraft({
    latitude: 'client account 123', longitude: '77.209'
  })).saved, false);
  assert.equal((await rememberCoordinateDraft({
    latitude: '91.0', longitude: '77.209'
  })).saved, false);
  assert.deepEqual(storage.data, {});
});
