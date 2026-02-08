const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createChromeMock(initialStorage = {}) {
  const storage = { ...initialStorage };
  const counters = { get: 0, remove: 0 };

  return {
    counters,
    storage,
    chrome: {
      storage: {
        local: {
          async get(key) {
            counters.get += 1;
            if (Array.isArray(key)) {
              const out = {};
              key.forEach((k) => {
                out[k] = storage[k];
              });
              return out;
            }
            if (typeof key === 'string') {
              return { [key]: storage[key] };
            }
            return { ...storage };
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

function createStore(overrides = {}) {
  const threads = new Map();
  const messagesByThread = new Map();
  const meta = new Map();
  const calls = {
    createThread: 0,
    deleteMeta: 0,
    resetAllData: 0,
    setMeta: 0
  };

  let activeThreadId = null;
  let nextSequence = 1;
  let status = {
    historyEnabled: true,
    configured: false,
    unlocked: true,
    lockNewChatsByDefault: false
  };

  if (overrides.status) {
    status = { ...status, ...overrides.status };
  }
  if (overrides.meta) {
    Object.entries(overrides.meta).forEach(([k, v]) => meta.set(k, v));
  }
  if (Array.isArray(overrides.threads)) {
    overrides.threads.forEach((thread) => {
      threads.set(thread.chatId, { ...thread });
    });
  }
  if (Array.isArray(overrides.messages)) {
    overrides.messages.forEach((message) => {
      const key = message.chatId;
      const bucket = messagesByThread.get(key) || [];
      bucket.push({ ...message });
      messagesByThread.set(key, bucket);
      nextSequence = Math.max(nextSequence, (message.sequence || 0) + 1);
    });
  }
  if (typeof overrides.activeThreadId === 'string') {
    activeThreadId = overrides.activeThreadId;
  }

  function threadList(limit = 250) {
    return Array.from(threads.values()).slice(0, limit);
  }

  function bumpThreadPreview(chatId, content, timestamp) {
    const thread = threads.get(chatId);
    if (!thread) return;
    thread.updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
    thread.lastPreview = String(content || '').slice(0, 120);
    thread.messageCount = Number.isFinite(thread.messageCount) ? thread.messageCount + 1 : 1;
  }

  const store = {
    calls,
    async openDb() {
      return true;
    },
    async getStatus() {
      return { ...status };
    },
    async configureEncryption() {
      status.configured = true;
      status.unlocked = true;
      return { ...status };
    },
    async setHistoryEnabled(enabled) {
      status.historyEnabled = Boolean(enabled);
      return { ...status };
    },
    async setProtectionMode() {
      return { ...status };
    },
    async setLockNewChatsByDefault(enabled) {
      status.lockNewChatsByDefault = Boolean(enabled);
      return { ...status };
    },
    async unlock() {
      status.unlocked = true;
      return { ...status };
    },
    async lock() {
      status.unlocked = false;
      return { ...status };
    },
    async resetProtection() {
      status.configured = false;
      status.unlocked = true;
      return { ...status };
    },
    async disableProtection() {
      status.configured = false;
      status.unlocked = true;
      return { ...status };
    },
    async protectThread(chatId) {
      const thread = threads.get(chatId);
      if (!thread) throw new Error('not found');
      return { ...thread, locked: true };
    },
    async unprotectThread(chatId) {
      const thread = threads.get(chatId);
      if (!thread) throw new Error('not found');
      return { ...thread, locked: false };
    },
    async resetAllData() {
      calls.resetAllData += 1;
      threads.clear();
      messagesByThread.clear();
      meta.clear();
      activeThreadId = null;
      nextSequence = 1;
      return true;
    },
    async getMeta(key) {
      return meta.has(key) ? meta.get(key) : null;
    },
    async setMeta(key, value) {
      calls.setMeta += 1;
      meta.set(key, value);
      return true;
    },
    async deleteMeta(key) {
      calls.deleteMeta += 1;
      meta.delete(key);
      return true;
    },
    async listThreads({ limit = 250 } = {}) {
      return { threads: threadList(limit) };
    },
    async createThread(thread) {
      calls.createThread += 1;
      const chatId = thread.threadId || thread.chatId;
      const created = {
        chatId,
        title: thread.title || 'New chat',
        createdAt: thread.createdAt || Date.now(),
        updatedAt: thread.updatedAt || Date.now(),
        messageCount: 0,
        lastPreview: '',
        titleIsDefault: Boolean(thread.titleIsDefault)
      };
      threads.set(chatId, created);
      return { ...created };
    },
    async getThreadSummary(chatId) {
      const value = threads.get(chatId);
      return value ? { ...value } : null;
    },
    async setActiveThreadId(chatId) {
      activeThreadId = chatId || null;
    },
    async getActiveThreadId() {
      return activeThreadId;
    },
    async renameThread(chatId, title) {
      const thread = threads.get(chatId);
      if (!thread) {
        const error = new Error('Chat not found');
        error.code = 'CHAT_NOT_FOUND';
        throw error;
      }
      thread.title = title;
      thread.updatedAt = Date.now();
      return { ...thread };
    },
    async deleteThread(chatId) {
      threads.delete(chatId);
      messagesByThread.delete(chatId);
      if (activeThreadId === chatId) activeThreadId = null;
      return true;
    },
    async appendMessage(chatId, message) {
      const bucket = messagesByThread.get(chatId) || [];
      const saved = {
        ...message,
        chatId,
        sequence: nextSequence++
      };
      bucket.push(saved);
      messagesByThread.set(chatId, bucket);
      bumpThreadPreview(chatId, message.content, message.timestamp);
      return { ...saved };
    },
    async listMessages(chatId, { limit = 60, beforeSequence = null } = {}) {
      const source = (messagesByThread.get(chatId) || []).slice();
      let filtered = source;
      if (Number.isFinite(beforeSequence)) {
        filtered = source.filter((msg) => Number(msg.sequence) < Number(beforeSequence));
      }
      const page = filtered.slice(Math.max(0, filtered.length - limit));
      const hasMore = filtered.length > page.length;
      const nextCursorSequence = hasMore && page.length > 0 ? page[0].sequence : null;
      return { messages: page, hasMore, nextCursorSequence };
    },
    async getThreadWithMessages(chatId, { limit = 60 } = {}) {
      const thread = threads.get(chatId);
      if (!thread) {
        const error = new Error('Chat not found');
        error.code = 'CHAT_NOT_FOUND';
        throw error;
      }
      const page = await store.listMessages(chatId, { limit });
      return { thread: { ...thread }, page };
    }
  };

  return store;
}

function loadHistoryServiceFactory() {
  const context = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const file = path.resolve(__dirname, '../src/background/history-chat-service.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { context, createHistoryChatService: context.createHistoryChatService };
}

async function invokeHandler(service, message) {
  return new Promise((resolve, reject) => {
    const handled = service.handleHistoryAndChatMessage(message, (response) => {
      resolve(response);
    });
    if (!handled) {
      reject(new Error(`Message not handled: ${message.type}`));
      return;
    }
    setTimeout(() => reject(new Error(`Timed out waiting for response: ${message.type}`)), 400);
  });
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
  await runTest('loadChatsState creates a default chat when none exist', async () => {
    const { context, createHistoryChatService } = loadHistoryServiceFactory();
    const store = createStore({ meta: { migrationVersion: 1 } });
    context.mlcHistoryStore = store;
    const chromeMock = createChromeMock({});
    const service = createHistoryChatService({
      chrome: chromeMock.chrome,
      sendMessageToPopup: () => {},
      CHATS_KEY: 'mlc_chats_v2',
      HISTORY_PAGE_SIZE: 60,
      clearDeliveryStateForChat: () => {},
      clearAllDeliveryState: () => {},
      getChatDeliveryStateKey: () => 'meta-key',
      isSupportedProviderKey: () => true
    });

    const state = await service.loadChatsState();
    assert.ok(state.activeChatId);
    assert.equal(state.chats.length, 1);
    assert.equal(store.calls.createThread, 1);
  });

  await runTest('deleteChat clears per-chat delivery meta/cache', async () => {
    const { context, createHistoryChatService } = loadHistoryServiceFactory();
    const store = createStore({
      meta: { migrationVersion: 1, 'state:chat_a': { deliveredUpTo: 3 } },
      activeThreadId: 'chat_a',
      threads: [{ chatId: 'chat_a', title: 'A', createdAt: 1, updatedAt: 1, messageCount: 0, lastPreview: '' }]
    });
    context.mlcHistoryStore = store;
    const cleared = [];
    const service = createHistoryChatService({
      chrome: createChromeMock({}).chrome,
      sendMessageToPopup: () => {},
      CHATS_KEY: 'mlc_chats_v2',
      HISTORY_PAGE_SIZE: 60,
      clearDeliveryStateForChat: (chatId) => cleared.push(chatId),
      clearAllDeliveryState: () => {},
      getChatDeliveryStateKey: (chatId) => `state:${chatId}`,
      isSupportedProviderKey: () => true
    });

    const result = await service.deleteChat('chat_a');
    assert.equal(result.ok, true);
    assert.equal(store.calls.deleteMeta, 1);
    assert.deepEqual(cleared, ['chat_a']);
  });

  await runTest('HISTORY_CLEAR_ALL resets migration state and clears delivery cache', async () => {
    const { context, createHistoryChatService } = loadHistoryServiceFactory();
    const chatsKey = 'mlc_chats_v2';
    const firstLegacy = {
      [chatsKey]: {
        activeChatId: 'legacy_chat_a',
        chats: [
          {
            chatId: 'legacy_chat_a',
            title: 'Legacy A',
            createdAt: 1,
            updatedAt: 2,
            messages: [{ role: 'user', content: 'hi', timestamp: 1 }]
          }
        ]
      }
    };
    const chromeMock = createChromeMock(firstLegacy);
    const store = createStore({ meta: { migrationVersion: 0 }, status: { configured: false, unlocked: true } });
    context.mlcHistoryStore = store;

    let clearAllCount = 0;
    const service = createHistoryChatService({
      chrome: chromeMock.chrome,
      sendMessageToPopup: () => {},
      CHATS_KEY: chatsKey,
      HISTORY_PAGE_SIZE: 60,
      clearDeliveryStateForChat: () => {},
      clearAllDeliveryState: () => {
        clearAllCount += 1;
      },
      getChatDeliveryStateKey: () => 'state:key',
      isSupportedProviderKey: () => true
    });

    await service.loadChatsState();
    const createdBeforeReset = store.calls.createThread;
    assert.ok(createdBeforeReset >= 1);

    chromeMock.storage[chatsKey] = {
      activeChatId: 'legacy_chat_b',
      chats: [
        {
          chatId: 'legacy_chat_b',
          title: 'Legacy B',
          createdAt: 3,
          updatedAt: 4,
          messages: [{ role: 'assistant', content: 'hello', timestamp: 2 }]
        }
      ]
    };

    const response = await invokeHandler(service, { type: 'HISTORY_CLEAR_ALL' });
    assert.equal(response.ok, true);
    assert.equal(clearAllCount, 1);

    await service.loadChatsState();
    assert.ok(store.calls.createThread > createdBeforeReset);
  });

  await runTest('GET_CHAT returns expected shape', async () => {
    const { context, createHistoryChatService } = loadHistoryServiceFactory();
    const store = createStore({
      meta: { migrationVersion: 1 },
      threads: [{ chatId: 'chat_shape', title: 'Shape', createdAt: 1, updatedAt: 2, messageCount: 0, lastPreview: '' }],
      messages: [{ chatId: 'chat_shape', role: 'user', content: 'hello', timestamp: 10, sequence: 1 }]
    });
    context.mlcHistoryStore = store;
    const service = createHistoryChatService({
      chrome: createChromeMock({}).chrome,
      sendMessageToPopup: () => {},
      CHATS_KEY: 'mlc_chats_v2',
      HISTORY_PAGE_SIZE: 60,
      clearDeliveryStateForChat: () => {},
      clearAllDeliveryState: () => {},
      getChatDeliveryStateKey: () => 'state:key',
      isSupportedProviderKey: () => true
    });

    const response = await invokeHandler(service, { type: 'GET_CHAT', chatId: 'chat_shape' });
    assert.equal(response.ok, true);
    assert.ok(response.chat);
    assert.equal(response.chat.chatId, 'chat_shape');
    assert.ok(Array.isArray(response.chat.messages));
    assert.ok(Object.prototype.hasOwnProperty.call(response.chat, 'nextCursorSequence'));
    assert.ok(Object.prototype.hasOwnProperty.call(response.chat, 'hasMore'));
  });

  await runTest('migration early-exits when history is locked before unlock', async () => {
    const { context, createHistoryChatService } = loadHistoryServiceFactory();
    const chatsKey = 'mlc_chats_v2';
    const chromeMock = createChromeMock({
      [chatsKey]: {
        activeChatId: 'legacy_locked',
        chats: [
          {
            chatId: 'legacy_locked',
            title: 'Legacy Locked',
            createdAt: 1,
            updatedAt: 2,
            messages: [{ role: 'user', content: 'locked', timestamp: 1 }]
          }
        ]
      }
    });
    const store = createStore({
      meta: { migrationVersion: 0 },
      status: {
        configured: true,
        unlocked: false,
        lockNewChatsByDefault: true
      }
    });
    context.mlcHistoryStore = store;
    const service = createHistoryChatService({
      chrome: chromeMock.chrome,
      sendMessageToPopup: () => {},
      CHATS_KEY: chatsKey,
      HISTORY_PAGE_SIZE: 60,
      clearDeliveryStateForChat: () => {},
      clearAllDeliveryState: () => {},
      getChatDeliveryStateKey: () => 'state:key',
      isSupportedProviderKey: () => true
    });

    const state = await service.loadChatsState({ ensureActive: false });
    assert.equal(state.activeChatId, null);
    assert.equal(state.chats.length, 0);
    assert.equal(store.calls.createThread, 0);
    assert.equal(store.calls.setMeta, 0);
    assert.equal(chromeMock.counters.get, 0);
  });
})();
