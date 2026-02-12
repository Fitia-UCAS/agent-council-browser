(function historyBridgeModule(globalScope) {
    'use strict';

    function createHistoryBridge({ getStore } = {}) {
        if (typeof getStore !== 'function') {
            throw new Error('History bridge requires getStore().');
        }

        async function ensureStore() {
            const store = await getStore();
            if (!store) {
                const err = new Error('History store is unavailable.');
                err.code = 'HISTORY_STORE_UNAVAILABLE';
                throw err;
            }
            if (typeof store.openDb === 'function') {
                await store.openDb();
            }
            return store;
        }

        async function getStatus() {
            const store = await ensureStore();
            return store.getStatus();
        }

        async function withUnlocked(action) {
            if (typeof action !== 'function') {
                throw new Error('withUnlocked requires an action callback.');
            }
            const store = await ensureStore();
            return action(store);
        }

        async function listMessages(chatId, options = {}) {
            return withUnlocked((store) => store.listMessages(chatId, options));
        }

        async function getThreadWithMessages(chatId, options = {}) {
            return withUnlocked((store) => store.getThreadWithMessages(chatId, options));
        }

        async function appendMessage(chatId, message) {
            return withUnlocked((store) => store.appendMessage(chatId, message));
        }

        async function createThread(payload) {
            return withUnlocked((store) => store.createThread(payload));
        }

        async function updateThread(chatId, patch) {
            return withUnlocked((store) => store.updateThread(chatId, patch));
        }

        async function deleteThread(chatId) {
            return withUnlocked((store) => store.deleteThread(chatId));
        }

        return {
            ensureStore,
            getStatus,
            withUnlocked,
            listMessages,
            getThreadWithMessages,
            appendMessage,
            createThread,
            updateThread,
            deleteThread,
        };
    }

    globalScope.MLCHistoryBridge = {
        createHistoryBridge,
    };
})(typeof self !== 'undefined' ? self : window);
