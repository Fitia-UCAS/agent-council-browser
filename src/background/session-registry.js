(function initSessionRegistry(global) {
    function createSessionRegistry(deps = {}) {
        const chromeApi = deps.chrome || global.chrome;
        const sessionsKey = typeof deps.SESSIONS_KEY === 'string' ? deps.SESSIONS_KEY : 'mlc_sessions_v1';
        const activeSessionKey = typeof deps.ACTIVE_SESSION_KEY === 'string' ? deps.ACTIVE_SESSION_KEY : 'mlc_active_session_v2';
        const getHistoryStatus = typeof deps.getHistoryStatus === 'function'
            ? deps.getHistoryStatus
            : (async () => null);
        const ensureHistoryStoreReady = typeof deps.ensureHistoryStoreReady === 'function'
            ? deps.ensureHistoryStoreReady
            : (async () => null);
        const buildConversationContext = typeof deps.buildConversationContext === 'function'
            ? deps.buildConversationContext
            : () => '';
        const listSessionProviders = typeof deps.listSessionProviders === 'function'
            ? deps.listSessionProviders
            : () => [];
        const formatLLMLabel = typeof deps.formatLLMLabel === 'function'
            ? deps.formatLLMLabel
            : () => 'ChatGPT';
        const getSupportedProviderKeys = typeof deps.getSupportedProviderKeys === 'function'
            ? deps.getSupportedProviderKeys
            : () => ['chatgpt', 'gemini'];
        const normalizeProviderKey = typeof deps.normalizeProviderKey === 'function'
            ? deps.normalizeProviderKey
            : (provider) => String(provider || '').trim().toLowerCase();
        const isSupportedProviderKey = typeof deps.isSupportedProviderKey === 'function'
            ? deps.isSupportedProviderKey
            : () => false;
        const logger = {
            warn: typeof deps.warn === 'function' ? deps.warn : (...args) => console.warn(...args),
            error: typeof deps.error === 'function' ? deps.error : (...args) => console.error(...args)
        };

        let sessionsById = new Map();
        let sessionsByChatId = new Map();
        let sessionsLoaded = false;
        let sessionsLoadPromise = null;
        const responseChainsBySessionId = new Map();

        function createDefaultSessionState() {
            return {
                isActive: false,
                isPaused: false,
                pausedReason: null,
                pausedProvider: null,
                pausedAgentId: null,
                pausedProfileId: null,
                pausedAt: 0,
                autoResume: null,
                mode: 'debate',
                route: null,
                chatId: null,
                sessionId: null,
                rounds: 0,
                totalTurns: 0,
                turnIndex: 1,
                firstLLM: 'chatgpt',
                secondLLM: 'gemini',
                participants: [],
                agentProfileIds: {},
                agentTabIds: {},
                profileIds: { chatgpt: null, gemini: null },
                tabIds: { chatgpt: null, gemini: null },
                userQuery: '',
                isFollowUp: false,
                conversationContext: '',
                promptOverrides: null,
                userMessageSequence: null,
                messages: [],
                waitingFor: null,
                parallelPromptIds: null,
                lastPromptId: null,
                lastPromptTimestamp: 0,
                startedAt: 0,
                endedAt: 0
            };
        }

        function normalizeSessionState(session) {
            if (!session || typeof session !== 'object') return null;
            const sessionId = typeof session.sessionId === 'string' ? session.sessionId : null;
            if (!sessionId) return null;
            const normalized = { ...createDefaultSessionState(), ...session, sessionId };
            normalized.isActive = Boolean(normalized.isActive);
            normalized.isPaused = Boolean(normalized.isPaused);
            normalized.pausedAgentId = typeof normalized.pausedAgentId === 'string' ? normalized.pausedAgentId : null;
            normalized.pausedProfileId = typeof normalized.pausedProfileId === 'string' ? normalized.pausedProfileId : null;
            normalized.messages = Array.isArray(normalized.messages) ? normalized.messages : [];
            normalized.profileIds = normalized.profileIds && typeof normalized.profileIds === 'object' ? normalized.profileIds : {};
            normalized.tabIds = normalized.tabIds && typeof normalized.tabIds === 'object' ? normalized.tabIds : {};
            normalized.participants = Array.isArray(normalized.participants) ? normalized.participants : [];
            normalized.agentProfileIds = normalized.agentProfileIds && typeof normalized.agentProfileIds === 'object' ? normalized.agentProfileIds : {};
            normalized.agentTabIds = normalized.agentTabIds && typeof normalized.agentTabIds === 'object' ? normalized.agentTabIds : {};
            if (!['debate', 'single', 'direct', 'parallel'].includes(normalized.mode)) {
                normalized.mode = 'debate';
            }
            const providers = getSupportedProviderKeys();
            for (const provider of providers) {
                if (!Object.prototype.hasOwnProperty.call(normalized.profileIds, provider)) {
                    normalized.profileIds[provider] = null;
                }
                if (!Object.prototype.hasOwnProperty.call(normalized.tabIds, provider)) {
                    normalized.tabIds[provider] = null;
                }
            }
            if (!Object.prototype.hasOwnProperty.call(normalized.profileIds, 'chatgpt')) {
                normalized.profileIds.chatgpt = null;
            }
            if (!Object.prototype.hasOwnProperty.call(normalized.profileIds, 'gemini')) {
                normalized.profileIds.gemini = null;
            }
            if (!Object.prototype.hasOwnProperty.call(normalized.tabIds, 'chatgpt')) {
                normalized.tabIds.chatgpt = null;
            }
            if (!Object.prototype.hasOwnProperty.call(normalized.tabIds, 'gemini')) {
                normalized.tabIds.gemini = null;
            }

            // Backward compatibility: derive participants if missing.
            if (!Array.isArray(normalized.participants) || normalized.participants.length === 0) {
                const routeAgents = Array.isArray(normalized.route?.agents) ? normalized.route.agents : null;
                if (routeAgents && routeAgents.length > 0) {
                    normalized.participants = routeAgents.map((agent, idx) => {
                        const provider = normalizeProviderKey(agent?.provider || '');
                        if (!provider || !isSupportedProviderKey(provider)) return null;
                        const agentId = typeof agent?.id === 'string' && agent.id.trim()
                            ? agent.id.trim()
                            : `agent_${provider}_${idx + 1}`;
                        const rawProfileSelection = typeof agent?.profileId === 'string' ? agent.profileId.trim() : '';
                        const profileId = normalized.agentProfileIds?.[agentId]
                            || (rawProfileSelection && rawProfileSelection !== 'default' ? rawProfileSelection : (normalized.profileIds?.[provider] || null));
                        const tabId = Number.isFinite(normalized.agentTabIds?.[agentId])
                            ? normalized.agentTabIds[agentId]
                            : (Number.isFinite(agent?.tabId)
                                ? agent.tabId
                                : (normalized.tabIds?.[provider] || null));
                        const label = typeof agent?.label === 'string' ? agent.label : '';
                        return { agentId, provider, profileId, tabId, label };
                    }).filter(Boolean);
                } else {
                    const providers = Array.isArray(normalized.route?.providers) && normalized.route.providers.length > 0
                        ? normalized.route.providers.map(normalizeProviderKey).filter((p) => p && isSupportedProviderKey(p))
                        : listSessionProviders(normalized);
                    normalized.participants = providers.map((provider) => ({
                        agentId: provider,
                        provider,
                        profileId: normalized.profileIds?.[provider] || null,
                        tabId: normalized.tabIds?.[provider] || null,
                        label: formatLLMLabel(provider)
                    })).filter(Boolean);
                }
            }

            // Ensure agent maps contain entries for participants.
            if (Array.isArray(normalized.participants)) {
                normalized.participants = normalized.participants.map((participant, idx) => {
                    if (!participant || typeof participant !== 'object') return null;
                    const provider = normalizeProviderKey(participant.provider);
                    if (!provider || !isSupportedProviderKey(provider)) return null;
                    const agentId = typeof participant.agentId === 'string' && participant.agentId.trim()
                        ? participant.agentId.trim()
                        : `agent_${provider}_${idx + 1}`;
                    const profileId = typeof participant.profileId === 'string' ? participant.profileId : null;
                    const tabId = Number.isFinite(participant.tabId) ? participant.tabId : null;
                    const label = typeof participant.label === 'string' ? participant.label : '';
                    normalized.agentProfileIds[agentId] = normalized.agentProfileIds[agentId] || profileId;
                    if (tabId) normalized.agentTabIds[agentId] = normalized.agentTabIds[agentId] || tabId;
                    return { agentId, provider, profileId, tabId, label };
                }).filter(Boolean);
            }

            return normalized;
        }

        function redactSessionForStorage(session) {
            if (!session || typeof session !== 'object') return session;
            return {
                ...session,
                userQuery: '',
                conversationContext: '',
                messages: []
            };
        }

        function mapHistoryMessageToSessionMessage(message) {
            if (!message || typeof message !== 'object') return null;
            const content = typeof message.content === 'string' ? message.content : '';
            const trimmed = content.trim();
            if (!trimmed) return null;
            const out = {
                role: message.role,
                content,
                timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now()
            };
            if (typeof message.contentHtml === 'string' && message.contentHtml.trim()) {
                out.contentHtml = message.contentHtml;
            }
            if (typeof message.agentId === 'string' && message.agentId.trim()) {
                out.agentId = message.agentId.trim();
            }
            if (typeof message.agentLabel === 'string' && message.agentLabel.trim()) {
                out.agentLabel = message.agentLabel.trim();
            }
            if (Number.isFinite(message.turnIndex)) out.turnIndex = message.turnIndex;
            if (Number.isFinite(message.roundIndex)) out.roundIndex = message.roundIndex;
            return out;
        }

        async function persistSessionsState() {
            let historyStatus = null;
            try {
                historyStatus = await getHistoryStatus();
            } catch {
                historyStatus = null;
            }
            const shouldRedact = Boolean(historyStatus?.historyEnabled);

            const payload = {};
            for (const [sessionId, session] of sessionsById.entries()) {
                const canRedactSession = shouldRedact
                    && session?.chatId
                    && Number.isFinite(session?.userMessageSequence)
                    && session.userMessageSequence > 0;
                payload[sessionId] = canRedactSession ? redactSessionForStorage(session) : session;
            }
            await chromeApi.storage.local.set({ [sessionsKey]: payload });
        }

        async function loadSessionsState() {
            if (sessionsLoaded) return sessionsById;
            if (sessionsLoadPromise) return sessionsLoadPromise;
            sessionsLoadPromise = (async () => {
                const stored = await chromeApi.storage.local.get([sessionsKey, activeSessionKey]);
                const rawSessions = stored?.[sessionsKey];
                sessionsById = new Map();
                sessionsByChatId = new Map();

                const ingest = (raw) => {
                    const normalized = normalizeSessionState(raw);
                    if (!normalized || (!normalized.isActive && !normalized.isPaused)) return;
                    sessionsById.set(normalized.sessionId, normalized);
                    if (normalized.chatId) {
                        sessionsByChatId.set(normalized.chatId, normalized.sessionId);
                    }
                };

                if (rawSessions && typeof rawSessions === 'object') {
                    for (const session of Object.values(rawSessions)) {
                        ingest(session);
                    }
                }

                const legacy = stored?.[activeSessionKey];
                if (legacy && (!rawSessions || Object.keys(rawSessions).length === 0)) {
                    ingest(legacy);
                }

                sessionsLoaded = true;
                sessionsLoadPromise = null;

                try {
                    const store = await ensureHistoryStoreReady();
                    const historyStatus = await store.getStatus();
                    if (historyStatus?.historyEnabled) {
                        for (const session of sessionsById.values()) {
                            if (!session || !session.chatId || !session.sessionId) continue;
                            const needsHydrate = !Array.isArray(session.messages) || session.messages.length === 0 || !String(session.userQuery || '').trim();
                            if (!needsHydrate) continue;
                            try {
                                const page = await store.listMessages(session.chatId, { limit: 240 });
                                const messages = Array.isArray(page?.messages) ? page.messages : [];
                                const sessionMessages = messages.filter((msg) => msg?.sessionId === session.sessionId);
                                if (sessionMessages.length > 0) {
                                    const mapped = sessionMessages.map(mapHistoryMessageToSessionMessage).filter(Boolean);
                                    if (mapped.length > 0) {
                                        session.messages = mapped;
                                    }
                                    const userMsg = sessionMessages.find((msg) => msg?.role === 'user' && typeof msg?.content === 'string' && msg.content.trim());
                                    if (userMsg) {
                                        session.userQuery = userMsg.content;
                                        if (!Number.isFinite(session.userMessageSequence) && Number.isFinite(userMsg.sequence)) {
                                            session.userMessageSequence = userMsg.sequence;
                                        }
                                    }
                                }
                                if (session.isFollowUp && Number.isFinite(session.userMessageSequence)) {
                                    try {
                                        const prior = await store.listMessages(session.chatId, { limit: 12, beforeSequence: session.userMessageSequence });
                                        session.conversationContext = buildConversationContext(prior?.messages, { maxChars: 4000, maxMessages: 10 });
                                    } catch {
                                        // ignore
                                    }
                                }
                            } catch {
                                // ignore hydration failures (locked chat, DB errors, etc.)
                            }
                        }
                    }
                } catch {
                    // ignore history hydration failures
                }

                if (legacy) {
                    await chromeApi.storage.local.remove(activeSessionKey);
                    await persistSessionsState();
                }

                return sessionsById;
            })();
            return sessionsLoadPromise;
        }

        async function getSessionById(sessionId) {
            if (!sessionId) return null;
            await loadSessionsState();
            return sessionsById.get(sessionId) || null;
        }

        async function getSessionForChat(chatId) {
            if (!chatId) return null;
            await loadSessionsState();
            const sessionId = sessionsByChatId.get(chatId);
            if (!sessionId) return null;
            return sessionsById.get(sessionId) || null;
        }

        function pickMostRecentSession() {
            let best = null;
            for (const session of sessionsById.values()) {
                if (!session.isActive && !session.isPaused) continue;
                if (!best || (session.startedAt || 0) > (best.startedAt || 0)) {
                    best = session;
                }
            }
            return best;
        }

        async function saveSession(session) {
            if (!session?.sessionId) return null;
            await loadSessionsState();
            sessionsById.set(session.sessionId, session);
            if (session.chatId) {
                sessionsByChatId.set(session.chatId, session.sessionId);
            }
            await persistSessionsState();
            return session;
        }

        async function removeSession(sessionId) {
            if (!sessionId) return;
            await loadSessionsState();
            const existing = sessionsById.get(sessionId);
            if (existing?.chatId && sessionsByChatId.get(existing.chatId) === sessionId) {
                sessionsByChatId.delete(existing.chatId);
            }
            sessionsById.delete(sessionId);
            responseChainsBySessionId.delete(sessionId);
            await persistSessionsState();
        }

        function enqueueResponse(sessionId, taskFn) {
            if (!sessionId || typeof taskFn !== 'function') {
                return Promise.resolve();
            }
            const chain = responseChainsBySessionId.get(sessionId) || Promise.resolve();
            const next = chain.then(taskFn);
            responseChainsBySessionId.set(sessionId, next.catch(() => {}));
            return next.catch((error) => {
                logger.error('[MLC SessionRegistry] Enqueued task failed:', error);
                throw error;
            });
        }

        function getSessionsMap() {
            return sessionsById;
        }

        return {
            createDefaultSessionState,
            loadSessionsState,
            persistSessionsState,
            getSessionById,
            getSessionForChat,
            saveSession,
            removeSession,
            pickMostRecentSession,
            enqueueResponse,
            getSessionsMap
        };
    }

    global.createSessionRegistry = createSessionRegistry;
}(globalThis));
