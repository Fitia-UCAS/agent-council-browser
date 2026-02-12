(function sessionStateStoreModule(globalScope) {
    'use strict';

    function createSessionStateStore({
        storageArea = null,
        sessionsKey = 'mlc_sessions_v1',
        legacyActiveKey = 'mlc_active_session_v2',
        normalizeSession,
        shouldPersistSession = null,
        shouldRedactSession = null,
        redactSession = null,
        onLoaded = null,
    } = {}) {
        const storage = storageArea || globalScope.chrome?.storage?.local || null;
        if (!storage) {
            throw new Error('Session state store requires a storage area.');
        }
        if (typeof normalizeSession !== 'function') {
            throw new Error('Session state store requires a normalizeSession function.');
        }

        let sessionsById = new Map();
        let sessionsByChatId = new Map();
        let loaded = false;
        let loadPromise = null;

        function ingest(rawSession) {
            const normalized = normalizeSession(rawSession);
            if (!normalized) return;
            if (typeof shouldPersistSession === 'function' && !shouldPersistSession(normalized))
                return;
            sessionsById.set(normalized.sessionId, normalized);
            if (normalized.chatId) {
                sessionsByChatId.set(normalized.chatId, normalized.sessionId);
            }
        }

        async function persist() {
            const payload = {};
            for (const [sessionId, session] of sessionsById.entries()) {
                const shouldRedact =
                    typeof shouldRedactSession === 'function'
                        ? Boolean(shouldRedactSession(session))
                        : false;
                payload[sessionId] =
                    shouldRedact && typeof redactSession === 'function'
                        ? redactSession(session)
                        : session;
            }
            await storage.set({ [sessionsKey]: payload });
        }

        async function load() {
            if (loaded) return sessionsById;
            if (loadPromise) return loadPromise;
            loadPromise = (async () => {
                const stored = await storage.get([sessionsKey, legacyActiveKey]);
                const rawSessions = stored?.[sessionsKey];
                sessionsById = new Map();
                sessionsByChatId = new Map();

                if (rawSessions && typeof rawSessions === 'object') {
                    Object.values(rawSessions).forEach((session) => ingest(session));
                }

                const legacy = stored?.[legacyActiveKey];
                if (legacy && (!rawSessions || Object.keys(rawSessions).length === 0)) {
                    ingest(legacy);
                }

                loaded = true;
                loadPromise = null;

                if (legacy) {
                    await storage.remove(legacyActiveKey);
                    await persist();
                }

                if (typeof onLoaded === 'function') {
                    await onLoaded({
                        sessionsById,
                        sessionsByChatId,
                    });
                }
                return sessionsById;
            })();
            return loadPromise;
        }

        async function getSessionById(sessionId) {
            if (!sessionId) return null;
            await load();
            return sessionsById.get(sessionId) || null;
        }

        async function getSessionForChat(chatId) {
            if (!chatId) return null;
            await load();
            const sessionId = sessionsByChatId.get(chatId);
            if (!sessionId) return null;
            return sessionsById.get(sessionId) || null;
        }

        function pickMostRecentSession() {
            let best = null;
            for (const session of sessionsById.values()) {
                if (!session?.isActive && !session?.isPaused) continue;
                if (!best || (session.startedAt || 0) > (best.startedAt || 0)) {
                    best = session;
                }
            }
            return best;
        }

        async function saveSession(session) {
            if (!session?.sessionId) return null;
            await load();
            sessionsById.set(session.sessionId, session);
            if (session.chatId) {
                sessionsByChatId.set(session.chatId, session.sessionId);
            }
            await persist();
            return session;
        }

        async function removeSession(sessionId) {
            if (!sessionId) return;
            await load();
            const existing = sessionsById.get(sessionId);
            if (existing?.chatId && sessionsByChatId.get(existing.chatId) === sessionId) {
                sessionsByChatId.delete(existing.chatId);
            }
            sessionsById.delete(sessionId);
            await persist();
        }

        async function clear() {
            sessionsById = new Map();
            sessionsByChatId = new Map();
            loaded = true;
            loadPromise = null;
            await storage.remove([sessionsKey, legacyActiveKey]);
            await storage.set({ [sessionsKey]: {} });
        }

        return {
            load,
            persist,
            getSessionById,
            getSessionForChat,
            pickMostRecentSession,
            saveSession,
            removeSession,
            clear,
            getSessionsMap: () => sessionsById,
            getChatIndexMap: () => sessionsByChatId,
            isLoaded: () => loaded,
        };
    }

    globalScope.MLCSessionStateStore = {
        createSessionStateStore,
    };
})(typeof self !== 'undefined' ? self : window);
