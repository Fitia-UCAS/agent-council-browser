/* global chrome */

const state = {
    sessionId: null,
    running: false,
    paused: false,
    pausedProvider: null,
    pausedReason: null,
    autoScroll: true,
    profiles: [],
    defaults: { chatgpt: null, gemini: null },
    selectedProfiles: { chatgpt: 'default', gemini: 'default' },
    sessionProfiles: { chatgpt: null, gemini: null },
    pendingClaim: null
};

const elements = {};

document.addEventListener('DOMContentLoaded', () => {
    elements.promptInput = document.getElementById('prompt-input');
    elements.sendButton = document.getElementById('send-button');
    elements.stopButton = document.getElementById('stop-button');
    elements.charCount = document.getElementById('char-count');
    elements.firstLLM = document.getElementById('first-llm');
    elements.iterations = document.getElementById('iterations');
    elements.chatgptProfile = document.getElementById('chatgpt-profile');
    elements.geminiProfile = document.getElementById('gemini-profile');
    elements.refreshProfiles = document.getElementById('refresh-profiles');
    elements.autoScroll = document.getElementById('auto-scroll');
    elements.timeline = document.getElementById('timeline');
    elements.emptyState = document.getElementById('empty-state');
    elements.statusChatGPT = document.getElementById('status-chatgpt');
    elements.statusGemini = document.getElementById('status-gemini');
    elements.sessionStatus = document.getElementById('session-status');

    elements.profileListChatgpt = document.getElementById('profile-list-chatgpt');
    elements.profileListGemini = document.getElementById('profile-list-gemini');
    elements.useCurrentChatgpt = document.getElementById('use-current-chatgpt');
    elements.useCurrentGemini = document.getElementById('use-current-gemini');
    elements.openChatgptTab = document.getElementById('open-chatgpt-tab');
    elements.openGeminiTab = document.getElementById('open-gemini-tab');

    elements.claimWizard = document.getElementById('claim-wizard');
    elements.claimTitle = document.getElementById('claim-title');
    elements.claimSubtitle = document.getElementById('claim-subtitle');
    elements.claimModel = document.getElementById('claim-model');
    elements.claimTabButton = document.getElementById('claim-tab-button');
    elements.cancelClaimButton = document.getElementById('cancel-claim-button');

    elements.pausedActions = document.getElementById('paused-actions');
    elements.resumeButton = document.getElementById('resume-session');
    elements.pausedFocusButton = document.getElementById('paused-focus');
    elements.pausedRebindButton = document.getElementById('paused-rebind');

    bindEvents();
    updateCharCount();
    updateSendState();

    requestProfiles();
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

    if (elements.refreshProfiles) {
        elements.refreshProfiles.addEventListener('click', requestProfiles);
    }

    if (elements.iterations) {
        elements.iterations.addEventListener('change', updateSendState);
    }

    if (elements.autoScroll) {
        elements.autoScroll.addEventListener('change', () => {
            state.autoScroll = elements.autoScroll.checked;
        });
    }

    if (elements.chatgptProfile) {
        elements.chatgptProfile.addEventListener('change', () => {
            state.selectedProfiles.chatgpt = elements.chatgptProfile.value;
            updateSendState();
        });
    }

    if (elements.geminiProfile) {
        elements.geminiProfile.addEventListener('change', () => {
            state.selectedProfiles.gemini = elements.geminiProfile.value;
            updateSendState();
        });
    }

    if (elements.useCurrentChatgpt) {
        elements.useCurrentChatgpt.addEventListener('click', () => {
            sendMessage({ type: 'CREATE_PROFILE_FROM_ACTIVE_TAB', provider: 'chatgpt' }, handleActionResponse);
        });
    }

    if (elements.useCurrentGemini) {
        elements.useCurrentGemini.addEventListener('click', () => {
            sendMessage({ type: 'CREATE_PROFILE_FROM_ACTIVE_TAB', provider: 'gemini' }, handleActionResponse);
        });
    }

    if (elements.openChatgptTab) {
        elements.openChatgptTab.addEventListener('click', () => {
            openProviderTab('chatgpt');
        });
    }

    if (elements.openGeminiTab) {
        elements.openGeminiTab.addEventListener('click', () => {
            openProviderTab('gemini');
        });
    }

    if (elements.claimTabButton) {
        elements.claimTabButton.addEventListener('click', () => {
            claimPendingTab();
        });
    }

    if (elements.cancelClaimButton) {
        elements.cancelClaimButton.addEventListener('click', () => {
            clearPendingClaim();
        });
    }

    if (elements.profileListChatgpt) {
        elements.profileListChatgpt.addEventListener('click', handleProfileListClick);
    }

    if (elements.profileListGemini) {
        elements.profileListGemini.addEventListener('click', handleProfileListClick);
    }

    if (elements.resumeButton) {
        elements.resumeButton.addEventListener('click', resumeSession);
    }

    if (elements.pausedFocusButton) {
        elements.pausedFocusButton.addEventListener('click', focusPausedProvider);
    }

    if (elements.pausedRebindButton) {
        elements.pausedRebindButton.addEventListener('click', rebindPausedProvider);
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

function handleActionResponse(response) {
    if (response && response.ok === false && response.error) {
        setSessionStatus(`Error: ${response.error}`);
    }
}

function updateCharCount() {
    if (!elements.charCount || !elements.promptInput) return;
    elements.charCount.textContent = String(elements.promptInput.value.length);
}

function updateSendState() {
    if (!elements.sendButton || !elements.promptInput || !elements.iterations) return;
    const hasPrompt = elements.promptInput.value.trim().length > 0;
    const iterations = parseInt(elements.iterations.value, 10) || 0;
    const profilesReady = isProfileSelectionValid('chatgpt') && isProfileSelectionValid('gemini');
    elements.sendButton.disabled = state.running || state.paused || !hasPrompt || iterations <= 0 || !profilesReady;
}

function setSessionState({ running, paused }) {
    state.running = running;
    state.paused = paused;
    const locked = running || paused;

    if (elements.sendButton) {
        const hasPrompt = elements.promptInput?.value.trim().length > 0;
        const label = running ? 'Running...' : (paused ? 'Paused' : 'Start debate');
        elements.sendButton.textContent = label;
        elements.sendButton.disabled = locked || !hasPrompt || !isProfileSelectionValid('chatgpt') || !isProfileSelectionValid('gemini');
    }
    if (elements.stopButton) {
        elements.stopButton.disabled = !locked;
    }

    if (elements.firstLLM) elements.firstLLM.disabled = locked;
    if (elements.iterations) elements.iterations.disabled = locked;
    if (elements.chatgptProfile) elements.chatgptProfile.disabled = locked;
    if (elements.geminiProfile) elements.geminiProfile.disabled = locked;
    if (elements.refreshProfiles) elements.refreshProfiles.disabled = locked;
    updatePausedActions();
}

function setSessionStatus(text) {
    if (elements.sessionStatus) {
        elements.sessionStatus.textContent = text;
    }
}

function requestProfiles() {
    sendMessage({ type: 'GET_TAB_PROFILES' });
}

function requestConnectionStatus() {
    sendMessage({ type: 'CHECK_CONNECTION' });
}

function requestActiveSession() {
    sendMessage({ type: 'GET_ACTIVE_SESSION' });
}

function startSession() {
    if (state.running || state.paused) return;
    if (!elements.promptInput) return;

    const prompt = elements.promptInput.value.trim();
    if (!prompt) return;

    const rounds = parseInt(elements.iterations?.value, 10) || 0;
    if (rounds <= 0) return;

    if (!isProfileSelectionValid('chatgpt') || !isProfileSelectionValid('gemini')) {
        setSessionStatus('Select valid profiles for ChatGPT and Gemini.');
        return;
    }

    const firstLLM = elements.firstLLM?.value || 'chatgpt';
    const chatgptSelection = elements.chatgptProfile?.value || 'default';
    const geminiSelection = elements.geminiProfile?.value || 'default';

    setSessionState({ running: true, paused: false });
    setSessionStatus('Starting session...');

    sendMessage({
        type: 'START_DEBATE_SESSION',
        prompt,
        firstLLM,
        rounds,
        profileIds: {
            chatgpt: chatgptSelection,
            gemini: geminiSelection
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

function resumeSession() {
    if (!state.sessionId || !state.paused) return;
    setSessionStatus('Resuming session...');
    sendMessage({ type: 'RESUME_SESSION' }, handleActionResponse);
}

function openProviderTab(provider) {
    sendMessage({ type: 'OPEN_PROVIDER_TAB', provider, focus: true }, (response) => {
        if (!response || response.ok === false) {
            handleActionResponse(response || { ok: false, error: 'Failed to open tab.' });
            return;
        }
        state.pendingClaim = {
            provider: response.provider,
            tabId: response.tabId,
            windowId: response.windowId,
            modelLabel: ''
        };
        renderClaimWizard();
    });
}

function claimPendingTab() {
    if (!state.pendingClaim) return;
    const providerLabel = formatProviderLabel(state.pendingClaim.provider);
    const modelLabel = truncateInlineText(state.pendingClaim.modelLabel, 48);
    const label = modelLabel
        ? `${providerLabel} - ${modelLabel}`
        : `${providerLabel} profile`;
    sendMessage({
        type: 'CLAIM_TAB_AS_PROFILE',
        provider: state.pendingClaim.provider,
        tabId: state.pendingClaim.tabId,
        label
    }, (response) => {
        handleActionResponse(response);
        if (response?.ok) {
            clearPendingClaim();
        }
    });
}

function clearPendingClaim() {
    state.pendingClaim = null;
    renderClaimWizard();
}

function handleBackgroundMessage(message) {
    switch (message.type) {
        case 'TAB_PROFILES':
            handleProfileList(message);
            break;
        case 'PROVIDER_MODEL_INFO':
            handleModelInfo(message);
            break;
        case 'CONNECTION_STATUS':
            handleConnectionStatus(message);
            break;
        case 'ACTIVE_SESSION':
            hydrateSession(message.session);
            break;
        case 'UI_SESSION_STARTED':
            state.sessionId = message.sessionId;
            state.sessionProfiles = message.profileIds || state.sessionProfiles;
            setSessionState({ running: true, paused: false });
            setSessionStatus(`Running round 1 of ${message.rounds}`);
            clearTranscript();
            break;
        case 'UI_SESSION_PROGRESS':
            handleProgress(message);
            break;
        case 'UI_MESSAGE_ADD':
            addMessage(message);
            break;
        case 'UI_SESSION_PAUSED':
            handleSessionPaused(message);
            break;
        case 'UI_SESSION_RESUMED':
            handleSessionResumed(message);
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

function handleProfileList(message) {
    state.profiles = Array.isArray(message.profiles) ? message.profiles : [];
    state.defaults = message.defaults || { chatgpt: null, gemini: null };
    renderProfileSelect(elements.chatgptProfile, 'chatgpt');
    renderProfileSelect(elements.geminiProfile, 'gemini');
    renderProfileLists();
    updateSendState();
}

function handleModelInfo(message) {
    if (!message || !state.pendingClaim) return;
    if (state.pendingClaim.tabId !== message.tabId) return;
    state.pendingClaim.modelLabel = message.modelLabel || '';
    renderClaimWizard();
}

function renderProfileSelect(selectEl, provider) {
    if (!selectEl) return;
    selectEl.innerHTML = '';

    const defaultProfile = getProfileById(state.defaults[provider]);
    const defaultOption = document.createElement('option');
    defaultOption.value = 'default';
    defaultOption.textContent = defaultProfile
        ? `Default (${defaultProfile.label})`
        : 'Default (not set)';
    selectEl.appendChild(defaultOption);

    const profiles = getProfilesForProvider(provider);
    if (profiles.length === 0) {
        const emptyOption = document.createElement('option');
        emptyOption.value = 'none';
        emptyOption.textContent = `No ${formatProviderLabel(provider)} profiles`;
        selectEl.appendChild(emptyOption);
    } else {
        profiles.forEach((profile) => {
            const option = document.createElement('option');
            option.value = profile.profileId;
            option.textContent = formatProfileOptionLabel(profile);
            selectEl.appendChild(option);
        });
    }

    const selected = state.selectedProfiles[provider] || 'default';
    const hasSelected = Array.from(selectEl.options).some(option => option.value === selected);
    selectEl.value = hasSelected ? selected : 'default';
    state.selectedProfiles[provider] = selectEl.value;
}

function renderProfileLists() {
    renderProfileList(elements.profileListChatgpt, 'chatgpt');
    renderProfileList(elements.profileListGemini, 'gemini');
}

function renderProfileList(container, provider) {
    if (!container) return;
    container.innerHTML = '';
    const profiles = getProfilesForProvider(provider);
    if (profiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'profile-empty';
        empty.textContent = `No ${formatProviderLabel(provider)} profiles yet.`;
        container.appendChild(empty);
        return;
    }

    profiles.forEach((profile) => {
        container.appendChild(buildProfileCard(profile));
    });
}

function buildProfileCard(profile) {
    const card = document.createElement('div');
    card.className = `profile-card status-${profile.status || 'unknown'}`;
    card.dataset.profileId = profile.profileId;

    const header = document.createElement('div');
    header.className = 'profile-header';

    const title = document.createElement('div');
    title.className = 'profile-title';
    title.textContent = profile.label || `${formatProviderLabel(profile.provider)} profile`;

    const status = document.createElement('div');
    status.className = `status-pill status-${profile.status || 'unknown'}`;
    status.textContent = formatStatusLabel(profile.status);

    header.appendChild(title);
    header.appendChild(status);

    const badges = document.createElement('div');
    badges.className = 'profile-badges';

    if (state.defaults[profile.provider] === profile.profileId) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-default';
        badge.textContent = 'Default';
        badges.appendChild(badge);
    }
    if (profile.inUseBySessionId) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-active';
        badge.textContent = 'In use';
        badges.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'profile-meta';
    const tabFullLabel = (profile.lastKnownTitle || profile.lastKnownUrl || '').trim();
    meta.appendChild(buildMetaLine('Tab', formatProfileTabLabel(profile), tabFullLabel));
    if (profile.modelHint) {
        const modelHint = normalizeInlineText(profile.modelHint);
        meta.appendChild(buildMetaLine('Model', `${modelHint} (best effort)`, modelHint));
    }
    if (profile.windowId !== null && profile.windowId !== undefined) {
        meta.appendChild(buildMetaLine('Window', String(profile.windowId)));
    }

    const actions = document.createElement('div');
    actions.className = 'profile-actions-row';
    actions.appendChild(buildActionButton('Focus', 'focus', !profile.tabId));
    actions.appendChild(buildActionButton('Set default', 'default'));
    actions.appendChild(buildActionButton('Rename', 'rename'));
    actions.appendChild(buildActionButton('Rebind', 'rebind'));
    actions.appendChild(buildActionButton('Remove', 'remove', false, true));

    card.appendChild(header);
    if (badges.childNodes.length) {
        card.appendChild(badges);
    }
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
}

function buildMetaLine(label, value, title = '') {
    const line = document.createElement('div');
    line.className = 'profile-meta-line';
    const strong = document.createElement('span');
    strong.className = 'profile-meta-label';
    strong.textContent = `${label}:`;
    const text = document.createElement('span');
    text.className = 'profile-meta-value';
    text.textContent = value;
    const tooltip = title ? String(title) : String(value || '');
    if (tooltip) {
        text.title = tooltip;
    }
    line.appendChild(strong);
    line.appendChild(text);
    return line;
}

function buildActionButton(label, action, disabled = false, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ghost-button${danger ? ' danger' : ''}`;
    button.textContent = label;
    button.dataset.action = action;
    button.disabled = disabled;
    return button;
}

function handleProfileListClick(event) {
    const button = event.target.closest('button');
    if (!button || !button.dataset.action) return;
    const card = button.closest('[data-profile-id]');
    if (!card) return;
    const profile = getProfileById(card.dataset.profileId);
    if (!profile) return;

    switch (button.dataset.action) {
        case 'focus':
            if (profile.tabId) {
                sendMessage({ type: 'FOCUS_TAB', tabId: profile.tabId }, handleActionResponse);
            }
            break;
        case 'default':
            sendMessage({ type: 'SET_DEFAULT_PROFILE', provider: profile.provider, profileId: profile.profileId }, handleActionResponse);
            break;
        case 'rename': {
            const nextLabel = window.prompt('Rename profile', profile.label || '');
            if (!nextLabel || nextLabel.trim() === profile.label) return;
            sendMessage({
                type: 'UPDATE_TAB_PROFILE',
                profileId: profile.profileId,
                patch: { label: nextLabel.trim() }
            }, handleActionResponse);
            break;
        }
        case 'rebind':
            sendMessage({
                type: 'CREATE_PROFILE_FROM_ACTIVE_TAB',
                provider: profile.provider,
                profileId: profile.profileId
            }, handleActionResponse);
            break;
        case 'remove': {
            const confirmed = window.confirm(`Remove profile "${profile.label}"?`);
            if (!confirmed) return;
            sendMessage({ type: 'DELETE_TAB_PROFILE', profileId: profile.profileId }, handleActionResponse);
            break;
        }
        default:
            break;
    }
}

function renderClaimWizard() {
    if (!elements.claimWizard) return;
    if (!state.pendingClaim) {
        elements.claimWizard.hidden = true;
        return;
    }
    const providerLabel = formatProviderLabel(state.pendingClaim.provider);
    if (elements.claimTitle) {
        elements.claimTitle.textContent = `Claim ${providerLabel} tab`;
    }
    if (elements.claimSubtitle) {
        elements.claimSubtitle.textContent = `We opened ${providerLabel}. Select the model there, then claim it.`;
    }
    if (elements.claimModel) {
        const full = normalizeInlineText(state.pendingClaim.modelLabel);
        const display = truncateInlineText(full, 64);
        elements.claimModel.textContent = full
            ? `Detected model: ${display} (best effort)`
            : 'Detected model: not available yet.';
        elements.claimModel.title = full ? `Detected model: ${full}` : '';
    }
    elements.claimWizard.hidden = false;
}

function updatePausedActions() {
    if (!elements.pausedActions) return;
    elements.pausedActions.hidden = !state.paused;
}

function focusPausedProvider() {
    if (!state.pausedProvider) return;
    const profileId = state.sessionProfiles[state.pausedProvider];
    const profile = getProfileById(profileId);
    if (!profile?.tabId) return;
    sendMessage({ type: 'FOCUS_TAB', tabId: profile.tabId }, handleActionResponse);
}

function rebindPausedProvider() {
    if (!state.pausedProvider) return;
    const profileId = state.sessionProfiles[state.pausedProvider];
    if (!profileId) return;
    sendMessage({
        type: 'CREATE_PROFILE_FROM_ACTIVE_TAB',
        provider: state.pausedProvider,
        profileId
    }, handleActionResponse);
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
        setSessionState({ running: false, paused: false });
        state.sessionId = null;
        state.sessionProfiles = { chatgpt: null, gemini: null };
        state.pausedProvider = null;
        state.pausedReason = null;
        return;
    }

    state.sessionId = session.sessionId;
    state.sessionProfiles = session.profileIds || state.sessionProfiles;
    state.paused = Boolean(session.isPaused);
    state.pausedProvider = session.pausedProvider || null;
    state.pausedReason = session.pausedReason || null;

    if (session.isPaused) {
        setSessionState({ running: false, paused: true });
        setSessionStatus(`Paused: ${state.pausedReason || 'Needs attention'}`);
    } else {
        setSessionState({ running: session.isActive, paused: false });
        setSessionStatus(session.isActive ? `Resumed round ${session.roundIndex || 1} of ${session.rounds}` : 'Idle');
    }

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

function handleSessionPaused(message) {
    state.paused = true;
    state.pausedProvider = message.provider || null;
    state.pausedReason = message.reason || 'Session paused.';
    setSessionState({ running: false, paused: true });
    setSessionStatus(`Paused: ${state.pausedReason}`);
}

function handleSessionResumed() {
    state.paused = false;
    state.pausedProvider = null;
    state.pausedReason = null;
    setSessionState({ running: true, paused: false });
    setSessionStatus('Resumed session.');
}

function handleSessionEnded(message) {
    setSessionState({ running: false, paused: false });
    setSessionStatus(message?.reason || 'Session completed');
    state.sessionId = null;
    state.sessionProfiles = { chatgpt: null, gemini: null };
}

function handleSessionError(message) {
    setSessionState({ running: false, paused: false });
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

function formatProviderLabel(provider) {
    return provider === 'gemini' ? 'Gemini' : 'ChatGPT';
}

function normalizeInlineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateInlineText(value, maxLen) {
    const normalized = normalizeInlineText(value);
    if (!normalized) return '';
    if (!Number.isFinite(maxLen) || maxLen <= 0) return normalized;
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLen - 1))}…`;
}

function getProfilesForProvider(provider) {
    return state.profiles.filter(profile => profile.provider === provider);
}

function getProfileById(profileId) {
    if (!profileId) return null;
    return state.profiles.find(profile => profile.profileId === profileId) || null;
}

function resolveSelectedProfileId(provider) {
    const selection = state.selectedProfiles[provider] || 'default';
    if (selection === 'default') {
        return state.defaults?.[provider] || null;
    }
    return selection;
}

function isProfileSelectionValid(provider) {
    const profileId = resolveSelectedProfileId(provider);
    if (!profileId) return false;
    const profile = getProfileById(profileId);
    return Boolean(profile && profile.status === 'ok' && profile.tabId);
}

function formatProfileOptionLabel(profile) {
    const statusSuffix = profile.status && profile.status !== 'ok' ? ` (${formatStatusLabel(profile.status)})` : '';
    const inUse = profile.inUseBySessionId ? ' [in use]' : '';
    return `${profile.label || 'Untitled'}${statusSuffix}${inUse}`;
}

function formatProfileTabLabel(profile) {
    if (!profile.tabId) return 'Unbound';
    const title = (profile.lastKnownTitle || profile.lastKnownUrl || '').trim();
    if (!title) return `Tab ${profile.tabId}`;
    return title.length > 52 ? `${title.slice(0, 49)}...` : title;
}

function formatStatusLabel(status) {
    switch (status) {
        case 'ok':
            return 'OK';
        case 'offline':
            return 'Offline';
        case 'wrong_host':
            return 'Wrong host';
        case 'unknown':
        default:
            return 'Unknown';
    }
}
