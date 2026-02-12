(function sidepanelHistoryControllerModule(globalScope) {
    'use strict';

    const client = globalScope.MLCSidepanelBackgroundClient || null;

    async function getHistoryStatus() {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ type: 'HISTORY_STATUS' });
    }

    async function lockHistory() {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ type: 'HISTORY_LOCK' });
    }

    async function unlockHistory(passphrase) {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ type: 'HISTORY_UNLOCK', passphrase });
    }

    globalScope.MLCSidepanelHistoryController = {
        getHistoryStatus,
        lockHistory,
        unlockHistory,
    };
})(typeof self !== 'undefined' ? self : window);
