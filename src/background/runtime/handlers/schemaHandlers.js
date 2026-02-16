(function schemaHandlersModule(globalScope) {
    'use strict';

    function normalizeSchemaResetApi(schemaReset) {
        return schemaReset && typeof schemaReset === 'object' ? schemaReset : null;
    }

    function createSchemaHandlers(options = {}) {
        const schemaReset = normalizeSchemaResetApi(options.schemaReset);

        async function getStatus() {
            if (!schemaReset || typeof schemaReset.detectLegacyState !== 'function') {
                return {
                    ok: false,
                    error: 'Schema reset helper is unavailable.',
                    code: 'SCHEMA_HELPER_UNAVAILABLE',
                };
            }
            const status = await schemaReset.detectLegacyState();
            return { ok: true, status };
        }

        async function reset() {
            if (!schemaReset || typeof schemaReset.performReset !== 'function') {
                return {
                    ok: false,
                    error: 'Schema reset helper is unavailable.',
                    code: 'SCHEMA_HELPER_UNAVAILABLE',
                };
            }
            const result = await schemaReset.performReset();
            return { ok: true, result };
        }

        return {
            getStatus,
            reset,
        };
    }

    globalScope.MLCSchemaHandlers = {
        createSchemaHandlers,
    };
})(typeof self !== 'undefined' ? self : window);
