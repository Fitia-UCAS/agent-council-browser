(function initPromptService(global) {
    function createPromptService(deps = {}) {
        const getDebatePromptConfigForUi = typeof deps.getDebatePromptConfigForUi === 'function'
            ? deps.getDebatePromptConfigForUi
            : null;
        const setDebatePromptOverride = typeof deps.setDebatePromptOverride === 'function'
            ? deps.setDebatePromptOverride
            : null;
        const clearDebatePromptOverride = typeof deps.clearDebatePromptOverride === 'function'
            ? deps.clearDebatePromptOverride
            : null;

        const buildDebatePrompt = typeof deps.buildDebatePrompt === 'function' ? deps.buildDebatePrompt : null;
        const buildSinglePrompt = typeof deps.buildSinglePrompt === 'function' ? deps.buildSinglePrompt : null;
        const buildDirectPrompt = typeof deps.buildDirectPrompt === 'function' ? deps.buildDirectPrompt : null;
        const buildSessionPrompt = typeof deps.buildSessionPrompt === 'function' ? deps.buildSessionPrompt : null;

        const getChatDeliveryStateKey = typeof deps.getChatDeliveryStateKey === 'function'
            ? deps.getChatDeliveryStateKey
            : (chatId) => `mlc_chat_delivery_state_v1:${chatId}`;
        const createEmptyDeliveryState = typeof deps.createEmptyDeliveryState === 'function'
            ? deps.createEmptyDeliveryState
            : () => ({ schemaVersion: 2, updatedAt: 0, providers: {} });
        const normalizeDeliveryProviderState = typeof deps.normalizeDeliveryProviderState === 'function'
            ? deps.normalizeDeliveryProviderState
            : (value) => value;
        const normalizeChatDeliveryState = typeof deps.normalizeChatDeliveryState === 'function'
            ? deps.normalizeChatDeliveryState
            : (value) => value;
        const getProviderContextKey = typeof deps.getProviderContextKey === 'function'
            ? deps.getProviderContextKey
            : () => null;
        const getEffectiveDeliveredUpTo = typeof deps.getEffectiveDeliveredUpTo === 'function'
            ? deps.getEffectiveDeliveredUpTo
            : () => 0;
        const logger = {
            error: typeof deps.error === 'function' ? deps.error : (...args) => console.error(...args)
        };

        const PROMPT_MESSAGE_TYPES = new Set([
            'GET_DEBATE_PROMPTS',
            'SET_DEBATE_PROMPTS',
            'RESET_DEBATE_PROMPTS'
        ]);

        function makeUnavailableError(action) {
            return {
                ok: false,
                error: `${action} unavailable`,
                code: 'SERVICE_UNAVAILABLE'
            };
        }

        function handlePromptMessage(message, sendResponse) {
            if (!message || !PROMPT_MESSAGE_TYPES.has(message.type)) {
                return false;
            }

            switch (message.type) {
                case 'GET_DEBATE_PROMPTS':
                    if (typeof getDebatePromptConfigForUi !== 'function') {
                        sendResponse(makeUnavailableError('Prompt config read'));
                        return false;
                    }
                    getDebatePromptConfigForUi().then(sendResponse).catch((error) => {
                        logger.error('[MLC PromptService] Error loading prompt templates:', error);
                        sendResponse({ ok: false, error: error?.message || 'Failed to load prompt templates' });
                    });
                    return true;
                case 'SET_DEBATE_PROMPTS':
                    if (typeof setDebatePromptOverride !== 'function') {
                        sendResponse(makeUnavailableError('Prompt config write'));
                        return false;
                    }
                    setDebatePromptOverride(message.config).then(sendResponse).catch((error) => {
                        logger.error('[MLC PromptService] Error saving prompt templates:', error);
                        sendResponse({ ok: false, error: error?.message || 'Failed to save prompt templates' });
                    });
                    return true;
                case 'RESET_DEBATE_PROMPTS':
                    if (typeof clearDebatePromptOverride !== 'function') {
                        sendResponse(makeUnavailableError('Prompt config reset'));
                        return false;
                    }
                    clearDebatePromptOverride().then(sendResponse).catch((error) => {
                        logger.error('[MLC PromptService] Error resetting prompt templates:', error);
                        sendResponse({ ok: false, error: error?.message || 'Failed to reset prompt templates' });
                    });
                    return true;
                default:
                    return false;
            }
        }

        function getHandledMessageTypes() {
            return [...PROMPT_MESSAGE_TYPES];
        }

        return {
            handlePromptMessage,
            getHandledMessageTypes,
            buildDebatePrompt,
            buildSinglePrompt,
            buildDirectPrompt,
            buildSessionPrompt,
            getChatDeliveryStateKey,
            createEmptyDeliveryState,
            normalizeDeliveryProviderState,
            normalizeChatDeliveryState,
            getProviderContextKey,
            getEffectiveDeliveredUpTo
        };
    }

    global.createPromptService = createPromptService;
}(globalThis));
