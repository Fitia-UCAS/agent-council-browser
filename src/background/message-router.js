(function initBackgroundMessageRouter(global) {
    function createBackgroundMessageRouter(deps = {}) {
        const historyChatService = deps.historyChatService || null;
        const historyMessageTypes = deps.historyMessageTypes || new Set();

        const profileService = deps.profileService || null;
        const profileMessageTypes = deps.profileMessageTypes || new Set();

        const promptService = deps.promptService || null;
        const promptMessageTypes = deps.promptMessageTypes || new Set();

        const sessionRuntimeService = deps.sessionRuntimeService || null;
        const sessionRuntimeMessageTypes = deps.sessionRuntimeMessageTypes || new Set();

        const handlersByType = deps.handlersByType && typeof deps.handlersByType === 'object'
            ? deps.handlersByType
            : {};

        const unknownHandler = typeof deps.unknownHandler === 'function'
            ? deps.unknownHandler
            : ({ message, sendResponse }) => {
                console.warn('[MLC Background] Unknown message type:', message?.type);
                sendResponse({ status: 'unknown_message_type' });
                return false;
            };

        function serviceUnavailable(sendResponse, serviceLabel) {
            sendResponse({
                ok: false,
                error: `${serviceLabel} service unavailable.`,
                code: 'SERVICE_UNAVAILABLE'
            });
            return false;
        }

        function handleMessage(message, sender, sendResponse) {
            if (historyMessageTypes.has(message?.type)) {
                if (historyChatService?.handleHistoryAndChatMessage) {
                    return Boolean(historyChatService.handleHistoryAndChatMessage(message, sendResponse));
                }
                return serviceUnavailable(sendResponse, 'History/chat');
            }

            if (profileMessageTypes.has(message?.type)) {
                if (profileService?.handleProfileMessage) {
                    return Boolean(profileService.handleProfileMessage(message, sender, sendResponse));
                }
                return serviceUnavailable(sendResponse, 'Profile');
            }

            if (promptMessageTypes.has(message?.type)) {
                if (promptService?.handlePromptMessage) {
                    return Boolean(promptService.handlePromptMessage(message, sendResponse));
                }
                return serviceUnavailable(sendResponse, 'Prompt');
            }

            if (sessionRuntimeMessageTypes.has(message?.type)) {
                if (sessionRuntimeService?.handleRuntimeMessage) {
                    return Boolean(sessionRuntimeService.handleRuntimeMessage(message, sendResponse));
                }
                return serviceUnavailable(sendResponse, 'Session runtime');
            }

            const handler = handlersByType[message?.type];
            if (typeof handler === 'function') {
                return Boolean(handler({ message, sender, sendResponse }));
            }

            return Boolean(unknownHandler({ message, sender, sendResponse }));
        }

        return {
            handleMessage
        };
    }

    global.createBackgroundMessageRouter = createBackgroundMessageRouter;
}(globalThis));
