(function messageRouterModule(globalScope) {
    'use strict';

    function normalizeRuntimeMessage(protocol, message) {
        const protocolApi = protocol && typeof protocol === 'object' ? protocol : null;
        if (protocolApi && typeof protocolApi.normalizeInboundMessage === 'function') {
            return protocolApi.normalizeInboundMessage(message);
        }

        if (!message || typeof message !== 'object') {
            return {
                ok: false,
                error: 'Invalid message payload.',
                code: 'INVALID_MESSAGE',
            };
        }
        return { ok: true, message };
    }

    function summarizeRuntimeMessage(protocol, message) {
        const protocolApi = protocol && typeof protocol === 'object' ? protocol : null;
        if (protocolApi && typeof protocolApi.summarizeMessageForLog === 'function') {
            return protocolApi.summarizeMessageForLog(message);
        }
        return { type: message?.type || null };
    }

    function createRuntimeMessageRouter(options = {}) {
        const protocol = options && typeof options === 'object' ? options.protocol || null : null;
        const handlers = new Map();

        function register(type, handler) {
            const normalizedType = String(type || '').trim();
            if (!normalizedType) return false;
            if (typeof handler !== 'function') return false;
            handlers.set(normalizedType, handler);
            return true;
        }

        function handle(rawMessage) {
            const normalized = normalizeRuntimeMessage(protocol, rawMessage);
            if (!normalized || !normalized.ok) {
                return {
                    handled: true,
                    response: {
                        ok: false,
                        error: normalized?.error || 'Invalid message payload.',
                        code: normalized?.code || 'INVALID_MESSAGE',
                    },
                };
            }

            const message = normalized.message || rawMessage || {};
            const type = String(message.type || '').trim();
            if (!type) {
                return {
                    handled: true,
                    response: {
                        ok: false,
                        error: 'Invalid message payload.',
                        code: 'INVALID_MESSAGE',
                    },
                };
            }

            const handler = handlers.get(type);
            if (!handler) {
                return {
                    handled: true,
                    response: {
                        ok: false,
                        error: `Unknown command: ${message.command || type}`,
                        code: 'UNKNOWN_COMMAND',
                    },
                };
            }

            const outcome = handler(message);
            if (outcome && typeof outcome === 'object' && 'response' in outcome) {
                return { handled: true, response: outcome.response };
            }
            return { handled: true, response: outcome };
        }

        return {
            register,
            handle,
        };
    }

    globalScope.MLCMessageRouter = {
        normalizeRuntimeMessage,
        summarizeRuntimeMessage,
        createRuntimeMessageRouter,
    };
})(typeof self !== 'undefined' ? self : window);
