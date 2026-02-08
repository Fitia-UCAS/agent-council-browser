const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPromptServiceFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/prompt-service.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.createPromptService;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
  const createPromptService = loadPromptServiceFactory();

  await runTest('prompt config message routing keeps async channel-open behavior', async () => {
    let getCalls = 0;
    let setCalls = 0;
    let resetCalls = 0;

    const service = createPromptService({
      getDebatePromptConfigForUi: async () => {
        getCalls += 1;
        return { ok: true, config: { debate: { header: 'h' } } };
      },
      setDebatePromptOverride: async (config) => {
        setCalls += 1;
        return { ok: true, config };
      },
      clearDebatePromptOverride: async () => {
        resetCalls += 1;
        return { ok: true };
      }
    });

    let getResponse = null;
    const getHandled = service.handlePromptMessage({ type: 'GET_DEBATE_PROMPTS' }, (payload) => {
      getResponse = payload;
    });
    assert.equal(getHandled, true);
    assert.equal(await waitFor(() => getResponse !== null), true);
    assert.equal(getCalls, 1);
    assert.equal(getResponse.ok, true);

    let setResponse = null;
    const setHandled = service.handlePromptMessage(
      { type: 'SET_DEBATE_PROMPTS', config: { debate: { header: 'new' } } },
      (payload) => {
        setResponse = payload;
      }
    );
    assert.equal(setHandled, true);
    assert.equal(await waitFor(() => setResponse !== null), true);
    assert.equal(setCalls, 1);
    assert.equal(setResponse.ok, true);

    let resetResponse = null;
    const resetHandled = service.handlePromptMessage({ type: 'RESET_DEBATE_PROMPTS' }, (payload) => {
      resetResponse = payload;
    });
    assert.equal(resetHandled, true);
    assert.equal(await waitFor(() => resetResponse !== null), true);
    assert.equal(resetCalls, 1);
    assert.equal(resetResponse.ok, true);
  });

  await runTest('unknown message is not handled by prompt service', async () => {
    const service = createPromptService({});
    const handled = service.handlePromptMessage({ type: 'NOT_PROMPT' }, () => {});
    assert.equal(handled, false);
  });

  await runTest('builder and delivery wrappers preserve behavior contracts', async () => {
    const service = createPromptService({
      buildDebatePrompt: async () => 'debate prompt',
      buildSinglePrompt: async () => 'single prompt',
      buildDirectPrompt: async () => 'direct prompt',
      buildSessionPrompt: async () => 'session prompt',
      getChatDeliveryStateKey: (chatId) => `k:${chatId}`,
      createEmptyDeliveryState: () => ({ schemaVersion: 2, providers: {} }),
      normalizeDeliveryProviderState: (value) => ({ ...value, normalized: true }),
      normalizeChatDeliveryState: (value) => ({ ...value, schemaVersion: 2 }),
      getProviderContextKey: () => 'profile:p1',
      getEffectiveDeliveredUpTo: () => 42
    });

    assert.equal(await service.buildDebatePrompt({}, 1), 'debate prompt');
    assert.equal(await service.buildSinglePrompt({}, 1), 'single prompt');
    assert.equal(await service.buildDirectPrompt({}, 1), 'direct prompt');
    assert.equal(await service.buildSessionPrompt({}, 1), 'session prompt');
    assert.equal(service.getChatDeliveryStateKey('chat_a'), 'k:chat_a');
    assert.equal(service.createEmptyDeliveryState().schemaVersion, 2);
    assert.equal(service.normalizeDeliveryProviderState({ deliveredUpTo: 1 }).normalized, true);
    assert.equal(service.normalizeChatDeliveryState({ providers: {} }).schemaVersion, 2);
    assert.equal(service.getProviderContextKey({}, 'chatgpt'), 'profile:p1');
    assert.equal(service.getEffectiveDeliveredUpTo({}, 'chatgpt', null), 42);
  });
})();
