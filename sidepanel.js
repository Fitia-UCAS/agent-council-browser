/* global chrome */

const state = {
    sessionId: null,
    running: false,
    autoScroll: true,
    tabs: { chatgpt: [], gemini: [] },
    preferred: { chatgpt: null, gemini: null }
};

const elements = {};

document.addEventListener('DOMContentLoaded', () => {
    elements.promptInput = document.getElementById('prompt-input');
    elements.sendButton = document.getElementById('send-button');
    elements.stopButton = document.getElementById('stop-button');
    elements.charCount = document.getElementById('char-count');
    elements.firstLLM = document.getElementById('first-llm');
    elements.iterations = document.getElementById('iterations');
    elements.chatgptTab = document.getElementById('chatgpt-tab');
    elements.geminiTab = document.getElementById('gemini-tab');
    elements.refreshTabs = document.getElementById('refresh-tabs');
    elements.autoScroll = document.getElementById('auto-scroll');
    elements.timeline = document.getElementById('timeline');
    elements.emptyState = document.getElementById('empty-state');
    elements.statusChatGPT = document.getElementById('status-chatgpt');
    elements.statusGemini = document.getElementById('status-gemini');
    elements.sessionStatus = document.getElementById('session-status');

    bindEvents();
    updateCharCount();
    updateSendState();

    requestTabList();
    requestConnectionStatus();
    requestActiveSession();
});

function bindEvents() {
    if (elements.promptInput) {
        elements.promptInput.addEventListener('input', () => {
            updateCharCount();
            updateSendState();
        });
        elements.promptInput.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                startSession();
            }
        });
    }

    if (elements.sendButton) {
        elements.sendButton.addEventListener('click', startSession);
    }

    if (elements.stopButton) {
        elements.stopButton.addEventListener('click', stopSession);
    }

    if (elements.refreshTabs) {
        elements.refreshTabs.addEventListener('click', requestTabList);
    }

    if (elements.iterations) {
        elements.iterations.addEventListener('change', updateSendState);
    }

    if (elements.autoScroll) {
        elements.autoScroll.addEventListener('change', () => {
            state.autoScroll = elements.autoScroll.checked;
        });
    }

    if (elements.chatgptTab) {
        elements.chatgptTab.addEventListener('change', persistTabPreferences);
    }

    if (elements.geminiTab) {
        elements.geminiTab.addEventListener('change', persistTabPreferences);
    }

    if (chrome?.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    }
}

function sendMessage(message, callback) {
    if (!chrome?.runtime?.sendMessage) return;
    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
            console.warn('Message failed:', message.type, chrome.runtime.lastError.message);
        }
        if (callback) callback(response);
    });
}

function updateCharCount() {
    if (!elements.charCount || !elements.promptInput) return;
    elements.charCount.textContent = String(elements.promptInput.value.length);
}

function updateSendState() {
    if (!elements.sendButton || !elements.promptInput || !elements.iterations) return;
    const hasPrompt = elements.promptInput.value.trim().length > 0;
    const iterations = parseInt(elements.iterations.value, 10) || 0;
    elements.sendButton.disabled = state.running || !hasPrompt || iterations <= 0;
}

function setRunningState(running) {
    state.running = running;
    if (elements.sendButton) {
        elements.sendButton.disabled = running || elements.promptInput.value.trim().length === 0;
        elements.sendButton.textContent = running ? 'Running...' : 'Start debate';
    }
    if (elements.stopButton) {
        elements.stopButton.disabled = !running;
    }

    const disabled = running;
    if (elements.firstLLM) elements.firstLLM.disabled = disabled;
    if (elements.iterations) elements.iterations.disabled = disabled;
    if (elements.chatgptTab) elements.chatgptTab.disabled = disabled;
    if (elements.geminiTab) elements.geminiTab.disabled = disabled;
    if (elements.refreshTabs) elements.refreshTabs.disabled = disabled;
}

function setSessionStatus(text) {
    if (elements.sessionStatus) {
        elements.sessionStatus.textContent = text;
    }
}

function requestTabList() {
    sendMessage({ type: 'LIST_LLM_TABS' });
}

function requestConnectionStatus() {
    sendMessage({ type: 'CHECK_CONNECTION' });
}

function requestActiveSession() {
    sendMessage({ type: 'GET_ACTIVE_SESSION' });
}

function persistTabPreferences() {
    const chatgptTabId = parseTabValue(elements.chatgptTab?.value);
    const geminiTabId = parseTabValue(elements.geminiTab?.value);
    sendMessage({
        type: 'SET_PREFERRED_TABS',
        chatgptTabId,
        geminiTabId
    });
}

function startSession() {
    if (state.running) return;
    if (!elements.promptInput) return;

    const prompt = elements.promptInput.value.trim();
    if (!prompt) return;

    const rounds = parseInt(elements.iterations?.value, 10) || 0;
    if (rounds <= 0) return;

    const firstLLM = elements.firstLLM?.value || 'chatgpt';
    const chatgptTabId = parseTabValue(elements.chatgptTab?.value);
    const geminiTabId = parseTabValue(elements.geminiTab?.value);

    setRunningState(true);
    setSessionStatus('Starting session...');

    sendMessage({
        type: 'START_DEBATE_SESSION',
        prompt,
        firstLLM,
        rounds,
        tabIds: {
            chatgpt: chatgptTabId,
            gemini: geminiTabId
        }
    });
}

function stopSession() {
    if (!state.sessionId) return;
    setSessionStatus('Stopping session...');
    sendMessage({
        type: 'STOP_SESSION',
        sessionId: state.sessionId
    });
}

function handleBackgroundMessage(message) {
    switch (message.type) {
        case 'LLM_TABS_LIST':
            handleTabList(message);
            break;
        case 'CONNECTION_STATUS':
            handleConnectionStatus(message);
            break;
        case 'ACTIVE_SESSION':
            hydrateSession(message.session);
            break;
        case 'UI_SESSION_STARTED':
            state.sessionId = message.sessionId;
            setRunningState(true);
            setSessionStatus(`Running round 1 of ${message.rounds}`);
            clearTranscript();
            break;
        case 'UI_SESSION_PROGRESS':
            handleProgress(message);
            break;
        case 'UI_MESSAGE_ADD':
            addMessage(message);
            break;
        case 'UI_SESSION_ENDED':
            handleSessionEnded(message);
            break;
        case 'UI_SESSION_ERROR':
            handleSessionError(message);
            break;
        case 'LLM_ERROR':
            handleSessionError({ error: message.error || 'Unknown error' });
            break;
        default:
            break;
    }
}

function handleTabList(message) {
    state.tabs = message.tabs || { chatgpt: [], gemini: [] };
    state.preferred = message.preferred || { chatgpt: null, gemini: null };
    populateTabSelect(elements.chatgptTab, state.tabs.chatgpt, state.preferred.chatgpt, 'ChatGPT');
    populateTabSelect(elements.geminiTab, state.tabs.gemini, state.preferred.gemini, 'Gemini');
}

function populateTabSelect(selectEl, tabs, preferredId, label) {
    if (!selectEl) return;

    selectEl.innerHTML = '';

    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = `Auto (${label})`;
    selectEl.appendChild(autoOption);

    if (!tabs || tabs.length === 0) {
        const emptyOption = document.createElement('option');
        emptyOption.value = 'none';
        emptyOption.textContent = `No ${label} tabs found`;
        selectEl.appendChild(emptyOption);
        selectEl.value = 'none';
        return;
    }

    tabs.forEach((tab) => {
        const option = document.createElement('option');
        option.value = `tab:${tab.id}`;
        option.textContent = formatTabLabel(tab);
        selectEl.appendChild(option);
    });

    if (preferredId && tabs.some(tab => tab.id === preferredId)) {
        selectEl.value = `tab:${preferredId}`;
    } else {
        selectEl.value = 'auto';
    }
}

function formatTabLabel(tab) {
    const title = (tab.title || tab.url || '').trim();
    if (!title) return `Tab ${tab.id}`;
    return title.length > 42 ? `${title.slice(0, 39)}...` : title;
}

function parseTabValue(value) {
    if (!value || value === 'auto' || value === 'none') return null;
    if (value.startsWith('tab:')) {
        const id = Number(value.replace('tab:', ''));
        return Number.isFinite(id) ? id : null;
    }
    return null;
}

function handleConnectionStatus(message) {
    const { gemini, chatgpt } = message.status || {};
    if (elements.statusChatGPT) {
        elements.statusChatGPT.textContent = `ChatGPT: ${chatgpt ? 'ready' : 'offline'}`;
        elements.statusChatGPT.style.borderColor = chatgpt ? 'rgba(245, 158, 11, 0.5)' : 'rgba(148, 163, 184, 0.3)';
    }
    if (elements.statusGemini) {
        elements.statusGemini.textContent = `Gemini: ${gemini ? 'ready' : 'offline'}`;
        elements.statusGemini.style.borderColor = gemini ? 'rgba(34, 197, 94, 0.5)' : 'rgba(148, 163, 184, 0.3)';
    }
}

function hydrateSession(session) {
    if (!session) {
        setRunningState(false);
        state.sessionId = null;
        return;
    }

    state.sessionId = session.sessionId;
    setRunningState(session.isActive);
    setSessionStatus(session.isActive ? `Resumed round ${session.roundIndex || 1} of ${session.rounds}` : 'Idle');

    clearTranscript();
    if (Array.isArray(session.messages)) {
        const ordered = [...session.messages].sort((a, b) => {
            if (a.turnIndex && b.turnIndex) return a.turnIndex - b.turnIndex;
            return (a.timestamp || 0) - (b.timestamp || 0);
        });
        ordered.forEach(addMessage);
    }
}

function handleProgress(message) {
    if (!message) return;
    if (message.roundIndex && message.totalRounds) {
        setSessionStatus(`Running round ${message.roundIndex} of ${message.totalRounds} - waiting for ${message.waitingFor}`);
    } else if (message.waitingFor) {
        setSessionStatus(`Waiting for ${message.waitingFor}`);
    }
}

function handleSessionEnded(message) {
    setRunningState(false);
    setSessionStatus(message?.reason || 'Session completed');
    state.sessionId = null;
}

function handleSessionError(message) {
    setRunningState(false);
    setSessionStatus(`Error: ${message?.error || 'Unknown error'}`);
    state.sessionId = null;
}

function clearTranscript() {
    if (!elements.timeline) return;
    elements.timeline.innerHTML = '';
    if (elements.emptyState) {
        elements.timeline.appendChild(elements.emptyState);
    }
}

function addMessage(message) {
    if (!elements.timeline) return;

    if (elements.emptyState && elements.timeline.contains(elements.emptyState)) {
        elements.emptyState.remove();
    }

    const container = document.createElement('div');
    container.className = `message ${message.role || message.llm || 'system'}`;

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const role = document.createElement('span');
    role.className = 'message-role';
    role.textContent = formatRoleLabel(message.role || message.llm || 'system');

    const label = document.createElement('span');
    const round = message.roundIndex ? `Round ${message.roundIndex}` : null;
    const turn = message.turnIndex ? `Turn ${message.turnIndex}` : null;
    label.textContent = [round, turn].filter(Boolean).join(' | ');

    meta.appendChild(role);
    meta.appendChild(label);

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = message.content || '';

    container.appendChild(meta);
    container.appendChild(content);

    elements.timeline.appendChild(container);

    if (state.autoScroll) {
        elements.timeline.scrollTop = elements.timeline.scrollHeight;
    }
}

function formatRoleLabel(role) {
    if (!role) return 'System';
    const normalized = role.toLowerCase();
    if (normalized === 'user') return 'User';
    if (normalized === 'chatgpt') return 'ChatGPT';
    if (normalized === 'gemini') return 'Gemini';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
