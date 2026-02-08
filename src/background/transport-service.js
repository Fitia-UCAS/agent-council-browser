(function initTransportService(global) {
    function createTransportService(deps = {}) {
        const processLLM = typeof deps.processLLM === 'function' ? deps.processLLM : null;
        const listLLMTabs = typeof deps.listLLMTabs === 'function' ? deps.listLLMTabs : null;
        const resolveTabForLLM = typeof deps.resolveTabForLLM === 'function' ? deps.resolveTabForLLM : null;
        const findLLMTab = typeof deps.findLLMTab === 'function' ? deps.findLLMTab : null;
        const injectAndExecute = typeof deps.injectAndExecute === 'function' ? deps.injectAndExecute : null;
        const injectAndPrepareAttachments = typeof deps.injectAndPrepareAttachments === 'function'
            ? deps.injectAndPrepareAttachments
            : null;
        const sendPromptViaClaudeDebugger = typeof deps.sendPromptViaClaudeDebugger === 'function'
            ? deps.sendPromptViaClaudeDebugger
            : null;
        const simpleInteraction = typeof deps.simpleInteraction === 'function' ? deps.simpleInteraction : null;

        function unavailable(name) {
            const error = new Error(`${name} unavailable`);
            error.code = 'SERVICE_UNAVAILABLE';
            throw error;
        }

        return {
            processLLM: (...args) => (processLLM ? processLLM(...args) : unavailable('processLLM')),
            listLLMTabs: (...args) => (listLLMTabs ? listLLMTabs(...args) : unavailable('listLLMTabs')),
            resolveTabForLLM: (...args) => (resolveTabForLLM ? resolveTabForLLM(...args) : unavailable('resolveTabForLLM')),
            findLLMTab: (...args) => (findLLMTab ? findLLMTab(...args) : unavailable('findLLMTab')),
            injectAndExecute: (...args) => (injectAndExecute ? injectAndExecute(...args) : unavailable('injectAndExecute')),
            injectAndPrepareAttachments: (...args) => (
                injectAndPrepareAttachments
                    ? injectAndPrepareAttachments(...args)
                    : unavailable('injectAndPrepareAttachments')
            ),
            sendPromptViaClaudeDebugger: (...args) => (
                sendPromptViaClaudeDebugger
                    ? sendPromptViaClaudeDebugger(...args)
                    : unavailable('sendPromptViaClaudeDebugger')
            ),
            simpleInteraction: (...args) => (simpleInteraction ? simpleInteraction(...args) : unavailable('simpleInteraction'))
        };
    }

    global.createTransportService = createTransportService;
}(globalThis));
