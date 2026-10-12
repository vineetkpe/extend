import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../utils/storage.js';

function makeMockBrowser({ denied = false, mismatchedDeviceLocation = false,
  headerFails = false, emitDetachEvents = false } = {}) {
  const stored = {};
  const tabsById = new Map();
  const listeners = new Set();
  const commands = [];
  const removed = [];
  const handlers = {};
  let nextTabId = 50;
  let reported = null;
  let sessionRules = [];

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
    declarativeNetRequest: {
      async updateSessionRules({ removeRuleIds, addRules = [] }) {
        commands.push(['xgeoRules', removeRuleIds, structuredClone(addRules)]);
        if (headerFails) throw new Error('Could not install Google X-Geo header');
        sessionRules = sessionRules.filter(r => !removeRuleIds.includes(r.id)).concat(addRules);
      },
      async getSessionRules() { return structuredClone(sessionRules); }
    },
    debugger: {
      onDetach: { addListener(fn) { handlers.onDetach = fn; } },
      attach(target, version, cb) { commands.push(['attach', target.tabId]); cb(); },
      detach(target, cb) {
        commands.push(['detach', target.tabId]);
        cb();
        if (emitDetachEvents) {
          queueMicrotask(() => handlers.onDetach?.(target, 'canceled_by_user'));
        }
      },
      sendCommand(target, method, params, cb) {
        commands.push([method, target.tabId]);
        if (method === 'Emulation.setGeolocationOverride') {
          reported = {
            latitude: params.latitude, longitude: params.longitude,
            accuracy: params.accuracy
          };
        }
        if (method === 'Runtime.evaluate') {
          cb({ result: { value: denied ? { error: 'User denied Geolocation' } :
            mismatchedDeviceLocation ? { latitude: 0, longitude: 0 } : reported } });
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
          commands.push(['navigate', id, changes.url]);
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
  return {
    send, startWorker, commands, removed, tabsById, stored,
    getLocationRules: () => structuredClone(sessionRules)
  };
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


test('large accuracy remains correct in applied session fingerprint', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('location-accuracy-150-priority');
  const result = await browser.send({
    action: 'APPLY_LOCATION',
    location: { latitude: 28.6139, longitude: 77.209, accuracy: 150 }
  });
  assert.equal(result.success, true);
  const job = browser.stored[STORAGE_KEYS.JOB_STATE];
  assert.deepEqual(job.appliedLocation, {
    tabId: 50, latitude: 28.6139, longitude: 77.209, accuracy: 150
  });
  assert.equal(job.locationApplied, true);
});

test('location Test fails closed if Google page reports different device coordinates', async () => {
  const browser = makeMockBrowser({ mismatchedDeviceLocation: true });
  await browser.startWorker('location-device-gps-mismatch-priority');
  const result = await browser.send({
    action: 'TEST_LOCATION',
    location: { latitude: 28.6139, longitude: 77.209, accuracy: 20 }
  });
  assert.equal(result.success, false);
  assert.match(result.error, /did not report the configured coordinates/i);
  assert.ok(!browser.stored[STORAGE_KEYS.JOB_STATE].locationApplied);
  assert.ok(browser.commands.some(row => row[0] === 'Emulation.clearGeolocationOverride'));
});


test('Apply reloads Google search after GPS override and verifies the reloaded document', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('client-location-reload-order');
  const result = await browser.send({
    action: 'APPLY_LOCATION',
    googleDomain: 'google.co.in',
    location: { latitude: 28.6139, longitude: 77.209, accuracy: 30 }
  });
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  assert.deepEqual(result.reported, {
    latitude: 28.6139, longitude: 77.209, accuracy: 30
  });
  const actions = browser.commands.map(entry => entry[0]);
  const overrideIndex = actions.indexOf('Emulation.setGeolocationOverride');
  const lastNavigation = actions.lastIndexOf('navigate');
  const evaluationIndex = actions.indexOf('Runtime.evaluate');
  assert.ok(overrideIndex >= 0, 'GPS override must be sent');
  assert.ok(lastNavigation > overrideIndex,
    'Google Search must reload AFTER setting the client coordinates');
  assert.ok(evaluationIndex > lastNavigation,
    'The reloaded Google page must report the configured coordinates');
  assert.match(browser.tabsById.get(result.tabId).url, /^https:\/\/www\.google\.co\.in\/search\?/);
});

test('Test also reloads an existing Google tab with newly entered client coordinates', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('client-location-existing-tab');
  const first = await browser.send({
    action: 'TEST_LOCATION',
    googleDomain: 'google.com.br',
    location: { latitude: -23.5505, longitude: -46.6333, accuracy: 20 }
  });
  assert.equal(first.success, true);
  const initialCommandCount = browser.commands.length;
  const second = await browser.send({
    action: 'APPLY_LOCATION',
    googleDomain: 'google.com.br',
    location: { latitude: -22.9068, longitude: -43.1729, accuracy: 100 }
  });
  assert.equal(second.success, true);
  assert.equal(second.tabId, first.tabId);
  assert.equal(second.reported.latitude, -22.9068);
  assert.equal(second.reported.longitude, -43.1729);
  const operations = browser.commands.slice(initialCommandCount);
  const override = operations.findIndex(entry => entry[0] === 'Emulation.setGeolocationOverride');
  const reload = operations.findIndex(entry => entry[0] === 'navigate');
  const verify = operations.findIndex(entry => entry[0] === 'Runtime.evaluate');
  assert.ok(override >= 0 && reload > override && verify > reload);
  assert.match(browser.tabsById.get(first.tabId).url, /^https:\/\/www\.google\.com\.br\/search\?/);
});

test('invalid Google domain cannot be used for location debugger', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('client-location-reject-untrusted-domain');
  const result = await browser.send({
    action: 'APPLY_LOCATION',
    googleDomain: 'google.com.attacker.example',
    location: { latitude: 28.6139, longitude: 77.209, accuracy: 20 }
  });
  assert.equal(result.success, false);
  assert.match(result.error, /unsupported Google Search country domain/i);
  assert.equal(browser.tabsById.size, 0);
  assert.equal(browser.commands.some(entry => entry[0] === 'attach'), false);
});


test('client X-Geo header is installed before Google reload, GPS applied and checked afterwards', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('client-xgeo-before-reload');
  const result = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.com',
    location: { latitude: 39.7946857, longitude: -105.0654264, accuracy: 20 }
  });
  assert.equal(result.success, true);
  assert.equal(result.verified, true);
  const rules = browser.getLocationRules();
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.tabIds, [result.tabId]);
  assert.equal(new RegExp(rules[0].condition.regexFilter).test(
    'https://www.google.com/search?q=surface+repair'), true);
  const decoded = atob(rules[0].action.requestHeaders[0].value.slice(2));
  assert.match(decoded, /latitude_e7: 397946857/);
  assert.match(decoded, /longitude_e7: -1050654264/);
  const actions = browser.commands.map(row => row[0]);
  assert.ok(actions.indexOf('xgeoRules') < actions.indexOf('Emulation.setGeolocationOverride'));
  assert.ok(actions.lastIndexOf('navigate') > actions.indexOf('Emulation.setGeolocationOverride'));
  assert.ok(actions.indexOf('Runtime.evaluate') > actions.lastIndexOf('navigate'));
});

test('changing clients replaces the old tab-only X-Geo hint rather than affecting other tabs', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('client-xgeo-switch');
  const first = await browser.send({
    action: 'TEST_LOCATION', googleDomain: 'google.com',
    location: { latitude: 39.7946857, longitude: -105.0654264, accuracy: 20 }
  });
  assert.equal(first.success, true);
  const old = browser.getLocationRules()[0];
  const second = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.co.in',
    location: { latitude: 28.6139, longitude: 77.209, accuracy: 20 }
  });
  assert.equal(second.success, true);
  assert.notEqual(second.tabId, first.tabId);
  const rules = browser.getLocationRules();
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition.tabIds, [second.tabId]);
  assert.notEqual(rules[0].action.requestHeaders[0].value,
    old.action.requestHeaders[0].value);
  assert.equal(browser.tabsById.get(first.tabId).url.startsWith(
    'https://www.google.com/search'), true);
});

test('Reset Location removes Google X-Geo and browser GPS together', async () => {
  const browser = makeMockBrowser();
  await browser.startWorker('client-xgeo-reset');
  const applied = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.com',
    location: { latitude: 38.8, longitude: -77.1, accuracy: 20 }
  });
  assert.equal(applied.success, true);
  assert.equal(browser.getLocationRules().length, 1);
  const reset = await browser.send({ action: 'RESET_LOCATION' });
  assert.equal(reset.success, true);
  assert.deepEqual(browser.getLocationRules(), []);
  assert.ok(browser.commands.some(row => row[0] === 'Emulation.clearGeolocationOverride'));
  assert.equal(browser.stored[STORAGE_KEYS.JOB_STATE].locationApplied, false);
});

test('X-Geo installation failures do not report verified client location', async () => {
  const browser = makeMockBrowser({ headerFails: true });
  await browser.startWorker('client-xgeo-error');
  const result = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.com',
    location: { latitude: 38.8, longitude: -77.1, accuracy: 20 }
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Could not install Google X-Geo header/);
  assert.equal(browser.commands.some(row => row[0] === 'Emulation.setGeolocationOverride'), false);
  assert.deepEqual(browser.getLocationRules(), []);
});


test('switching client Google tabs ignores intentionally detached old debugger', async () => {
  const browser = makeMockBrowser({ emitDetachEvents: true });
  await browser.startWorker('client-xgeo-late-detach');
  const first = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.com',
    location: { latitude: 40.7128, longitude: -74.006, accuracy: 20 }
  });
  assert.equal(first.success, true);
  const next = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.co.in',
    location: { latitude: 28.6139, longitude: 77.209, accuracy: 20 }
  });
  assert.equal(next.success, true);
  assert.notEqual(next.tabId, first.tabId);
  await Promise.resolve();
  assert.equal(browser.getLocationRules().length, 1);
  assert.deepEqual(browser.getLocationRules()[0].condition.tabIds, [next.tabId]);
  assert.equal(browser.stored[STORAGE_KEYS.JOB_STATE].locationApplied, true);
  assert.equal(browser.stored[STORAGE_KEYS.JOB_STATE].locationState, 'ACTIVE');
});

test('Reset Location is not mistaken for unexpected debugger loss', async () => {
  const browser = makeMockBrowser({ emitDetachEvents: true });
  await browser.startWorker('client-xgeo-reset-detach');
  const apply = await browser.send({
    action: 'APPLY_LOCATION', googleDomain: 'google.com',
    location: { latitude: 40.7128, longitude: -74.006, accuracy: 20 }
  });
  assert.equal(apply.success, true);
  const reset = await browser.send({ action: 'RESET_LOCATION' });
  assert.equal(reset.success, true);
  await Promise.resolve();
  assert.equal(browser.stored[STORAGE_KEYS.JOB_STATE].locationState, 'NOT CONFIGURED');
  assert.deepEqual(browser.getLocationRules(), []);
});
