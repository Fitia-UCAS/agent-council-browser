const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSessionRuntimeServiceFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/session-runtime-service.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.createSessionRuntimeService;
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
  const createSessionRuntimeService = loadSessionRuntimeServiceFactory();

  await runTest('capture messages route through enqueue + provider handlers', async () => {
    const calls = [];
    const service = createSessionRuntimeService({
      enqueueDebateResponse: (message, label) => calls.push(`enqueue:${message.type}:${label}`),
      handleGeminiResponse: () => calls.push('gemini'),
      handleChatGPTResponse: () => calls.push('chatgpt'),
      handleClaudeResponse: () => calls.push('claude'),
      handleGrokResponse: () => calls.push('grok')
    });

    let payload = null;
    assert.equal(service.handleRuntimeMessage({ type: 'GEMINI_RESPONSE_CAPTURED', sessionId: 's1' }, (out) => { payload = out; }), false);
    assert.equal(payload.status, 'gemini_response_received');

    payload = null;
    assert.equal(service.handleRuntimeMessage({ type: 'CHATGPT_RESPONSE_CAPTURED', sessionId: 's1' }, (out) => { payload = out; }), false);
    assert.equal(payload.status, 'chatgpt_response_received');

    payload = null;
    assert.equal(service.handleRuntimeMessage({ type: 'CLAUDE_RESPONSE_CAPTURED', sessionId: 's1' }, (out) => { payload = out; }), false);
    assert.equal(payload.status, 'claude_response_received');

    payload = null;
    assert.equal(service.handleRuntimeMessage({ type: 'GROK_RESPONSE_CAPTURED', sessionId: 's1' }, (out) => { payload = out; }), false);
    assert.equal(payload.status, 'grok_response_received');

    assert.deepEqual(calls, [
      'enqueue:GEMINI_RESPONSE_CAPTURED:Gemini response',
      'gemini',
      'enqueue:CHATGPT_RESPONSE_CAPTURED:ChatGPT response',
      'chatgpt',
      'enqueue:CLAUDE_RESPONSE_CAPTURED:Claude response',
      'claude',
      'enqueue:GROK_RESPONSE_CAPTURED:Grok response',
      'grok'
    ]);
  });

  await runTest('resume session keeps async channel-open and forwards result', async () => {
    let responsePayload = null;
    const service = createSessionRuntimeService({
      resumeDebateSession: async (sessionId, chatId) => ({ ok: true, sessionId, chatId })
    });

    const keepOpen = service.handleRuntimeMessage(
      { type: 'RESUME_SESSION', sessionId: 'sess_1', chatId: 'chat_1' },
      (payload) => {
        responsePayload = payload;
      }
    );

    assert.equal(keepOpen, true);
    assert.equal(await waitFor(() => responsePayload !== null), true);
    assert.equal(responsePayload.ok, true);
    assert.equal(responsePayload.sessionId, 'sess_1');
    assert.equal(responsePayload.chatId, 'chat_1');
  });

  await runTest('start/stop and multi-agent runtime messages preserve payload semantics', async () => {
    const started = [];
    const stopped = [];

    const service = createSessionRuntimeService({
      handleStartDebateSession: async (message) => {
        started.push(message);
      },
      handleStopDebateSession: async (message) => {
        stopped.push(message);
      }
    });

    let response = null;
    assert.equal(service.handleRuntimeMessage({ type: 'START_RUN', prompt: 'p' }, (out) => { response = out; }), false);
    assert.equal(response.status, 'run_started');

    response = null;
    assert.equal(service.handleRuntimeMessage({ type: 'STOP_SESSION', reason: 'user' }, (out) => { response = out; }), false);
    assert.equal(response.status, 'debate_session_stopped');

    response = null;
    assert.equal(
      service.handleRuntimeMessage({ type: 'START_MULTI_AGENT_SESSION', prompt: 'p2', sourceLLM: 'chatgpt', maxIterations: 4 }, (out) => { response = out; }),
      false
    );
    assert.equal(response.status, 'multi_agent_session_started');

    response = null;
    assert.equal(service.handleRuntimeMessage({ type: 'END_MULTI_AGENT_SESSION', reason: 'done' }, (out) => { response = out; }), false);
    assert.equal(response.status, 'multi_agent_session_ended');

    assert.equal(started.length, 2);
    assert.equal(started[1].firstLLM, 'chatgpt');
    assert.equal(started[1].rounds, 4);
    assert.equal(stopped.length, 2);
    assert.equal(stopped[1].reason, 'done');
  });

  await runTest('unknown message is not handled', async () => {
    const service = createSessionRuntimeService({});
    const handled = service.handleRuntimeMessage({ type: 'NOT_RUNTIME' }, () => {});
    assert.equal(handled, false);
  });
})();
