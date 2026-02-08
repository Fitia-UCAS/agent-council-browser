const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function createChromeMock() {
  const storage = {};
  return {
    storage,
    chrome: {
      storage: {
        local: {
          async get(key) {
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

function createStore() {
  const chat = {
    chatId: 'chat_1',
    title: 'New chat',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    lastPreview: 'hello'
  };
  const page = {
    messages: [{ role: 'user', content: 'hello', sequence: 1 }],
    nextCursorSequence: null,
    hasMore: false
  };

  return {
    async openDb() {
      return true;
    },
    async getStatus() {
      return {
        historyEnabled: true,
        configured: false,
        unlocked: true,
        lockNewChatsByDefault: false
      };
    },
    async getMeta(key) {
      if (key === 'migrationVersion') return 1;
      return null;
    },
    async setMeta() {
      return true;
    },
    async listThreads() {
      return { threads: [chat] };
    },
    async getActiveThreadId() {
      return chat.chatId;
    },
    async setActiveThreadId() {
      return true;
    },
    async getThreadWithMessages(chatId) {
      if (chatId !== chat.chatId) {
        const error = new Error('Chat not found');
        error.code = 'CHAT_NOT_FOUND';
        throw error;
      }
      return { thread: chat, page };
    }
  };
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
  await runTest('background wiring delegates history/chat routing to service', async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8');
    assert.ok(source.includes("importScripts('src/background/history-chat-service.js')"));
    assert.ok(source.includes('historyChatService?.handleHistoryAndChatMessage'));
    assert.ok(source.includes("code: 'SERVICE_UNAVAILABLE'"));

    const removedCases = [
      "case 'HISTORY_STATUS'",
      "case 'GET_CHATS_STATE'",
      "case 'GET_CHAT'",
      "case 'GET_MESSAGES_PAGE'",
      "case 'CREATE_CHAT'",
      "case 'SET_ACTIVE_CHAT'",
      "case 'RENAME_CHAT'",
      "case 'DELETE_CHAT'"
    ];
    removedCases.forEach((token) => {
      assert.equal(source.includes(token), false, `expected ${token} to be delegated out of switch`);
    });
  });

  await runTest('history service handler keeps async channel-open behavior and payload shape', async () => {
    const { context, createHistoryChatService } = loadHistoryServiceFactory();
    const { chrome } = createChromeMock();
    const store = createStore();
    context.mlcHistoryStore = store;

    const service = createHistoryChatService({
      chrome,
      sendMessageToPopup: () => {},
      CHATS_KEY: 'mlc_chats_v1',
      HISTORY_PAGE_SIZE: 60,
      clearDeliveryStateForChat: () => {},
      clearAllDeliveryState: () => {},
      getChatDeliveryStateKey: (chatId) => `meta:${chatId}`,
      isSupportedProviderKey: () => true
    });

    let chatsResponse = null;
    const chatsHandled = service.handleHistoryAndChatMessage({ type: 'GET_CHATS_STATE' }, (payload) => {
      chatsResponse = payload;
    });
    assert.equal(chatsHandled, true);
    assert.equal(await waitFor(() => chatsResponse !== null), true);
    assert.equal(chatsResponse.ok, true);
    assert.equal(chatsResponse.activeChatId, 'chat_1');
    assert.equal(Array.isArray(chatsResponse.chats), true);

    let chatResponse = null;
    const chatHandled = service.handleHistoryAndChatMessage({ type: 'GET_CHAT', chatId: 'chat_1' }, (payload) => {
      chatResponse = payload;
    });
    assert.equal(chatHandled, true);
    assert.equal(await waitFor(() => chatResponse !== null), true);
    assert.equal(chatResponse.ok, true);
    assert.equal(chatResponse.chat.chatId, 'chat_1');
    assert.equal(Array.isArray(chatResponse.chat.messages), true);
    assert.equal(typeof chatResponse.chat.hasMore, 'boolean');
    assert.ok(Object.prototype.hasOwnProperty.call(chatResponse.chat, 'nextCursorSequence'));

    const unknownHandled = service.handleHistoryAndChatMessage({ type: 'NOT_A_HISTORY_TYPE' }, () => {});
    assert.equal(unknownHandled, false);

    delete context.mlcHistoryStore;
  });
})();
