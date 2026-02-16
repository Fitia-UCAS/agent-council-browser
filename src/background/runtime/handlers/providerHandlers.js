(function providerHandlersModule(globalScope) {
    'use strict';

    function createProviderHandlers(options = {}) {
        const capabilities =
            options && typeof options.providerCapabilities === 'object'
                ? { ...options.providerCapabilities }
                : {};

        function getCapabilities() {
            return { ok: true, capabilities: { ...capabilities } };
        }

        return {
            getCapabilities,
        };
    }

    globalScope.MLCProviderHandlers = {
        createProviderHandlers,
    };
})(typeof self !== 'undefined' ? self : window);
