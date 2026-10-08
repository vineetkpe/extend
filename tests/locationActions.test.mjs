import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../utils/storage.js';

function makeMockBrowser({ denied = false } = {}) {
  const stored = {};
  const tabsById = new Map();
  const listeners = new Set();
  const commands = [];
  const removed = [];
  const handlers = {};
  let nextTabId = 50;
  let reported = null;

  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(stored[key]) }; },
        async set(obj) { Object.assign(stored, structuredClone(obj)); }
      },
      local: {
        async get() { return {}; },
        async set() {}
      }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { handlers.onMessage = fn; } },
      async sendMessage() {}
    },
    debugger: {
      onDetach: { addListener() {} },
      attach(target, version, cb) { commands.push(['attach', target.tabId]); cb(); },
      detach(target, cb) { commands.push(['detach', target.tabId]); cb(); },
      sendCommand(target, method, params, cb) {
        commands.push([method, target.tabId]);
        if (method === 'Emulation.setGeolocationOverride') {
          reported = {
            latitude: params.latitude, longitude: params.longitude,
            accuracy: params.accuracy
          };
        }
        if (method === 'Runtime.evaluate') {
          cb({ result: { value: denied ? { error: 'User denied Geolocation' } : reported } });
          return;
        }
        if (method === 'Emulation.clearGeolocationOverride') reported = null;
        cb({});
      }
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: {
        addListener(fn) { listeners.add(fn); },
        removeListener(fn) { listeners.delete(fn); }
      },
      async create(opts) {
        const tab = { id: nextTabId++, url: opts.url, active: opts.active };
        tabsById.set(tab.id, tab);
        return tab;
      },
      async get(id) {
        if (!tabsById.has(id)) throw new Error('Tab missing');
        return { ...tabsById.get(id) };
      },
      async update(id, changes) {
        const tab = tabsById.get(id);
        if (!tab) throw new Error('Tab missing');
        Object.assign(tab, changes);
        if (changes.url) {
          queueMicrotask(() => {
            for (const cb of listeners) cb(id, { status: 'complete' }, tab);
          });
        }
        return { ...tab };
      },
      async remove(id) { removed.push(id); tabsById.delete(id); }
    }
  };

  async function startWorker(suffix) {
    await import('../background.js?' + suffix);
    assert.equal(typeof handlers.onMessage, 'function');
  }
  function send(request) {
    return new Promise(resolve => {
      const keepsOpen = handlers.onMessage(request, {}, resolve);
      assert.equal(keepsOpen, true);
    });
  }
  return { send, startWorker, commands, removed, tabsById, stored };
}

test('TEST_LOCATION creates visible persistent Google tab, verifies device coordinates and reuses it', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('location-test-keep-tab');
  const request = {
    action: 'TEST_LOCATION',
    location: { latitude: 34.1478, longitude: -118.1445, accuracy: 20 }
  };
  const result = await browser.send(request);
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.equal(result.tabId, 50);
  assert.equal(browser.tabsById.size, 1, 'Tab must stay open after verification');
  assert.equal(browser.tabsById.get(50).active, true);
  assert.equal(browser.removed.length, 0, 'Original implementation closed test tab');
  assert.ok(browser.commands.some(row => row[0] === 'Emulation.setGeolocationOverride'));
  assert.ok(browser.commands.some(row => row[0] === 'Runtime.evaluate'));
  assert.ok(!browser.commands.some(row => row[0] === 'Browser.grantPermissions'));

  const second = await browser.send(request);
  assert.equal(second.success, true);
  assert.equal(second.tabId, 50);
  assert.equal(browser.tabsById.size, 1);

  const savedState = browser.stored[STORAGE_KEYS.JOB_STATE];
  assert.equal(savedState.searchTabId, 50);
  assert.equal(savedState.locationApplied, true);
  assert.match(result.message, /IP-based city/);
});

test('location permission errors fail without claiming that device location is verified', async () => {
  const browser = makeMockBrowser({ denied: true });
  await browser.startWorker('location-test-permission-fail');
  const result = await browser.send({
    action: 'TEST_LOCATION',
    location: { latitude: 34.1478, longitude: -118.1445, accuracy: 20 }
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Site settings/);
  assert.equal(browser.tabsById.size, 1, 'Keep tab visible so user can allow location');
  assert.ok(browser.commands.some(row => row[0] === 'Emulation.clearGeolocationOverride'));
});

test('APPLY_LOCATION verifies in visible Google tab, rather than claiming pending configuration', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('location-apply-live');
  const result = await browser.send({
    action: 'APPLY_LOCATION',
    location: { latitude: 40.7128, longitude: -74.006, accuracy: 20 }
  });
  assert.equal(result.success, true);
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.equal(browser.tabsById.size, 1);
  assert.equal(browser.stored[STORAGE_KEYS.JOB_STATE].locationApplied, true);
});
