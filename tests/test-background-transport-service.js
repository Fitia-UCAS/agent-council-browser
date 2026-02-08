const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadTransportServiceFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/transport-service.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.createTransportService;
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
  const createTransportService = loadTransportServiceFactory();

  await runTest('transport wrappers preserve tab resolution fallback order behavior contract', async () => {
    const calls = [];
    const service = createTransportService({
      listLLMTabs: async (provider) => {
        calls.push(`list:${provider}`);
        return [{ id: provider === 'chatgpt' ? 1 : 2 }];
      },
      resolveTabForLLM: async (provider, requested, preferred) => {
        calls.push(`resolve:${provider}:${requested || 'none'}:${preferred || 'none'}`);
        return { tabId: 99 };
      },
      findLLMTab: async (provider) => {
        calls.push(`find:${provider}`);
        return { id: 7 };
      }
    });

    const tabs = await service.listLLMTabs('chatgpt');
    const resolved = await service.resolveTabForLLM('chatgpt', null, 123);
    const found = await service.findLLMTab('gemini');

    assert.equal(Array.isArray(tabs), true);
    assert.equal(tabs[0].id, 1);
    assert.equal(resolved.tabId, 99);
    assert.equal(found.id, 7);
    assert.deepEqual(calls, ['list:chatgpt', 'resolve:chatgpt:none:123', 'find:gemini']);
  });

  await runTest('transport wrappers surface send/injection failures unchanged', async () => {
    const expected = new Error('Tab not found');
    expected.code = 'TAB_NOT_FOUND';

    const service = createTransportService({
      processLLM: async () => { throw expected; },
      injectAndExecute: async () => { throw expected; }
    });

    let processFailed = false;
    try {
      await service.processLLM('chatgpt', 'hello');
    } catch (error) {
      processFailed = true;
      assert.equal(error.code, 'TAB_NOT_FOUND');
      assert.equal(error.message, 'Tab not found');
    }
    assert.equal(processFailed, true);

    let injectFailed = false;
    try {
      await service.injectAndExecute(1, 'chatgpt', 'hello');
    } catch (error) {
      injectFailed = true;
      assert.equal(error.code, 'TAB_NOT_FOUND');
    }
    assert.equal(injectFailed, true);
  });

  await runTest('attachment and interaction wrappers delegate per provider path', async () => {
    const calls = [];
    const service = createTransportService({
      injectAndPrepareAttachments: async (tabId, provider, attachments) => {
        calls.push(`prepare:${provider}:${attachments.length}`);
        return { ok: true, tabId, provider };
      },
      sendPromptViaClaudeDebugger: async (tabId, prompt) => {
        calls.push(`claude:${tabId}:${prompt.length}`);
        return { ok: true };
      },
      simpleInteraction: async (prompt, provider) => {
        calls.push(`simple:${provider}:${prompt.length}`);
        return { ok: true };
      }
    });

    const prepared = await service.injectAndPrepareAttachments(10, 'claude', [{ name: 'a.txt' }]);
    const claude = await service.sendPromptViaClaudeDebugger(10, 'hello');
    const simple = await service.simpleInteraction('hello', 'chatgpt');

    assert.equal(prepared.ok, true);
    assert.equal(claude.ok, true);
    assert.equal(simple.ok, true);
    assert.deepEqual(calls, ['prepare:claude:1', 'claude:10:5', 'simple:chatgpt:5']);
  });
})();
