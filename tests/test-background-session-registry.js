const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createChromeMock(initialStorage = {}) {
  const storage = { ...initialStorage };
  const counters = { set: 0, remove: 0 };

  return {
    storage,
    counters,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              const out = {};
              keys.forEach((key) => {
                out[key] = storage[key];
              });
              return out;
            }
            if (typeof keys === 'string') {
              return { [keys]: storage[keys] };
            }
            return { ...storage };
          },
          async set(payload) {
            counters.set += 1;
            Object.assign(storage, payload);
            return true;
          },
          remove(key, callback) {
            counters.remove += 1;
            if (Array.isArray(key)) {
              key.forEach((k) => delete storage[k]);
            } else if (typeof key === 'string') {
              delete storage[key];
            }
            if (typeof callback === 'function') callback();
          }
        }
      }
    }
  };
}

function createHistoryStoreMock({ historyEnabled = true, messagesByChat = {} } = {}) {
  return {
    async getStatus() {
      return { historyEnabled };
    },
    async listMessages(chatId, { limit = 240, beforeSequence = null } = {}) {
      const source = Array.isArray(messagesByChat[chatId]) ? messagesByChat[chatId] : [];
      let filtered = source;
      if (Number.isFinite(beforeSequence)) {
        filtered = filtered.filter((msg) => Number(msg.sequence) < Number(beforeSequence));
      }
      const page = filtered.slice(Math.max(0, filtered.length - limit));
      const hasMore = filtered.length > page.length;
      const nextCursorSequence = hasMore && page.length > 0 ? page[0].sequence : null;
      return { messages: page, hasMore, nextCursorSequence };
    }
  };
}

function loadRegistryFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/session-registry.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.createSessionRegistry;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function makeRegistry({ storage, historyStore, getHistoryStatus } = {}) {
  const createSessionRegistry = loadRegistryFactory();
  const keys = {
    sessions: 'mlc_sessions_test',
    active: 'mlc_active_test'
  };
  const chromeMock = createChromeMock(storage || {});
  const registry = createSessionRegistry({
    chrome: chromeMock.chrome,
    SESSIONS_KEY: keys.sessions,
    ACTIVE_SESSION_KEY: keys.active,
    getHistoryStatus: getHistoryStatus || (async () => ({ historyEnabled: true })),
    ensureHistoryStoreReady: async () => historyStore || createHistoryStoreMock(),
    buildConversationContext: (messages) => (Array.isArray(messages) && messages.length ? 'ctx-ready' : ''),
    listSessionProviders: (session) => {
      const out = [];
      if (session?.firstLLM) out.push(session.firstLLM);
      if (session?.secondLLM && !out.includes(session.secondLLM)) out.push(session.secondLLM);
      return out;
    },
    formatLLMLabel: (provider) => String(provider || '').toUpperCase(),
    getSupportedProviderKeys: () => ['chatgpt', 'gemini', 'claude', 'grok'],
    normalizeProviderKey: (provider) => String(provider || '').trim().toLowerCase(),
    isSupportedProviderKey: (provider) => ['chatgpt', 'gemini', 'claude', 'grok'].includes(String(provider || '').toLowerCase())
  });
  return { registry, chromeMock, keys };
}

(async () => {
  await runTest('legacy active session migration path works', async () => {
    const legacySession = {
      sessionId: 'sess_legacy',
      isActive: true,
      startedAt: 10,
      firstLLM: 'chatgpt',
      secondLLM: 'gemini'
    };
    const { registry, chromeMock } = makeRegistry({
      storage: {
        mlc_active_test: legacySession
      }
    });

    const sessions = await registry.loadSessionsState();
    assert.equal(sessions.has('sess_legacy'), true);
    assert.equal(chromeMock.counters.remove >= 1, true);
    assert.equal(chromeMock.counters.set >= 1, true);
  });

  await runTest('session normalization populates participant/profile/tab defaults', async () => {
    const rawSession = {
      sessionId: 'sess_norm',
      isActive: true,
      startedAt: 20,
      mode: 'debate',
      route: {
        agents: [
          { id: 'agent_a', provider: 'chatgpt' },
          { id: 'agent_b', provider: 'gemini' }
        ]
      },
      profileIds: { chatgpt: 'profile_chatgpt' },
      tabIds: { chatgpt: 101 }
    };
    const { registry, chromeMock } = makeRegistry({
      storage: {
        mlc_sessions_test: {
          sess_norm: rawSession
        }
      },
      getHistoryStatus: async () => ({ historyEnabled: false })
    });

    await registry.loadSessionsState();
    const session = await registry.getSessionById('sess_norm');
    assert.ok(session);
    assert.equal(session.participants.length, 2);
    assert.equal(session.participants[0].agentId, 'agent_a');
    assert.equal(session.participants[0].profileId, 'profile_chatgpt');
    assert.equal(session.participants[1].provider, 'gemini');
    assert.equal(Object.prototype.hasOwnProperty.call(session.profileIds, 'gemini'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(session.tabIds, 'gemini'), true);
    assert.equal(chromeMock.counters.remove, 0);
  });

  await runTest('redaction occurs only when expected', async () => {
    const { registry, chromeMock } = makeRegistry({
      storage: {},
      getHistoryStatus: async () => ({ historyEnabled: true })
    });

    await registry.saveSession({
      sessionId: 'sess_redact',
      chatId: 'chat_redact',
      userMessageSequence: 3,
      userQuery: 'sensitive',
      conversationContext: 'ctx',
      messages: [{ role: 'user', content: 'private' }],
      isActive: true
    });

    await registry.saveSession({
      sessionId: 'sess_keep',
      chatId: 'chat_keep',
      userMessageSequence: null,
      userQuery: 'keep',
      conversationContext: 'keep_ctx',
      messages: [{ role: 'assistant', content: 'keep message' }],
      isActive: true
    });

    const stored = chromeMock.storage.mlc_sessions_test;
    assert.equal(stored.sess_redact.userQuery, '');
    assert.equal(stored.sess_redact.messages.length, 0);
    assert.equal(stored.sess_keep.userQuery, 'keep');
    assert.equal(stored.sess_keep.messages.length, 1);
  });

  await runTest('hydration repopulates missing messages and userQuery from history', async () => {
    const sessionId = 'sess_hydrate';
    const chatId = 'chat_hydrate';
    const historyStore = createHistoryStoreMock({
      historyEnabled: true,
      messagesByChat: {
        [chatId]: [
          { sessionId, role: 'user', content: 'User Q', sequence: 5, timestamp: 1 },
          { sessionId, role: 'chatgpt', content: 'Answer', sequence: 6, timestamp: 2 }
        ]
      }
    });

    const { registry } = makeRegistry({
      storage: {
        mlc_sessions_test: {
          [sessionId]: {
            sessionId,
            chatId,
            isActive: true,
            isFollowUp: true,
            userQuery: '',
            messages: []
          }
        }
      },
      historyStore
    });

    await registry.loadSessionsState();
    const hydrated = await registry.getSessionById(sessionId);
    assert.ok(hydrated);
    assert.equal(Array.isArray(hydrated.messages), true);
    assert.equal(hydrated.messages.length >= 2, true);
    assert.equal(hydrated.userQuery, 'User Q');
  });

  await runTest('pickMostRecentSession keeps selection behavior', async () => {
    const { registry } = makeRegistry({
      storage: {
        mlc_sessions_test: {
          a: { sessionId: 'a', isActive: true, startedAt: 10 },
          b: { sessionId: 'b', isPaused: true, startedAt: 50 },
          c: { sessionId: 'c', isActive: false, isPaused: false, startedAt: 100 }
        }
      }
    });
    await registry.loadSessionsState();
    const picked = registry.pickMostRecentSession();
    assert.ok(picked);
    assert.equal(picked.sessionId, 'b');
  });

  await runTest('enqueueResponse serializes tasks per session id', async () => {
    const { registry } = makeRegistry({ storage: {} });
    const order = [];

    const first = registry.enqueueResponse('sess_queue', async () => {
      order.push('first:start');
      await delay(25);
      order.push('first:end');
    });
    const second = registry.enqueueResponse('sess_queue', async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.all([first, second]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  });
})();
