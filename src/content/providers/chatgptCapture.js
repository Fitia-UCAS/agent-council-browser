(function chatgptCaptureProviderModule(globalScope) {
    'use strict';

    const provider = {
        id: 'chatgpt',
        matchesHost(hostname) {
            const host = String(hostname || '').toLowerCase();
            return host.includes('chatgpt.com') || host.includes('openai.com');
        },
        forceCaptureStableMs: 45000,
    };

    const registry = globalScope.MLCCaptureProviders || {};
    registry.chatgpt = provider;
    globalScope.MLCCaptureProviders = registry;
})(typeof self !== 'undefined' ? self : window);
