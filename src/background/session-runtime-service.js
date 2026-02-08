(function initSessionRuntimeService(global) {
    function createSessionRuntimeService(deps = {}) {
        const handleStartDebateSession = typeof deps.handleStartDebateSession === 'function'
            ? deps.handleStartDebateSession
            : null;
        const resumeDebateSession = typeof deps.resumeDebateSession === 'function'
            ? deps.resumeDebateSession
            : null;
        const handleStopDebateSession = typeof deps.handleStopDebateSession === 'function'
            ? deps.handleStopDebateSession
            : null;
        const enqueueDebateResponse = typeof deps.enqueueDebateResponse === 'function'
            ? deps.enqueueDebateResponse
            : null;
        const handleGeminiResponse = typeof deps.handleGeminiResponse === 'function'
            ? deps.handleGeminiResponse
            : null;
        const handleChatGPTResponse = typeof deps.handleChatGPTResponse === 'function'
            ? deps.handleChatGPTResponse
            : null;
        const handleClaudeResponse = typeof deps.handleClaudeResponse === 'function'
            ? deps.handleClaudeResponse
            : null;
        const handleGrokResponse = typeof deps.handleGrokResponse === 'function'
            ? deps.handleGrokResponse
            : null;
        const logger = {
            error: typeof deps.error === 'function' ? deps.error : (...args) => console.error(...args)
        };

        const RUNTIME_MESSAGE_TYPES = new Set([
            'GEMINI_RESPONSE_CAPTURED',
            'CHATGPT_RESPONSE_CAPTURED',
            'CLAUDE_RESPONSE_CAPTURED',
            'GROK_RESPONSE_CAPTURED',
            'MLC_RESPONSE_CAPTURED',
            'MULTI_AGENT_RESPONSE_CAPTURED',
            'START_DEBATE_SESSION',
            'START_RUN',
            'RESUME_SESSION',
            'STOP_SESSION',
            'START_MULTI_AGENT_SESSION',
            'END_MULTI_AGENT_SESSION'
        ]);

        function unavailableError(action) {
            return { ok: false, error: `${action} unavailable`, code: 'SERVICE_UNAVAILABLE' };
        }

        function handleRuntimeMessage(message, sendResponse) {
            if (!message || !RUNTIME_MESSAGE_TYPES.has(message.type)) return false;

            switch (message.type) {
                case 'GEMINI_RESPONSE_CAPTURED':
                    if (enqueueDebateResponse) enqueueDebateResponse(message, 'Gemini response');
                    if (handleGeminiResponse) handleGeminiResponse(message);
                    sendResponse({ status: 'gemini_response_received', type: message.type });
                    return false;
                case 'CHATGPT_RESPONSE_CAPTURED':
                    if (enqueueDebateResponse) enqueueDebateResponse(message, 'ChatGPT response');
                    if (handleChatGPTResponse) handleChatGPTResponse(message);
                    sendResponse({ status: 'chatgpt_response_received', type: message.type });
                    return false;
                case 'CLAUDE_RESPONSE_CAPTURED':
                    if (enqueueDebateResponse) enqueueDebateResponse(message, 'Claude response');
                    if (handleClaudeResponse) handleClaudeResponse(message);
                    sendResponse({ status: 'claude_response_received', type: message.type });
                    return false;
                case 'GROK_RESPONSE_CAPTURED':
                    if (enqueueDebateResponse) enqueueDebateResponse(message, 'Grok response');
                    if (handleGrokResponse) handleGrokResponse(message);
                    sendResponse({ status: 'grok_response_received', type: message.type });
                    return false;
                case 'MLC_RESPONSE_CAPTURED':
                    if (enqueueDebateResponse) enqueueDebateResponse(message, 'response');
                    sendResponse({ status: 'mlc_response_received', type: message.type });
                    return false;
                case 'MULTI_AGENT_RESPONSE_CAPTURED':
                    if (enqueueDebateResponse) enqueueDebateResponse(message, 'multi-agent response');
                    sendResponse({ status: 'multi_agent_response_received', type: message.type });
                    return false;
                case 'START_DEBATE_SESSION':
                    if (!handleStartDebateSession) {
                        sendResponse(unavailableError('start debate session'));
                        return false;
                    }
                    handleStartDebateSession(message).catch((error) => {
                        logger.error('[MLC Runtime] Error starting session:', error);
                    });
                    sendResponse({ status: 'debate_session_started', type: message.type });
                    return false;
                case 'START_RUN':
                    if (!handleStartDebateSession) {
                        sendResponse(unavailableError('start run'));
                        return false;
                    }
                    handleStartDebateSession(message).catch((error) => {
                        logger.error('[MLC Runtime] Error starting run:', error);
                    });
                    sendResponse({ status: 'run_started', type: message.type });
                    return false;
                case 'RESUME_SESSION':
                    if (!resumeDebateSession) {
                        sendResponse(unavailableError('resume session'));
                        return false;
                    }
                    resumeDebateSession(message.sessionId, message.chatId || null).then(sendResponse).catch((error) => {
                        logger.error('[MLC Runtime] Error resuming session:', error);
                        sendResponse({ ok: false, error: error.message });
                    });
                    return true;
                case 'STOP_SESSION':
                    if (!handleStopDebateSession) {
                        sendResponse(unavailableError('stop session'));
                        return false;
                    }
                    handleStopDebateSession(message).catch((error) => {
                        logger.error('[MLC Runtime] Error stopping session:', error);
                    });
                    sendResponse({ status: 'debate_session_stopped', type: message.type });
                    return false;
                case 'START_MULTI_AGENT_SESSION':
                    if (!handleStartDebateSession) {
                        sendResponse(unavailableError('start multi-agent session'));
                        return false;
                    }
                    handleStartDebateSession({
                        prompt: message.prompt,
                        firstLLM: message.sourceLLM,
                        rounds: message.maxIterations
                    }).catch((error) => {
                        logger.error('[MLC Runtime] Error starting multi-agent session:', error);
                    });
                    sendResponse({ status: 'multi_agent_session_started', type: message.type });
                    return false;
                case 'END_MULTI_AGENT_SESSION':
                    if (!handleStopDebateSession) {
                        sendResponse(unavailableError('end multi-agent session'));
                        return false;
                    }
                    handleStopDebateSession({ reason: message.reason || 'User requested' }).catch((error) => {
                        logger.error('[MLC Runtime] Error stopping multi-agent session:', error);
                    });
                    sendResponse({ status: 'multi_agent_session_ended', type: message.type });
                    return false;
                default:
                    return false;
            }
        }

        function getHandledMessageTypes() {
            return [...RUNTIME_MESSAGE_TYPES];
        }

        return {
            handleRuntimeMessage,
            getHandledMessageTypes
        };
    }

    global.createSessionRuntimeService = createSessionRuntimeService;
}(globalThis));
