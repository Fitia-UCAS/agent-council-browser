(function grokCaptureProviderModule(globalScope) {
    'use strict';

    const provider = {
        id: 'grok',
        matchesHost(hostname) {
            const host = String(hostname || '').toLowerCase();
            return host.includes('grok.com');
        },
        forceCaptureStableMs: 22000,
    };

    const registry = globalScope.MLCCaptureProviders || {};
    registry.grok = provider;
    globalScope.MLCCaptureProviders = registry;
})(typeof self !== 'undefined' ? self : window);
