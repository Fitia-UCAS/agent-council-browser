(function geminiCaptureProviderModule(globalScope) {
    'use strict';

    const provider = {
        id: 'gemini',
        matchesHost(hostname) {
            const host = String(hostname || '').toLowerCase();
            return host.includes('gemini.google.com');
        },
        forceCaptureStableMs: 15000,
    };

    const registry = globalScope.MLCCaptureProviders || {};
    registry.gemini = provider;
    globalScope.MLCCaptureProviders = registry;
})(typeof self !== 'undefined' ? self : window);
