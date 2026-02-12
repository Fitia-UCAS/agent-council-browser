(function captureEngineModule(globalScope) {
    'use strict';

    function createCaptureEngine({
        provider,
        extractLatestResponse,
        getGeneratingState,
        emitCapturedResponse,
        scheduler,
    } = {}) {
        const state = {
            provider: String(provider || '')
                .trim()
                .toLowerCase(),
            active: false,
            promptId: null,
            sessionId: null,
            turnIndex: null,
            agentId: null,
            startedAt: 0,
            baselineText: '',
            lastText: '',
            hasNewText: false,
            sawGenerating: false,
            lastTextChangeAt: 0,
        };

        const schedule =
            typeof scheduler === 'function' ? scheduler : (fn, delayMs) => setTimeout(fn, delayMs);

        function armCapture(message) {
            if (!message || !message.promptId) return false;
            state.active = true;
            state.promptId = message.promptId;
            state.sessionId = message.sessionId || null;
            state.turnIndex = message.turnIndex || null;
            state.agentId = message.agentId || null;
            state.startedAt = message.timestamp || Date.now();
            state.lastText = '';
            const baseline =
                typeof extractLatestResponse === 'function'
                    ? extractLatestResponse({ withMeta: true })
                    : { text: '' };
            state.baselineText = baseline?.text || '';
            state.hasNewText = false;
            state.sawGenerating = false;
            state.lastTextChangeAt = state.startedAt;
            return true;
        }

        function deactivate() {
            state.active = false;
            state.promptId = null;
        }

        function evaluateCapture() {
            if (!state.active || typeof extractLatestResponse !== 'function') return false;
            const extraction = extractLatestResponse({ withMeta: true });
            const text = String(extraction?.text || '');
            if (typeof getGeneratingState === 'function') {
                const generating = Boolean(getGeneratingState());
                state.sawGenerating = state.sawGenerating || generating;
                if (generating) {
                    state.lastText = text;
                    return false;
                }
            }
            if (!text.trim()) return false;
            if (!state.hasNewText && text.trim() === String(state.baselineText || '').trim()) {
                return false;
            }
            state.hasNewText = true;
            if (state.lastText !== text) {
                state.lastText = text;
                state.lastTextChangeAt = Date.now();
                return false;
            }
            const stableForMs = Date.now() - state.lastTextChangeAt;
            if (stableForMs < 900) return false;

            if (typeof emitCapturedResponse === 'function') {
                emitCapturedResponse({
                    ...extraction,
                    promptId: state.promptId,
                    sessionId: state.sessionId,
                    turnIndex: state.turnIndex,
                    agentId: state.agentId,
                });
            }
            deactivate();
            return true;
        }

        function scheduleEvaluation(delayMs = 0) {
            schedule(
                () => {
                    evaluateCapture();
                },
                Math.max(0, delayMs)
            );
        }

        return {
            state,
            armCapture,
            evaluateCapture,
            scheduleEvaluation,
            deactivate,
        };
    }

    globalScope.MLCCaptureEngine = {
        createCaptureEngine,
    };
})(typeof self !== 'undefined' ? self : window);
