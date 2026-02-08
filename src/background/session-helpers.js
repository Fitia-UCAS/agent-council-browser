(function initMlcBackgroundSessionHelpers(global) {
    const CHAT_DELIVERY_STATE_META_PREFIX = 'mlc_chat_delivery_state_v1:';
    const CHAT_DELIVERY_STATE_SCHEMA_VERSION = 2;
    const providerApi = global.mlcProviders || null;

    const normalizeProviderKey = typeof providerApi?.normalizeProviderKey === 'function'
        ? providerApi.normalizeProviderKey
        : (provider) => String(provider || '').trim().toLowerCase();

    const getSupportedProviderKeys = typeof providerApi?.getSupportedProviderKeys === 'function'
        ? providerApi.getSupportedProviderKeys
        : () => ['chatgpt', 'gemini', 'claude', 'grok'];

    const isSupportedProviderKey = typeof providerApi?.isSupportedProviderKey === 'function'
        ? providerApi.isSupportedProviderKey
        : (provider) => getSupportedProviderKeys().includes(normalizeProviderKey(provider));

    const formatLLMLabel = typeof providerApi?.formatLLMLabel === 'function'
        ? providerApi.formatLLMLabel
        : (provider) => {
            const normalized = normalizeProviderKey(provider);
            if (normalized === 'gemini') return 'Gemini';
            if (normalized === 'claude') return 'Claude';
            if (normalized === 'grok') return 'Grok';
            return 'ChatGPT';
        };

    const PROVIDER_CAPABILITIES = providerApi?.PROVIDER_CAPABILITIES || {
        chatgpt: { attachments: { mode: 'auto' } },
        gemini: { attachments: { mode: 'manual' } },
        claude: { attachments: { mode: 'auto' } },
        grok: { attachments: { mode: 'auto' } }
    };

    function initProviderFlagMap(providers, initialValue) {
        const map = {};
        if (!Array.isArray(providers)) return map;
        for (const provider of providers) {
            const key = normalizeProviderKey(provider);
            if (!key || Object.prototype.hasOwnProperty.call(map, key)) continue;
            map[key] = Boolean(initialValue);
        }
        return map;
    }

    function listSessionProviders(session, fallbackProvider) {
        const ordered = [];
        const push = (provider) => {
            const key = normalizeProviderKey(provider);
            if (!key || !isSupportedProviderKey(key)) return;
            if (!ordered.includes(key)) ordered.push(key);
        };
        push(session?.firstLLM);
        push(session?.secondLLM);
        push(fallbackProvider);
        return ordered;
    }

    function getSessionProviders(session, fallbackProvider) {
        const ordered = [];
        const push = (provider) => {
            const key = normalizeProviderKey(provider);
            if (!key || !isSupportedProviderKey(key)) return;
            if (!ordered.includes(key)) ordered.push(key);
        };

        const routeProviders = Array.isArray(session?.route?.providers) ? session.route.providers : [];
        routeProviders.forEach(push);
        listSessionProviders(session, fallbackProvider).forEach(push);
        return ordered;
    }

    function sanitizeSessionPromptOverrides(input) {
        if (!input || typeof input !== 'object') return null;
        const allowedKeys = new Set([
            'header',
            'first_turn_instruction',
            'intermediary_message',
            'final_message',
            'followup_user_msg_wrapper'
        ]);
        const output = {};
        for (const modeKey of ['debate', 'single']) {
            const section = input[modeKey];
            if (!section || typeof section !== 'object') continue;
            const sanitized = {};
            for (const [key, value] of Object.entries(section)) {
                if (!allowedKeys.has(key)) continue;
                if (typeof value !== 'string') continue;
                sanitized[key] = value;
            }
            if (Object.keys(sanitized).length > 0) {
                output[modeKey] = sanitized;
            }
        }
        return Object.keys(output).length > 0 ? output : null;
    }

    function sanitizeUiRoute(input) {
        if (!input || typeof input !== 'object') return null;
        const kind = typeof input.kind === 'string' ? input.kind.toLowerCase() : '';
        const rounds = Math.min(12, Math.max(1, parseInt(input.rounds, 10) || 1));

        const agents = [];
        const rawAgents = Array.isArray(input.agents) ? input.agents : null;

        const generateRouteAgentId = () => `agent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const normalizeProfileSelection = (value) => {
            if (value === null || value === undefined) return null;
            const text = String(value).trim();
            if (!text) return null;
            return text;
        };

        if (rawAgents) {
            for (const item of rawAgents) {
                if (!item || typeof item !== 'object') continue;
                const provider = normalizeProviderKey(item.provider || item.llm);
                if (!provider || !isSupportedProviderKey(provider)) continue;
                const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : generateRouteAgentId();
                const profileId = normalizeProfileSelection(item.profileId ?? item.profile ?? item.profile_id);
                agents.push({ id, provider, profileId });
            }
        } else {
            const rawProviders = Array.isArray(input.providers) ? input.providers : [];
            rawProviders.forEach((item, index) => {
                const provider = normalizeProviderKey(item);
                if (!provider || !isSupportedProviderKey(provider)) return;
                agents.push({
                    id: `agent_${provider}_${index}_${Math.random().toString(36).slice(2)}`,
                    provider,
                    profileId: 'default'
                });
            });
        }

        if (agents.length === 0) return null;

        if (kind === 'debate') {
            if (agents.length < 2) return null;
            return { kind: 'debate', agents, providers: agents.map((agent) => agent.provider), rounds };
        }

        if (kind === 'parallel') {
            if (agents.length < 2) return null;
            return { kind: 'parallel', agents, providers: agents.map((agent) => agent.provider), rounds: 1 };
        }

        return { kind: 'single', agents: [agents[0]], providers: [agents[0].provider], rounds: 1 };
    }

    function buildRouteFromRun(mode, { firstLLM, secondLLM, directTarget, rounds }) {
        if (mode === 'debate') {
            const first = firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
            const second = first === 'chatgpt' ? 'gemini' : 'chatgpt';
            return { kind: 'debate', providers: [first, second], rounds };
        }
        if (mode === 'direct' && directTarget === 'both') {
            return { kind: 'parallel', providers: ['chatgpt', 'gemini'], rounds: 1 };
        }
        const provider = firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
        return { kind: 'single', providers: [provider], rounds: 1 };
    }

    function getSessionParticipants(session) {
        if (Array.isArray(session?.participants) && session.participants.length > 0) {
            return session.participants;
        }
        const routeAgents = Array.isArray(session?.route?.agents) ? session.route.agents : null;
        if (routeAgents && routeAgents.length > 0) {
            return routeAgents.map((agent, idx) => {
                const provider = normalizeProviderKey(agent?.provider);
                if (!provider || !isSupportedProviderKey(provider)) return null;
                const agentId = typeof agent?.id === 'string' && agent.id.trim()
                    ? agent.id.trim()
                    : `agent_${provider}_${idx + 1}`;
                const profileId = typeof session?.agentProfileIds?.[agentId] === 'string'
                    ? session.agentProfileIds[agentId]
                    : (session?.profileIds?.[provider] || null);
                const tabId = Number.isFinite(session?.agentTabIds?.[agentId])
                    ? session.agentTabIds[agentId]
                    : (session?.tabIds?.[provider] || null);
                const label = typeof agent?.label === 'string' ? agent.label : (formatLLMLabel(provider));
                return { agentId, provider, profileId, tabId, label };
            }).filter(Boolean);
        }
        const providers = Array.isArray(session?.route?.providers) && session.route.providers.length > 0
            ? session.route.providers.map(normalizeProviderKey).filter((p) => p && isSupportedProviderKey(p))
            : listSessionProviders(session);
        return providers.map((provider) => ({
            agentId: provider,
            provider,
            profileId: session?.profileIds?.[provider] || null,
            tabId: session?.tabIds?.[provider] || null,
            label: formatLLMLabel(provider)
        })).filter(Boolean);
    }

    function getRoundIndex(turnIndex, session = null) {
        if (session?.mode === 'direct' || session?.mode === 'parallel') {
            return 1;
        }
        if (session?.mode === 'single') {
            return Math.max(1, turnIndex);
        }
        if (session?.mode === 'debate') {
            const participants = getSessionParticipants(session);
            const divisor = participants.length >= 2 ? participants.length : 2;
            return Math.ceil(turnIndex / divisor);
        }
        return Math.ceil(turnIndex / 2);
    }

    function getTurnParticipant(session, turnIndex) {
        const participants = getSessionParticipants(session);
        if (participants.length === 0) return null;

        if (session?.mode === 'parallel') {
            return participants[0] || null;
        }
        if (session?.mode === 'direct') {
            if (participants.length >= 2) {
                return turnIndex === 1 ? participants[0] : participants[1];
            }
            return participants[0] || null;
        }
        if (session?.mode === 'single') {
            return participants[0] || null;
        }
        if (session?.mode === 'debate') {
            const idx = Math.max(0, (turnIndex - 1) % participants.length);
            return participants[idx] || null;
        }
        return participants[0] || null;
    }

    function getTurnLLM(session, turnIndex) {
        if (session?.mode === 'parallel') {
            return session.firstLLM || 'chatgpt';
        }
        if (session?.mode === 'direct') {
            if (turnIndex === 1) return session.firstLLM || 'chatgpt';
            return session.secondLLM || session.firstLLM || 'chatgpt';
        }
        if (session?.mode === 'single') {
            return session.firstLLM || 'chatgpt';
        }
        if (session?.mode === 'debate') {
            const participant = getTurnParticipant(session, turnIndex);
            if (participant?.provider) return participant.provider;
        }
        return turnIndex % 2 === 1 ? session.firstLLM : session.secondLLM;
    }

    function getProviderAttachmentMode(provider) {
        const mode = PROVIDER_CAPABILITIES?.[provider]?.attachments?.mode;
        if (mode === 'manual' || mode === 'none') return mode;
        return 'auto';
    }

    function getParallelProviders(session) {
        const providers = [];
        const candidates = Array.isArray(session?.route?.providers) && session.route.providers.length > 0
            ? session.route.providers
            : listSessionProviders(session);
        for (const candidate of candidates) {
            const key = normalizeProviderKey(candidate);
            if (!isSupportedProviderKey(key)) continue;
            if (!providers.includes(key)) providers.push(key);
        }
        return providers;
    }

    function buildParallelPromptId(sessionId, agentId) {
        return `${sessionId}:parallel:${String(agentId || '').trim()}`;
    }

    function formatProvidersForUi(providers) {
        if (!Array.isArray(providers) || providers.length === 0) return '';
        return providers.map(formatLLMLabel).join(' + ');
    }

    function getChatDeliveryStateKey(chatId) {
        return `${CHAT_DELIVERY_STATE_META_PREFIX}${chatId}`;
    }

    function createEmptyDeliveryState() {
        const providers = {};
        for (const provider of getSupportedProviderKeys()) {
            providers[provider] = { deliveredUpTo: 0, contextKey: null };
        }
        // Backward compatibility (older code assumes these keys exist).
        if (!Object.prototype.hasOwnProperty.call(providers, 'chatgpt')) providers.chatgpt = { deliveredUpTo: 0, contextKey: null };
        if (!Object.prototype.hasOwnProperty.call(providers, 'gemini')) providers.gemini = { deliveredUpTo: 0, contextKey: null };
        return {
            schemaVersion: CHAT_DELIVERY_STATE_SCHEMA_VERSION,
            updatedAt: 0,
            providers
        };
    }

    function normalizeDeliveryProviderState(value) {
        const out = { deliveredUpTo: 0, contextKey: null };
        if (!value || typeof value !== 'object') return out;
        if (Number.isFinite(value.deliveredUpTo) && value.deliveredUpTo > 0) {
            out.deliveredUpTo = Math.floor(value.deliveredUpTo);
        }
        if (typeof value.contextKey === 'string' && value.contextKey.trim()) {
            out.contextKey = value.contextKey.trim();
        }
        return out;
    }

    function normalizeChatDeliveryState(value) {
        const base = createEmptyDeliveryState();
        if (!value || typeof value !== 'object') return base;

        if ((value.schemaVersion === 1 || value.schemaVersion === 2) && value.providers && typeof value.providers === 'object') {
            const out = createEmptyDeliveryState();
            out.updatedAt = Number.isFinite(value.updatedAt) ? Math.floor(value.updatedAt) : 0;
            for (const provider of Object.keys(out.providers)) {
                out.providers[provider] = normalizeDeliveryProviderState(value.providers[provider]);
            }
            return out;
        }

        // Legacy shape: { chatgpt: number, gemini: number }
        const out = createEmptyDeliveryState();
        if (Number.isFinite(value.chatgpt) && value.chatgpt > 0) out.providers.chatgpt.deliveredUpTo = Math.floor(value.chatgpt);
        if (Number.isFinite(value.gemini) && value.gemini > 0) out.providers.gemini.deliveredUpTo = Math.floor(value.gemini);
        return out;
    }

    function getProviderContextKey(session, provider) {
        const profileId = session?.profileIds?.[provider];
        if (typeof profileId === 'string' && profileId.trim()) {
            return `profile:${profileId.trim()}`;
        }
        const tabId = session?.tabIds?.[provider];
        if (Number.isFinite(tabId)) {
            return `tab:${Math.floor(tabId)}`;
        }
        return null;
    }

    function getEffectiveDeliveredUpTo(state, provider, contextKey) {
        if (!state || typeof state !== 'object') return 0;
        const providers = state.providers && typeof state.providers === 'object' ? state.providers : null;
        const normalizedProvider = normalizeProviderKey(provider);
        const entry = normalizedProvider && providers?.[normalizedProvider] && typeof providers[normalizedProvider] === 'object'
            ? providers[normalizedProvider]
            : null;
        const deliveredUpTo = Number.isFinite(entry?.deliveredUpTo) ? Math.max(0, Math.floor(entry.deliveredUpTo)) : 0;
        const storedContextKey = typeof entry?.contextKey === 'string' && entry.contextKey.trim()
            ? entry.contextKey.trim()
            : null;
        if (contextKey && storedContextKey && contextKey !== storedContextKey) {
            return 0;
        }
        return deliveredUpTo;
    }

    global.mlcBackgroundSessionHelpers = {
        initProviderFlagMap,
        listSessionProviders,
        getSessionProviders,
        sanitizeSessionPromptOverrides,
        sanitizeUiRoute,
        buildRouteFromRun,
        getRoundIndex,
        getSessionParticipants,
        getTurnParticipant,
        getTurnLLM,
        getProviderAttachmentMode,
        getParallelProviders,
        buildParallelPromptId,
        formatProvidersForUi,
        getChatDeliveryStateKey,
        createEmptyDeliveryState,
        normalizeDeliveryProviderState,
        normalizeChatDeliveryState,
        getProviderContextKey,
        getEffectiveDeliveredUpTo
    };
}(globalThis));
