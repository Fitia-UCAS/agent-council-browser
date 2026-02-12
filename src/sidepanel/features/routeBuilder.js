(function routeBuilderModule(globalScope) {
    'use strict';

    const DEFAULT_PROVIDER_IDS = ['chatgpt', 'gemini', 'claude', 'grok'];

    function generateRouteAgentId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return `agent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }

    function normalizeProviderId(provider, providerCapabilities = null) {
        const value = String(provider || '')
            .trim()
            .toLowerCase();
        if (!value) return null;
        if (DEFAULT_PROVIDER_IDS.includes(value)) return value;
        if (
            providerCapabilities &&
            typeof providerCapabilities === 'object' &&
            Object.prototype.hasOwnProperty.call(providerCapabilities, value)
        ) {
            return value;
        }
        return null;
    }

    function normalizeProfileSelection(value) {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        if (!text) return null;
        if (text === 'default') return 'default';
        return text;
    }

    function normalizeRouteAgent(input, { providerCapabilities = null } = {}) {
        const raw = input && typeof input === 'object' ? input : {};
        const provider = normalizeProviderId(raw.provider || raw.llm, providerCapabilities);
        if (!provider) return null;
        const profileId = normalizeProfileSelection(raw.profileId ?? raw.profile ?? raw.profile_id);
        const id =
            typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateRouteAgentId();
        return { id, provider, profileId: profileId || null };
    }

    function sanitizeRoute(input, { providerCapabilities = null } = {}) {
        const route = input && typeof input === 'object' ? input : {};
        const agents = [];
        const rawAgents = Array.isArray(route.agents) ? route.agents : null;
        if (rawAgents) {
            rawAgents.forEach((item) => {
                if (typeof item === 'string') {
                    const provider = normalizeProviderId(item, providerCapabilities);
                    if (provider)
                        agents.push({ id: generateRouteAgentId(), provider, profileId: 'default' });
                    return;
                }
                const normalized = normalizeRouteAgent(item, { providerCapabilities });
                if (normalized) agents.push(normalized);
            });
        } else {
            const rawProviders = Array.isArray(route.providers) ? route.providers : [];
            rawProviders.forEach((item) => {
                const provider = normalizeProviderId(item, providerCapabilities);
                if (provider)
                    agents.push({ id: generateRouteAgentId(), provider, profileId: 'default' });
            });
        }

        const agentCountsByProvider = {};
        agents.forEach((agent) => {
            if (!agent?.provider) return;
            agentCountsByProvider[agent.provider] =
                (agentCountsByProvider[agent.provider] || 0) + 1;
        });
        agents.forEach((agent) => {
            if (!agent || agent.profileId !== null) return;
            if ((agentCountsByProvider[agent.provider] || 0) <= 1) {
                agent.profileId = 'default';
            }
        });

        const kindRaw = String(route.kind || route.mode || '')
            .trim()
            .toLowerCase();
        let kind = 'single';
        if (kindRaw === 'debate') kind = 'debate';
        else if (kindRaw === 'parallel' || kindRaw === 'compare') kind = 'parallel';

        let rounds = Number.parseInt(route.rounds, 10);
        if (!Number.isFinite(rounds)) rounds = kind === 'debate' ? 3 : 1;
        rounds = Math.max(1, Math.min(12, rounds));

        if (kind === 'single') {
            if (agents.length === 0) return null;
            return {
                kind: 'single',
                rounds: 1,
                agents: [agents[0]],
            };
        }
        if (kind === 'parallel') {
            if (agents.length < 2) {
                if (agents.length === 0) return null;
                return {
                    kind: 'single',
                    rounds: 1,
                    agents: [agents[0]],
                };
            }
            return {
                kind: 'parallel',
                rounds: 1,
                agents,
            };
        }
        if (agents.length < 2) {
            if (agents.length === 0) return null;
            return {
                kind: 'single',
                rounds: 1,
                agents: [agents[0]],
            };
        }
        return {
            kind: 'debate',
            rounds,
            agents,
        };
    }

    function getDefaultRoute() {
        return { kind: 'single', rounds: 3, agents: [] };
    }

    function getRouteAgents(route) {
        return Array.isArray(route?.agents) ? route.agents : [];
    }

    function countRouteAgentsByProvider(route) {
        const counts = {};
        getRouteAgents(route).forEach((agent) => {
            const provider = String(agent?.provider || '').trim();
            if (!provider) return;
            counts[provider] = (counts[provider] || 0) + 1;
        });
        return counts;
    }

    function getRouteRequiredProviders(route) {
        const mode = String(route?.kind || '').toLowerCase();
        const requiredAgents =
            mode === 'single' ? getRouteAgents(route).slice(0, 1) : getRouteAgents(route);
        const providers = [];
        requiredAgents.forEach((agent) => {
            const provider = String(agent?.provider || '')
                .trim()
                .toLowerCase();
            if (!provider || providers.includes(provider)) return;
            providers.push(provider);
        });
        return providers;
    }

    function getRouteRequiredAgents(route) {
        const mode = String(route?.kind || '').toLowerCase();
        const requiredAgents =
            mode === 'single' ? getRouteAgents(route).slice(0, 1) : getRouteAgents(route);
        return requiredAgents
            .filter((agent) => agent && agent.provider)
            .map((agent) => ({
                id: agent.id,
                provider: String(agent.provider).trim().toLowerCase(),
                profileId: normalizeProfileSelection(agent.profileId),
            }));
    }

    function formatRouteSummary(route, labelFormatter = null) {
        const agents = getRouteAgents(route);
        if (agents.length === 0) return 'Select agents…';
        const kind = String(route?.kind || '').toLowerCase();
        const labels = agents
            .map((agent) => {
                if (typeof labelFormatter === 'function') {
                    return labelFormatter(agent);
                }
                const provider = String(agent?.provider || '')
                    .trim()
                    .toLowerCase();
                if (!provider) return '';
                if (provider === 'chatgpt') return 'ChatGPT';
                if (provider === 'gemini') return 'Gemini';
                if (provider === 'claude') return 'Claude';
                if (provider === 'grok') return 'Grok';
                return provider;
            })
            .filter(Boolean);
        if (kind === 'debate') {
            const rounds = Number.isFinite(Number(route?.rounds)) ? Number(route.rounds) : 1;
            return `Debate (${labels.join(' + ')}, ${rounds})`;
        }
        if (kind === 'parallel') return labels.join(' + ');
        return labels[0] || 'Single';
    }

    globalScope.MLCRouteBuilder = {
        DEFAULT_PROVIDER_IDS,
        generateRouteAgentId,
        normalizeProviderId,
        normalizeProfileSelection,
        normalizeRouteAgent,
        sanitizeRoute,
        getDefaultRoute,
        getRouteAgents,
        countRouteAgentsByProvider,
        getRouteRequiredProviders,
        getRouteRequiredAgents,
        formatRouteSummary,
    };
})(typeof self !== 'undefined' ? self : window);
