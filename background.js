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
    migratePreferredTabsToProfiles().catch((error) => {
        console.warn('[MLC Background] Failed to migrate preferred tabs:', error);
    });
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
const TAB_PROFILES_KEY = 'mlc_tab_profiles_v1';
const CHATS_KEY = 'mlc_chats_v1';

let tabProfilesOpChain = Promise.resolve();

function withTabProfilesLock(operation) {
    const run = async () => operation();
    const next = tabProfilesOpChain.then(run, run);
    tabProfilesOpChain = next.catch(() => {});
    return next;
}

const defaultChatsState = {
    schemaVersion: 1,
    activeChatId: null,
    chats: []
};

function generateChatId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function normalizeChatTitle(title) {
    const value = String(title || '').replace(/\s+/g, ' ').trim();
    return value;
}

function getChatTitleFromPrompt(prompt) {
    const cleaned = normalizeInlineText(prompt);
    if (!cleaned) return '';
    return cleaned.length > 48 ? `${cleaned.slice(0, 48).trim()}…` : cleaned;
}

function toChatSummary(chat) {
    return {
        chatId: chat.chatId,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0
    };
}

async function loadChatsState({ ensureActive = true } = {}) {
    const stored = await chrome.storage.local.get(CHATS_KEY);
    const raw = stored?.[CHATS_KEY];
    const state = raw && typeof raw === 'object'
        ? {
            schemaVersion: 1,
            activeChatId: typeof raw.activeChatId === 'string' ? raw.activeChatId : null,
            chats: Array.isArray(raw.chats) ? raw.chats : []
        }
        : { ...defaultChatsState };

    if (!ensureActive) return state;

    const hasActive = state.activeChatId && state.chats.some(chat => chat.chatId === state.activeChatId);
    if (state.chats.length === 0 || !hasActive) {
        const now = Date.now();
        const chatId = generateChatId();
        state.chats.unshift({
            chatId,
            title: 'New chat',
            createdAt: now,
            updatedAt: now,
            messages: []
        });
        state.activeChatId = chatId;
        await chrome.storage.local.set({ [CHATS_KEY]: state });
    }

    return state;
}

async function saveChatsState(state) {
    await chrome.storage.local.set({ [CHATS_KEY]: state });
}

async function notifyChatsState(stateOverride = null) {
    const state = stateOverride || await loadChatsState();
    sendMessageToPopup({
        type: 'CHATS_STATE',
        activeChatId: state.activeChatId,
        chats: state.chats.map(toChatSummary)
    });
}

function findChatById(state, chatId) {
    return state.chats.find(chat => chat.chatId === chatId) || null;
}

async function createChat({ makeActive = true } = {}) {
    const state = await loadChatsState({ ensureActive: false });
    const now = Date.now();
    const chat = {
        chatId: generateChatId(),
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        messages: []
    };
    state.chats.unshift(chat);
    if (makeActive) {
        state.activeChatId = chat.chatId;
    } else if (!state.activeChatId) {
        state.activeChatId = chat.chatId;
    }
    await saveChatsState(state);
    await notifyChatsState(state);
    return { ok: true, chat: chat, state };
}

async function setActiveChat(chatId) {
    const state = await loadChatsState({ ensureActive: false });
    const chat = chatId ? findChatById(state, chatId) : null;
    if (!chat) {
        return { ok: false, error: 'Chat not found.' };
    }
    state.activeChatId = chat.chatId;
    await saveChatsState(state);
    await notifyChatsState(state);
    return { ok: true, chat, state };
}

async function renameChat(chatId, title) {
    const state = await loadChatsState({ ensureActive: false });
    const chat = findChatById(state, chatId);
    if (!chat) return { ok: false, error: 'Chat not found.' };
    const nextTitle = normalizeChatTitle(title);
    if (!nextTitle) return { ok: false, error: 'Title is empty.' };
    chat.title = nextTitle;
    chat.updatedAt = Date.now();
    await saveChatsState(state);
    await notifyChatsState(state);
    return { ok: true, chat };
}

async function deleteChat(chatId) {
    const state = await loadChatsState({ ensureActive: false });
    const exists = state.chats.some(chat => chat.chatId === chatId);
    if (!exists) return { ok: false, error: 'Chat not found.' };
    state.chats = state.chats.filter(chat => chat.chatId !== chatId);
    if (state.activeChatId === chatId) {
        state.activeChatId = state.chats[0]?.chatId || null;
    }
    await saveChatsState(state);
    await notifyChatsState(state);
    return { ok: true, state };
}

async function appendChatMessage(chatId, message) {
    if (!chatId || !message) return { ok: false, error: 'Missing chatId or message.' };
    const state = await loadChatsState({ ensureActive: false });
    const chat = findChatById(state, chatId);
    if (!chat) return { ok: false, error: 'Chat not found.' };

    const entry = {
        role: message.role || 'assistant',
        content: String(message.content || ''),
        timestamp: Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
        sessionId: message.sessionId || null,
        turnIndex: Number.isFinite(message.turnIndex) ? message.turnIndex : null,
        roundIndex: Number.isFinite(message.roundIndex) ? message.roundIndex : null
    };
    if (typeof message.contentHtml === 'string' && message.contentHtml.trim()) {
        entry.contentHtml = message.contentHtml;
    }
    if (!entry.content.trim()) return { ok: false, error: 'Empty message content.' };

    if (!Array.isArray(chat.messages)) chat.messages = [];
    chat.messages.push(entry);
    chat.updatedAt = Date.now();
    if ((chat.title === 'New chat' || !chat.title) && entry.role === 'user') {
        const derived = getChatTitleFromPrompt(entry.content);
        if (derived) {
            chat.title = derived;
        }
    }

    await saveChatsState(state);
    await notifyChatsState(state);
    return { ok: true };
}

const defaultDebateState = {
    isActive: false,
    isPaused: false,
    pausedReason: null,
    pausedProvider: null,
    pausedAt: 0,
    chatId: null,
    sessionId: null,
    rounds: 0,
    totalTurns: 0,
    turnIndex: 1,
    firstLLM: 'chatgpt',
    secondLLM: 'gemini',
    profileIds: { chatgpt: null, gemini: null },
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
        if (!activeDebateState.profileIds) {
            activeDebateState.profileIds = { chatgpt: null, gemini: null };
        }
        if (typeof activeDebateState.isPaused !== 'boolean') {
            activeDebateState.isPaused = false;
        }
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

function normalizeProvider(provider) {
    return provider === 'gemini' ? 'gemini' : 'chatgpt';
}

function getTabUrlCandidate(tab) {
    if (!tab) return '';
    if (typeof tab.url === 'string' && tab.url) return tab.url;
    if (typeof tab.pendingUrl === 'string' && tab.pendingUrl) return tab.pendingUrl;
    return '';
}

function getEmptyProfilesState() {
    return { profiles: [], defaults: { chatgpt: null, gemini: null } };
}

function generateProfileId() {
    return 'profile_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function normalizeInlineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeModelHint(provider, modelHint) {
    const normalizedProvider = normalizeProvider(provider);
    const cleaned = normalizeInlineText(modelHint).replace(/^Model:\s*/i, '').trim();
    if (!cleaned) return '';

    // Model labels should be short and single-line. Anything longer is almost
    // certainly a bad DOM match (e.g., capturing chat transcript text).
    const maxLen = 80;
    if (cleaned.length > maxLen) return '';

    const words = cleaned.split(' ').filter(Boolean);
    if (words.length > 12) return '';

    const suspicious = [
        /iteration\s*\d/i,
        /user (query|message)/i,
        /\bnow respond\b/i,
        /\bmulti[-\s]llm\b/i,
        /\bmulti[-\s]agent\b/i,
        /\bdebate\b/i,
        /\bhere is\b/i,
        /\bchatgpt\b.*\banswer\b/i,
        /\bgemini\b.*\banswer\b/i
    ];
    if (suspicious.some(re => re.test(cleaned))) return '';

    // Lightweight provider sanity checks (non-blocking).
    if (normalizedProvider === 'chatgpt') {
        if (!/(gpt|o1|o3|o4)/i.test(cleaned)) {
            // ChatGPT model labels almost always include GPT/o1/o3/o4; if not, still allow short labels.
            // No-op.
        }
    } else {
        // Gemini labels often include "Gemini", but may be abbreviated; no strict check.
    }

    return cleaned;
}

function sanitizeProfilesState(state) {
    if (!state || !Array.isArray(state.profiles)) return { state, changed: false };
    let changed = false;
    const nextProfiles = state.profiles.map((profile) => {
        const next = { ...profile };
        const safeHint = sanitizeModelHint(next.provider, next.modelHint);
        if (safeHint !== (next.modelHint || '')) {
            next.modelHint = safeHint;
            changed = true;
        }
        return next;
    });
    const nextState = changed ? { ...state, profiles: nextProfiles } : state;
    return { state: nextState, changed };
}

function getExpectedHosts(provider) {
    if (provider === 'gemini') {
        return ['gemini.google.com'];
    }
    return ['chatgpt.com', 'chat.openai.com', 'openai.com', 'platform.openai.com'];
}

function isExpectedHost(provider, url) {
    if (!url) return false;
    try {
        const { hostname } = new URL(url);
        const expected = getExpectedHosts(provider);
        return expected.some(host => hostname === host || hostname.endsWith(`.${host}`));
    } catch (error) {
        return false;
    }
}

async function loadTabProfiles() {
    const stored = await chrome.storage.local.get(TAB_PROFILES_KEY);
    if (stored && stored[TAB_PROFILES_KEY]) {
        const next = stored[TAB_PROFILES_KEY];
        if (Array.isArray(next.profiles) && next.defaults) {
            const state = {
                profiles: next.profiles,
                defaults: {
                    chatgpt: next.defaults.chatgpt || null,
                    gemini: next.defaults.gemini || null
                }
            };
            return sanitizeProfilesState(state).state;
        }
    }
    return getEmptyProfilesState();
}

async function saveTabProfiles(state) {
    await chrome.storage.local.set({ [TAB_PROFILES_KEY]: state });
    return state;
}

function findProfileById(state, profileId) {
    return state.profiles.find(profile => profile.profileId === profileId);
}

function findProfileByTabId(state, provider, tabId) {
    return state.profiles.find(profile => profile.provider === provider && profile.tabId === tabId);
}

function formatDefaultProfileLabel(provider, tab) {
    const base = provider === 'gemini' ? 'Gemini' : 'ChatGPT';
    if (tab?.title) {
        const trimmed = tab.title.trim();
        if (trimmed) {
            return `${base} - ${trimmed.length > 32 ? `${trimmed.slice(0, 29)}...` : trimmed}`;
        }
    }
    return `${base} profile`;
}

function applyProfilePatch(profile, patch = {}) {
    const next = { ...profile };
    if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
        next.label = String(patch.label || '').trim() || next.label;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'tabId')) {
        next.tabId = Number.isFinite(patch.tabId) ? patch.tabId : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'windowId')) {
        next.windowId = Number.isFinite(patch.windowId) ? patch.windowId : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'modelHint')) {
        next.modelHint = sanitizeModelHint(next.provider, patch.modelHint);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastKnownTitle')) {
        next.lastKnownTitle = patch.lastKnownTitle ? String(patch.lastKnownTitle) : '';
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastKnownUrl')) {
        next.lastKnownUrl = patch.lastKnownUrl ? String(patch.lastKnownUrl) : '';
    }
    return next;
}

async function validateProfile(profile) {
    const updatedAt = Date.now();
    if (!profile || !profile.tabId) {
        return { ...profile, status: 'offline', updatedAt };
    }
	try {
	    const tab = await chrome.tabs.get(profile.tabId);
	    const url = getTabUrlCandidate(tab);
	    const status = url
	        ? (isExpectedHost(profile.provider, url) ? 'ok' : 'wrong_host')
	        : 'unknown';
	    return {
            ...profile,
            tabId: tab.id,
            windowId: tab.windowId,
            lastKnownTitle: tab.title || profile.lastKnownTitle || '',
            lastKnownUrl: url || profile.lastKnownUrl || '',
            status,
            lastSeenAt: Date.now(),
            updatedAt
        };
    } catch (error) {
        return {
            ...profile,
            status: 'offline',
            windowId: null,
            updatedAt
        };
    }
}

async function refreshAllProfiles({ persist = true } = {}) {
    if (!persist) {
        const state = await loadTabProfiles();
        const updatedProfiles = await Promise.all(state.profiles.map(profile => validateProfile(profile)));
        return sanitizeProfilesState({ ...state, profiles: updatedProfiles }).state;
    }

    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        const updatedProfiles = await Promise.all(state.profiles.map(profile => validateProfile(profile)));
        const next = sanitizeProfilesState({ ...state, profiles: updatedProfiles }).state;
        await saveTabProfiles(next);
        return next;
    });
}

async function notifyTabProfiles(stateOverride = null) {
    const state = stateOverride || await refreshAllProfiles({ persist: true });
    sendMessageToPopup({
        type: 'TAB_PROFILES',
        profiles: state.profiles,
        defaults: state.defaults
    });
}

async function pingTab(tabId, provider) {
    if (!tabId) return false;
    try {
        const response = await Promise.race([
            chrome.tabs.sendMessage(tabId, { type: 'PING' }),
            new Promise((resolve) => setTimeout(() => resolve(null), 1500))
        ]);
        return Boolean(response && response.type === 'PONG');
    } catch (error) {
        console.warn(`[MLC Background] ${provider} tab ping failed:`, error.message);
        return false;
    }
}

async function migratePreferredTabsToProfiles() {
    return withTabProfilesLock(async () => {
        const existing = await chrome.storage.local.get(TAB_PROFILES_KEY);
        if (existing && existing[TAB_PROFILES_KEY]) return;
        const preferred = await getPreferredTabs();
        if (!preferred.chatgpt && !preferred.gemini) return;

        const state = getEmptyProfilesState();
        for (const provider of ['chatgpt', 'gemini']) {
            const tabId = preferred[provider];
            if (!Number.isFinite(tabId)) continue;
            const profileId = generateProfileId();
            let profile = {
                profileId,
                provider,
                tabId,
                windowId: null,
                label: provider === 'gemini' ? 'Gemini profile' : 'ChatGPT profile',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                lastSeenAt: 0,
                status: 'unknown',
                modelHint: '',
                lastKnownTitle: '',
                lastKnownUrl: '',
                inUseBySessionId: null
            };
            profile = await validateProfile(profile);
            state.profiles.push(profile);
            state.defaults[provider] = profileId;
        }

        await saveTabProfiles(state);
        await notifyTabProfiles(state);
    });
}

async function claimTabAsProfile({ provider, tabId, label, profileId, setDefault = false, skipHostCheck = false }) {
    return withTabProfilesLock(async () => {
        const normalizedProvider = normalizeProvider(provider);
        if (!Number.isFinite(tabId)) {
            return { ok: false, error: 'Tab ID is invalid.' };
        }
        let tab;
        try {
            tab = await chrome.tabs.get(tabId);
        } catch (error) {
            return { ok: false, error: 'Tab not found.' };
        }
        const tabUrl = getTabUrlCandidate(tab);
        const status = tabUrl
            ? (isExpectedHost(normalizedProvider, tabUrl) ? 'ok' : 'wrong_host')
            : 'unknown';

        if (!skipHostCheck && status !== 'ok') {
            return { ok: false, error: `Selected tab is not a valid ${normalizedProvider === 'gemini' ? 'Gemini' : 'ChatGPT'} tab.` };
        }

        const state = await loadTabProfiles();
        let profile = profileId ? findProfileById(state, profileId) : null;
        if (!profile) {
            profile = findProfileByTabId(state, normalizedProvider, tabId);
        }

        if (!profile) {
            profile = {
                profileId: generateProfileId(),
                provider: normalizedProvider,
                tabId: tabId,
                windowId: tab.windowId || null,
                label: label ? String(label).trim() : formatDefaultProfileLabel(normalizedProvider, tab),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                lastSeenAt: Date.now(),
                status,
                modelHint: '',
                lastKnownTitle: tab.title || '',
                lastKnownUrl: tabUrl || '',
                inUseBySessionId: null
            };
            state.profiles.push(profile);
        } else {
            profile = applyProfilePatch(profile, {
                tabId: tabId,
                windowId: tab.windowId,
                label: label ? String(label).trim() : profile.label,
                lastKnownTitle: tab.title || profile.lastKnownTitle,
                lastKnownUrl: tabUrl || profile.lastKnownUrl
            });
            profile.updatedAt = Date.now();
            profile.lastSeenAt = Date.now();
            profile.status = status;
            const index = state.profiles.findIndex(item => item.profileId === profile.profileId);
            if (index >= 0) state.profiles[index] = profile;
        }

        if (setDefault || !state.defaults[normalizedProvider]) {
            state.defaults[normalizedProvider] = profile.profileId;
        }

        profile = await validateProfile(profile);
        const index = state.profiles.findIndex(item => item.profileId === profile.profileId);
        if (index >= 0) state.profiles[index] = profile;
        await saveTabProfiles(state);
        await syncSessionProfileBinding(profile);
        await notifyTabProfiles(state);
        return { ok: true, profile };
    });
}

async function createProfileFromActiveTab(provider, label, profileId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
        return { ok: false, error: 'No active tab found.' };
    }
    return claimTabAsProfile({
        provider,
        tabId: activeTab.id,
        label,
        profileId
    });
}

async function updateTabProfile(profileId, patch) {
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        const profile = findProfileById(state, profileId);
        if (!profile) return { ok: false, error: 'Profile not found.' };

        let next = applyProfilePatch(profile, patch);
        if (Number.isFinite(patch?.tabId)) {
            try {
                const tab = await chrome.tabs.get(patch.tabId);
                const tabUrl = getTabUrlCandidate(tab);
                if (!isExpectedHost(profile.provider, tabUrl)) {
                    return { ok: false, error: 'Selected tab is not valid for this provider.' };
                }
                next = applyProfilePatch(next, {
                    windowId: tab.windowId,
                    lastKnownTitle: tab.title || next.lastKnownTitle,
                    lastKnownUrl: tabUrl || next.lastKnownUrl
                });
                next.status = 'ok';
                next.lastSeenAt = Date.now();
            } catch (error) {
                return { ok: false, error: 'Tab not found.' };
            }
        }

        next.updatedAt = Date.now();
        const updated = await validateProfile(next);
        const index = state.profiles.findIndex(item => item.profileId === profileId);
        if (index >= 0) state.profiles[index] = updated;
        await saveTabProfiles(state);
        await syncSessionProfileBinding(updated);
        await notifyTabProfiles(state);
        return { ok: true, profile: updated };
    });
}

async function deleteTabProfile(profileId) {
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        const profile = findProfileById(state, profileId);
        if (!profile) return { ok: false, error: 'Profile not found.' };
        state.profiles = state.profiles.filter(item => item.profileId !== profileId);
        for (const provider of ['chatgpt', 'gemini']) {
            if (state.defaults[provider] === profileId) {
                state.defaults[provider] = null;
            }
        }
        await saveTabProfiles(state);
        if (profile.inUseBySessionId) {
            await pauseDebateSession(`Profile "${profile.label}" was removed.`, profile.provider);
        }
        await notifyTabProfiles(state);
        return { ok: true };
    });
}

async function setDefaultProfile(provider, profileId) {
    return withTabProfilesLock(async () => {
        const normalizedProvider = normalizeProvider(provider);
        const state = await loadTabProfiles();
        if (profileId) {
            const profile = findProfileById(state, profileId);
            if (!profile || profile.provider !== normalizedProvider) {
                return { ok: false, error: 'Profile not found for provider.' };
            }
            state.defaults[normalizedProvider] = profileId;
        } else {
            state.defaults[normalizedProvider] = null;
        }
        await saveTabProfiles(state);
        await notifyTabProfiles(state);
        return { ok: true };
    });
}

async function focusTab(tabId) {
    if (!Number.isFinite(tabId)) return { ok: false, error: 'Invalid tab ID.' };
    try {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: 'Tab not found.' };
    }
}

async function openProviderTab(provider, options = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const url = normalizedProvider === 'gemini' ? 'https://gemini.google.com/' : 'https://chatgpt.com/';
    const focus = options.focus !== false;
    const tab = await chrome.tabs.create({
        url,
        active: focus,
        windowId: Number.isFinite(options.windowId) ? options.windowId : undefined
    });
    return { ok: true, provider: normalizedProvider, tabId: tab.id, windowId: tab.windowId };
}

async function connectProvider(provider, options = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const opened = await openProviderTab(normalizedProvider, options);
    if (!opened?.ok) return opened || { ok: false, error: 'Failed to open provider tab.' };
    const label = normalizedProvider === 'gemini' ? 'Gemini' : 'ChatGPT';
    let claimed = await claimTabAsProfile({
        provider: normalizedProvider,
        tabId: opened.tabId,
        label,
        setDefault: true
    });
    if (!claimed?.ok) {
        claimed = await claimTabAsProfile({
            provider: normalizedProvider,
            tabId: opened.tabId,
            label,
            setDefault: true,
            skipHostCheck: true
        });
    }
    if (!claimed?.ok) return claimed || { ok: false, error: 'Failed to bind provider tab.' };
    return { ok: true, provider: normalizedProvider, tabId: opened.tabId, profile: claimed.profile };
}

async function syncSessionProfileBinding(profile) {
    const session = await loadActiveDebateState();
    if (!session.sessionId || !profile) return;
    if (session.profileIds?.[profile.provider] === profile.profileId) {
        session.tabIds[profile.provider] = profile.tabId || null;
        await persistDebateState();
    }
}

async function updateProfileModelHint(tabId, provider, modelHint) {
    if (!Number.isFinite(tabId)) return;
    return withTabProfilesLock(async () => {
        const normalizedProvider = normalizeProvider(provider);
        const state = await loadTabProfiles();
        const profile = state.profiles.find(item => item.provider === normalizedProvider && item.tabId === tabId);
        if (!profile) return;
        const next = applyProfilePatch(profile, { modelHint: sanitizeModelHint(normalizedProvider, modelHint) });
        next.updatedAt = Date.now();
        const index = state.profiles.findIndex(item => item.profileId === profile.profileId);
        if (index >= 0) state.profiles[index] = next;
        await saveTabProfiles(state);
        await notifyTabProfiles(state);
    });
}

function resolveProfileSelection(provider, selection, defaults) {
    if (!selection || selection === 'default') {
        return defaults?.[provider] || null;
    }
    return selection;
}

async function validateProfileForSession(provider, profileId, { requirePing = false } = {}) {
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        const profile = findProfileById(state, profileId);
        if (!profile) {
            return { ok: false, error: 'Profile not found.' };
        }
        const validated = await validateProfile(profile);
        const index = state.profiles.findIndex(item => item.profileId === profileId);
        if (index >= 0) state.profiles[index] = validated;
        await saveTabProfiles(state);
        await notifyTabProfiles(state);
        if (validated.status !== 'ok') {
            const statusLabel = validated.status === 'offline'
                ? 'offline'
                : (validated.status === 'wrong_host' ? 'not on the right host' : 'unavailable');
            return { ok: false, error: `${validated.label} is ${statusLabel}.` };
        }
        if (requirePing) {
            const pingOk = await pingTab(validated.tabId, provider);
            if (!pingOk) {
                return { ok: false, error: `${validated.label} is not responding. Refresh the tab and try again.` };
            }
        }
        return { ok: true, profile: validated };
    });
}

async function lockProfilesForSession(sessionId, profileIds) {
    if (!sessionId || !profileIds) return;
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        let changed = false;
        for (const provider of ['chatgpt', 'gemini']) {
            const profileId = profileIds[provider];
            if (!profileId) continue;
            const profile = findProfileById(state, profileId);
            if (!profile) continue;
            if (profile.inUseBySessionId !== sessionId) {
                profile.inUseBySessionId = sessionId;
                profile.updatedAt = Date.now();
                changed = true;
            }
        }
        if (changed) {
            await saveTabProfiles(state);
            await notifyTabProfiles(state);
        }
    });
}

async function releaseProfilesForSession(sessionId) {
    if (!sessionId) return;
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        let changed = false;
        state.profiles.forEach(profile => {
            if (profile.inUseBySessionId === sessionId) {
                profile.inUseBySessionId = null;
                profile.updatedAt = Date.now();
                changed = true;
            }
        });
        if (changed) {
            await saveTabProfiles(state);
            await notifyTabProfiles(state);
        }
    });
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[MLC Background] Received message:', message);

    switch (message.type) {
        case 'SEND_PROMPT':
            handleSendPrompt(message);
            sendResponse({ status: 'received', type: message.type });
            break;
        case 'GET_TAB_PROFILES':
            notifyTabProfiles().catch(error => {
                console.error('[MLC Profiles] Error listing profiles:', error);
            });
            sendResponse({ status: 'profiles_sent', type: message.type });
            break;
        case 'GET_DEBATE_PROMPTS':
            getDebatePromptConfigForUi().then(sendResponse).catch(error => {
                console.error('[MLC Debate] Error loading prompt templates:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'SET_DEBATE_PROMPTS':
            setDebatePromptOverride(message.config).then(sendResponse).catch(error => {
                console.error('[MLC Debate] Error saving prompt templates:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'RESET_DEBATE_PROMPTS':
            clearDebatePromptOverride().then(sendResponse).catch(error => {
                console.error('[MLC Debate] Error resetting prompt templates:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'CREATE_PROFILE_FROM_ACTIVE_TAB':
            createProfileFromActiveTab(message.provider, message.label, message.profileId).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error creating profile from active tab:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'CLAIM_TAB_AS_PROFILE':
            claimTabAsProfile(message).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error claiming tab as profile:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'UPDATE_TAB_PROFILE':
            updateTabProfile(message.profileId, message.patch || {}).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error updating profile:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'DELETE_TAB_PROFILE':
            deleteTabProfile(message.profileId).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error deleting profile:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'SET_DEFAULT_PROFILE':
            setDefaultProfile(message.provider, message.profileId || null).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error setting default profile:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'FOCUS_TAB':
            focusTab(message.tabId).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error focusing tab:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'OPEN_PROVIDER_TAB':
            openProviderTab(message.provider, message).then(sendResponse).catch(error => {
                console.error('[MLC Profiles] Error opening provider tab:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'CONNECT_PROVIDER':
            connectProvider(message.provider, { focus: true }).then(sendResponse).catch((error) => {
                console.error('[MLC Profiles] Error connecting provider:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'PROVIDER_MODEL_INFO':
            if (sender?.tab?.id) {
                const provider = normalizeProvider(message.provider);
                const modelLabel = sanitizeModelHint(provider, message.modelLabel || '');
                if (modelLabel) {
                    updateProfileModelHint(sender.tab.id, provider, modelLabel);
                }
                sendMessageToPopup({
                    type: 'PROVIDER_MODEL_INFO',
                    provider,
                    tabId: sender.tab.id,
                    modelLabel
                });
            }
            sendResponse({ ok: true });
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
        case 'GET_CHATS_STATE':
            loadChatsState().then((state) => {
                sendResponse({
                    ok: true,
                    activeChatId: state.activeChatId,
                    chats: state.chats.map(toChatSummary)
                });
            }).catch((error) => {
                console.error('[MLC Chats] Error loading chats:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'GET_CHAT':
            loadChatsState().then((state) => {
                const chat = message.chatId ? findChatById(state, message.chatId) : null;
                if (!chat) {
                    sendResponse({ ok: false, error: 'Chat not found.' });
                    return;
                }
                sendResponse({ ok: true, chat });
            }).catch((error) => {
                console.error('[MLC Chats] Error loading chat:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'CREATE_CHAT':
            createChat({ makeActive: true }).then((result) => {
                sendResponse({ ok: true, chat: result.chat, activeChatId: result.state.activeChatId });
            }).catch((error) => {
                console.error('[MLC Chats] Error creating chat:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'SET_ACTIVE_CHAT':
            setActiveChat(message.chatId).then((result) => {
                if (!result.ok) {
                    sendResponse(result);
                    return;
                }
                sendResponse({ ok: true, chat: result.chat, activeChatId: result.state.activeChatId });
            }).catch((error) => {
                console.error('[MLC Chats] Error selecting chat:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'RENAME_CHAT':
            renameChat(message.chatId, message.title).then(sendResponse).catch((error) => {
                console.error('[MLC Chats] Error renaming chat:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'DELETE_CHAT':
            deleteChat(message.chatId).then(sendResponse).catch((error) => {
                console.error('[MLC Chats] Error deleting chat:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
        case 'START_DEBATE_SESSION':
            handleStartDebateSession(message).catch(error => {
                console.error('[MLC Debate] Error starting session:', error);
            });
            sendResponse({ status: 'debate_session_started', type: message.type });
            break;
        case 'RESUME_SESSION':
            resumeDebateSession().then(sendResponse).catch(error => {
                console.error('[MLC Debate] Error resuming session:', error);
                sendResponse({ ok: false, error: error.message });
            });
            return true;
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
    const requestedProfiles = message.profileIds || null;
    const requestedChatId = typeof message.chatId === 'string' ? message.chatId : null;

    if (!prompt) {
        sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: 'Prompt is empty.' });
        return;
    }

    if (activeDebateState.isActive) {
        await endDebateSession('Session replaced by a new request.');
    }

    let chatgptTab = null;
    let geminiTab = null;
    let profileIds = { chatgpt: null, gemini: null };
    const chatsState = await loadChatsState();
    const chatIdCandidate = requestedChatId || chatsState.activeChatId;
    const chat = chatIdCandidate ? findChatById(chatsState, chatIdCandidate) : null;
    const chatId = chat?.chatId || chatsState.activeChatId;
    if (chatId && chatsState.activeChatId !== chatId) {
        await setActiveChat(chatId);
    }

    const profilesState = await loadTabProfiles();
    const hasDefaultProfiles = Boolean(profilesState.defaults?.chatgpt && profilesState.defaults?.gemini);
    const hasExplicitTabIds = Number.isFinite(requestedTabs.chatgpt) || Number.isFinite(requestedTabs.gemini);
    const useProfiles = Boolean(requestedProfiles || (!hasExplicitTabIds && hasDefaultProfiles));

    if (useProfiles) {
        profileIds = {
            chatgpt: resolveProfileSelection('chatgpt', requestedProfiles?.chatgpt, profilesState.defaults),
            gemini: resolveProfileSelection('gemini', requestedProfiles?.gemini, profilesState.defaults)
        };

        if (!profileIds.chatgpt || !profileIds.gemini) {
            sendMessageToPopup({
                type: 'UI_SESSION_ERROR',
                error: 'Both ChatGPT and Gemini profiles are required to start a debate.'
            });
            return;
        }

        const chatgptValidation = await validateProfileForSession('chatgpt', profileIds.chatgpt, { requirePing: true });
        if (!chatgptValidation.ok) {
            sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: chatgptValidation.error });
            return;
        }
        const geminiValidation = await validateProfileForSession('gemini', profileIds.gemini, { requirePing: true });
        if (!geminiValidation.ok) {
            sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: geminiValidation.error });
            return;
        }
        chatgptTab = { id: chatgptValidation.profile.tabId };
        geminiTab = { id: geminiValidation.profile.tabId };
    } else {
        if (Number.isFinite(requestedTabs.chatgpt) || Number.isFinite(requestedTabs.gemini)) {
            await setPreferredTabs({
                chatgptTabId: requestedTabs.chatgpt,
                geminiTabId: requestedTabs.gemini
            });
        }

        const preferred = await getPreferredTabs();
        chatgptTab = await resolveTabForLLM('chatgpt', requestedTabs.chatgpt, preferred.chatgpt);
        geminiTab = await resolveTabForLLM('gemini', requestedTabs.gemini, preferred.gemini);

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
    }

    const now = Date.now();
    activeDebateState = {
        ...defaultDebateState,
        isActive: true,
        chatId: chatId,
        sessionId: generateSessionId(),
        rounds: rounds,
        totalTurns: rounds * 2,
        turnIndex: 1,
        firstLLM: firstLLM,
        secondLLM: secondLLM,
        profileIds: profileIds,
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
        chatId: activeDebateState.chatId,
        rounds: rounds,
        firstLLM: firstLLM,
        tabIds: activeDebateState.tabIds,
        profileIds: activeDebateState.profileIds
    });

    sendMessageToPopup({
        type: 'UI_MESSAGE_ADD',
        chatId: activeDebateState.chatId,
        role: 'user',
        content: prompt,
        timestamp: now,
        turnIndex: 0,
        sessionId: activeDebateState.sessionId
    });

    if (activeDebateState.chatId) {
        await appendChatMessage(activeDebateState.chatId, {
            role: 'user',
            content: prompt,
            timestamp: now,
            turnIndex: 0,
            sessionId: activeDebateState.sessionId
        });
    }

    await lockProfilesForSession(activeDebateState.sessionId, activeDebateState.profileIds);
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

const DEBATE_PROMPTS_PATH = 'debate_prompts.json';
const PROMPT_TEMPLATES_OVERRIDE_KEY = 'mlc_debate_prompts_override_v1';
let cachedDebatePromptConfig = null;
let cachedDebatePromptSource = null;
let debatePromptConfigLoadPromise = null;

function getDefaultDebatePromptConfig() {
    return {
        schemaVersion: 1,
        debate: {
            placeholders: {},
            header: [
                'You will participate in a multi-agent debate with {other_llm} over {rounds} iterations to produce the most accurate answer to the user.',
                '',
                'Guidelines:',
                '- Be precise and non-egoic (optimize for correctness, not for "being right").',
                '- Be constructive: critique to make progress and improve the answer.',
                '- If unsure, say so briefly and propose a way to verify.'
            ].join('\n'),
            intermediary_message: [
                'Provide a constructive improvement for iteration {round}/{rounds}:',
                '- Critique key issues (short bullets)',
                '- Revised answer'
            ].join('\n'),
            final_message: 'Provide your final best answer for the user. Output only the final answer (no critique section).',
            turn1: [
                '{header}',
                '',
                'Iteration {round}/{rounds}',
                '',
                'User question:',
                '{user_msg}',
                '',
                'Provide your best answer.'
            ].join('\n'),
            turn2: [
                '{header}',
                '',
                'Iteration {round}/{rounds}',
                '',
                'User question:',
                '{user_msg}',
                '',
                '{first_llm} answer (iteration 1/{rounds}):',
                '{first_answer}',
                '',
                '{intermediary_message}'
            ].join('\n'),
            turn3plus_first: [
                'Iteration {round}/{rounds}',
                '',
                `Here is {other_llm}'s answer for iteration {prev_round}/{rounds}:`,
                '{other_answer}',
                '',
                '{intermediary_message}'
            ].join('\n'),
            turn3plus_second: [
                'Iteration {round}/{rounds}',
                '',
                `Here is {other_llm}'s answer for iteration {round}/{rounds}:`,
                '{other_answer}',
                '',
                '{intermediary_message}'
            ].join('\n')
        }
    };
}

function normalizeDebatePromptConfig(rawConfig) {
    const defaults = getDefaultDebatePromptConfig();
    if (!rawConfig || typeof rawConfig !== 'object') return defaults;

    const rawDebate = rawConfig.debate && typeof rawConfig.debate === 'object' ? rawConfig.debate : null;
    if (!rawDebate) return defaults;

    const pickString = (value, fallback) => (typeof value === 'string' ? value : fallback);

    return {
        schemaVersion: 1,
        debate: {
            placeholders:
                rawDebate.placeholders && typeof rawDebate.placeholders === 'object'
                    ? rawDebate.placeholders
                    : defaults.debate.placeholders,
            header: pickString(rawDebate.header, defaults.debate.header),
            intermediary_message: pickString(rawDebate.intermediary_message, defaults.debate.intermediary_message),
            final_message: pickString(rawDebate.final_message, defaults.debate.final_message),
            turn1: pickString(rawDebate.turn1, defaults.debate.turn1),
            turn2: pickString(rawDebate.turn2, defaults.debate.turn2),
            turn3plus_first: pickString(rawDebate.turn3plus_first, defaults.debate.turn3plus_first),
            turn3plus_second: pickString(rawDebate.turn3plus_second, defaults.debate.turn3plus_second)
        }
    };
}

async function getDebatePromptOverride() {
    const stored = await chrome.storage.local.get(PROMPT_TEMPLATES_OVERRIDE_KEY);
    return stored?.[PROMPT_TEMPLATES_OVERRIDE_KEY] || null;
}

async function loadDebatePromptConfigFromFile() {
    try {
        const url = chrome.runtime.getURL(DEBATE_PROMPTS_PATH);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load ${DEBATE_PROMPTS_PATH}: ${response.status}`);
        }
        const json = await response.json();
        return normalizeDebatePromptConfig(json);
    } catch (error) {
        console.warn('[MLC Debate] Failed to load prompt templates; using defaults.', error);
        return getDefaultDebatePromptConfig();
    }
}

async function loadDebatePromptConfig() {
    if (cachedDebatePromptConfig) return cachedDebatePromptConfig;
    if (debatePromptConfigLoadPromise) return debatePromptConfigLoadPromise;

    debatePromptConfigLoadPromise = (async () => {
        try {
            const override = await getDebatePromptOverride();
            if (override) {
                cachedDebatePromptConfig = normalizeDebatePromptConfig(override);
                cachedDebatePromptSource = 'override';
                return cachedDebatePromptConfig;
            }
            cachedDebatePromptConfig = await loadDebatePromptConfigFromFile();
            cachedDebatePromptSource = 'default';
            return cachedDebatePromptConfig;
        } finally {
            debatePromptConfigLoadPromise = null;
        }
    })();

    return debatePromptConfigLoadPromise;
}

async function getDebatePromptConfigForUi() {
    const override = await getDebatePromptOverride();
    if (override) {
        return { ok: true, config: normalizeDebatePromptConfig(override), source: 'override' };
    }
    const config = await loadDebatePromptConfigFromFile();
    return { ok: true, config, source: 'default' };
}

async function setDebatePromptOverride(config) {
    if (!config || typeof config !== 'object') {
        return { ok: false, error: 'Invalid prompt config.' };
    }
    const normalized = normalizeDebatePromptConfig(config);
    await chrome.storage.local.set({ [PROMPT_TEMPLATES_OVERRIDE_KEY]: normalized });
    cachedDebatePromptConfig = normalized;
    cachedDebatePromptSource = 'override';
    return { ok: true, config: normalized, source: 'override' };
}

async function clearDebatePromptOverride() {
    await chrome.storage.local.remove(PROMPT_TEMPLATES_OVERRIDE_KEY);
    cachedDebatePromptConfig = null;
    cachedDebatePromptSource = null;
    return { ok: true };
}

function renderPromptTemplate(template, variables) {
    if (typeof template !== 'string') return '';
    const safeVars = variables && typeof variables === 'object' ? variables : {};
    return template.replace(/{([a-zA-Z0-9_]+)}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(safeVars, key)) return match;
        const value = safeVars[key];
        if (value === null || value === undefined) return '';
        return String(value);
    });
}

function getLastResponse(session, llmType) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role === llmType) {
            return session.messages[i].content;
        }
    }
    return '';
}

async function buildDebatePrompt(session, turnIndex) {
    const promptConfig = await loadDebatePromptConfig();
    const templates = promptConfig?.debate || getDefaultDebatePromptConfig().debate;

    const roundIndex = getRoundIndex(turnIndex);
    const expectedLLM = getTurnLLM(session, turnIndex);
    const expectedLabel = formatLLMLabel(expectedLLM);
    const otherLLM = expectedLLM === session.firstLLM ? session.secondLLM : session.firstLLM;
    const otherLabel = formatLLMLabel(otherLLM);
    const safeOtherResponse = getLastResponse(session, otherLLM) || '[No prior response captured yet]';
    const safeFirstResponse = getLastResponse(session, session.firstLLM) || '[No prior response captured yet]';

    const totalTurns = Number.isFinite(session.totalTurns) ? session.totalTurns : session.rounds * 2;
    const firstLabel = formatLLMLabel(session.firstLLM);
    const secondLabel = formatLLMLabel(session.secondLLM);
    const baseVariables = {
        rounds: session.rounds,
        iterations: session.rounds,
        round: roundIndex,
        iteration: roundIndex,
        prev_round: Math.max(0, roundIndex - 1),
        turn: turnIndex,
        turn_index: turnIndex,
        total_turns: totalTurns,
        expected_llm: expectedLabel,
        llm: expectedLabel,
        other_llm: otherLabel,
        first_llm: firstLabel,
        fisrt_llm: firstLabel,
        second_llm: secondLabel,
        user_msg: session.userQuery,
        user_query: session.userQuery,
        first_answer: safeFirstResponse,
        other_answer: safeOtherResponse,
        last_other_answer: safeOtherResponse
    };

    const header = renderPromptTemplate(templates.header, baseVariables);
    const renderedIntermediary = renderPromptTemplate(templates.intermediary_message, { ...baseVariables, header });
    const renderedFinal = renderPromptTemplate(templates.final_message, { ...baseVariables, header });
    const isFinalTurn = turnIndex === totalTurns;
    const variables = {
        ...baseVariables,
        header,
        intermediary_message: isFinalTurn ? renderedFinal : renderedIntermediary,
        final_message: renderedFinal
    };

    if (turnIndex === 1) {
        return renderPromptTemplate(templates.turn1, variables).trim();
    }

    if (turnIndex === 2) {
        return renderPromptTemplate(templates.turn2, variables).trim();
    }

    if (expectedLLM === session.firstLLM) {
        return renderPromptTemplate(templates.turn3plus_first, variables).trim();
    }

    return renderPromptTemplate(templates.turn3plus_second, variables).trim();
}

async function validateTabForProvider(tabId, provider) {
    if (!Number.isFinite(tabId)) {
        return { ok: false, error: 'Tab not set.' };
    }
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!isExpectedHost(provider, getTabUrlCandidate(tab))) {
            return { ok: false, error: 'Tab is not on the expected host.' };
        }
        return { ok: true, tabId: tab.id };
    } catch (error) {
        return { ok: false, error: 'Tab not found.' };
    }
}

async function resolveSessionTab(session, provider, { requirePing = false } = {}) {
    if (session.profileIds?.[provider]) {
        const validation = await validateProfileForSession(provider, session.profileIds[provider], { requirePing });
        if (!validation.ok) {
            return { ok: false, error: validation.error };
        }
        session.tabIds[provider] = validation.profile.tabId;
        await persistDebateState();
        return { ok: true, tabId: validation.profile.tabId };
    }

    const fallbackValidation = await validateTabForProvider(session.tabIds?.[provider], provider);
    return fallbackValidation;
}

async function pauseDebateSession(reason, provider) {
    const session = await loadActiveDebateState();
    if (!session.sessionId) return;
    session.isPaused = true;
    session.pausedReason = reason || 'Session paused.';
    session.pausedProvider = provider || null;
    session.pausedAt = Date.now();
    await persistDebateState();
    sendMessageToPopup({
        type: 'UI_SESSION_PAUSED',
        sessionId: session.sessionId,
        provider: provider || null,
        reason: session.pausedReason
    });
}

async function resumeDebateSession() {
    const session = await loadActiveDebateState();
    if (!session.sessionId || !session.isPaused) {
        return { ok: false, error: 'No paused session to resume.' };
    }
    const expectedLLM = getTurnLLM(session, session.turnIndex);
    const validation = await resolveSessionTab(session, expectedLLM, { requirePing: true });
    if (!validation.ok) {
        await pauseDebateSession(validation.error, expectedLLM);
        return { ok: false, error: validation.error };
    }
    session.isPaused = false;
    session.pausedReason = null;
    session.pausedProvider = null;
    session.pausedAt = 0;
    await persistDebateState();
    sendMessageToPopup({
        type: 'UI_SESSION_RESUMED',
        sessionId: session.sessionId
    });
    await sendDebateTurn(session);
    return { ok: true };
}

async function updateProfilesForTab(tab) {
    if (!tab || !Number.isFinite(tab.id)) return null;
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        let changed = false;
        const affected = [];
        state.profiles = state.profiles.map(profile => {
            if (profile.tabId !== tab.id) return profile;
            const urlCandidate = getTabUrlCandidate(tab);
            const status = urlCandidate
                ? (isExpectedHost(profile.provider, urlCandidate) ? 'ok' : 'wrong_host')
                : 'unknown';
            const next = {
                ...profile,
                windowId: tab.windowId,
                lastKnownTitle: tab.title || profile.lastKnownTitle || '',
                lastKnownUrl: urlCandidate || profile.lastKnownUrl || '',
                status,
                lastSeenAt: Date.now(),
                updatedAt: Date.now()
            };
            changed = true;
            affected.push(next);
            return next;
        });
        if (changed) {
            await saveTabProfiles(state);
            await notifyTabProfiles(state);
            for (const profile of affected) {
                if (profile.inUseBySessionId && profile.status !== 'ok') {
                    await pauseDebateSession(`Profile "${profile.label}" is ${profile.status}.`, profile.provider);
                }
            }
        }
        return affected;
    });
}

async function handleTabRemoved(tabId) {
    return withTabProfilesLock(async () => {
        const state = await loadTabProfiles();
        let changed = false;
        const affected = [];
        state.profiles = state.profiles.map(profile => {
            if (profile.tabId !== tabId) return profile;
            const next = {
                ...profile,
                status: 'offline',
                windowId: null,
                updatedAt: Date.now()
            };
            changed = true;
            affected.push(next);
            return next;
        });
        if (changed) {
            await saveTabProfiles(state);
            await notifyTabProfiles(state);
            for (const profile of affected) {
                if (profile.inUseBySessionId) {
                    await pauseDebateSession(`Profile "${profile.label}" went offline.`, profile.provider);
                }
            }
        }
    });
}

async function handleTabActivated(activeInfo) {
    if (!activeInfo || !Number.isFinite(activeInfo.tabId)) return;
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await updateProfilesForTab(tab);
    } catch (error) {
        // ignore
    }
}

async function handleWindowFocusChanged(windowId) {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    try {
        const [tab] = await chrome.tabs.query({ active: true, windowId });
        if (tab) {
            await updateProfilesForTab(tab);
        }
    } catch (error) {
        // ignore
    }
}

chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch(error => {
        console.warn('[MLC Profiles] Failed to handle tab removal:', error);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab || !Number.isFinite(tabId)) return;
    if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title) {
        updateProfilesForTab(tab).catch(error => {
            console.warn('[MLC Profiles] Failed to handle tab update:', error);
        });
    }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    handleTabActivated(activeInfo).catch(error => {
        console.warn('[MLC Profiles] Failed to handle tab activation:', error);
    });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
    handleWindowFocusChanged(windowId).catch(error => {
        console.warn('[MLC Profiles] Failed to handle window focus change:', error);
    });
});

async function sendDebateTurn(session) {
    if (session.isPaused) return;
    const turnIndex = session.turnIndex;
    const expectedLLM = getTurnLLM(session, turnIndex);
    const resolution = await resolveSessionTab(session, expectedLLM);
    if (!resolution.ok) {
        await pauseDebateSession(resolution.error || 'Tab validation failed.', expectedLLM);
        return;
    }

    const promptText = await buildDebatePrompt(session, turnIndex);
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
        await injectAndExecute(resolution.tabId, expectedLLM, promptText, {
            sessionId: session.sessionId,
            promptId: promptId,
            turnIndex: turnIndex
        });
    } catch (error) {
        await pauseDebateSession(error.message || 'Failed to send prompt.', expectedLLM);
    }
}

async function handleDebateResponse(message) {
    if (!message.sessionId) return;

    const session = await loadActiveDebateState();
    if (!session.isActive || session.sessionId !== message.sessionId) {
        console.log('[MLC Debate] Ignoring response: session not active or mismatch.');
        return;
    }
    if (session.isPaused && !session.lastPromptId) {
        console.log('[MLC Debate] Ignoring response while paused with no active prompt.');
        return;
    }

    const expectedLLM = session.waitingFor;
    if (message.sourceLLM && expectedLLM && message.sourceLLM !== expectedLLM) {
        console.log('[MLC Debate] Ignoring response from unexpected LLM:', message.sourceLLM);
        return;
    }

    const messageTurnIndex = Number.isFinite(message.turnIndex)
        ? message.turnIndex
        : parseInt(message.turnIndex, 10);
    const hasTurnIndex = Number.isFinite(messageTurnIndex);
    const promptMismatch = session.lastPromptId && message.promptId && session.lastPromptId !== message.promptId;
    const turnMismatch = hasTurnIndex && messageTurnIndex !== session.turnIndex;

    if (promptMismatch && (!hasTurnIndex || turnMismatch)) {
        console.log('[MLC Debate] Ignoring response with mismatched promptId/turnIndex.', {
            expectedPromptId: session.lastPromptId,
            messagePromptId: message.promptId,
            expectedTurnIndex: session.turnIndex,
            messageTurnIndex: messageTurnIndex
        });
        return;
    }

    const content = (message.content || '').trim();
    if (!content) return;
    const rawHtml = typeof message.contentHtml === 'string' ? message.contentHtml : '';
    const trimmedHtml = rawHtml.trim();
    const MAX_HTML_CHARS = 120000;
    const contentHtml = trimmedHtml && trimmedHtml.length <= MAX_HTML_CHARS
        ? rawHtml
        : '';

    const turnIndex = session.turnIndex;
    const roundIndex = getRoundIndex(turnIndex);
    const timestamp = Date.now();

    const entry = {
        role: expectedLLM || message.sourceLLM || 'assistant',
        content: content,
        timestamp: timestamp,
        turnIndex: turnIndex,
        roundIndex: roundIndex
    };
    if (contentHtml) entry.contentHtml = contentHtml;
    session.messages.push(entry);

    session.waitingFor = null;
    session.lastPromptId = null;
    session.lastPromptTimestamp = 0;

    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_MESSAGE_ADD',
        chatId: session.chatId || null,
        sessionId: session.sessionId,
        role: expectedLLM || message.sourceLLM,
        content: content,
        contentHtml: contentHtml || undefined,
        timestamp: timestamp,
        turnIndex: turnIndex,
        roundIndex: roundIndex
    });

    if (session.chatId) {
        await appendChatMessage(session.chatId, {
            role: expectedLLM || message.sourceLLM,
            content,
            contentHtml: contentHtml || undefined,
            timestamp,
            turnIndex,
            roundIndex,
            sessionId: session.sessionId
        });
    }

    if (turnIndex >= session.totalTurns) {
        await endDebateSession('Session completed.');
        return;
    }

    session.turnIndex = turnIndex + 1;
    await persistDebateState();
    if (!session.isPaused) {
        await sendDebateTurn(session);
    }
}

async function endDebateSession(reason) {
    const session = await loadActiveDebateState();
    if (!session.sessionId) return;

    session.isActive = false;
    session.isPaused = false;
    session.waitingFor = null;
    session.endedAt = Date.now();
    await persistDebateState();

    await releaseProfilesForSession(session.sessionId);

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
        content: message.content,
        contentHtml: message.contentHtml || undefined
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
        content: message.content,
        contentHtml: message.contentHtml || undefined
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

        const profilesState = await loadTabProfiles();
        const defaultProfileId = profilesState.defaults?.[llmType];
        const defaultProfile = defaultProfileId ? findProfileById(profilesState, defaultProfileId) : null;
        const preferred = await getPreferredTabs();
        const preferredId = context.tabId || defaultProfile?.tabId || preferred[llmType];

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
        const profilesState = await loadTabProfiles();
        const geminiProfile = profilesState.defaults.gemini ? findProfileById(profilesState, profilesState.defaults.gemini) : null;
        const chatgptProfile = profilesState.defaults.chatgpt ? findProfileById(profilesState, profilesState.defaults.chatgpt) : null;

        const geminiTab = geminiProfile?.tabId
            ? { id: geminiProfile.tabId }
            : await findLLMTab('gemini');
        const chatgptTab = chatgptProfile?.tabId
            ? { id: chatgptProfile.tabId }
            : await findLLMTab('chatgpt');

        console.log('[MLC Background] Gemini tab result:', geminiTab ? `Found tab ${geminiTab.id}` : 'Not found');
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
