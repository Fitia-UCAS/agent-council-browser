(function sidepanelSessionControllerModule(globalScope) {
    'use strict';

    const client = globalScope.MLCSidepanelBackgroundClient || null;

    async function requestActiveSession(chatId) {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ type: 'GET_ACTIVE_SESSION', chatId: chatId || undefined });
    }

    async function resumeSession(sessionId) {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ type: 'RESUME_SESSION', sessionId });
    }

    async function stopSession(sessionId) {
        if (!client || typeof client.sendAsync !== 'function') return null;
        return client.sendAsync({ type: 'STOP_SESSION', sessionId });
    }

    globalScope.MLCSidepanelSessionController = {
        requestActiveSession,
        resumeSession,
        stopSession,
    };
})(typeof self !== 'undefined' ? self : window);
