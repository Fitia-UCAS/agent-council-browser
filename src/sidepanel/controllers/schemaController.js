(function sidepanelSchemaControllerModule(globalScope) {
    'use strict';

    const client = globalScope.MLCSidepanelBackgroundClient || null;

    async function getSchemaStatus() {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ command: 'SCHEMA_STATUS' });
    }

    async function runSchemaReset() {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ command: 'SCHEMA_RESET' });
    }

    globalScope.MLCSidepanelSchemaController = {
        getSchemaStatus,
        runSchemaReset,
    };
})(typeof self !== 'undefined' ? self : window);
