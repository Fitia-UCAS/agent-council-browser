const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMessageRouterFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/message-router.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.createBackgroundMessageRouter;
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
  const createBackgroundMessageRouter = loadMessageRouterFactory();

  await runTest('delegated handlers are called exactly once', async () => {
    let historyCalls = 0;
    const router = createBackgroundMessageRouter({
      historyChatService: {
        handleHistoryAndChatMessage(message, sendResponse) {
          historyCalls += 1;
          sendResponse({ ok: true, from: 'history' });
          return true;
        }
      },
      historyMessageTypes: new Set(['GET_CHAT']),
      handlersByType: {
        GET_PROVIDER_CAPABILITIES: () => {
          throw new Error('should not hit core handler');
        }
      }
    });

    let payload = null;
    const keepOpen = router.handleMessage({ type: 'GET_CHAT' }, {}, (out) => {
      payload = out;
    });

    assert.equal(keepOpen, true);
    assert.equal(historyCalls, 1);
    assert.equal(payload.ok, true);
    assert.equal(payload.from, 'history');
  });

  await runTest('runtime handlers preserve async channel-open semantics', async () => {
    const router = createBackgroundMessageRouter({
      sessionRuntimeService: {
        handleRuntimeMessage(message, sendResponse) {
          if (message.type === 'RESUME_SESSION') {
            sendResponse({ ok: true });
            return true;
          }
          sendResponse({ status: 'run_started' });
          return false;
        }
      },
      sessionRuntimeMessageTypes: new Set(['RESUME_SESSION', 'START_RUN'])
    });

    let payload = null;
    let keepOpen = router.handleMessage({ type: 'RESUME_SESSION' }, {}, (out) => {
      payload = out;
    });
    assert.equal(keepOpen, true);
    assert.equal(payload.ok, true);

    payload = null;
    keepOpen = router.handleMessage({ type: 'START_RUN' }, {}, (out) => {
      payload = out;
    });
    assert.equal(keepOpen, false);
    assert.equal(payload.status, 'run_started');
  });

  await runTest('service unavailable and unknown fallback payloads remain stable', async () => {
    const router = createBackgroundMessageRouter({
      profileMessageTypes: new Set(['CHECK_CONNECTION']),
      handlersByType: {
        LIST_LLM_TABS: ({ sendResponse }) => {
          sendResponse({ status: 'listing_tabs' });
          return false;
        }
      },
      unknownHandler: ({ sendResponse }) => {
        sendResponse({ status: 'unknown_message_type' });
        return false;
      }
    });

    let payload = null;
    let keepOpen = router.handleMessage({ type: 'CHECK_CONNECTION' }, {}, (out) => {
      payload = out;
    });
    assert.equal(keepOpen, false);
    assert.equal(payload.code, 'SERVICE_UNAVAILABLE');

    payload = null;
    keepOpen = router.handleMessage({ type: 'LIST_LLM_TABS' }, {}, (out) => {
      payload = out;
    });
    assert.equal(keepOpen, false);
    assert.equal(payload.status, 'listing_tabs');

    payload = null;
    keepOpen = router.handleMessage({ type: 'NOT_HANDLED' }, {}, (out) => {
      payload = out;
    });
    assert.equal(keepOpen, false);
    assert.equal(payload.status, 'unknown_message_type');
  });
})();
