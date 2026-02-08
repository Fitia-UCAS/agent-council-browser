const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadProfileServiceFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/profile-service.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.createProfileService;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await delay(5);
  }
  return false;
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

(async () => {
  const createProfileService = loadProfileServiceFactory();

  await runTest('deriveProfileStatus returns offline/unknown/wrong_host/ok', async () => {
    const service = createProfileService({
      getTabUrlCandidate: (tab) => tab?.url || tab?.pendingUrl || '',
      isExpectedHost: (provider, url) => {
        const host = new URL(url).hostname;
        return provider === 'chatgpt' ? host.endsWith('chatgpt.com') : host.endsWith('gemini.google.com');
      }
    });

    assert.equal(service.deriveProfileStatus({ provider: 'chatgpt', tab: null }), 'offline');
    assert.equal(service.deriveProfileStatus({ provider: 'chatgpt', tabLookupFailed: true }), 'offline');
    assert.equal(service.deriveProfileStatus({ provider: 'chatgpt', tab: { id: 1 } }), 'unknown');
    assert.equal(
      service.deriveProfileStatus({ provider: 'chatgpt', tab: { id: 2, url: 'https://gemini.google.com/' } }),
      'wrong_host'
    );
    assert.equal(
      service.deriveProfileStatus({ provider: 'chatgpt', tab: { id: 3, url: 'https://chatgpt.com/' } }),
      'ok'
    );
  });

  await runTest('CHECK_CONNECTION routes through service and mirrors payload to popup + response', async () => {
    const popupMessages = [];
    let responsePayload = null;

    const service = createProfileService({
      sendMessageToPopup: (msg) => popupMessages.push(msg),
      checkConnectionStatus: async ({ profileIds }) => ({
        status: { chatgpt: true },
        profileStatus: Object.fromEntries(profileIds.map((id) => [id, true]))
      })
    });

    const handled = service.handleProfileMessage(
      { type: 'CHECK_CONNECTION', profileIds: ['p1', 'p2'] },
      {},
      (payload) => {
        responsePayload = payload;
      }
    );

    assert.equal(handled, true);
    assert.equal(await waitFor(() => responsePayload !== null), true);
    assert.equal(responsePayload.type, 'CONNECTION_STATUS');
    assert.equal(responsePayload.status.chatgpt, true);
    assert.equal(responsePayload.profileStatus.p1, true);
    assert.equal(popupMessages.length, 1);
    assert.equal(popupMessages[0].type, 'CONNECTION_STATUS');
  });

  await runTest('connection/profile actions delegate and return async channel-open', async () => {
    let connectCalled = false;
    let responsePayload = null;

    const service = createProfileService({
      connectProvider: async (provider, options) => {
        connectCalled = provider === 'chatgpt' && options?.focus === true;
        return { ok: true, provider };
      }
    });

    const handled = service.handleProfileMessage(
      { type: 'CONNECT_PROVIDER', provider: 'chatgpt' },
      {},
      (payload) => {
        responsePayload = payload;
      }
    );

    assert.equal(handled, true);
    assert.equal(await waitFor(() => responsePayload !== null), true);
    assert.equal(connectCalled, true);
    assert.equal(responsePayload.ok, true);
  });

  await runTest('tab lifecycle wrappers delegate with same gating behavior', async () => {
    const calls = {
      removed: 0,
      updated: 0,
      activated: 0,
      focused: 0
    };

    const service = createProfileService({
      handleTabRemoved: async () => { calls.removed += 1; },
      updateProfilesForTab: async () => { calls.updated += 1; },
      handleTabActivated: async () => { calls.activated += 1; },
      handleWindowFocusChanged: async () => { calls.focused += 1; }
    });

    service.onTabRemoved(1);
    service.onTabUpdated(2, { title: 'updated' }, { id: 2, url: 'https://chatgpt.com/' });
    service.onTabUpdated(2, { status: 'loading' }, { id: 2, url: 'https://chatgpt.com/' });
    service.onTabActivated({ tabId: 3 });
    service.onWindowFocusChanged(4);

    assert.equal(await waitFor(() => calls.removed === 1 && calls.updated === 1 && calls.activated === 1 && calls.focused === 1), true);
  });
})();
