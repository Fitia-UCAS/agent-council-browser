(function initHistoryChatService(global) {
    function createHistoryChatService(deps = {}) {
        const chromeApi = deps.chrome || global.chrome;
        const sendMessageToPopup = typeof deps.sendMessageToPopup === 'function' ? deps.sendMessageToPopup : () => {};
        const chatsStorageKey = typeof deps.CHATS_KEY === 'string' ? deps.CHATS_KEY : 'mlc_chats_v2';
        const historyPageSize = Number.isFinite(deps.HISTORY_PAGE_SIZE) ? deps.HISTORY_PAGE_SIZE : 60;
        const clearDeliveryStateForChat = typeof deps.clearDeliveryStateForChat === 'function'
            ? deps.clearDeliveryStateForChat
            : () => {};
        const clearAllDeliveryState = typeof deps.clearAllDeliveryState === 'function'
            ? deps.clearAllDeliveryState
            : () => {};
        const getChatDeliveryStateKey = typeof deps.getChatDeliveryStateKey === 'function'
            ? deps.getChatDeliveryStateKey
            : () => null;
        const isSupportedProviderKey = typeof deps.isSupportedProviderKey === 'function'
            ? deps.isSupportedProviderKey
            : () => false;

        let historyMigrationChecked = false;
        let historyMigrationPromise = null;

        function resetMigrationState() {
            historyMigrationChecked = false;
            historyMigrationPromise = null;
        }

        function generateChatId() {
            return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        function toChatSummary(chat) {
            if (!chat || typeof chat !== 'object') return null;
            const chatId = chat.chatId || chat.threadId;
            if (!chatId) return null;
            return {
                chatId,
                title: chat.title || 'New chat',
                createdAt: Number.isFinite(chat.createdAt) ? chat.createdAt : null,
                updatedAt: Number.isFinite(chat.updatedAt) ? chat.updatedAt : null,
                messageCount: Number.isFinite(chat.messageCount)
                    ? chat.messageCount
                    : (Array.isArray(chat.messages) ? chat.messages.length : 0),
                lastPreview: typeof chat.lastPreview === 'string' ? chat.lastPreview : undefined
            };
        }

        async function ensureHistoryStoreReady() {
            if (!global.mlcHistoryStore) {
                const err = new Error('History store is unavailable.');
                err.code = 'HISTORY_STORE_UNAVAILABLE';
                throw err;
            }
            await global.mlcHistoryStore.openDb();
            return global.mlcHistoryStore;
        }

        async function getHistoryStatus() {
            const store = await ensureHistoryStoreReady();
            return store.getStatus();
        }

        async function requireHistoryUnlocked() {
            const store = await ensureHistoryStoreReady();
            return store;
        }

        async function ensureLegacyChatsMigrated(store) {
            if (historyMigrationChecked) return;
            if (historyMigrationPromise) return historyMigrationPromise;

            historyMigrationPromise = (async () => {
                try {
                    const status = await store.getStatus().catch(() => null);
                    if (status?.configured && status?.lockNewChatsByDefault && !status?.unlocked) {
                        // New threads would be protected and require unlock; wait until unlock before migration.
                        return;
                    }

                    const version = await store.getMeta('migrationVersion');
                    if (Number(version) >= 1) {
                        historyMigrationChecked = true;
                        return;
                    }

                    const stored = await chromeApi.storage.local.get(chatsStorageKey);
                    const raw = stored?.[chatsStorageKey];
                    const chats = raw && typeof raw === 'object' && Array.isArray(raw.chats) ? raw.chats : [];
                    const legacyActiveChatId = raw && typeof raw === 'object' && typeof raw.activeChatId === 'string'
                        ? raw.activeChatId
                        : null;

                    if (!chats.length) {
                        await store.setMeta('migrationVersion', 1);
                        historyMigrationChecked = true;
                        return;
                    }

                    let importedChats = 0;
                    let importedMessages = 0;
                    let lockedFailure = false;

                    for (const legacyChat of chats) {
                        const chatId = typeof legacyChat?.chatId === 'string' && legacyChat.chatId
                            ? legacyChat.chatId
                            : generateChatId();

                        const existing = await store.getThreadSummary(chatId);
                        if (existing) continue;

                        const createdAt = Number.isFinite(legacyChat?.createdAt) ? legacyChat.createdAt : Date.now();
                        const updatedAt = Number.isFinite(legacyChat?.updatedAt) ? legacyChat.updatedAt : createdAt;
                        const titleRaw = typeof legacyChat?.title === 'string' ? legacyChat.title : 'New chat';
                        const title = titleRaw.trim() ? titleRaw : 'New chat';
                        const titleIsDefault = title === 'New chat';

                        try {
                            await store.createThread({
                                threadId: chatId,
                                title,
                                createdAt,
                                updatedAt,
                                titleIsDefault
                            });
                            importedChats += 1;
                        } catch (error) {
                            if (error?.code === 'HISTORY_LOCKED') {
                                lockedFailure = true;
                                break;
                            }
                            console.warn('[MLC History] Failed to create thread during migration:', error);
                            continue;
                        }

                        const messages = Array.isArray(legacyChat?.messages) ? legacyChat.messages : [];
                        for (const legacyMessage of messages) {
                            const content = String(legacyMessage?.content || '');
                            if (!content.trim()) continue;
                            const role = legacyMessage?.role || 'assistant';
                            const timestamp = Number.isFinite(legacyMessage?.timestamp) ? legacyMessage.timestamp : Date.now();
                            const contentHtml = typeof legacyMessage?.contentHtml === 'string' ? legacyMessage.contentHtml : undefined;
                            try {
                                await store.appendMessage(chatId, {
                                    role,
                                    content,
                                    contentHtml,
                                    timestamp,
                                    sessionId: legacyMessage?.sessionId || undefined,
                                    turnIndex: Number.isFinite(legacyMessage?.turnIndex) ? legacyMessage.turnIndex : undefined,
                                    roundIndex: Number.isFinite(legacyMessage?.roundIndex) ? legacyMessage.roundIndex : undefined
                                });
                                importedMessages += 1;
                            } catch (error) {
                                if (error?.code === 'HISTORY_LOCKED') {
                                    lockedFailure = true;
                                    break;
                                }
                                console.warn('[MLC History] Failed to migrate message:', error);
                            }
                        }
                        if (lockedFailure) break;
                    }

                    if (lockedFailure) return;

                    const currentActive = await store.getActiveThreadId();
                    if (!currentActive && legacyActiveChatId) {
                        const migratedActive = await store.getThreadSummary(legacyActiveChatId);
                        if (migratedActive) {
                            await store.setActiveThreadId(legacyActiveChatId);
                        }
                    }

                    await store.setMeta('migrationVersion', 1);
                    historyMigrationChecked = true;
                    await new Promise((resolve) => chromeApi.storage.local.remove(chatsStorageKey, resolve));
                    console.log('[MLC History] Migration complete.', { importedChats, importedMessages });
                } catch (error) {
                    console.error('[MLC History] Migration failed:', error);
                }
            })().finally(() => {
                historyMigrationPromise = null;
            });

            return historyMigrationPromise;
        }

        async function loadChatsState({ ensureActive = true } = {}) {
            const store = await requireHistoryUnlocked();
            await ensureLegacyChatsMigrated(store);
            const { threads } = await store.listThreads({ limit: 250 });
            let activeChatId = await store.getActiveThreadId();
            const hasActive = activeChatId && threads.some((thread) => thread.chatId === activeChatId);

            if (!ensureActive) {
                return { activeChatId: hasActive ? activeChatId : null, chats: threads };
            }

            if (!threads.length) {
                const chatId = generateChatId();
                await store.createThread({ threadId: chatId, title: 'New chat', titleIsDefault: true });
                await store.setActiveThreadId(chatId);
                const refreshed = await store.listThreads({ limit: 250 });
                return { activeChatId: chatId, chats: refreshed.threads };
            }

            if (!hasActive) {
                activeChatId = threads[0].chatId;
                await store.setActiveThreadId(activeChatId);
            }

            return { activeChatId, chats: threads };
        }

        async function notifyChatsState(stateOverride = null) {
            try {
                const state = stateOverride || await loadChatsState();
                sendMessageToPopup({
                    type: 'CHATS_STATE',
                    activeChatId: state.activeChatId,
                    chats: state.chats
                });
            } catch (error) {
                const status = await getHistoryStatus().catch(() => ({ configured: false, unlocked: false }));
                sendMessageToPopup({ type: 'HISTORY_STATUS', status, error: error?.message });
            }
        }

        async function createChat({ makeActive = true } = {}) {
            const store = await requireHistoryUnlocked();
            const chatId = generateChatId();
            await store.createThread({ threadId: chatId, title: 'New chat', titleIsDefault: true });
            if (makeActive) {
                await store.setActiveThreadId(chatId);
            }
            const chat = await store.getThreadSummary(chatId);
            const state = await loadChatsState({ ensureActive: false });
            await notifyChatsState(state);
            return {
                ok: true,
                chat: { ...chat, messages: [] },
                state: { ...state, activeChatId: makeActive ? chatId : state.activeChatId }
            };
        }

        async function setActiveChat(chatId) {
            const store = await requireHistoryUnlocked();
            const chat = await store.getThreadSummary(chatId);
            if (!chat) {
                return { ok: false, error: 'Chat not found.', code: 'CHAT_NOT_FOUND' };
            }
            await store.setActiveThreadId(chatId);
            const state = await loadChatsState({ ensureActive: false });
            await notifyChatsState(state);
            return { ok: true, chat: { ...chat, messages: [] }, state };
        }

        async function renameChat(chatId, title) {
            const store = await requireHistoryUnlocked();
            try {
                const updated = await store.renameThread(chatId, title);
                await notifyChatsState();
                return { ok: true, chat: updated };
            } catch (error) {
                return { ok: false, error: error.message, code: error.code || 'RENAME_FAILED' };
            }
        }

        async function deleteChat(chatId) {
            const store = await requireHistoryUnlocked();
            const chat = await store.getThreadSummary(chatId);
            if (!chat) return { ok: false, error: 'Chat not found.', code: 'CHAT_NOT_FOUND' };

            await store.deleteThread(chatId);
            try {
                const key = getChatDeliveryStateKey(chatId);
                if (key) await store.deleteMeta(key);
            } catch (error) {
                // ignore
            }
            clearDeliveryStateForChat(chatId);
            const activeChatId = await store.getActiveThreadId();
            if (activeChatId === chatId) {
                const { threads } = await store.listThreads({ limit: 1 });
                await store.setActiveThreadId(threads[0]?.chatId || null);
            }
            const state = await loadChatsState({ ensureActive: true });
            await notifyChatsState(state);
            return { ok: true, state };
        }

        async function appendChatMessage(chatId, message) {
            if (!chatId || !message) return { ok: false, error: 'Missing chatId or message.' };
            try {
                const store = await requireHistoryUnlocked();
                const provider = isSupportedProviderKey(message.role) ? message.role : null;
                const saved = await store.appendMessage(chatId, { ...message, provider });
                await notifyChatsState();
                return { ok: true, message: saved };
            } catch (error) {
                console.warn('[MLC Chats] Failed to persist message:', error);
                return { ok: false, error: error.message, code: error.code || 'APPEND_MESSAGE_FAILED' };
            }
        }

        function handleHistoryAndChatMessage(message, sendResponse) {
            if (!message || !message.type) return false;

            switch (message.type) {
                case 'HISTORY_STATUS':
                    getHistoryStatus().then((status) => {
                        sendResponse({ ok: true, status });
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_STATUS_FAILED' });
                    });
                    return true;
                case 'HISTORY_CONFIGURE':
                    ensureHistoryStoreReady().then((store) => store.configureEncryption(message.passphrase, { mode: message.protectionMode })).then((status) => {
                        sendResponse({ ok: true, status });
                        notifyChatsState().catch(() => {});
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_CONFIGURE_FAILED' });
                    });
                    return true;
                case 'HISTORY_SET_ENABLED':
                    ensureHistoryStoreReady().then((store) => store.setHistoryEnabled(Boolean(message.enabled))).then((status) => {
                        sendResponse({ ok: true, status });
                        notifyChatsState().catch(() => {});
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_SET_ENABLED_FAILED' });
                    });
                    return true;
                case 'HISTORY_SET_PROTECTION_MODE':
                    ensureHistoryStoreReady().then((store) => store.setProtectionMode(message.protectionMode)).then((status) => {
                        sendResponse({ ok: true, status });
                        notifyChatsState().catch(() => {});
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_SET_PROTECTION_MODE_FAILED' });
                    });
                    return true;
                case 'HISTORY_SET_LOCK_NEW_CHATS':
                    ensureHistoryStoreReady().then((store) => store.setLockNewChatsByDefault(Boolean(message.enabled))).then((status) => {
                        sendResponse({ ok: true, status });
                        notifyChatsState().catch(() => {});
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_SET_LOCK_NEW_CHATS_FAILED' });
                    });
                    return true;
                case 'HISTORY_UNLOCK':
                    ensureHistoryStoreReady().then((store) => store.unlock(message.passphrase)).then((status) => {
                        sendResponse({ ok: true, status });
                        notifyChatsState().catch(() => {});
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_UNLOCK_FAILED' });
                    });
                    return true;
                case 'HISTORY_LOCK':
                    ensureHistoryStoreReady().then((store) => store.lock()).then((status) => {
                        sendResponse({ ok: true, status });
                        notifyChatsState().catch(() => {});
                    }).catch((error) => {
                        sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_LOCK_FAILED' });
                    });
                    return true;
                case 'HISTORY_RESET_PROTECTION':
                    ensureHistoryStoreReady()
                        .then((store) => store.resetProtection())
                        .then((status) => {
                            clearAllDeliveryState();
                            sendResponse({ ok: true, status });
                            notifyChatsState().catch(() => {});
                        })
                        .catch((error) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_RESET_PROTECTION_FAILED' });
                        });
                    return true;
                case 'HISTORY_DISABLE_PROTECTION':
                    ensureHistoryStoreReady()
                        .then((store) => store.disableProtection(message.passphrase))
                        .then((status) => {
                            clearAllDeliveryState();
                            sendResponse({ ok: true, status });
                            notifyChatsState().catch(() => {});
                        })
                        .catch((error) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_DISABLE_PROTECTION_FAILED' });
                        });
                    return true;
                case 'PROTECT_CHAT':
                    ensureHistoryStoreReady()
                        .then((store) => store.protectThread(message.chatId))
                        .then((chat) => {
                            sendResponse({ ok: true, chat });
                            notifyChatsState().catch(() => {});
                        })
                        .catch((error) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'PROTECT_CHAT_FAILED' });
                        });
                    return true;
                case 'UNPROTECT_CHAT':
                    ensureHistoryStoreReady()
                        .then((store) => store.unprotectThread(message.chatId))
                        .then((chat) => {
                            sendResponse({ ok: true, chat });
                            notifyChatsState().catch(() => {});
                        })
                        .catch((error) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'UNPROTECT_CHAT_FAILED' });
                        });
                    return true;
                case 'HISTORY_CLEAR_ALL':
                    ensureHistoryStoreReady()
                        .then((store) => store.resetAllData())
                        .then(() => new Promise((resolve) => chromeApi.storage.local.remove(chatsStorageKey, resolve)))
                        .then(() => {
                            resetMigrationState();
                            clearAllDeliveryState();
                        })
                        .then(() => getHistoryStatus())
                        .then((status) => {
                            sendResponse({ ok: true, status });
                            notifyChatsState().catch(() => {});
                        })
                        .catch((error) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_CLEAR_ALL_FAILED' });
                        });
                    return true;
                case 'HISTORY_RESET':
                    ensureHistoryStoreReady()
                        .then((store) => store.resetAllData())
                        .then(() => new Promise((resolve) => chromeApi.storage.local.remove(chatsStorageKey, resolve)))
                        .then(() => {
                            resetMigrationState();
                            clearAllDeliveryState();
                        })
                        .then(() => getHistoryStatus())
                        .then((status) => {
                            sendResponse({ ok: true, status });
                            notifyChatsState().catch(() => {});
                        })
                        .catch((error) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_RESET_FAILED' });
                        });
                    return true;
                case 'GET_CHATS_STATE':
                    loadChatsState().then((state) => {
                        sendResponse({
                            ok: true,
                            activeChatId: state.activeChatId,
                            chats: state.chats
                        });
                    }).catch((error) => {
                        console.error('[MLC Chats] Error loading chats:', error);
                        getHistoryStatus().then((status) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHATS_FAILED', status });
                        }).catch(() => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHATS_FAILED' });
                        });
                    });
                    return true;
                case 'GET_CHAT':
                    requireHistoryUnlocked().then((store) => {
                        const chatId = message.chatId;
                        return store.getThreadWithMessages(chatId, { limit: historyPageSize });
                    }).then(({ thread, page }) => {
                        sendResponse({
                            ok: true,
                            chat: {
                                chatId: thread.chatId,
                                title: thread.title,
                                createdAt: thread.createdAt,
                                updatedAt: thread.updatedAt,
                                messageCount: thread.messageCount,
                                lastPreview: thread.lastPreview,
                                messages: page.messages,
                                nextCursorSequence: page.nextCursorSequence,
                                hasMore: page.hasMore
                            }
                        });
                    }).catch((error) => {
                        console.error('[MLC Chats] Error loading chat:', error);
                        getHistoryStatus().then((status) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHAT_FAILED', status });
                        }).catch(() => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHAT_FAILED' });
                        });
                    });
                    return true;
                case 'GET_MESSAGES_PAGE':
                    requireHistoryUnlocked().then((store) => {
                        const chatId = message.chatId;
                        const limit = Number.isFinite(message.limit) ? message.limit : historyPageSize;
                        const beforeSequence = Number.isFinite(message.beforeSequence) ? message.beforeSequence : null;
                        return store.listMessages(chatId, { limit, beforeSequence });
                    }).then((page) => {
                        sendResponse({ ok: true, ...page });
                    }).catch((error) => {
                        console.error('[MLC Chats] Error listing messages:', error);
                        sendResponse({ ok: false, error: error.message, code: error.code || 'GET_MESSAGES_FAILED' });
                    });
                    return true;
                case 'CREATE_CHAT':
                    createChat({ makeActive: true }).then((result) => {
                        sendResponse({ ok: true, chat: result.chat, activeChatId: result.state.activeChatId });
                    }).catch((error) => {
                        console.error('[MLC Chats] Error creating chat:', error);
                        getHistoryStatus().then((status) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'CREATE_CHAT_FAILED', status });
                        }).catch(() => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'CREATE_CHAT_FAILED' });
                        });
                    });
                    return true;
                case 'SET_ACTIVE_CHAT':
                    setActiveChat(message.chatId).then((result) => {
                        if (!result.ok) {
                            sendResponse(result);
                            return;
                        }
                        sendResponse({ ok: true, chat: result.chat, activeChatId: result.state.activeChatId });
                    }).catch((error) => {
                        console.error('[MLC Chats] Error selecting chat:', error);
                        getHistoryStatus().then((status) => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'SET_ACTIVE_CHAT_FAILED', status });
                        }).catch(() => {
                            sendResponse({ ok: false, error: error.message, code: error.code || 'SET_ACTIVE_CHAT_FAILED' });
                        });
                    });
                    return true;
                case 'RENAME_CHAT':
                    renameChat(message.chatId, message.title).then(sendResponse).catch((error) => {
                        console.error('[MLC Chats] Error renaming chat:', error);
                        sendResponse({ ok: false, error: error.message, code: error.code || 'RENAME_CHAT_FAILED' });
                    });
                    return true;
                case 'DELETE_CHAT':
                    deleteChat(message.chatId).then(sendResponse).catch((error) => {
                        console.error('[MLC Chats] Error deleting chat:', error);
                        sendResponse({ ok: false, error: error.message, code: error.code || 'DELETE_CHAT_FAILED' });
                    });
                    return true;
                default:
                    return false;
            }
        }

        return {
            toChatSummary,
            ensureHistoryStoreReady,
            getHistoryStatus,
            requireHistoryUnlocked,
            loadChatsState,
            notifyChatsState,
            createChat,
            setActiveChat,
            renameChat,
            deleteChat,
            appendChatMessage,
            handleHistoryAndChatMessage
        };
    }

    global.createHistoryChatService = createHistoryChatService;
}(globalThis));
