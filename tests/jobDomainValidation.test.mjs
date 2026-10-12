import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../utils/storage.js';
import { supportedGoogleDomain } from '../utils/locationPreview.js';

function makeWorker({ savedDomain = 'google.com' } = {}) {
  const storage = {
    [STORAGE_KEYS.PROJECTS]: {
      imported: {
        config: {
          projectId: 'imported', projectName: 'Imported Client',
          googleDomain: savedDomain
        },
        keywords: []
      }
    },
    [STORAGE_KEYS.ACTIVE_PROJECT_ID]: 'imported'
  };
  let messageHandler;
  const navigation = [];
  globalThis.chrome = {
    storage: {
      session: {
        async get(key) { return { [key]: structuredClone(storage[key]) }; },
        async set(updates) { Object.assign(storage, structuredClone(updates)); }
      },
      local: {
        async get() { return {}; },
        async set() { throw new Error('Rejected job must not write preferences'); }
      }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { messageHandler = fn; } },
      async sendMessage() {}
    },
    debugger: { onDetach: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      async create(opts) { navigation.push(['create', opts]); throw new Error('Unexpected new search tab'); },
      async update(id, opts) { navigation.push(['update', opts]); throw new Error('Unexpected search navigation'); }
    }
  };
  return {
    async boot(label) {
      await import('../background.js?' + label);
      assert.equal(typeof messageHandler, 'function');
    },
    async start(settings) {
      return await new Promise(resolve => {
        const request = {
          action: 'START_JOB',
          projectId: 'imported',
          queue: [{ id: 'kw1', keyword: 'sensitive client phrase',
            targetUrl: 'https://client.example/', previousPosition: 5 }]
        };
        if (settings !== undefined) request.settings = settings;
        assert.equal(messageHandler(request, {}, resolve), true);
      });
    },
    navigation,
    storage
  };
}

test('untrusted Google-domain settings cannot receive a client keyword request', async () => {
  const mock = makeWorker();
  await mock.boot('reject-untrusted-job-domain');
  for (const invalidDomain of [
    'google.com.attacker.example', 'google.co.in.attacker.example',
    'example.com', 'GOOGLE.COM', 'google.com/search?q=private',
    'google.com:443', '//attacker.example'
  ]) {
    const response = await mock.start({ googleDomain: invalidDomain, useLocation: false });
    assert.equal(response.success, false, invalidDomain);
    assert.match(response.error || response.message, /unsupported Google Search country domain/i);
    assert.equal(mock.navigation.length, 0, invalidDomain);
    assert.equal(mock.storage[STORAGE_KEYS.JOB_STATE], undefined,
      'Invalid domain must not create an active job');
  }
});

test('an imported project with an unsupported Google domain is rejected before a rank check', async () => {
  const mock = makeWorker({ savedDomain: 'google.com.evil.example' });
  await mock.boot('reject-untrusted-imported-project-domain');
  const response = await mock.start();
  assert.equal(response.success, false);
  assert.match(response.error, /unsupported Google Search country domain/i);
  assert.deepEqual(mock.navigation, []);
});

test('all country domains permitted for real Google Search are in the runtime allowlist', () => {
  const supported = [
    'google.com', 'google.co.uk', 'google.ca', 'google.com.au',
    'google.co.in', 'google.de', 'google.fr', 'google.es',
    'google.it', 'google.co.nz', 'google.ie', 'google.com.sg',
    'google.com.mx', 'google.com.br'
  ];
  for (const domain of supported) {
    assert.equal(supportedGoogleDomain(domain), domain);
  }
});
