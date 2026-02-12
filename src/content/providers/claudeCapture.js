(function claudeCaptureProviderModule(globalScope) {
    'use strict';

    const provider = {
        id: 'claude',
        matchesHost(hostname) {
            const host = String(hostname || '').toLowerCase();
            return host.includes('claude.ai');
        },
        forceCaptureStableMs: 20000,
    };

    const registry = globalScope.MLCCaptureProviders || {};
    registry.claude = provider;
    globalScope.MLCCaptureProviders = registry;
})(typeof self !== 'undefined' ? self : window);
