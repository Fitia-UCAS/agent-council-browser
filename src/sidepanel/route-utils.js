(function initMlcRouteUtils(global) {
    const DEFAULT_PROVIDER_IDS = ['chatgpt', 'gemini', 'claude', 'grok'];

    function clampInt(value, min, max) {
        const num = Number(value);
        if (!Number.isFinite(num)) return min;
        return Math.max(min, Math.min(max, Math.round(num)));
    }

    function normalizeProviderId(provider, options = {}) {
        const value = String(provider || '').trim().toLowerCase();
        if (!value) return null;
        const defaultProviders = Array.isArray(options.defaultProviders) && options.defaultProviders.length
            ? options.defaultProviders
            : DEFAULT_PROVIDER_IDS;
        if (defaultProviders.includes(value)) return value;
        const capabilities = options.providerCapabilities && typeof options.providerCapabilities === 'object'
            ? options.providerCapabilities
            : null;
        if (capabilities && Object.prototype.hasOwnProperty.call(capabilities, value)) return value;
        return null;
    }

    function generateRouteAgentId() {
        if (global.crypto?.randomUUID) return global.crypto.randomUUID();
        return `agent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function normalizeProfileSelection(value) {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        if (!text) return null;
        if (text === 'default') return 'default';
        if (text.startsWith('profile_')) return text;
        return text;
    }

    function normalizeRouteAgent(input, options = {}) {
        const raw = input && typeof input === 'object' ? input : {};
        const provider = normalizeProviderId(raw.provider || raw.llm, options);
        if (!provider) return null;
        const profileId = normalizeProfileSelection(raw.profileId ?? raw.profile ?? raw.profile_id);
        const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateRouteAgentId();
        return { id, provider, profileId: profileId || null };
    }

    function sanitizeRoute(input, options = {}) {
        const route = input && typeof input === 'object' ? input : {};
        const agents = [];
        const rawAgents = Array.isArray(route.agents) ? route.agents : null;
        if (rawAgents) {
            rawAgents.forEach((item) => {
                if (typeof item === 'string') {
                    const provider = normalizeProviderId(item, options);
                    if (provider) agents.push({ id: generateRouteAgentId(), provider, profileId: 'default' });
                    return;
                }
                const normalized = normalizeRouteAgent(item, options);
                if (normalized) agents.push(normalized);
            });
        } else {
            const rawProviders = Array.isArray(route.providers) ? route.providers : [];
            rawProviders.forEach((item) => {
                const provider = normalizeProviderId(item, options);
                if (provider) agents.push({ id: generateRouteAgentId(), provider, profileId: 'default' });
            });
        }

        // Back-compat: older routes used `profileId: null` while effectively meaning "Default".
        // We only auto-upgrade to Default when there's a single agent for that provider, so
        // multi-agent same-provider routes can still represent "unassigned" slots.
        const agentCountsByProvider = {};
        agents.forEach((agent) => {
            if (!agent?.provider) return;
            agentCountsByProvider[agent.provider] = (agentCountsByProvider[agent.provider] || 0) + 1;
        });
        agents.forEach((agent) => {
            if (!agent?.provider) return;
            if (normalizeProfileSelection(agent.profileId)) return;
            if (agentCountsByProvider[agent.provider] !== 1) return;
            agent.profileId = 'default';
        });

        const requestedKind = String(route.kind || '').trim().toLowerCase();
        const roundsMin = Number.isFinite(options.roundsMin) ? options.roundsMin : 1;
        const roundsMax = Number.isFinite(options.roundsMax) ? options.roundsMax : 12;
        const roundsValue = route.rounds == null ? 3 : route.rounds;
        const rounds = clampInt(roundsValue, roundsMin, roundsMax);

        let kind = 'single';
        if (agents.length >= 2) {
            if (requestedKind === 'debate') kind = 'debate';
            else kind = 'parallel';
        }

        return {
            kind,
            agents,
            rounds
        };
    }

    function getSupportedProviders(options = {}) {
        const capabilities = options.providerCapabilities && typeof options.providerCapabilities === 'object'
            ? Object.keys(options.providerCapabilities)
            : [];
        const normalized = capabilities
            .map((provider) => normalizeProviderId(provider, options))
            .filter(Boolean);
        const unique = [...new Set(normalized)];
        if (unique.length > 0) return unique;
        const defaultProviders = Array.isArray(options.defaultProviders) && options.defaultProviders.length
            ? options.defaultProviders
            : DEFAULT_PROVIDER_IDS;
        return [...defaultProviders];
    }

    function routeFromRunConfig(runConfig, options = {}) {
        if (!runConfig || typeof runConfig !== 'object') return null;
        if (runConfig.route && typeof runConfig.route === 'object') {
            return sanitizeRoute(runConfig.route, options);
        }

        const runType = runConfig.runType || runConfig.mode || null;
        if (runType === 'debate') {
            const first = normalizeProviderId(runConfig.firstLLM, options) || 'chatgpt';
            const second = first === 'chatgpt' ? 'gemini' : 'chatgpt';
            return sanitizeRoute({ kind: 'debate', providers: [first, second], rounds: runConfig.rounds }, options);
        }
        if (runType === 'direct') {
            const target = normalizeProviderId(runConfig.target, options);
            if (runConfig.target === 'both') {
                const providers = getSupportedProviders(options);
                return sanitizeRoute({ kind: 'parallel', providers: providers.length >= 2 ? providers : ['chatgpt', 'gemini'] }, options);
            }
            return sanitizeRoute({ kind: 'single', providers: [target || 'chatgpt'] }, options);
        }
        if (runType === 'single') {
            const llm = normalizeProviderId(runConfig.llm, options) || 'chatgpt';
            return sanitizeRoute({ kind: 'single', providers: [llm] }, options);
        }
        return null;
    }

    global.mlcRouteUtils = {
        DEFAULT_PROVIDER_IDS,
        normalizeProviderId,
        generateRouteAgentId,
        normalizeProfileSelection,
        normalizeRouteAgent,
        sanitizeRoute,
        getSupportedProviders,
        routeFromRunConfig
    };
}(globalThis));
