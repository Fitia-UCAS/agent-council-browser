(function tabProfileStoreModule(globalScope) {
    'use strict';

    function createTabProfileStore({
        storageArea = null,
        storageKey = 'mlc_tab_profiles_v1',
        providerRegistry = null,
        formatProviderLabel = null,
        getTabUrlCandidate = null,
    } = {}) {
        const storage = storageArea || globalScope.chrome?.storage?.local || null;
        if (!storage) {
            throw new Error('Tab profile store requires a storage area.');
        }
        const registry = providerRegistry || null;
        const getProviderKeys = () =>
            registry && typeof registry.getSupportedProviderKeys === 'function'
                ? registry.getSupportedProviderKeys()
                : ['chatgpt', 'gemini'];
        const normalizeProvider = (provider) =>
            registry && typeof registry.normalizeProvider === 'function'
                ? registry.normalizeProvider(provider)
                : String(provider || '')
                      .trim()
                      .toLowerCase();
        const isExpectedHost = (provider, url) =>
            registry && typeof registry.isExpectedHost === 'function'
                ? registry.isExpectedHost(provider, url)
                : true;
        const labelFor =
            typeof formatProviderLabel === 'function'
                ? formatProviderLabel
                : (provider) => String(provider || '').trim() || 'Provider';
        const getTabUrl =
            typeof getTabUrlCandidate === 'function'
                ? getTabUrlCandidate
                : (tab) => {
                      if (!tab) return '';
                      if (typeof tab.url === 'string' && tab.url) return tab.url;
                      if (typeof tab.pendingUrl === 'string' && tab.pendingUrl)
                          return tab.pendingUrl;
                      return '';
                  };

        function createEmptyState() {
            const defaults = {};
            getProviderKeys().forEach((provider) => {
                defaults[provider] = null;
            });
            if (!Object.prototype.hasOwnProperty.call(defaults, 'chatgpt')) defaults.chatgpt = null;
            if (!Object.prototype.hasOwnProperty.call(defaults, 'gemini')) defaults.gemini = null;
            return { profiles: [], defaults };
        }

        function generateProfileId() {
            return 'profile_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        function normalizeInlineText(value) {
            return String(value || '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function sanitizeModelHint(provider, modelHint) {
            const cleaned = normalizeInlineText(modelHint)
                .replace(/^Model:\s*/i, '')
                .trim();
            if (!cleaned) return '';
            if (cleaned.length > 80) return '';
            const words = cleaned.split(' ').filter(Boolean);
            if (words.length > 12) return '';

            const suspicious = [
                /iteration\s*\d/i,
                /user (query|message)/i,
                /\bnow respond\b/i,
                /\bmulti[-\s]llm\b/i,
                /\bmulti[-\s]agent\b/i,
                /\bdebate\b/i,
                /\bhere is\b/i,
                /\bchatgpt\b.*\banswer\b/i,
                /\bgemini\b.*\banswer\b/i,
            ];
            if (suspicious.some((re) => re.test(cleaned))) return '';
            return cleaned;
        }

        function sanitizeProfilesState(state) {
            if (!state || !Array.isArray(state.profiles)) return { state, changed: false };
            let changed = false;
            const nextProfiles = state.profiles.map((profile) => {
                const next = { ...profile };
                const safeHint = sanitizeModelHint(next.provider, next.modelHint);
                if (safeHint !== (next.modelHint || '')) {
                    next.modelHint = safeHint;
                    changed = true;
                }
                return next;
            });
            const nextState = changed ? { ...state, profiles: nextProfiles } : state;
            return { state: nextState, changed };
        }

        async function load() {
            const stored = await storage.get(storageKey);
            if (stored && stored[storageKey]) {
                const next = stored[storageKey];
                if (Array.isArray(next.profiles) && next.defaults) {
                    const baseDefaults = createEmptyState().defaults;
                    const storedDefaults =
                        next.defaults && typeof next.defaults === 'object' ? next.defaults : {};
                    const defaults = { ...baseDefaults };
                    for (const [provider, profileId] of Object.entries(storedDefaults)) {
                        const key = normalizeProvider(provider);
                        if (!key) continue;
                        if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
                        defaults[key] = profileId || null;
                    }
                    const state = { profiles: next.profiles, defaults };
                    return sanitizeProfilesState(state).state;
                }
            }
            return createEmptyState();
        }

        async function save(state) {
            await storage.set({ [storageKey]: state });
            return state;
        }

        function findById(state, profileId) {
            return state.profiles.find((profile) => profile.profileId === profileId);
        }

        function findByTabId(state, provider, tabId) {
            return state.profiles.find(
                (profile) => profile.provider === provider && profile.tabId === tabId
            );
        }

        function formatDefaultLabel(provider, tab) {
            const base = labelFor(provider);
            if (tab?.title) {
                const trimmed = tab.title.trim();
                if (trimmed) {
                    return `${base} - ${trimmed.length > 32 ? `${trimmed.slice(0, 29)}...` : trimmed}`;
                }
            }
            return `${base} profile`;
        }

        function applyPatch(profile, patch = {}) {
            const next = { ...profile };
            if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
                next.label = String(patch.label || '').trim() || next.label;
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'tabId')) {
                next.tabId = Number.isFinite(patch.tabId) ? patch.tabId : null;
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'windowId')) {
                next.windowId = Number.isFinite(patch.windowId) ? patch.windowId : null;
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'modelHint')) {
                next.modelHint = sanitizeModelHint(next.provider, patch.modelHint);
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'lastKnownTitle')) {
                next.lastKnownTitle = patch.lastKnownTitle ? String(patch.lastKnownTitle) : '';
            }
            if (Object.prototype.hasOwnProperty.call(patch, 'lastKnownUrl')) {
                next.lastKnownUrl = patch.lastKnownUrl ? String(patch.lastKnownUrl) : '';
            }
            return next;
        }

        async function validateProfile(profile) {
            const updatedAt = Date.now();
            if (!profile || !profile.tabId) {
                return { ...profile, status: 'offline', updatedAt };
            }
            try {
                const tab = await chrome.tabs.get(profile.tabId);
                const url = getTabUrl(tab);
                const status = url
                    ? isExpectedHost(profile.provider, url)
                        ? 'ok'
                        : 'wrong_host'
                    : 'unknown';
                return {
                    ...profile,
                    tabId: tab.id,
                    windowId: tab.windowId,
                    lastKnownTitle: tab.title || profile.lastKnownTitle || '',
                    lastKnownUrl: url || profile.lastKnownUrl || '',
                    status,
                    lastSeenAt: Date.now(),
                    updatedAt,
                };
            } catch {
                return {
                    ...profile,
                    status: 'offline',
                    windowId: null,
                    updatedAt,
                };
            }
        }

        async function refreshAllProfiles({ persist = true } = {}) {
            const state = await load();
            const updatedProfiles = await Promise.all(
                state.profiles.map((profile) => validateProfile(profile))
            );
            const next = sanitizeProfilesState({ ...state, profiles: updatedProfiles }).state;
            if (persist) {
                await save(next);
            }
            return next;
        }

        return {
            createEmptyState,
            generateProfileId,
            normalizeInlineText,
            sanitizeModelHint,
            sanitizeProfilesState,
            load,
            save,
            findById,
            findByTabId,
            formatDefaultLabel,
            applyPatch,
            validateProfile,
            refreshAllProfiles,
        };
    }

    globalScope.MLCTabProfileStore = {
        createTabProfileStore,
    };
})(typeof self !== 'undefined' ? self : window);
