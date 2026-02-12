(function providerRegistryModule(globalScope) {
    'use strict';

    const DEFAULT_PROVIDER_METADATA = {
        chatgpt: {
            label: 'ChatGPT',
            openUrl: 'https://chatgpt.com/',
            expectedHosts: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'platform.openai.com'],
            urlPatterns: [
                '*://chat.openai.com/*',
                '*://chatgpt.com/*',
                '*://openai.com/chatgpt*',
                '*://platform.openai.com/*',
            ],
        },
        gemini: {
            label: 'Gemini',
            openUrl: 'https://gemini.google.com/',
            expectedHosts: ['gemini.google.com'],
            urlPatterns: ['*://gemini.google.com/*'],
        },
        claude: {
            label: 'Claude',
            openUrl: 'https://claude.ai/new',
            expectedHosts: ['claude.ai'],
            urlPatterns: ['*://claude.ai/*', '*://*.claude.ai/*'],
        },
        grok: {
            label: 'Grok',
            openUrl: 'https://grok.com/',
            expectedHosts: ['grok.com'],
            urlPatterns: ['*://grok.com/*', '*://*.grok.com/*'],
        },
    };

    const DEFAULT_PROVIDER_CAPABILITIES = {
        chatgpt: {
            attachments: { mode: 'auto' },
        },
        gemini: {
            attachments: { mode: 'manual' },
        },
        claude: {
            attachments: { mode: 'auto' },
        },
        grok: {
            attachments: { mode: 'auto' },
        },
    };

    function normalizeProviderKey(provider) {
        return String(provider || '')
            .trim()
            .toLowerCase();
    }

    function cloneRecord(input) {
        return JSON.parse(JSON.stringify(input || {}));
    }

    function createProviderRegistry({
        metadata = DEFAULT_PROVIDER_METADATA,
        capabilities = DEFAULT_PROVIDER_CAPABILITIES,
        fallbackProvider = 'chatgpt',
    } = {}) {
        const providerMetadata = cloneRecord(metadata);
        const providerCapabilities = cloneRecord(capabilities);
        const supportedProviders = [
            ...new Set(Object.keys(providerCapabilities).map(normalizeProviderKey).filter(Boolean)),
        ];

        function getSupportedProviderKeys() {
            return [...supportedProviders];
        }

        function isSupportedProviderKey(provider) {
            const key = normalizeProviderKey(provider);
            return Boolean(key) && supportedProviders.includes(key);
        }

        function normalizeProvider(provider) {
            const key = normalizeProviderKey(provider);
            if (isSupportedProviderKey(key)) return key;
            return fallbackProvider;
        }

        function getProviderMetadata(provider) {
            const key = normalizeProvider(provider);
            return providerMetadata[key] || providerMetadata[fallbackProvider] || null;
        }

        function getProviderCapabilities(provider) {
            const key = normalizeProvider(provider);
            return providerCapabilities[key] || providerCapabilities[fallbackProvider] || {};
        }

        function formatProviderLabel(provider) {
            const meta = getProviderMetadata(provider);
            if (meta?.label) return meta.label;
            return String(normalizeProvider(provider) || fallbackProvider);
        }

        function getExpectedHosts(provider) {
            const meta = getProviderMetadata(provider);
            const hosts = Array.isArray(meta?.expectedHosts) ? meta.expectedHosts : [];
            if (hosts.length > 0) return hosts;
            return providerMetadata[fallbackProvider]?.expectedHosts || [];
        }

        function isExpectedHost(provider, url) {
            if (!url) return false;
            try {
                const { hostname } = new URL(url);
                const expected = getExpectedHosts(provider);
                return expected.some((host) => hostname === host || hostname.endsWith(`.${host}`));
            } catch {
                return false;
            }
        }

        function getProviderAttachmentMode(provider) {
            const mode = getProviderCapabilities(provider)?.attachments?.mode;
            if (mode === 'manual' || mode === 'none') return mode;
            return 'auto';
        }

        function getOpenUrl(provider) {
            const meta = getProviderMetadata(provider);
            return String(meta?.openUrl || '');
        }

        function isContentScriptInjectableUrl(provider, url) {
            if (!url) return false;
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'https:') return false;
                const hostname = parsed.hostname;
                const normalized = normalizeProvider(provider);
                if (normalized === 'chatgpt') {
                    return hostname === 'chatgpt.com' || hostname === 'chat.openai.com';
                }
                if (normalized === 'gemini') {
                    return hostname === 'gemini.google.com';
                }
                if (normalized === 'claude') {
                    return hostname === 'claude.ai' || hostname.endsWith('.claude.ai');
                }
                if (normalized === 'grok') {
                    return hostname === 'grok.com' || hostname.endsWith('.grok.com');
                }
                return false;
            } catch {
                return false;
            }
        }

        function buildProviderFlagMap(providers, initialValue) {
            const map = {};
            if (!Array.isArray(providers)) return map;
            providers.forEach((provider) => {
                const key = normalizeProviderKey(provider);
                if (!key || Object.prototype.hasOwnProperty.call(map, key)) return;
                map[key] = Boolean(initialValue);
            });
            return map;
        }

        function listSessionProviders(session, fallback = null) {
            const ordered = [];
            const push = (provider) => {
                const key = normalizeProviderKey(provider);
                if (!key || !isSupportedProviderKey(key)) return;
                if (!ordered.includes(key)) ordered.push(key);
            };
            push(session?.firstLLM);
            push(session?.secondLLM);
            push(fallback);
            return ordered;
        }

        function getSessionProviders(session, fallback = null) {
            const ordered = [];
            const push = (provider) => {
                const key = normalizeProviderKey(provider);
                if (!key || !isSupportedProviderKey(key)) return;
                if (!ordered.includes(key)) ordered.push(key);
            };
            const routeProviders = Array.isArray(session?.route?.providers)
                ? session.route.providers
                : [];
            routeProviders.forEach(push);
            listSessionProviders(session, fallback).forEach(push);
            return ordered;
        }

        return {
            normalizeProviderKey,
            normalizeProvider,
            getSupportedProviderKeys,
            isSupportedProviderKey,
            getProviderMetadata,
            getProviderCapabilities,
            formatProviderLabel,
            getExpectedHosts,
            isExpectedHost,
            getProviderAttachmentMode,
            getOpenUrl,
            isContentScriptInjectableUrl,
            buildProviderFlagMap,
            listSessionProviders,
            getSessionProviders,
            getMetadataMap: () => cloneRecord(providerMetadata),
            getCapabilitiesMap: () => cloneRecord(providerCapabilities),
        };
    }

    globalScope.MLCProviderRegistry = {
        DEFAULT_PROVIDER_METADATA,
        DEFAULT_PROVIDER_CAPABILITIES,
        createProviderRegistry,
    };
})(typeof self !== 'undefined' ? self : window);
