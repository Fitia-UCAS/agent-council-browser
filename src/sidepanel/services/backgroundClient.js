(function sidepanelBackgroundClientModule(globalScope) {
    'use strict';

    function getProtocol() {
        return globalScope.MLCProtocolV3 &&
            typeof globalScope.MLCProtocolV3.withProtocolEnvelope === 'function'
            ? globalScope.MLCProtocolV3
            : null;
    }

    function normalizeOutbound(message) {
        const payload = message && typeof message === 'object' ? { ...message } : {};
        const protocol = getProtocol();
        if (!protocol) return payload;
        return protocol.withProtocolEnvelope(payload);
    }

    function send(message, callback) {
        if (!chrome?.runtime?.sendMessage) return;
        const outbound = normalizeOutbound(message);
        if (getProtocol() && !outbound.command) {
            callback?.({
                ok: false,
                error: 'Unsupported control message: missing protocol command.',
                code: 'UNKNOWN_COMMAND',
            });
            return;
        }
        chrome.runtime.sendMessage(outbound, (response) => {
            if (chrome.runtime.lastError) {
                const kind = outbound.command || outbound.type || 'unknown';
                console.warn(
                    '[MLC Sidepanel] background send failed:',
                    kind,
                    chrome.runtime.lastError.message
                );
            }
            callback?.(response);
        });
    }

    function sendAsync(message) {
        return new Promise((resolve) => {
            send(message, resolve);
        });
    }

    globalScope.MLCSidepanelBackgroundClient = {
        normalizeOutbound,
        send,
        sendAsync,
    };
})(typeof self !== 'undefined' ? self : window);
