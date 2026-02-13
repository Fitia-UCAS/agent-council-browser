(function routeBindingModule(globalScope) {
    'use strict';

    function normalizeProviderId(provider) {
        const value = String(provider || '')
            .trim()
            .toLowerCase();
        return value || null;
    }

    function normalizeProfileSelection(value) {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        if (!text) return null;
        if (text === 'default') return 'default';
        return text;
    }

    function getKnownProfileConnection(profileConnectionStatus, profileId) {
        if (!profileId) return null;
        if (!profileConnectionStatus || typeof profileConnectionStatus !== 'object') return null;
        if (!Object.prototype.hasOwnProperty.call(profileConnectionStatus, profileId)) return null;
        return profileConnectionStatus[profileId] === true
            ? true
            : profileConnectionStatus[profileId] === false
              ? false
              : null;
    }

    function isProfileRoutable(profile, provider) {
        if (!profile || typeof profile !== 'object') return false;
        const normalizedProvider = normalizeProviderId(provider);
        const profileProvider = normalizeProviderId(profile.provider);
        if (!normalizedProvider || !profileProvider) return false;
        if (normalizedProvider !== profileProvider) return false;
        if (profile.inUseBySessionId) return false;
        if (!Number.isFinite(profile.tabId)) return false;
        if (profile.status === 'offline') return false;
        if (profile.status === 'wrong_host') return false;
        return true;
    }

    function pickRouteAgentIndexForNewTabBinding({
        provider,
        agents,
        targetAgentId = null,
        defaultProfileId = null,
        profilesById = {},
        profileConnectionStatus = {},
    } = {}) {
        const normalizedProvider = normalizeProviderId(provider);
        if (!normalizedProvider) return -1;
        if (!Array.isArray(agents) || agents.length === 0) return -1;

        if (targetAgentId) {
            const explicitIndex = agents.findIndex((agent) => {
                const agentProvider = normalizeProviderId(agent?.provider);
                return agent?.id === targetAgentId && agentProvider === normalizedProvider;
            });
            if (explicitIndex >= 0) return explicitIndex;
        }

        for (let i = agents.length - 1; i >= 0; i -= 1) {
            const agent = agents[i];
            const agentProvider = normalizeProviderId(agent?.provider);
            if (agentProvider !== normalizedProvider) continue;

            const selection = normalizeProfileSelection(agent?.profileId);
            if (!selection) return i;

            if (selection === 'default') {
                if (!defaultProfileId) return i;
                const profile = profilesById?.[defaultProfileId] || null;
                if (!isProfileRoutable(profile, normalizedProvider)) return i;
                if (getKnownProfileConnection(profileConnectionStatus, defaultProfileId) === false)
                    return i;
                continue;
            }

            const profile = profilesById?.[selection] || null;
            if (!isProfileRoutable(profile, normalizedProvider)) return i;
            if (getKnownProfileConnection(profileConnectionStatus, selection) === false) return i;
        }

        return -1;
    }

    globalScope.MLCRouteBinding = {
        normalizeProviderId,
        normalizeProfileSelection,
        pickRouteAgentIndexForNewTabBinding,
    };
})(typeof self !== 'undefined' ? self : window);
