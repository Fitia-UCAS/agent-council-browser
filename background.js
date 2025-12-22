/**
 * Multi-LLM Coder Extension - Background Service Worker
 * Handles communication with LLM websites and tab management
 */

// Extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('[MLC Background] Multi-LLM Coder extension installed/updated.');
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
            console.warn('[MLC Background] Failed to set side panel behavior:', error);
        });
    }
});

if (chrome.action && chrome.sidePanel && chrome.sidePanel.open) {
    chrome.action.onClicked.addListener((tab) => {
        const windowId = tab?.windowId;
        chrome.sidePanel.open(windowId ? { windowId } : {}).catch((error) => {
            console.warn('[MLC Background] Failed to open side panel on action click:', error);
        });
    });
}

// Safe message sending function
function sendMessageToPopup(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            if (chrome.runtime.lastError) {
                // console.log('[MLC Background] No popup to receive message:', message.type, chrome.runtime.lastError.message);
            }
        });
    } catch (error) {
        console.error('[MLC Background] Failed to send message to popup:', message.type, error);
    }
}

// FOLLOW-UP STATE FOR AUTO PROMPT V2
const defaultFollowUpState = {
    originalPrompt: null,
    originalSourceLLM: null, // 'chatgpt' | 'gemini'
    originalChatGPTTabId: null,
    originalGeminiTabId: null,
    geminiResponseContentForFollowUp: null,
    geminiResponseScraped: false,
    chatGPTResponseContentForFollowUp: null,
    chatGPTResponseScraped: false,
    promptTimestamp: 0, // Track when the prompt was sent
    promptId: null, // Unique ID for this prompt-response cycle
    waitingForResponse: false // Flag to track when we're waiting for a response
};
let activeFollowUpState = { ...defaultFollowUpState };

function resetFollowUpState() {
    activeFollowUpState = { ...defaultFollowUpState };
    console.log('[MLC FollowUp] Follow-up state reset.');
}

// Generate a unique ID for each prompt-response cycle
function generatePromptId() {
    return 'prompt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// DEBATE SESSION STATE MANAGEMENT
const ACTIVE_SESSION_KEY = 'mlc_active_session_v2';
const PREFERRED_TABS_KEY = 'mlc_preferred_tabs';

const defaultDebateState = {
    isActive: false,
    sessionId: null,
    rounds: 0,
    totalTurns: 0,
    turnIndex: 1,
    firstLLM: 'chatgpt',
    secondLLM: 'gemini',
    tabIds: { chatgpt: null, gemini: null },
    userQuery: '',
    messages: [],
    waitingFor: null,
    lastPromptId: null,
    lastPromptTimestamp: 0,
    startedAt: 0,
    endedAt: 0
};

let activeDebateState = { ...defaultDebateState };

function resetDebateState() {
    activeDebateState = { ...defaultDebateState };
    console.log('[MLC Debate] State reset.');
}

function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

async function loadActiveDebateState() {
    if (activeDebateState.sessionId) {
        return activeDebateState;
    }
    const stored = await chrome.storage.local.get(ACTIVE_SESSION_KEY);
    if (stored && stored[ACTIVE_SESSION_KEY]) {
        activeDebateState = stored[ACTIVE_SESSION_KEY];
    }
    return activeDebateState;
}

async function persistDebateState() {
    await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: activeDebateState });
}

async function getPreferredTabs() {
    const stored = await chrome.storage.local.get(PREFERRED_TABS_KEY);
    return stored && stored[PREFERRED_TABS_KEY] ? stored[PREFERRED_TABS_KEY] : { chatgpt: null, gemini: null };
}

async function setPreferredTabs(payload = {}) {
    const { chatgptTabId, geminiTabId } = payload;
    const current = await getPreferredTabs();
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(payload, 'chatgptTabId')) {
        next.chatgpt = Number.isFinite(chatgptTabId) ? chatgptTabId : null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'geminiTabId')) {
        next.gemini = Number.isFinite(geminiTabId) ? geminiTabId : null;
    }

    await chrome.storage.local.set({ [PREFERRED_TABS_KEY]: next });
    return next;
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[MLC Background] Received message:', message);

    switch (message.type) {
        case 'SEND_PROMPT':
            handleSendPrompt(message);
            sendResponse({ status: 'received', type: message.type });
            break;
        case 'FORWARD_PROMPT':
            handleForwardPrompt(message, sender);
            sendResponse({ status: 'forward_received', type: message.type });
            break;
        case 'GEMINI_RESPONSE_CAPTURED':
            handleDebateResponse(message).catch(error => {
                console.error('[MLC Debate] Error handling Gemini response:', error);
            });
            handleGeminiResponse(message);
            sendResponse({ status: 'gemini_response_received', type: message.type });
            break;
        case 'CHATGPT_RESPONSE_CAPTURED':
            handleDebateResponse(message).catch(error => {
                console.error('[MLC Debate] Error handling ChatGPT response:', error);
            });
            handleChatGPTResponse(message);
            sendResponse({ status: 'chatgpt_response_received', type: message.type });
            break;
        case 'MLC_RESPONSE_CAPTURED':
            handleDebateResponse(message).catch(error => {
                console.error('[MLC Debate] Error handling response:', error);
            });
            sendResponse({ status: 'mlc_response_received', type: message.type });
            break;
        case 'MULTI_AGENT_RESPONSE_CAPTURED':
            handleDebateResponse(message).catch(error => {
                console.error('[MLC Debate] Error handling multi-agent response:', error);
            });
            sendResponse({ status: 'multi_agent_response_received', type: message.type });
            break;
        case 'CHECK_CONNECTION':
            checkConnectionStatus().then(status => {
                sendMessageToPopup({
                    type: 'CONNECTION_STATUS',
                    status: status
                });
                sendResponse({
                    type: 'CONNECTION_STATUS',
                    status: status
                });
            });
            return true; // Keep message channel open for async response
        case 'LIST_LLM_TABS':
            handleListLLMTabs().catch(error => {
                console.error('[MLC Debate] Error listing tabs:', error);
            });
            sendResponse({ status: 'listing_tabs', type: message.type });
            break;
        case 'SET_PREFERRED_TABS':
            setPreferredTabs(message).then(() => handleListLLMTabs()).catch(error => {
                console.error('[MLC Debate] Error saving preferred tabs:', error);
            });
            sendResponse({ status: 'preferred_tabs_saved', type: message.type });
            break;
        case 'GET_ACTIVE_SESSION':
            handleGetActiveSession().catch(error => {
                console.error('[MLC Debate] Error getting active session:', error);
            });
            sendResponse({ status: 'active_session_sent', type: message.type });
            break;
        case 'START_DEBATE_SESSION':
            handleStartDebateSession(message).catch(error => {
                console.error('[MLC Debate] Error starting session:', error);
            });
            sendResponse({ status: 'debate_session_started', type: message.type });
            break;
        case 'STOP_SESSION':
            handleStopDebateSession(message).catch(error => {
                console.error('[MLC Debate] Error stopping session:', error);
            });
            sendResponse({ status: 'debate_session_stopped', type: message.type });
            break;
        case 'START_MULTI_AGENT_SESSION':
            handleStartDebateSession({
                prompt: message.prompt,
                firstLLM: message.sourceLLM,
                rounds: message.maxIterations
            }).catch(error => {
                console.error('[MLC Debate] Error starting multi-agent session:', error);
            });
            sendResponse({ status: 'multi_agent_session_started', type: message.type });
            break;
        case 'END_MULTI_AGENT_SESSION':
            handleStopDebateSession({ reason: message.reason || 'User requested' }).catch(error => {
                console.error('[MLC Debate] Error stopping multi-agent session:', error);
            });
            sendResponse({ status: 'multi_agent_session_ended', type: message.type });
            break;
        default:
            console.warn('[MLC Background] Unknown message type:', message.type);
            sendResponse({ status: 'unknown_message_type' });
            break;
    }

    return false;
});

async function handleListLLMTabs() {
    const chatgptTabs = await listLLMTabs('chatgpt');
    const geminiTabs = await listLLMTabs('gemini');
    const sanitize = (tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        active: tab.active,
        lastAccessed: tab.lastAccessed,
        status: tab.status
    });
    const preferred = await getPreferredTabs();
    sendMessageToPopup({
        type: 'LLM_TABS_LIST',
        tabs: {
            chatgpt: chatgptTabs.map(sanitize),
            gemini: geminiTabs.map(sanitize)
        },
        preferred: preferred
    });
}

async function handleGetActiveSession() {
    const session = await loadActiveDebateState();
    if (!session || !session.sessionId) {
        sendMessageToPopup({ type: 'ACTIVE_SESSION', session: null });
        return;
    }
    sendMessageToPopup({ type: 'ACTIVE_SESSION', session: session });
}

async function handleStartDebateSession(message) {
    const prompt = (message.prompt || '').trim();
    const rounds = Math.max(1, parseInt(message.rounds, 10) || 1);
    const firstLLM = message.firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
    const secondLLM = firstLLM === 'chatgpt' ? 'gemini' : 'chatgpt';
    const requestedTabs = message.tabIds || {};

    if (!prompt) {
        sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: 'Prompt is empty.' });
        return;
    }

    if (activeDebateState.isActive) {
        await endDebateSession('Session replaced by a new request.');
    }

    if (Number.isFinite(requestedTabs.chatgpt) || Number.isFinite(requestedTabs.gemini)) {
        await setPreferredTabs({
            chatgptTabId: requestedTabs.chatgpt,
            geminiTabId: requestedTabs.gemini
        });
    }

    const preferred = await getPreferredTabs();
    const chatgptTab = await resolveTabForLLM('chatgpt', requestedTabs.chatgpt, preferred.chatgpt);
    const geminiTab = await resolveTabForLLM('gemini', requestedTabs.gemini, preferred.gemini);

    if (!chatgptTab || !geminiTab) {
        const missing = [];
        if (!chatgptTab) missing.push('ChatGPT');
        if (!geminiTab) missing.push('Gemini');
        sendMessageToPopup({
            type: 'UI_SESSION_ERROR',
            error: `${missing.join(' and ')} tab not found. Please open the required LLM tabs.`
        });
        return;
    }

    const now = Date.now();
    activeDebateState = {
        ...defaultDebateState,
        isActive: true,
        sessionId: generateSessionId(),
        rounds: rounds,
        totalTurns: rounds * 2,
        turnIndex: 1,
        firstLLM: firstLLM,
        secondLLM: secondLLM,
        tabIds: {
            chatgpt: chatgptTab.id,
            gemini: geminiTab.id
        },
        userQuery: prompt,
        messages: [{ role: 'user', content: prompt, timestamp: now, turnIndex: 0 }],
        startedAt: now
    };

    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_SESSION_STARTED',
        sessionId: activeDebateState.sessionId,
        rounds: rounds,
        firstLLM: firstLLM,
        tabIds: activeDebateState.tabIds
    });

    sendMessageToPopup({
        type: 'UI_MESSAGE_ADD',
        role: 'user',
        content: prompt,
        timestamp: now,
        turnIndex: 0
    });

    await sendDebateTurn(activeDebateState);
}

async function handleStopDebateSession(message) {
    const reason = message.reason || 'Session stopped.';
    if (message.sessionId && activeDebateState.sessionId && message.sessionId !== activeDebateState.sessionId) {
        return;
    }
    await endDebateSession(reason);
}

function getRoundIndex(turnIndex) {
    return Math.ceil(turnIndex / 2);
}

function getTurnLLM(session, turnIndex) {
    return turnIndex % 2 === 1 ? session.firstLLM : session.secondLLM;
}

function formatLLMLabel(llmType) {
    return llmType === 'gemini' ? 'Gemini' : 'ChatGPT';
}

function buildDebateHeader(rounds) {
    return [
        `Here is a multi-agent session with ChatGPT and Gemini over ${rounds} iterations.`,
        'Please be constructive during your debate to bring the most accurate answer to the user.',
        'Be critical, constructive, and fair.'
    ].join('\n');
}

function getLastResponse(session, llmType) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role === llmType) {
            return session.messages[i].content;
        }
    }
    return '';
}

function buildDebatePrompt(session, turnIndex) {
    const roundIndex = getRoundIndex(turnIndex);
    const expectedLLM = getTurnLLM(session, turnIndex);
    const expectedLabel = formatLLMLabel(expectedLLM);
    const otherLLM = expectedLLM === session.firstLLM ? session.secondLLM : session.firstLLM;
    const otherLabel = formatLLMLabel(otherLLM);
    const safeOtherResponse = getLastResponse(session, otherLLM) || '[No prior response captured yet]';
    const safeFirstResponse = getLastResponse(session, session.firstLLM) || '[No prior response captured yet]';

    if (turnIndex === 1) {
        return `${buildDebateHeader(session.rounds)}\n\nIteration: 1\nTurn: ${expectedLabel}\n\nUser query:\n${session.userQuery}`;
    }

    if (turnIndex === 2) {
        return `${buildDebateHeader(session.rounds)}\n\nIteration: 1\nTurn: ${expectedLabel}\n\nUser query:\n${session.userQuery}\n\n${formatLLMLabel(session.firstLLM)} answer:\n${safeFirstResponse}\n\nNow respond with critique and improvements. If you disagree, explain why.`;
    }

    if (expectedLLM === session.firstLLM) {
        return `Iteration: ${roundIndex}\nHere is ${otherLabel} answer from iteration ${roundIndex - 1}:\n${safeOtherResponse}\n\nNow respond as ${expectedLabel}.`;
    }

    return `Iteration: ${roundIndex}\nHere is ${otherLabel} answer:\n${safeOtherResponse}\n\nNow respond as ${expectedLabel}.`;
}

async function sendDebateTurn(session) {
    const turnIndex = session.turnIndex;
    const expectedLLM = getTurnLLM(session, turnIndex);
    const promptText = buildDebatePrompt(session, turnIndex);
    const promptId = `${session.sessionId}:turn:${turnIndex}`;

    activeDebateState.waitingFor = expectedLLM;
    activeDebateState.lastPromptId = promptId;
    activeDebateState.lastPromptTimestamp = Date.now();

    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_SESSION_PROGRESS',
        sessionId: session.sessionId,
        waitingFor: expectedLLM,
        roundIndex: getRoundIndex(turnIndex),
        totalRounds: session.rounds
    });

    try {
        await injectAndExecute(session.tabIds[expectedLLM], expectedLLM, promptText, {
            sessionId: session.sessionId,
            promptId: promptId,
            turnIndex: turnIndex
        });
    } catch (error) {
        await endDebateSession(error.message || 'Failed to send prompt.');
    }
}

async function handleDebateResponse(message) {
    if (!message.sessionId) return;

    const session = await loadActiveDebateState();
    if (!session.isActive || session.sessionId !== message.sessionId) {
        console.log('[MLC Debate] Ignoring response: session not active or mismatch.');
        return;
    }

    const expectedLLM = session.waitingFor;
    if (message.sourceLLM && expectedLLM && message.sourceLLM !== expectedLLM) {
        console.log('[MLC Debate] Ignoring response from unexpected LLM:', message.sourceLLM);
        return;
    }

    if (session.lastPromptId && message.promptId && session.lastPromptId !== message.promptId) {
        console.log('[MLC Debate] Ignoring response with mismatched promptId.');
        return;
    }

    if (message.turnIndex && message.turnIndex !== session.turnIndex) {
        console.log('[MLC Debate] Ignoring response with mismatched turn index.');
        return;
    }

    const content = (message.content || '').trim();
    if (!content) return;

    const turnIndex = session.turnIndex;
    const roundIndex = getRoundIndex(turnIndex);
    const timestamp = Date.now();

    session.messages.push({
        role: expectedLLM || message.sourceLLM || 'assistant',
        content: content,
        timestamp: timestamp,
        turnIndex: turnIndex,
        roundIndex: roundIndex
    });

    session.waitingFor = null;
    session.lastPromptId = null;
    session.lastPromptTimestamp = 0;

    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_MESSAGE_ADD',
        role: expectedLLM || message.sourceLLM,
        content: content,
        timestamp: timestamp,
        turnIndex: turnIndex,
        roundIndex: roundIndex
    });

    if (turnIndex >= session.totalTurns) {
        await endDebateSession('Session completed.');
        return;
    }

    session.turnIndex = turnIndex + 1;
    await persistDebateState();
    await sendDebateTurn(session);
}

async function endDebateSession(reason) {
    const session = await loadActiveDebateState();
    if (!session.sessionId) return;

    session.isActive = false;
    session.waitingFor = null;
    session.endedAt = Date.now();
    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_SESSION_ENDED',
        sessionId: session.sessionId,
        reason: reason || 'Session ended.'
    });

    resetDebateState();
}

async function handleSendPrompt(message) {
    const { prompt, targets, multiAgent } = message;
    
    console.log('[MLC Background] Processing SEND_PROMPT:', { prompt: `"${prompt.substring(0,50)}..."`, targets, multiAgent });
    
    // Check if multi-agent mode is requested
    if (multiAgent && multiAgent.enabled) {
        const firstLLM = targets.chatgpt ? 'chatgpt' : 'gemini';
        handleStartDebateSession({
            prompt: prompt,
            firstLLM: firstLLM,
            rounds: multiAgent.maxIterations || 3
        });
        return;
    }
    
    // Regular mode - send to individual LLMs
    if (targets.gemini) {
        await processLLM('gemini', prompt);
    }
    
    if (targets.chatgpt) {
        await processLLM('chatgpt', prompt);
    }
}

function handleForwardPrompt(message, sender) {
    const { from, prompt } = message;
    console.log('[MLC Background] Processing FORWARD_PROMPT:', { from, prompt: `"${prompt.substring(0,50)}..."` });
    if (!prompt) {
        console.warn('[MLC Background] Forward prompt is empty, aborting.');
        return;
    }

    let targetLLM = null;
    if (from === 'chatgpt') {
        targetLLM = 'gemini';
        // Initialise follow-up state – we only need to trigger when origin is ChatGPT
        resetFollowUpState();

        // Generate a unique prompt ID and store timestamp
        const promptId = generatePromptId();
        const timestamp = Date.now();

        // Set up the follow-up state with more tracking info
        activeFollowUpState.originalPrompt = prompt;
        activeFollowUpState.originalSourceLLM = 'chatgpt';
        activeFollowUpState.originalChatGPTTabId = sender?.tab?.id || null;
        activeFollowUpState.promptTimestamp = timestamp;
        activeFollowUpState.promptId = promptId;
        activeFollowUpState.waitingForResponse = true;

        console.log('[MLC FollowUp] Initialized follow-up tracking:', activeFollowUpState);

    } else if (from === 'gemini') {
        targetLLM = 'chatgpt';

        resetFollowUpState();

        const promptId = generatePromptId();
        const timestamp = Date.now();

        activeFollowUpState.originalPrompt = prompt;
        activeFollowUpState.originalSourceLLM = 'gemini';
        activeFollowUpState.originalGeminiTabId = sender?.tab?.id || null;
        activeFollowUpState.promptTimestamp = timestamp;
        activeFollowUpState.promptId = promptId;
        activeFollowUpState.waitingForResponse = true;

    }

    if (targetLLM) {
        console.log(`[MLC Background] Forwarding from ${from} to ${targetLLM}.`);
        processLLM(targetLLM, prompt, { promptId: activeFollowUpState.promptId });
    } else {
        console.error('[MLC Background] Unknown "from" field for FORWARD_PROMPT:', from);
    }
}

function handleGeminiResponse(message) {
    if (message.sessionId) return;

    console.log('[MLC FollowUp] Gemini response received:', {
        content: message.content ? message.content.substring(0, 50) + '...' : 'None',
        promptId: message.promptId,
        responseDelay: message.responseDelay,
        waitingState: activeFollowUpState.waitingForResponse,
        currentPromptId: activeFollowUpState.promptId
    });
    
    // TEMPORARILY DISABLE STRICT VALIDATION
    // Our validation may be too strict and blocking valid responses
    
    // Check if the response has content
    if (!message.content || message.content.trim().length === 0) {
        console.log('[MLC FollowUp] Received empty Gemini response, ignoring.');
        return;
    }
    
    console.log(`[MLC FollowUp] Valid Gemini response received, accepting for follow-up.`);
    activeFollowUpState.geminiResponseContentForFollowUp = message.content;
    activeFollowUpState.geminiResponseScraped = true;
    activeFollowUpState.waitingForResponse = false;
    
    console.log('[MLC FollowUp] Stored Gemini response, attempting trigger.');
    triggerFollowUpIfReady();

    sendMessageToPopup({
        type: 'LLM_RESPONSE',
        llm: 'gemini',
        content: message.content
    });
}

function handleChatGPTResponse(message) {
    if (message.sessionId) return;

    console.log('[MLC FollowUp] ChatGPT response received:', {
        content: message.content ? message.content.substring(0, 50) + '...' : 'None',
        promptId: message.promptId,
        waitingState: activeFollowUpState.waitingForResponse,
        currentPromptId: activeFollowUpState.promptId
    });

    if (!message.content || message.content.trim().length === 0) {
        console.log('[MLC FollowUp] Received empty ChatGPT response, ignoring.');
        return;
    }

    activeFollowUpState.chatGPTResponseContentForFollowUp = message.content;
    activeFollowUpState.chatGPTResponseScraped = true;
    activeFollowUpState.waitingForResponse = false;

    console.log('[MLC FollowUp] Stored ChatGPT response, attempting trigger.');
    triggerFollowUpIfReady();

    sendMessageToPopup({
        type: 'LLM_RESPONSE',
        llm: 'chatgpt',
        content: message.content
    });
}

function triggerFollowUpIfReady() {
    if (
        activeFollowUpState.originalSourceLLM === 'chatgpt' &&
        activeFollowUpState.geminiResponseScraped &&
        activeFollowUpState.geminiResponseContentForFollowUp &&
        activeFollowUpState.originalChatGPTTabId
    ) {
        console.log('[MLC FollowUp] Conditions met, injecting follow-up prompt to ChatGPT.');
        const followUpPromptText = `I also asked Gemini the same question here's his answer:\n${activeFollowUpState.geminiResponseContentForFollowUp}\n\nCould you read your answer and his answer to see if you can enhance yours or if everything's good.`;
        injectFollowUpIntoChatGPT(activeFollowUpState.originalChatGPTTabId, followUpPromptText);
        resetFollowUpState();
    } else if (
        activeFollowUpState.originalSourceLLM === 'gemini' &&
        activeFollowUpState.chatGPTResponseScraped &&
        activeFollowUpState.chatGPTResponseContentForFollowUp &&
        activeFollowUpState.originalGeminiTabId
    ) {
        console.log('[MLC FollowUp] Conditions met, injecting follow-up prompt to Gemini.');
        const followUpPromptText = `I also asked ChatGPT the same question here's his answer:\n${activeFollowUpState.chatGPTResponseContentForFollowUp}\n\nCould you read your answer and his answer to see if you can enhance yours or if everything's good.`;
        injectFollowUpIntoGemini(activeFollowUpState.originalGeminiTabId, followUpPromptText);
        resetFollowUpState();
    } else {
        console.log('[MLC FollowUp] Not ready for follow-up yet.', activeFollowUpState);
    }
}

async function injectFollowUpIntoChatGPT(tabId, promptText) {
    try {
        console.log(`[MLC FollowUp] Injecting follow-up into ChatGPT tab ${tabId}.`);
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: simpleInteraction_InjectOnly,
            args: [promptText, 'chatgpt']
        });
        if (results && results[0] && results[0].result && results[0].result.success) {
            console.log('[MLC FollowUp] Follow-up prompt injected successfully.');
        } else {
            console.error('[MLC FollowUp] Failed to inject follow-up prompt.', results);
        }
    } catch (error) {
        console.error('[MLC FollowUp] Error during follow-up injection:', error);
    }
}

async function injectFollowUpIntoGemini(tabId, promptText) {
    try {
        console.log(`[MLC FollowUp] Injecting follow-up into Gemini tab ${tabId}.`);
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: simpleInteraction_InjectOnly,
            args: [promptText, 'gemini']
        });
        if (results && results[0] && results[0].result && results[0].result.success) {
            console.log('[MLC FollowUp] Follow-up prompt injected successfully into Gemini.');
        } else {
            console.error('[MLC FollowUp] Failed to inject follow-up prompt into Gemini.', results);
        }
    } catch (error) {
        console.error('[MLC FollowUp] Error during follow-up injection into Gemini:', error);
    }
}

// Inject-only variant: sets text but does NOT send.
function simpleInteraction_InjectOnly(prompt, llmType) {
    console.log(`[SimpleInteraction_InjectOnly INJECTED] (${llmType}) attempting to set prompt length ${prompt.length}.`);
    try {
        const inputSelectors = {
            chatgpt: [
                '#prompt-textarea',
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea'
            ],
            gemini: [
                'div.ql-editor[role="textbox"]',
                '.ql-editor.textarea',
                'div[contenteditable="true"]',
                'textarea[placeholder*="Enter a prompt"]',
                'textarea[placeholder*="Ask"]',
                'textarea'
            ]
        };
        const selectors = inputSelectors[llmType] || [];
        let inputEl = null;
        for (const sel of selectors) {
            inputEl = document.querySelector(sel);
            if (inputEl) break;
        }
        if (!inputEl) {
            console.error('[SimpleInteraction_InjectOnly INJECTED] No input element found.');
            return { success:false, error:'input_not_found' };
        }
        inputEl.focus();
        if (inputEl.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter ? setter.call(inputEl, prompt) : (inputEl.value = prompt);
            inputEl.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
        } else if (inputEl.isContentEditable || inputEl.contentEditable === 'true') {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, prompt);
            inputEl.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
        } else {
            inputEl.value = prompt;
            inputEl.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
        }
        return { success:true };
    } catch(e) {
        console.error('[SimpleInteraction_InjectOnly INJECTED] Exception', e);
        return { success:false, error:e.message };
    }
}

async function processLLM(llmType, prompt, context = {}) {
    try {
        console.log(`[MLC Background] processLLM for ${llmType} with prompt: "${prompt.substring(0, 50)}..."`);

        const preferred = await getPreferredTabs();
        const preferredId = context.tabId || preferred[llmType];

        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Finding tab...' });
        const tab = await findLLMTab(llmType, preferredId);

        if (!tab) {
            throw new Error(`${llmType} tab not found. Please open ${llmType} in a tab and ensure you're logged in.`);
        }
        console.log(`[MLC Background] Found ${llmType} tab: ID ${tab.id}, URL ${tab.url}`);

        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Injecting script...' });
        const promptId = context.promptId || generatePromptId();
        await injectAndExecute(tab.id, llmType, prompt, {
            promptId: promptId,
            sessionId: context.sessionId || null,
            turnIndex: context.turnIndex || null
        });

        return promptId;
    } catch (error) {
        console.error(`[MLC Background] Error processing ${llmType}:`, error.message, error.stack);
        sendMessageToPopup({ type: 'LLM_ERROR', llm: llmType, error: error.message });
        return null;
    }
}

async function listLLMTabs(llmType) {
    const urlPatterns = {
        gemini: ['*://gemini.google.com/*'],
        chatgpt: [
            '*://chat.openai.com/*',
            '*://chatgpt.com/*',
            '*://openai.com/chatgpt*',
            '*://platform.openai.com/*'
        ]
    };

    const patterns = urlPatterns[llmType];
    if (!patterns) {
        throw new Error(`[MLC Background] Unknown LLM type for listLLMTabs: ${llmType}`);
    }

    let allTabs = [];
    for (const pattern of patterns) {
        const tabs = await chrome.tabs.query({ url: pattern });
        allTabs = allTabs.concat(tabs);
    }

    if (allTabs.length === 0) {
        const allTabsQuery = await chrome.tabs.query({});
        const titleMatches = allTabsQuery.filter(tab => {
            const title = tab.title?.toLowerCase() || '';
            const url = tab.url?.toLowerCase() || '';
            const llmName = llmType.toLowerCase();
            return title.includes(llmName) || url.includes(llmName) || (llmName === 'chatgpt' && (title.includes('openai') || url.includes('openai')));
        });
        allTabs = titleMatches;
    }

    const seen = new Set();
    return allTabs.filter(tab => {
        if (seen.has(tab.id)) return false;
        seen.add(tab.id);
        return true;
    });
}

function selectTabFromList(tabs, preferredTabId) {
    if (!tabs || tabs.length === 0) return null;
    if (preferredTabId) {
        const preferred = tabs.find(tab => tab.id === preferredTabId);
        if (preferred) return preferred;
    }

    const activeTab = tabs.find(tab => tab.active);
    if (activeTab) return activeTab;

    const byLastAccessed = [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return byLastAccessed[0] || null;
}

async function resolveTabForLLM(llmType, requestedTabId, preferredTabId) {
    const tabs = await listLLMTabs(llmType);
    const completeTabs = tabs.filter(tab => tab.status === 'complete');
    const candidates = completeTabs.length > 0 ? completeTabs : tabs;

    if (requestedTabId) {
        const match = candidates.find(tab => tab.id === requestedTabId);
        if (match) return match;
    }

    return selectTabFromList(candidates, preferredTabId);
}

async function findLLMTab(llmType, preferredTabId) {
    try {
        const selectedTab = await resolveTabForLLM(llmType, null, preferredTabId);
        console.log(`[MLC Background] findLLMTab for ${llmType} selected:`, selectedTab ? { id: selectedTab.id, url: selectedTab.url, title: selectedTab.title } : 'None');
        return selectedTab;
    } catch (error) {
        console.error(`[MLC Background] Error in findLLMTab for ${llmType}:`, error);
        return null;
    }
}

async function injectAndExecute(tabId, llmType, prompt, context = {}) {
    try {
        console.log(`[MLC Background] Injecting simpleInteraction into Tab ID ${tabId} for ${llmType}.`);
        
        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Sending prompt...' });
        
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: simpleInteraction, // This function is defined below
            args: [prompt, llmType]
        });
        
        console.log(`[MLC Background] Injection results for ${llmType} (Tab ID: ${tabId}):`, JSON.stringify(results, null, 2));
        
        if (results && results[0] && results[0].result) {
            const result = results[0].result;
            if (result.success) {
                console.log(`[MLC Background] simpleInteraction SUCCEEDED for ${llmType}: ${result.method}`);
                const promptId = context.promptId || generatePromptId();
                try {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'MLC_PROMPT_SENT',
                        sessionId: context.sessionId || null,
                        promptId: promptId,
                        llmType: llmType,
                        turnIndex: context.turnIndex || null,
                        timestamp: Date.now()
                    });
                } catch (error) {
                    console.warn('[MLC Background] Failed to notify content script about prompt:', error);
                }
                sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Prompt sent.' });
                return promptId;
            } else {
                console.error(`[MLC Background] simpleInteraction FAILED for ${llmType}:`, result.error);
                throw new Error(result.error || `Unknown error in simpleInteraction for ${llmType}`);
            }
        } else {
            const noResultError = `No result or unexpected result structure from injection for ${llmType}.`;
            console.error(`[MLC Background] ${noResultError} Results:`, results);
            throw new Error(noResultError);
        }
        
    } catch (error) {
        console.error(`[MLC Background] Error injecting script for ${llmType} into Tab ID ${tabId}:`, error.message, error.stack);
        // Rethrow to be caught by processLLM
        throw new Error(`Failed to interact with ${llmType}: ${error.message}`);
    }
}

// This function is injected and executed in the context of the target LLM's page
// ... (keep all other parts of background.js from the previous good version) ...
// ... (including onInstalled, sendMessageToPopup, onMessage, handleSendPrompt, handleForwardPrompt, processLLM, findLLMTab, injectAndExecute, checkConnectionStatus) ...

// THIS IS THE FUNCTION THAT GETS INJECTED AND EXECUTED IN THE TARGET PAGE
async function simpleInteraction(prompt, llmType) { // Added async here for the setTimeout
    console.log(`[SimpleInteraction INJECTED] Attempting on ${llmType} with prompt: "${prompt.substring(0, 50)}..."`);

    try {
        let inputElement = null;
        let sendButton = null;

        const inputSelectors = {
            chatgpt: [
                '#prompt-textarea',
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea[data-id="root"]',
                'textarea'
            ],
            gemini: [ // Gemini primarily uses a contenteditable div
                'div.ql-editor[role="textbox"]',        // Specific Gemini input
                '.ql-editor.textarea',                  // Another common pattern
                'div[contenteditable="true"][aria-label*="prompt"]',
                'textarea[placeholder*="Enter a prompt"]', // Fallback if textarea is ever used
                'textarea[placeholder*="Ask"]',
                '[contenteditable="true"]' // General fallback
            ]
        };

        const currentInputSelectors = inputSelectors[llmType];
        if (!currentInputSelectors) {
            const errMsg = `[SimpleInteraction INJECTED] Unknown llmType for input selectors: ${llmType}`;
            console.error(errMsg);
            return { success: false, error: errMsg, details: { stage: 'find_input_selectors' } };
        }

        for (const selector of currentInputSelectors) {
            inputElement = document.querySelector(selector);
            if (inputElement) {
                console.log(`[SimpleInteraction INJECTED] Found input for ${llmType} with: ${selector}`, inputElement);
                break;
            }
        }

        if (!inputElement) {
            const errMsg = `[SimpleInteraction INJECTED] No input element found for ${llmType} after trying all selectors.`;
            console.error(errMsg);
            return { success: false, error: errMsg, details: { stage: 'find_input_element' } };
        }
        console.log(`[SimpleInteraction INJECTED] Successfully found input for ${llmType}:`, inputElement);
        inputElement.focus(); // Focus the element first

        // --- Setting the prompt ---
        if (llmType === 'chatgpt' && inputElement.tagName === 'TEXTAREA') {
            console.log(`[SimpleInteraction INJECTED] Setting prompt for ChatGPT TEXTAREA`);
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(inputElement, prompt);
            } else {
                inputElement.value = prompt;
            }
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            inputElement.dispatchEvent(new KeyboardEvent('keydown',  { key: ' ', keyCode: 32, bubbles: true, composed: true }));
            inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', keyCode: 32, bubbles: true, composed: true }));
            console.log(`[SimpleInteraction INJECTED] Dispatched events for ChatGPT TEXTAREA.`);

        } else if ((llmType === 'gemini' && (inputElement.isContentEditable || inputElement.contentEditable === 'true')) ||
                   (inputElement.isContentEditable || inputElement.contentEditable === 'true')) { // General contentEditable case
            console.log(`[SimpleInteraction INJECTED] Setting prompt for contentEditable element (${llmType})`);
            document.execCommand('selectAll', false, null);
            const insertSuccess = document.execCommand('insertText', false, prompt);
            console.log(`[SimpleInteraction INJECTED] Used document.execCommand('insertText'). Success: ${insertSuccess}.`);
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true })); // Ensure input event fires for contentEditable too
        } else { // Fallback for other input types (e.g. Gemini using a textarea which is rare)
            console.log(`[SimpleInteraction INJECTED] Setting prompt for standard input/textarea element (${llmType})`);
            inputElement.value = prompt;
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }

        // Verification Step
        await new Promise(resolve => setTimeout(resolve, 50));
        const currentText = (inputElement.isContentEditable || inputElement.contentEditable === 'true') ? inputElement.textContent : inputElement.value;
        console.log(`[SimpleInteraction INJECTED] Text in input field for ${llmType} after setting: "${currentText.substring(0,100)}..."`);
        if (!currentText.includes(prompt.substring(0, Math.min(prompt.length, 50)))) {
            console.warn(`[SimpleInteraction INJECTED] WARNING: Prompt may not have been set correctly for ${llmType}. Expected start: "${prompt.substring(0,50)}...", Got: "${currentText.substring(0,50)}..."`);
        }


        // --- Find and click send button ---
        const buttonSelectors = {
             chatgpt: [
                'button[data-testid="send-button"]',
                'button[data-testid="fruitjuice-send-button"]',
                'button[aria-label="Send message" i]',
                'form button[type="submit"]',
                'button[class*="bottom"] span[data-state="closed"]',
                'button:has(svg > path[d*="M7 11L12 6L17 11M12 18V7"])'
            ],
            gemini: [ // Gemini send button selectors
                'button[aria-label="Send message"]',      // Primary target for Gemini
                'button[data-testid="send-button"]',      // If available
                'button.send-button',                     // If class is used
                'button:has(svg[aria-label="Send message"])', // Button containing the send SVG
                'button.send-button-container button'     // A common pattern in Gemini
            ],
            generic: [
                'button[type="submit"]',
                'button[aria-label*="Send" i]',
                'button:has(svg)',
            ]
        };
        
        const currentButtonSelectors = buttonSelectors[llmType] ? 
                                       [...buttonSelectors[llmType], ...buttonSelectors.generic] : 
                                       buttonSelectors.generic;

        for (const selector of currentButtonSelectors) {
            const buttons = document.querySelectorAll(selector);
            for (const btn of buttons) {
                const style = window.getComputedStyle(btn);
                if (btn && !btn.disabled && btn.offsetParent !== null && 
                    style.display !== 'none' && style.visibility !== 'hidden' && 
                    btn.offsetHeight > 0 && btn.offsetWidth > 0) {
                    sendButton = btn;
                    console.log(`[SimpleInteraction INJECTED] Found send button for ${llmType} with: ${selector}`, sendButton);
                    break;
                }
            }
            if (sendButton) break;
        }
        
        if (!sendButton) {
            console.warn(`[SimpleInteraction INJECTED] No send button found for ${llmType} via selectors. Attempting Enter key on input.`);
            inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
            console.log(`[SimpleInteraction INJECTED] Dispatched Enter keydown to input for ${llmType}.`);
            return { success: true, method: `enter_key_fallback_on_input_for_${llmType}`, details: { stage: 'send_enter_fallback' } };
        }
        
        console.log(`[SimpleInteraction INJECTED] Clicking send button for ${llmType}:`, sendButton);
        sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
        sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, cancelable: true }));
        sendButton.click();
        
        return { success: true, method: `button_click_for_${llmType}`, details: { stage: 'send_button_click' } };
        
    } catch (error) {
        const errMsg = `[SimpleInteraction INJECTED] Error during interaction with ${llmType}: ${error.message} (Stack: ${error.stack})`;
        console.error(errMsg, error);
        return { success: false, error: errMsg, details: { stage: 'main_catch_block', errorMessage: error.message } };
    }
}
// ... (rest of background.js like checkConnectionStatus) ...


async function checkConnectionStatus() {
    const status = {
        gemini: false,
        chatgpt: false
    };
    
    console.log('[MLC Background] Starting connection status check...');
    
    try {
        // Check if tabs exist and content scripts are responsive
        console.log('[MLC Background] Looking for Gemini tab...');
        const geminiTab = await findLLMTab('gemini');
        console.log('[MLC Background] Gemini tab result:', geminiTab ? `Found tab ${geminiTab.id}` : 'Not found');
        
        console.log('[MLC Background] Looking for ChatGPT tab...');
        const chatgptTab = await findLLMTab('chatgpt');
        console.log('[MLC Background] ChatGPT tab result:', chatgptTab ? `Found tab ${chatgptTab.id}` : 'Not found');
        
        // Test if content scripts are actually loaded by trying to ping them
        if (geminiTab) {
            try {
                console.log('[MLC Background] Pinging Gemini content script...');
                const response = await chrome.tabs.sendMessage(geminiTab.id, { type: 'PING' });
                console.log('[MLC Background] Gemini ping response:', response);
                status.gemini = true;
                console.log('[MLC Background] Gemini tab responsive:', geminiTab.id);
            } catch (error) {
                console.log('[MLC Background] Gemini tab found but content script not responsive:', error.message);
                status.gemini = false;
            }
        } else {
            console.log('[MLC Background] No Gemini tab found');
        }
        
        if (chatgptTab) {
            try {
                console.log('[MLC Background] Pinging ChatGPT content script...');
                const response = await chrome.tabs.sendMessage(chatgptTab.id, { type: 'PING' });
                console.log('[MLC Background] ChatGPT ping response:', response);
                status.chatgpt = true;
                console.log('[MLC Background] ChatGPT tab responsive:', chatgptTab.id);
            } catch (error) {
                console.log('[MLC Background] ChatGPT tab found but content script not responsive:', error.message);
                status.chatgpt = false;
            }
        } else {
            console.log('[MLC Background] No ChatGPT tab found');
        }

    } catch (error) {
        console.error('[MLC Background] Error checking connection status:', error);
    }
    
    console.log('[MLC Background] Final connection status:', status);
    return status;
}
