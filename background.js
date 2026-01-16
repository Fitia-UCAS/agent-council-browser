/**
 * Multi-LLM Coder Extension - Background Service Worker
 * Handles communication with LLM websites and tab management
 */

try {
    importScripts('historyStore.js');
} catch (error) {
    console.error('[MLC History] Failed to import history store:', error);
}

try {
    importScripts('debatePromptUtils.js');
} catch (error) {
    console.error('[MLC Debate] Failed to import debate prompt utils:', error);
}

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

const HISTORY_PAGE_SIZE = 60;

function generateChatId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function toChatSummary(chat) {
    if (!chat || typeof chat !== 'object') return null;
    const chatId = chat.chatId || chat.threadId;
    if (!chatId) return null;
    return {
        chatId,
        title: chat.title || 'New chat',
        createdAt: Number.isFinite(chat.createdAt) ? chat.createdAt : null,
        updatedAt: Number.isFinite(chat.updatedAt) ? chat.updatedAt : null,
        messageCount: Number.isFinite(chat.messageCount)
            ? chat.messageCount
            : (Array.isArray(chat.messages) ? chat.messages.length : 0),
        lastPreview: typeof chat.lastPreview === 'string' ? chat.lastPreview : undefined
    };
}

async function ensureHistoryStoreReady() {
    if (!self.mlcHistoryStore) {
        const err = new Error('History store is unavailable.');
        err.code = 'HISTORY_STORE_UNAVAILABLE';
        throw err;
    }
    await self.mlcHistoryStore.openDb();
    return self.mlcHistoryStore;
}

async function getHistoryStatus() {
    const store = await ensureHistoryStoreReady();
    return store.getStatus();
}

async function requireHistoryUnlocked() {
    const store = await ensureHistoryStoreReady();
    const status = await store.getStatus();
    if (!status.configured) {
        const err = new Error('History encryption is not configured.');
        err.code = 'HISTORY_NOT_CONFIGURED';
        throw err;
    }
    if (!status.unlocked) {
        const err = new Error('History is locked.');
        err.code = 'HISTORY_LOCKED';
        throw err;
    }
    return store;
}

let historyMigrationChecked = false;
let historyMigrationPromise = null;

async function ensureLegacyChatsMigrated(store) {
    if (historyMigrationChecked) return;
    if (historyMigrationPromise) return historyMigrationPromise;

    historyMigrationPromise = (async () => {
        try {
            const version = await store.getMeta('migrationVersion');
            if (Number(version) >= 1) {
                historyMigrationChecked = true;
                return;
            }

            const stored = await chrome.storage.local.get(CHATS_KEY);
            const raw = stored?.[CHATS_KEY];
            const chats = raw && typeof raw === 'object' && Array.isArray(raw.chats) ? raw.chats : [];
            const legacyActiveChatId = raw && typeof raw === 'object' && typeof raw.activeChatId === 'string'
                ? raw.activeChatId
                : null;

            if (!chats.length) {
                await store.setMeta('migrationVersion', 1);
                historyMigrationChecked = true;
                return;
            }

            let importedChats = 0;
            let importedMessages = 0;

            for (const legacyChat of chats) {
                const chatId = typeof legacyChat?.chatId === 'string' && legacyChat.chatId
                    ? legacyChat.chatId
                    : generateChatId();

                const existing = await store.getThreadSummary(chatId);
                if (existing) continue;

                const createdAt = Number.isFinite(legacyChat?.createdAt) ? legacyChat.createdAt : Date.now();
                const updatedAt = Number.isFinite(legacyChat?.updatedAt) ? legacyChat.updatedAt : createdAt;
                const titleRaw = typeof legacyChat?.title === 'string' ? legacyChat.title : 'New chat';
                const title = titleRaw.trim() ? titleRaw : 'New chat';
                const titleIsDefault = title === 'New chat';

                try {
                    await store.createThread({
                        threadId: chatId,
                        title,
                        createdAt,
                        updatedAt,
                        titleIsDefault
                    });
                    importedChats += 1;
                } catch (error) {
                    console.warn('[MLC History] Failed to create thread during migration:', error);
                    continue;
                }

                const messages = Array.isArray(legacyChat?.messages) ? legacyChat.messages : [];
                for (const legacyMessage of messages) {
                    const content = String(legacyMessage?.content || '');
                    if (!content.trim()) continue;
                    const role = legacyMessage?.role || 'assistant';
                    const timestamp = Number.isFinite(legacyMessage?.timestamp) ? legacyMessage.timestamp : Date.now();
                    const contentHtml = typeof legacyMessage?.contentHtml === 'string' ? legacyMessage.contentHtml : undefined;
                    try {
                        await store.appendMessage(chatId, {
                            role,
                            content,
                            contentHtml,
                            timestamp,
                            sessionId: legacyMessage?.sessionId || undefined,
                            turnIndex: Number.isFinite(legacyMessage?.turnIndex) ? legacyMessage.turnIndex : undefined,
                            roundIndex: Number.isFinite(legacyMessage?.roundIndex) ? legacyMessage.roundIndex : undefined
                        });
                        importedMessages += 1;
                    } catch (error) {
                        console.warn('[MLC History] Failed to migrate message:', error);
                    }
                }
            }

            const currentActive = await store.getActiveThreadId();
            if (!currentActive && legacyActiveChatId) {
                const migratedActive = await store.getThreadSummary(legacyActiveChatId);
                if (migratedActive) {
                    await store.setActiveThreadId(legacyActiveChatId);
                }
            }

            await store.setMeta('migrationVersion', 1);
            historyMigrationChecked = true;
            console.log('[MLC History] Migration complete.', { importedChats, importedMessages });
        } catch (error) {
            console.error('[MLC History] Migration failed:', error);
        }
    })().finally(() => {
        historyMigrationPromise = null;
    });

    return historyMigrationPromise;
}

async function loadChatsState({ ensureActive = true } = {}) {
    const store = await requireHistoryUnlocked();
    await ensureLegacyChatsMigrated(store);
    const { threads } = await store.listThreads({ limit: 250 });
    let activeChatId = await store.getActiveThreadId();
    const hasActive = activeChatId && threads.some(thread => thread.chatId === activeChatId);

    if (!ensureActive) {
        return { activeChatId: hasActive ? activeChatId : null, chats: threads };
    }

    if (!threads.length) {
        const chatId = generateChatId();
        await store.createThread({ threadId: chatId, title: 'New chat', titleIsDefault: true });
        await store.setActiveThreadId(chatId);
        const refreshed = await store.listThreads({ limit: 250 });
        return { activeChatId: chatId, chats: refreshed.threads };
    }

    if (!hasActive) {
        activeChatId = threads[0].chatId;
        await store.setActiveThreadId(activeChatId);
    }

    return { activeChatId, chats: threads };
}

async function notifyChatsState(stateOverride = null) {
    try {
        const state = stateOverride || await loadChatsState();
        sendMessageToPopup({
            type: 'CHATS_STATE',
            activeChatId: state.activeChatId,
            chats: state.chats
        });
    } catch (error) {
        const status = await getHistoryStatus().catch(() => ({ configured: false, unlocked: false }));
        sendMessageToPopup({ type: 'HISTORY_STATUS', status, error: error?.message });
    }
}

async function createChat({ makeActive = true } = {}) {
    const store = await requireHistoryUnlocked();
    const chatId = generateChatId();
    await store.createThread({ threadId: chatId, title: 'New chat', titleIsDefault: true });
    if (makeActive) {
        await store.setActiveThreadId(chatId);
    }
    const chat = await store.getThreadSummary(chatId);
    const state = await loadChatsState({ ensureActive: false });
    await notifyChatsState(state);
    return {
        ok: true,
        chat: { ...chat, messages: [] },
        state: { ...state, activeChatId: makeActive ? chatId : state.activeChatId }
    };
}

async function setActiveChat(chatId) {
    const store = await requireHistoryUnlocked();
    const chat = await store.getThreadSummary(chatId);
    if (!chat) {
        return { ok: false, error: 'Chat not found.', code: 'CHAT_NOT_FOUND' };
    }
    await store.setActiveThreadId(chatId);
    const state = await loadChatsState({ ensureActive: false });
    await notifyChatsState(state);
    return { ok: true, chat: { ...chat, messages: [] }, state };
}

async function renameChat(chatId, title) {
    const store = await requireHistoryUnlocked();
    try {
        const updated = await store.renameThread(chatId, title);
        await notifyChatsState();
        return { ok: true, chat: updated };
    } catch (error) {
        return { ok: false, error: error.message, code: error.code || 'RENAME_FAILED' };
    }
}

async function deleteChat(chatId) {
    const store = await requireHistoryUnlocked();
    const chat = await store.getThreadSummary(chatId);
    if (!chat) return { ok: false, error: 'Chat not found.', code: 'CHAT_NOT_FOUND' };

    await store.deleteThread(chatId);
    try {
        await store.deleteMeta(getChatDeliveryStateKey(chatId));
    } catch (error) {
        // ignore
    }
    deliveryStateCache.delete(chatId);
    const activeChatId = await store.getActiveThreadId();
    if (activeChatId === chatId) {
        const { threads } = await store.listThreads({ limit: 1 });
        await store.setActiveThreadId(threads[0]?.chatId || null);
    }
    const state = await loadChatsState({ ensureActive: true });
    await notifyChatsState(state);
    return { ok: true, state };
}

async function appendChatMessage(chatId, message) {
    if (!chatId || !message) return { ok: false, error: 'Missing chatId or message.' };
    try {
        const store = await requireHistoryUnlocked();
        const provider = isSupportedProviderKey(message.role) ? message.role : null;
        const saved = await store.appendMessage(chatId, { ...message, provider });
        await notifyChatsState();
        return { ok: true, message: saved };
    } catch (error) {
        console.warn('[MLC Chats] Failed to persist message:', error);
        return { ok: false, error: error.message, code: error.code || 'APPEND_MESSAGE_FAILED' };
    }
}

const defaultDebateState = {
    isActive: false,
    isPaused: false,
    pausedReason: null,
    pausedProvider: null,
    pausedAt: 0,
    mode: 'debate',
    route: null,
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
    isFollowUp: false,
    conversationContext: '',
    promptOverrides: null,
    userMessageSequence: null,
    messages: [],
    waitingFor: null,
    parallelPromptIds: null,
    lastPromptId: null,
    lastPromptTimestamp: 0,
    startedAt: 0,
    endedAt: 0
};

let activeDebateState = { ...defaultDebateState };
let debateResponseChain = Promise.resolve();

function enqueueDebateResponse(message, label) {
    debateResponseChain = debateResponseChain
        .then(() => handleDebateResponse(message))
        .catch((error) => {
            console.error(`[MLC Debate] Error handling ${label || 'response'}:`, error);
        });
}

// Attachment payloads are intentionally kept out of chrome.storage.local (quota + privacy).
// They live in-memory for the active session only and are cleared once delivered.
// sentTo: attachments have been accounted for that provider (uploaded+sent, or intentionally skipped).
// preparedTo: attachments have been pre-attached to the provider UI but not necessarily sent yet.
let activeSessionAttachments = null; // { sessionId, attachments: [...], sentTo: { [provider]: boolean }, preparedTo: { [provider]: boolean } }

function normalizeProviderKey(provider) {
    return String(provider || '').trim().toLowerCase();
}

function getSupportedProviderKeys() {
    const capabilities = PROVIDER_CAPABILITIES && typeof PROVIDER_CAPABILITIES === 'object'
        ? Object.keys(PROVIDER_CAPABILITIES)
        : [];
    const normalized = capabilities.map(normalizeProviderKey).filter(Boolean);
    return [...new Set(normalized)];
}

function isSupportedProviderKey(provider) {
    const key = normalizeProviderKey(provider);
    if (!key) return false;
    return getSupportedProviderKeys().includes(key);
}

function initProviderFlagMap(providers, initialValue) {
    const map = {};
    if (!Array.isArray(providers)) return map;
    for (const provider of providers) {
        const key = normalizeProviderKey(provider);
        if (!key || Object.prototype.hasOwnProperty.call(map, key)) continue;
        map[key] = Boolean(initialValue);
    }
    return map;
}

function listSessionProviders(session, fallbackProvider) {
    const ordered = [];
    const push = (provider) => {
        const key = normalizeProviderKey(provider);
        if (!key || !isSupportedProviderKey(key)) return;
        if (!ordered.includes(key)) ordered.push(key);
    };
    push(session?.firstLLM);
    push(session?.secondLLM);
    push(fallbackProvider);
    return ordered;
}

function getSessionProviders(session, fallbackProvider) {
    const ordered = [];
    const push = (provider) => {
        const key = normalizeProviderKey(provider);
        if (!key || !isSupportedProviderKey(key)) return;
        if (!ordered.includes(key)) ordered.push(key);
    };

    const routeProviders = Array.isArray(session?.route?.providers) ? session.route.providers : [];
    routeProviders.forEach(push);
    listSessionProviders(session, fallbackProvider).forEach(push);
    return ordered;
}

function stripDataUrlPrefix(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    if (!raw.startsWith('data:')) return raw;
    const comma = raw.indexOf(',');
    return comma === -1 ? '' : raw.slice(comma + 1);
}

function estimateBytesFromBase64(base64) {
    if (!base64) return 0;
    const cleaned = base64.replace(/\s+/g, '');
    const padding = cleaned.endsWith('==') ? 2 : (cleaned.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
}

function normalizeIncomingAttachments(input) {
    if (!Array.isArray(input) || input.length === 0) return [];
    const MAX_FILES = 10;
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

    const output = [];
    let totalBytes = 0;

    for (const raw of input.slice(0, MAX_FILES)) {
        if (!raw || typeof raw !== 'object') continue;
        const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'attachment';
        const type = typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim() : 'application/octet-stream';
        const base64 = stripDataUrlPrefix(raw.base64);
        if (!base64) continue;
        const size = Number.isFinite(raw.size) ? raw.size : estimateBytesFromBase64(base64);
        if (!Number.isFinite(size) || size <= 0) continue;
        if (totalBytes + size > MAX_TOTAL_BYTES) break;
        totalBytes += size;
        output.push({
            name,
            type,
            size,
            lastModified: Number.isFinite(raw.lastModified) ? raw.lastModified : Date.now(),
            base64
        });
    }

    return output;
}

function setActiveSessionAttachments(sessionId, attachments, providers = null) {
    const sanitized = normalizeIncomingAttachments(attachments);
    if (!sessionId || sanitized.length === 0) {
        activeSessionAttachments = null;
        return;
    }
    activeSessionAttachments = {
        sessionId,
        attachments: sanitized,
        sentTo: initProviderFlagMap(providers, false),
        preparedTo: initProviderFlagMap(providers, false)
    };
}

function hasSessionAttachments(sessionId) {
    return Boolean(
        activeSessionAttachments &&
        activeSessionAttachments.sessionId === sessionId &&
        Array.isArray(activeSessionAttachments.attachments) &&
        activeSessionAttachments.attachments.length > 0
    );
}

function getPendingSessionAttachments(sessionId, provider, { includePrepared = false } = {}) {
    if (!activeSessionAttachments || activeSessionAttachments.sessionId !== sessionId) return null;
    const normalizedProvider = normalizeProviderKey(provider);
    if (!normalizedProvider) return null;
    if (activeSessionAttachments.sentTo?.[normalizedProvider]) return null;
    if (!includePrepared && activeSessionAttachments.preparedTo?.[normalizedProvider]) return null;
    return activeSessionAttachments.attachments || null;
}

function markSessionAttachmentsPrepared(session, provider) {
    if (!session?.sessionId || !activeSessionAttachments || activeSessionAttachments.sessionId !== session.sessionId) return;
    const normalizedProvider = normalizeProviderKey(provider);
    if (!normalizedProvider) return;
    if (!activeSessionAttachments.preparedTo || typeof activeSessionAttachments.preparedTo !== 'object') {
        activeSessionAttachments.preparedTo = {};
    }
    activeSessionAttachments.preparedTo[normalizedProvider] = true;
    if (!activeSessionAttachments.sentTo || typeof activeSessionAttachments.sentTo !== 'object') {
        activeSessionAttachments.sentTo = {};
    }
    if (typeof activeSessionAttachments.sentTo[normalizedProvider] !== 'boolean') {
        activeSessionAttachments.sentTo[normalizedProvider] = false;
    }
}

function markSessionAttachmentsSent(session, provider) {
    if (!session?.sessionId || !activeSessionAttachments || activeSessionAttachments.sessionId !== session.sessionId) return;
    const normalizedProvider = normalizeProviderKey(provider);
    if (!normalizedProvider) return;
    if (!activeSessionAttachments.sentTo || typeof activeSessionAttachments.sentTo !== 'object') {
        activeSessionAttachments.sentTo = {};
    }
    activeSessionAttachments.sentTo[normalizedProvider] = true;
    if (!activeSessionAttachments.preparedTo || typeof activeSessionAttachments.preparedTo !== 'object') {
        activeSessionAttachments.preparedTo = {};
    }
    activeSessionAttachments.preparedTo[normalizedProvider] = true;

    const requiredProviders = getSessionProviders(session, normalizedProvider);
    const allSent = requiredProviders.every((p) => activeSessionAttachments.sentTo?.[p]);
    if (allSent) {
        activeSessionAttachments = null;
    }
}

function clearSessionAttachments(sessionId) {
    if (!activeSessionAttachments) return;
    if (!sessionId || activeSessionAttachments.sessionId === sessionId) {
        activeSessionAttachments = null;
    }
}

function notifyAttachmentFallback(session, provider) {
    const sessionId = session?.sessionId || null;
    if (!sessionId) return;
    const label = formatLLMLabel(provider);
    const timestamp = Date.now();
    const content = `Attachment upload failed for ${label}. Sent this message without files. If ${label} needs the file, attach it manually in the ${label} tab and resend.`;
    sendMessageToPopup({
        type: 'UI_MESSAGE_ADD',
        chatId: session?.chatId || null,
        sessionId,
        role: 'system',
        content,
        timestamp
    });
}

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
        if (!['debate', 'single', 'direct', 'parallel'].includes(activeDebateState.mode)) {
            activeDebateState.mode = 'debate';
        }
        if (typeof activeDebateState.isFollowUp !== 'boolean') {
            activeDebateState.isFollowUp = false;
        }
        if (typeof activeDebateState.conversationContext !== 'string') {
            activeDebateState.conversationContext = '';
        }
        if (!Number.isFinite(activeDebateState.userMessageSequence)) {
            activeDebateState.userMessageSequence = null;
        }
        if (!activeDebateState.promptOverrides || typeof activeDebateState.promptOverrides !== 'object') {
            activeDebateState.promptOverrides = null;
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
    const key = normalizeProviderKey(provider);
    if (key && isSupportedProviderKey(key)) return key;
    // Preserve legacy behavior: unknown providers map to ChatGPT.
    return 'chatgpt';
}

function getTabUrlCandidate(tab) {
    if (!tab) return '';
    if (typeof tab.url === 'string' && tab.url) return tab.url;
    if (typeof tab.pendingUrl === 'string' && tab.pendingUrl) return tab.pendingUrl;
    return '';
}

function getEmptyProfilesState() {
    const defaults = {};
    for (const provider of getSupportedProviderKeys()) {
        defaults[provider] = null;
    }
    // Backward compatibility (older code expects these keys to exist).
    if (!Object.prototype.hasOwnProperty.call(defaults, 'chatgpt')) defaults.chatgpt = null;
    if (!Object.prototype.hasOwnProperty.call(defaults, 'gemini')) defaults.gemini = null;
    return { profiles: [], defaults };
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
    const normalized = normalizeProvider(provider);
    const hosts = PROVIDER_METADATA?.[normalized]?.expectedHosts;
    if (Array.isArray(hosts) && hosts.length > 0) return hosts;
    return PROVIDER_METADATA.chatgpt.expectedHosts;
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
            const baseDefaults = getEmptyProfilesState().defaults;
            const storedDefaults = next.defaults && typeof next.defaults === 'object' ? next.defaults : {};
            const defaults = { ...baseDefaults };
            for (const [provider, profileId] of Object.entries(storedDefaults)) {
                const key = normalizeProviderKey(provider);
                if (!key) continue;
                if (!Object.prototype.hasOwnProperty.call(defaults, key)) continue;
                defaults[key] = profileId || null;
            }
            const state = { profiles: next.profiles, defaults };
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
    const base = formatLLMLabel(provider);
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
            return { ok: false, error: `Selected tab is not a valid ${formatLLMLabel(normalizedProvider)} tab.` };
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
        for (const provider of Object.keys(state.defaults || {})) {
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
    const url = PROVIDER_METADATA?.[normalizedProvider]?.openUrl || PROVIDER_METADATA.chatgpt.openUrl;
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
    const label = formatLLMLabel(normalizedProvider);
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
        for (const [provider, profileId] of Object.entries(profileIds || {})) {
            const normalizedProvider = normalizeProvider(provider);
            if (!profileId || !normalizedProvider) continue;
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
        case 'GET_PROVIDER_CAPABILITIES':
            sendResponse({ ok: true, capabilities: PROVIDER_CAPABILITIES });
            break;
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
            enqueueDebateResponse(message, 'Gemini response');
            handleGeminiResponse(message);
            sendResponse({ status: 'gemini_response_received', type: message.type });
            break;
        case 'CHATGPT_RESPONSE_CAPTURED':
            enqueueDebateResponse(message, 'ChatGPT response');
            handleChatGPTResponse(message);
            sendResponse({ status: 'chatgpt_response_received', type: message.type });
            break;
        case 'CLAUDE_RESPONSE_CAPTURED':
            enqueueDebateResponse(message, 'Claude response');
            handleClaudeResponse(message);
            sendResponse({ status: 'claude_response_received', type: message.type });
            break;
        case 'GROK_RESPONSE_CAPTURED':
            enqueueDebateResponse(message, 'Grok response');
            handleGrokResponse(message);
            sendResponse({ status: 'grok_response_received', type: message.type });
            break;
        case 'MLC_RESPONSE_CAPTURED':
            enqueueDebateResponse(message, 'response');
            sendResponse({ status: 'mlc_response_received', type: message.type });
            break;
        case 'MULTI_AGENT_RESPONSE_CAPTURED':
            enqueueDebateResponse(message, 'multi-agent response');
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
        case 'HISTORY_STATUS':
            getHistoryStatus().then((status) => {
                sendResponse({ ok: true, status });
            }).catch((error) => {
                sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_STATUS_FAILED' });
            });
            return true;
        case 'HISTORY_CONFIGURE':
            ensureHistoryStoreReady().then((store) => store.configureEncryption(message.passphrase)).then((status) => {
                sendResponse({ ok: true, status });
                notifyChatsState().catch(() => {});
            }).catch((error) => {
                sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_CONFIGURE_FAILED' });
            });
            return true;
        case 'HISTORY_UNLOCK':
            ensureHistoryStoreReady().then((store) => store.unlock(message.passphrase)).then((status) => {
                sendResponse({ ok: true, status });
                notifyChatsState().catch(() => {});
            }).catch((error) => {
                sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_UNLOCK_FAILED' });
            });
            return true;
        case 'HISTORY_LOCK':
            ensureHistoryStoreReady().then((store) => store.lock()).then((status) => {
                sendResponse({ ok: true, status });
                notifyChatsState().catch(() => {});
            }).catch((error) => {
                sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_LOCK_FAILED' });
            });
            return true;
        case 'HISTORY_RESET':
            ensureHistoryStoreReady()
                .then((store) => store.resetAllData())
                .then(() => new Promise((resolve) => chrome.storage.local.remove(CHATS_KEY, resolve)))
                .then(() => {
                    historyMigrationChecked = false;
                    historyMigrationPromise = null;
                    deliveryStateCache.clear();
                })
                .then(() => getHistoryStatus())
                .then((status) => {
                    sendResponse({ ok: true, status });
                    notifyChatsState().catch(() => {});
                })
                .catch((error) => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'HISTORY_RESET_FAILED' });
                });
            return true;
        case 'GET_CHATS_STATE':
            loadChatsState().then((state) => {
                sendResponse({
                    ok: true,
                    activeChatId: state.activeChatId,
                    chats: state.chats
                });
            }).catch((error) => {
                console.error('[MLC Chats] Error loading chats:', error);
                getHistoryStatus().then((status) => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHATS_FAILED', status });
                }).catch(() => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHATS_FAILED' });
                });
            });
            return true;
        case 'GET_CHAT':
            requireHistoryUnlocked().then((store) => {
                const chatId = message.chatId;
                return store.getThreadWithMessages(chatId, { limit: HISTORY_PAGE_SIZE });
            }).then(({ thread, page }) => {
                sendResponse({
                    ok: true,
                    chat: {
                        chatId: thread.chatId,
                        title: thread.title,
                        createdAt: thread.createdAt,
                        updatedAt: thread.updatedAt,
                        messageCount: thread.messageCount,
                        lastPreview: thread.lastPreview,
                        messages: page.messages,
                        nextCursorSequence: page.nextCursorSequence,
                        hasMore: page.hasMore
                    }
                });
            }).catch((error) => {
                console.error('[MLC Chats] Error loading chat:', error);
                getHistoryStatus().then((status) => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHAT_FAILED', status });
                }).catch(() => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'GET_CHAT_FAILED' });
                });
            });
            return true;
        case 'GET_MESSAGES_PAGE':
            requireHistoryUnlocked().then((store) => {
                const chatId = message.chatId;
                const limit = Number.isFinite(message.limit) ? message.limit : HISTORY_PAGE_SIZE;
                const beforeSequence = Number.isFinite(message.beforeSequence) ? message.beforeSequence : null;
                return store.listMessages(chatId, { limit, beforeSequence });
            }).then((page) => {
                sendResponse({ ok: true, ...page });
            }).catch((error) => {
                console.error('[MLC Chats] Error listing messages:', error);
                sendResponse({ ok: false, error: error.message, code: error.code || 'GET_MESSAGES_FAILED' });
            });
            return true;
        case 'CREATE_CHAT':
            createChat({ makeActive: true }).then((result) => {
                sendResponse({ ok: true, chat: result.chat, activeChatId: result.state.activeChatId });
            }).catch((error) => {
                console.error('[MLC Chats] Error creating chat:', error);
                getHistoryStatus().then((status) => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'CREATE_CHAT_FAILED', status });
                }).catch(() => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'CREATE_CHAT_FAILED' });
                });
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
                getHistoryStatus().then((status) => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'SET_ACTIVE_CHAT_FAILED', status });
                }).catch(() => {
                    sendResponse({ ok: false, error: error.message, code: error.code || 'SET_ACTIVE_CHAT_FAILED' });
                });
            });
            return true;
        case 'RENAME_CHAT':
            renameChat(message.chatId, message.title).then(sendResponse).catch((error) => {
                console.error('[MLC Chats] Error renaming chat:', error);
                sendResponse({ ok: false, error: error.message, code: error.code || 'RENAME_CHAT_FAILED' });
            });
            return true;
        case 'DELETE_CHAT':
            deleteChat(message.chatId).then(sendResponse).catch((error) => {
                console.error('[MLC Chats] Error deleting chat:', error);
                sendResponse({ ok: false, error: error.message, code: error.code || 'DELETE_CHAT_FAILED' });
            });
            return true;
        case 'START_DEBATE_SESSION':
            handleStartDebateSession(message).catch(error => {
                console.error('[MLC Debate] Error starting session:', error);
            });
            sendResponse({ status: 'debate_session_started', type: message.type });
            break;
        case 'START_RUN':
            handleStartDebateSession(message).catch(error => {
                console.error('[MLC Session] Error starting run:', error);
            });
            sendResponse({ status: 'run_started', type: message.type });
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

function sanitizeSessionPromptOverrides(input) {
    if (!input || typeof input !== 'object') return null;
    const allowedKeys = new Set([
        'header',
        'first_turn_instruction',
        'intermediary_message',
        'final_message',
        'followup_user_msg_wrapper'
    ]);
    const output = {};
    for (const modeKey of ['debate', 'single']) {
        const section = input[modeKey];
        if (!section || typeof section !== 'object') continue;
        const sanitized = {};
        for (const [key, value] of Object.entries(section)) {
            if (!allowedKeys.has(key)) continue;
            if (typeof value !== 'string') continue;
            sanitized[key] = value;
        }
        if (Object.keys(sanitized).length > 0) {
            output[modeKey] = sanitized;
        }
    }
    return Object.keys(output).length > 0 ? output : null;
}

function sanitizeUiRoute(input) {
    if (!input || typeof input !== 'object') return null;
    const kind = typeof input.kind === 'string' ? input.kind.toLowerCase() : '';
    const rawProviders = Array.isArray(input.providers) ? input.providers : [];
    const providers = [];
    for (const item of rawProviders) {
        const normalized = normalizeProviderKey(item);
        if (!normalized || !isSupportedProviderKey(normalized)) continue;
        if (!providers.includes(normalized)) providers.push(normalized);
    }
    if (providers.length === 0) return null;
    const rounds = Math.min(12, Math.max(1, parseInt(input.rounds, 10) || 1));

    if (kind === 'debate') {
        if (providers.length < 2) return null;
        return { kind: 'debate', providers, rounds };
    }

    if (kind === 'parallel') {
        if (providers.length < 2) return null;
        return { kind: 'parallel', providers, rounds: 1 };
    }

    return { kind: 'single', providers: [providers[0]], rounds: 1 };
}

function buildRouteFromRun(mode, { firstLLM, secondLLM, directTarget, rounds }) {
    if (mode === 'debate') {
        const first = firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
        const second = first === 'chatgpt' ? 'gemini' : 'chatgpt';
        return { kind: 'debate', providers: [first, second], rounds };
    }
    if (mode === 'direct' && directTarget === 'both') {
        return { kind: 'parallel', providers: ['chatgpt', 'gemini'], rounds: 1 };
    }
    const provider = firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
    return { kind: 'single', providers: [provider], rounds: 1 };
}

async function handleStartDebateSession(message) {
    try {
        const prompt = (message.prompt || '').trim();
        const baseMode = message.mode === 'direct'
            ? 'direct'
            : (message.mode === 'single' ? 'single' : 'debate');
        let mode = baseMode;
        const directTarget = message.target === 'both'
            ? 'both'
            : (message.target === 'gemini' ? 'gemini' : 'chatgpt');
        const rounds = baseMode === 'debate' || baseMode === 'single'
            ? Math.min(12, Math.max(1, parseInt(message.rounds, 10) || 1))
            : 1;
        const singleLLM = message.llm === 'gemini' ? 'gemini' : 'chatgpt';
        const debateFirstLLM = message.firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
        let [firstLLM, secondLLM] = baseMode === 'debate'
            ? [debateFirstLLM, debateFirstLLM === 'chatgpt' ? 'gemini' : 'chatgpt']
            : (baseMode === 'single'
                ? [singleLLM, null]
                : (directTarget === 'both'
                    ? ['chatgpt', 'gemini']
                    : [directTarget, null]));
        const route = sanitizeUiRoute(message.route) || buildRouteFromRun(baseMode, { firstLLM, secondLLM, directTarget, rounds });
        if (route?.kind === 'parallel') {
            mode = 'parallel';
        } else if (route?.kind === 'debate') {
            mode = 'debate';
        }
        if (Array.isArray(route?.providers) && route.providers.length > 0) {
            firstLLM = route.providers[0] || firstLLM;
            secondLLM = route.providers.length > 1 ? route.providers[1] : null;
        }
        const requestedTabs = message.tabIds || {};
        const requestedProfiles = message.profileIds || null;
        const requestedChatId = typeof message.chatId === 'string' ? message.chatId : null;
        const promptOverrides = sanitizeSessionPromptOverrides(message.promptOverrides);

        if (!prompt) {
            sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: 'Prompt is empty.' });
            return;
        }

	        let historyStore = null;
	        try {
	            historyStore = await requireHistoryUnlocked();
	        } catch (error) {
	            historyStore = null;
	        }

	        if (activeDebateState.isActive) {
	            await endDebateSession('Session replaced by a new request.');
	        }

	        const profileIds = {};
	        const tabIds = {};
	        for (const provider of getSupportedProviderKeys()) {
	            profileIds[provider] = null;
	            tabIds[provider] = null;
	        }
	        let chatId = null;
	        if (historyStore) {
	            const chatsState = await loadChatsState();
	            const chatIdCandidate = requestedChatId || chatsState.activeChatId;
	            const hasCandidate = chatIdCandidate && Array.isArray(chatsState.chats)
	                ? chatsState.chats.some((chat) => chat.chatId === chatIdCandidate)
	                : false;
	            chatId = hasCandidate ? chatIdCandidate : chatsState.activeChatId;
	            if (chatId && chatsState.activeChatId !== chatId) {
	                await setActiveChat(chatId);
	            }
	        }

        let isFollowUp = false;
        let conversationContext = '';
        if (historyStore && chatId) {
            try {
                const summary = await historyStore.getThreadSummary(chatId);
                const priorCount = Number.isFinite(summary?.messageCount) ? summary.messageCount : 0;
                isFollowUp = priorCount > 0;
                if (isFollowUp) {
                    const page = await historyStore.listMessages(chatId, { limit: 12 });
                    conversationContext = buildConversationContext(page.messages, { maxChars: 4000, maxMessages: 10 });
                }
            } catch (error) {
                console.warn('[MLC Debate] Failed to build conversation context:', error);
            }
        }

        const profilesState = await loadTabProfiles();
        const requiredProviders = Array.isArray(route?.providers) && route.providers.length > 0
            ? route.providers
            : (secondLLM ? ['chatgpt', 'gemini'] : [firstLLM]);
        const hasDefaultProfiles = requiredProviders.every((provider) => Boolean(profilesState.defaults?.[provider]));
        const hasExplicitTabIds = requiredProviders.some((provider) => Number.isFinite(requestedTabs[provider]));
        const hasRequestedProfiles = Boolean(requestedProfiles && requiredProviders.some((provider) => requestedProfiles?.[provider]));
        const useProfiles = Boolean(hasRequestedProfiles || (!hasExplicitTabIds && hasDefaultProfiles));

        if (useProfiles) {
            for (const provider of requiredProviders) {
                profileIds[provider] = resolveProfileSelection(provider, requestedProfiles?.[provider], profilesState.defaults);
                if (!profileIds[provider]) {
                    sendMessageToPopup({
                        type: 'UI_SESSION_ERROR',
                        error: `${formatLLMLabel(provider)} profile is required to start.`
                    });
                    return;
                }
                const validation = await validateProfileForSession(provider, profileIds[provider], { requirePing: true });
                if (!validation.ok) {
                    sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: validation.error });
                    return;
                }
                tabIds[provider] = validation.profile.tabId;
            }
        } else {
            if (mode === 'single') {
                if (firstLLM === 'chatgpt' && Number.isFinite(requestedTabs.chatgpt)) {
                    await setPreferredTabs({ chatgptTabId: requestedTabs.chatgpt });
                } else if (firstLLM === 'gemini' && Number.isFinite(requestedTabs.gemini)) {
                    await setPreferredTabs({ geminiTabId: requestedTabs.gemini });
                }
            } else if (Number.isFinite(requestedTabs.chatgpt) || Number.isFinite(requestedTabs.gemini)) {
                await setPreferredTabs({
                    chatgptTabId: requestedTabs.chatgpt,
                    geminiTabId: requestedTabs.gemini
                });
            }

            const preferred = await getPreferredTabs();
            for (const provider of requiredProviders) {
                const resolved = await resolveTabForLLM(provider, requestedTabs[provider], preferred[provider]);
                if (!resolved) {
                    sendMessageToPopup({
                        type: 'UI_SESSION_ERROR',
                        error: `${formatLLMLabel(provider)} tab not found. Please open it and try again.`
                    });
                    return;
                }
                tabIds[provider] = resolved.id;
            }
        }

        const now = Date.now();
        let runConfig = mode === 'parallel'
            ? { runType: 'parallel', providers: requiredProviders }
            : (mode === 'direct'
                ? { runType: 'direct', target: directTarget }
                : (mode === 'single'
                    ? { mode: 'single', rounds, llm: firstLLM }
                    : { runType: 'debate', rounds, firstLLM }));
        if (route) {
            runConfig = { ...runConfig, route };
        }
        const totalTurns = mode === 'parallel'
            ? 1
            : (mode === 'direct'
                ? (secondLLM ? 2 : 1)
                : (mode === 'single'
                    ? rounds
                    : (mode === 'debate'
                        ? rounds * (Array.isArray(route?.providers) && route.providers.length >= 2
                            ? route.providers.length
                            : (secondLLM ? 2 : 1))
                        : rounds * 2)));
        const sessionId = generateSessionId();
        activeDebateState = {
            ...defaultDebateState,
            isActive: true,
            mode,
            route: route || null,
            chatId: chatId,
            sessionId,
            rounds: rounds,
            totalTurns,
            turnIndex: 1,
            firstLLM: firstLLM,
            secondLLM: secondLLM,
            profileIds: profileIds,
            tabIds,
            userQuery: prompt,
            isFollowUp,
            conversationContext,
            promptOverrides,
            messages: [{ role: 'user', content: prompt, timestamp: now, turnIndex: 0 }],
            startedAt: now
        };

        setActiveSessionAttachments(sessionId, message.attachments, requiredProviders);
        const attachmentsMeta = activeSessionAttachments?.sessionId === sessionId
            ? activeSessionAttachments.attachments.map(({ name, type, size }) => ({ name, type, size }))
            : null;

        await persistDebateState();

        sendMessageToPopup({
            type: 'UI_SESSION_STARTED',
            sessionId: activeDebateState.sessionId,
            chatId: activeDebateState.chatId,
            rounds: rounds,
            mode,
            firstLLM: firstLLM,
            target: mode === 'direct' ? directTarget : undefined,
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
            sessionId: activeDebateState.sessionId,
            meta: { runConfig, isFollowUp, promptOverrides, attachments: attachmentsMeta || undefined }
        });

        if (activeDebateState.chatId) {
            const appendResult = await appendChatMessage(activeDebateState.chatId, {
                role: 'user',
                content: prompt,
                timestamp: now,
                turnIndex: 0,
                sessionId: activeDebateState.sessionId,
                meta: { runConfig, isFollowUp, promptOverrides, attachments: attachmentsMeta || undefined }
            });
            if (appendResult?.ok && Number.isFinite(appendResult?.message?.sequence)) {
                activeDebateState.userMessageSequence = appendResult.message.sequence;
                await persistDebateState();
            }
        }

        await lockProfilesForSession(activeDebateState.sessionId, activeDebateState.profileIds);
        if (activeDebateState.mode === 'parallel') {
            await sendParallelTurn(activeDebateState);
        } else {
            await sendDebateTurn(activeDebateState);
        }
    } catch (error) {
        console.error('[MLC Debate] Error starting session:', error);
        sendMessageToPopup({ type: 'UI_SESSION_ERROR', error: error?.message || 'Failed to start session.' });
    }
}

async function handleStopDebateSession(message) {
    const reason = message.reason || 'Session stopped.';
    if (message.sessionId && activeDebateState.sessionId && message.sessionId !== activeDebateState.sessionId) {
        return;
    }
    await endDebateSession(reason);
}

function getRoundIndex(turnIndex, session = null) {
    if (session?.mode === 'direct' || session?.mode === 'parallel') {
        return 1;
    }
    if (session?.mode === 'single') {
        return Math.max(1, turnIndex);
    }
    if (session?.mode === 'debate') {
        const debateProviders = Array.isArray(session?.route?.providers)
            ? session.route.providers.map(normalizeProviderKey).filter((p) => p && isSupportedProviderKey(p))
            : [];
        const divisor = debateProviders.length >= 2 ? debateProviders.length : 2;
        return Math.ceil(turnIndex / divisor);
    }
    return Math.ceil(turnIndex / 2);
}

function getTurnLLM(session, turnIndex) {
    if (session?.mode === 'parallel') {
        return session.firstLLM || 'chatgpt';
    }
    if (session?.mode === 'direct') {
        if (turnIndex === 1) return session.firstLLM || 'chatgpt';
        return session.secondLLM || session.firstLLM || 'chatgpt';
    }
    if (session?.mode === 'single') {
        return session.firstLLM || 'chatgpt';
    }
    if (session?.mode === 'debate') {
        const debateProviders = Array.isArray(session?.route?.providers)
            ? session.route.providers.map(normalizeProviderKey).filter((p) => p && isSupportedProviderKey(p))
            : [];
        if (debateProviders.length >= 2) {
            const idx = Math.max(0, (turnIndex - 1) % debateProviders.length);
            return debateProviders[idx];
        }
    }
    return turnIndex % 2 === 1 ? session.firstLLM : session.secondLLM;
}

function formatLLMLabel(llmType) {
    const normalized = normalizeProviderKey(llmType);
    const label = PROVIDER_METADATA?.[normalized]?.label;
    if (label) return label;
    if (normalized === 'gemini') return 'Gemini';
    if (normalized === 'claude') return 'Claude';
    if (normalized === 'grok') return 'Grok';
    return 'ChatGPT';
}

const PROVIDER_METADATA = {
    chatgpt: {
        label: 'ChatGPT',
        openUrl: 'https://chatgpt.com/',
        expectedHosts: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'platform.openai.com'],
        urlPatterns: [
            '*://chat.openai.com/*',
            '*://chatgpt.com/*',
            '*://openai.com/chatgpt*',
            '*://platform.openai.com/*'
        ]
    },
    gemini: {
        label: 'Gemini',
        openUrl: 'https://gemini.google.com/',
        expectedHosts: ['gemini.google.com'],
        urlPatterns: ['*://gemini.google.com/*']
    },
    claude: {
        label: 'Claude',
        openUrl: 'https://claude.ai/new',
        expectedHosts: ['claude.ai'],
        urlPatterns: ['*://claude.ai/*', '*://*.claude.ai/*']
    },
    grok: {
        label: 'Grok',
        openUrl: 'https://grok.com/',
        expectedHosts: ['grok.com'],
        urlPatterns: ['*://grok.com/*', '*://*.grok.com/*']
    }
};

const PROVIDER_CAPABILITIES = {
    chatgpt: {
        attachments: {
            mode: 'auto'
        }
    },
    gemini: {
        // Gemini currently blocks reliable programmatic uploads from extension content scripts:
        // - No discoverable <input type="file"> in light DOM / open shadow roots
        // - Synthetic drag/drop events are ignored (event.isTrusted === false)
        // Fall back to sending text-only (no programmatic upload).
        attachments: {
            mode: 'manual'
        }
    },
    claude: {
        // Claude (claude.ai) exposes a real <input type="file"> in the composer.
        // We attempt programmatic upload via DataTransfer -> input.files + change/input events.
        attachments: {
            mode: 'auto'
        }
    },
    grok: {
        // Grok (grok.com) attachment automation is best-effort. If UI automation fails, we fall back to text-only.
        attachments: {
            mode: 'auto'
        }
    }
};

function getProviderAttachmentMode(provider) {
    const mode = PROVIDER_CAPABILITIES?.[provider]?.attachments?.mode;
    if (mode === 'manual' || mode === 'none') return mode;
    return 'auto';
}

const DEBATE_PROMPTS_PATH = 'debate_prompts.json';
const PROMPT_TEMPLATES_OVERRIDE_KEY = 'mlc_debate_prompts_override_v1';
let cachedDebatePromptConfig = null;
let cachedDebatePromptSource = null;
let debatePromptConfigLoadPromise = null;

function getDefaultDebatePromptConfig() {
    const followupDebateWrapper = [
        "Here's a new message from the user:",
        '{raw_user_msg}',
        '',
        'This is a continuation of the same chat.',
        'Run: a debate between {first_llm} and {second_llm} over {rounds} iterations (starting with {first_llm}).',
        'You are {llm} on iteration {round}/{rounds}.'
    ].join('\n');
    const followupSingleWrapper = [
        "Here's a new message from the user:",
        '{raw_user_msg}',
        '',
        'This is a continuation of the same chat. Please {llm} answer.',
        'If refining: you are on iteration {round}/{rounds}.'
    ].join('\n');
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
            first_turn_instruction: 'Provide your best answer.',
            intermediary_message: [
                'Provide a constructive improvement for iteration {round}/{rounds}:',
                '- Critique key issues (short bullets)',
                '- Revised answer'
            ].join('\n'),
            final_message: 'Provide your final best answer for the user. Output only the final answer (no critique section).',
            followup_user_msg_wrapper: followupDebateWrapper,
            turn1: [
                '{header}',
                '',
                'Iteration {round}/{rounds}',
                '',
                'User question:',
                '{user_msg}',
                '',
                '{first_turn_instruction}'
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
        },
        single: {
            placeholders: {},
            header: 'You are a single LLM agent. Provide the best possible answer to the user.',
            first_turn_instruction: 'Provide your best answer.',
            intermediary_message: [
                'Improve your answer for iteration {round}/{rounds}:',
                '- Fix errors',
                '- Add missing details',
                '- Keep it concise'
            ].join('\n'),
            final_message: 'Provide your final best answer for the user. Output only the final answer.',
            followup_user_msg_wrapper: followupSingleWrapper,
            turn1: [
                '{header}',
                '',
                'Iteration {round}/{rounds}',
                '',
                'User message:',
                '{user_msg}',
                '',
                '{first_turn_instruction}'
            ].join('\n'),
            turn2plus: [
                'Iteration {round}/{rounds}',
                '',
                'Your previous answer (iteration {prev_round}/{rounds}):',
                '{prev_answer}',
                '',
                'User message:',
                '{user_msg}',
                '',
                '{intermediary_message}'
            ].join('\n')
        },
        direct: {
            placeholders: {},
            single_turn: [
                "Here's a new message from the user:",
                '{raw_user_msg}',
                '',
                'Please {llm} answer.'
            ].join('\n'),
            single_turn_with_history: [
                'Conversation so far:',
                '{conversation_history}',
                '',
                "Here's a new message from the user:",
                '{raw_user_msg}',
                '',
                'Please {llm} answer.'
            ].join('\n'),
            both_turn: [
                "Here's a new message from the user:",
                '{raw_user_msg}',
                '',
                'You are {llm}. Please answer independently.'
            ].join('\n'),
            both_turn_with_history: [
                'Conversation so far:',
                '{conversation_history}',
                '',
                "Here's a new message from the user:",
                '{raw_user_msg}',
                '',
                'You are {llm}. Please answer independently.'
            ].join('\n')
        }
    };
}

function normalizeDebatePromptConfig(rawConfig) {
    const defaults = getDefaultDebatePromptConfig();
    if (!rawConfig || typeof rawConfig !== 'object') return defaults;

    const rawDebate = rawConfig.debate && typeof rawConfig.debate === 'object' ? rawConfig.debate : null;
    const rawSingle = rawConfig.single && typeof rawConfig.single === 'object' ? rawConfig.single : null;
    const rawDirect = rawConfig.direct && typeof rawConfig.direct === 'object' ? rawConfig.direct : null;

    const pickString = (value, fallback) => (typeof value === 'string' ? value : fallback);

    return {
        schemaVersion: 1,
        debate: rawDebate ? {
            placeholders:
                rawDebate.placeholders && typeof rawDebate.placeholders === 'object'
                    ? rawDebate.placeholders
                    : defaults.debate.placeholders,
            header: pickString(rawDebate.header, defaults.debate.header),
            first_turn_instruction: pickString(rawDebate.first_turn_instruction, defaults.debate.first_turn_instruction),
            intermediary_message: pickString(rawDebate.intermediary_message, defaults.debate.intermediary_message),
            final_message: pickString(rawDebate.final_message, defaults.debate.final_message),
            followup_user_msg_wrapper: pickString(rawDebate.followup_user_msg_wrapper, defaults.debate.followup_user_msg_wrapper),
            turn1: pickString(rawDebate.turn1, defaults.debate.turn1),
            turn2: pickString(rawDebate.turn2, defaults.debate.turn2),
            turn3plus_first: pickString(rawDebate.turn3plus_first, defaults.debate.turn3plus_first),
            turn3plus_second: pickString(rawDebate.turn3plus_second, defaults.debate.turn3plus_second)
        } : defaults.debate,
        single: rawSingle ? {
            placeholders:
                rawSingle.placeholders && typeof rawSingle.placeholders === 'object'
                    ? rawSingle.placeholders
                    : defaults.single.placeholders,
            header: pickString(rawSingle.header, defaults.single.header),
            first_turn_instruction: pickString(rawSingle.first_turn_instruction, defaults.single.first_turn_instruction),
            intermediary_message: pickString(rawSingle.intermediary_message, defaults.single.intermediary_message),
            final_message: pickString(rawSingle.final_message, defaults.single.final_message),
            followup_user_msg_wrapper: pickString(rawSingle.followup_user_msg_wrapper, defaults.single.followup_user_msg_wrapper),
            turn1: pickString(rawSingle.turn1, defaults.single.turn1),
            turn2plus: pickString(rawSingle.turn2plus, defaults.single.turn2plus)
        } : defaults.single,
        direct: rawDirect ? {
            placeholders:
                rawDirect.placeholders && typeof rawDirect.placeholders === 'object'
                    ? rawDirect.placeholders
                    : defaults.direct.placeholders,
            single_turn: pickString(rawDirect.single_turn, defaults.direct.single_turn),
            single_turn_with_history: pickString(rawDirect.single_turn_with_history, defaults.direct.single_turn_with_history),
            both_turn: pickString(rawDirect.both_turn, defaults.direct.both_turn),
            both_turn_with_history: pickString(rawDirect.both_turn_with_history, defaults.direct.both_turn_with_history)
        } : defaults.direct
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

function describeMessageRoleForContext(role) {
    if (!role) return 'Assistant';
    if (role === 'user') return 'User';
    if (isSupportedProviderKey(role)) return formatLLMLabel(role);
    return String(role);
}

function buildConversationContext(messages, { maxChars = 4000, maxMessages = 10 } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const recent = messages.slice(Math.max(0, messages.length - maxMessages));
    const blocks = [];
    for (const message of recent) {
        if (!message) continue;
        const role = describeMessageRoleForContext(message.role);
        const content = String(message.content || '').trim();
        if (!content) continue;
        blocks.push(`${role}:\n${content}`);
    }
    if (blocks.length === 0) return '';
    let text = blocks.join('\n\n');
    if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
        text = text.slice(text.length - maxChars);
    }
    return text;
}

function formatTranscriptForPrompt(messages, { maxChars = 48000 } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const blocks = [];
    for (const message of messages) {
        if (!message) continue;
        const role = describeMessageRoleForContext(message.role);
        const content = String(message.content || '').trim();
        if (!content) continue;
        blocks.push(`${role}:\n${content}`);
    }
    if (blocks.length === 0) return '';
    let text = blocks.join('\n\n');
    if (Number.isFinite(maxChars) && maxChars > 0 && text.length > maxChars) {
        text = `…(earlier messages omitted)\n\n${text.slice(text.length - maxChars)}`;
    }
    return text;
}

const CHAT_DELIVERY_STATE_META_PREFIX = 'mlc_chat_delivery_state_v1:';
const CHAT_DELIVERY_STATE_SCHEMA_VERSION = 2;

function getChatDeliveryStateKey(chatId) {
    return `${CHAT_DELIVERY_STATE_META_PREFIX}${chatId}`;
}

function createEmptyDeliveryState() {
    const providers = {};
    for (const provider of getSupportedProviderKeys()) {
        providers[provider] = { deliveredUpTo: 0, contextKey: null };
    }
    // Backward compatibility (older code assumes these keys exist).
    if (!Object.prototype.hasOwnProperty.call(providers, 'chatgpt')) providers.chatgpt = { deliveredUpTo: 0, contextKey: null };
    if (!Object.prototype.hasOwnProperty.call(providers, 'gemini')) providers.gemini = { deliveredUpTo: 0, contextKey: null };
    return {
        schemaVersion: CHAT_DELIVERY_STATE_SCHEMA_VERSION,
        updatedAt: 0,
        providers
    };
}

function normalizeDeliveryProviderState(value) {
    const out = { deliveredUpTo: 0, contextKey: null };
    if (!value || typeof value !== 'object') return out;
    if (Number.isFinite(value.deliveredUpTo) && value.deliveredUpTo > 0) {
        out.deliveredUpTo = Math.floor(value.deliveredUpTo);
    }
    if (typeof value.contextKey === 'string' && value.contextKey.trim()) {
        out.contextKey = value.contextKey.trim();
    }
    return out;
}

function normalizeChatDeliveryState(value) {
    const base = createEmptyDeliveryState();
    if (!value || typeof value !== 'object') return base;

    if ((value.schemaVersion === 1 || value.schemaVersion === 2) && value.providers && typeof value.providers === 'object') {
        const out = createEmptyDeliveryState();
        out.updatedAt = Number.isFinite(value.updatedAt) ? Math.floor(value.updatedAt) : 0;
        for (const provider of Object.keys(out.providers)) {
            out.providers[provider] = normalizeDeliveryProviderState(value.providers[provider]);
        }
        return out;
    }

    // Legacy shape: { chatgpt: number, gemini: number }
    const out = createEmptyDeliveryState();
    if (Number.isFinite(value.chatgpt) && value.chatgpt > 0) out.providers.chatgpt.deliveredUpTo = Math.floor(value.chatgpt);
    if (Number.isFinite(value.gemini) && value.gemini > 0) out.providers.gemini.deliveredUpTo = Math.floor(value.gemini);
    return out;
}

const deliveryStateCache = new Map();

async function getChatDeliveryState(store, chatId) {
    if (!store || !chatId) return createEmptyDeliveryState();
    const cached = deliveryStateCache.get(chatId);
    if (cached) return cached;
    try {
        const raw = await store.getMeta(getChatDeliveryStateKey(chatId));
        const normalized = normalizeChatDeliveryState(raw);
        deliveryStateCache.set(chatId, normalized);
        return normalized;
    } catch (error) {
        const fallback = createEmptyDeliveryState();
        deliveryStateCache.set(chatId, fallback);
        return fallback;
    }
}

async function saveChatDeliveryState(store, chatId, state) {
    if (!store || !chatId) return { ok: false, error: 'Missing store/chatId.' };
    const normalized = normalizeChatDeliveryState(state);
    normalized.updatedAt = Date.now();
    deliveryStateCache.set(chatId, normalized);
    try {
        await store.setMeta(getChatDeliveryStateKey(chatId), normalized);
        return { ok: true, state: normalized };
    } catch (error) {
        return { ok: false, error: error?.message || 'Failed to save delivery state.' };
    }
}

function getProviderContextKey(session, provider) {
    const profileId = session?.profileIds?.[provider];
    if (typeof profileId === 'string' && profileId.trim()) {
        return `profile:${profileId.trim()}`;
    }
    const tabId = session?.tabIds?.[provider];
    if (Number.isFinite(tabId)) {
        return `tab:${Math.floor(tabId)}`;
    }
    return null;
}

function getEffectiveDeliveredUpTo(state, provider, contextKey) {
    if (!state || typeof state !== 'object') return 0;
    const providers = state.providers && typeof state.providers === 'object' ? state.providers : null;
    const normalizedProvider = normalizeProviderKey(provider);
    const entry = normalizedProvider && providers?.[normalizedProvider] && typeof providers[normalizedProvider] === 'object'
        ? providers[normalizedProvider]
        : null;
    const deliveredUpTo = Number.isFinite(entry?.deliveredUpTo) ? Math.max(0, Math.floor(entry.deliveredUpTo)) : 0;
    const storedContextKey = typeof entry?.contextKey === 'string' && entry.contextKey.trim()
        ? entry.contextKey.trim()
        : null;
    if (contextKey && storedContextKey && contextKey !== storedContextKey) {
        return 0;
    }
    return deliveredUpTo;
}

async function bumpProviderDeliveredUpTo(store, chatId, provider, sequence, contextKey) {
    if (!store || !chatId) return { ok: false, error: 'Missing store/chatId.' };
    const normalizedProvider = normalizeProviderKey(provider);
    if (!normalizedProvider || !isSupportedProviderKey(normalizedProvider)) return { ok: false, error: 'Invalid provider.' };
    if (!Number.isFinite(sequence) || sequence <= 0) return { ok: false, error: 'Invalid sequence.' };

    const state = await getChatDeliveryState(store, chatId);
    const normalized = normalizeChatDeliveryState(state);
    const entry = normalized.providers[normalizedProvider] || { deliveredUpTo: 0, contextKey: null };
    normalized.providers[normalizedProvider] = entry;
    const safeContextKey = typeof contextKey === 'string' && contextKey.trim() ? contextKey.trim() : null;

    if (safeContextKey && entry.contextKey && entry.contextKey !== safeContextKey) {
        entry.deliveredUpTo = 0;
    }
    if (safeContextKey) entry.contextKey = safeContextKey;

    entry.deliveredUpTo = Math.max(entry.deliveredUpTo, Math.floor(sequence));
    return saveChatDeliveryState(store, chatId, normalized);
}

async function buildDirectHistoryDelta(store, chatId, { afterSequence = 0, cutoffSequence, maxMessages = 400, maxChars = 48000 } = {}) {
    if (!store || !chatId) return '';
    if (!Number.isFinite(cutoffSequence) || cutoffSequence <= 1) return '';
    const after = Number.isFinite(afterSequence) ? Math.max(0, Math.floor(afterSequence)) : 0;
    const cutoff = Math.max(1, Math.floor(cutoffSequence));
    if (cutoff <= after + 1) return '';

    const collectedReversed = [];
    let beforeSequence = cutoff; // excludes the new user message (sequence == cutoff) and anything after
    let reachedBoundary = false;

    while (!reachedBoundary) {
        const page = await store.listMessages(chatId, { limit: 80, beforeSequence });
        const messages = Array.isArray(page?.messages) ? page.messages : [];
        if (messages.length === 0) break;

        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const msg = messages[i];
            if (!msg || !Number.isFinite(msg.sequence)) continue;
            if (msg.sequence <= after) {
                reachedBoundary = true;
                break;
            }
            const role = msg.role;
            if (role !== 'user' && !isSupportedProviderKey(role)) continue;
            collectedReversed.push(msg);
            if (collectedReversed.length >= maxMessages) {
                reachedBoundary = true;
                break;
            }
        }

        if (reachedBoundary) break;
        if (!page?.hasMore || !Number.isFinite(page?.nextCursorSequence)) break;
        beforeSequence = page.nextCursorSequence;
        if (!Number.isFinite(beforeSequence) || beforeSequence <= 0) break;
    }

    if (collectedReversed.length === 0) return '';
    const ordered = collectedReversed.reverse();
    return formatTranscriptForPrompt(ordered, { maxChars });
}

function renderUserMessageForSession(session, templates, baseVariables) {
    const rawUserMsg = String(session?.userQuery || '').trim();
    if (!rawUserMsg) return '';
    if (!session?.isFollowUp) return rawUserMsg;
    const wrapper = typeof templates?.followup_user_msg_wrapper === 'string'
        ? templates.followup_user_msg_wrapper.trim()
        : '';
    if (!wrapper) return rawUserMsg;
    return renderPromptTemplate(wrapper, {
        ...(baseVariables && typeof baseVariables === 'object' ? baseVariables : {}),
        raw_user_msg: rawUserMsg,
        conversation_context: session?.conversationContext || ''
    }).trim();
}

async function buildDebatePrompt(session, turnIndex) {
    const promptConfig = await loadDebatePromptConfig();
    const baseTemplates = promptConfig?.debate || getDefaultDebatePromptConfig().debate;
    const overrides = session?.promptOverrides?.debate && typeof session.promptOverrides.debate === 'object'
        ? session.promptOverrides.debate
        : null;
    const templates = overrides ? { ...baseTemplates, ...overrides } : baseTemplates;

    const debateProviders = Array.isArray(session?.route?.providers)
        ? session.route.providers.map(normalizeProviderKey).filter((p) => p && isSupportedProviderKey(p))
        : listSessionProviders(session);
    const providerCount = debateProviders.length >= 2 ? debateProviders.length : 2;

    const roundIndex = getRoundIndex(turnIndex, session);
    const expectedLLM = getTurnLLM(session, turnIndex);
    const expectedLabel = formatLLMLabel(expectedLLM);
    const prevIdx = turnIndex > 1 ? (turnIndex - 2) % providerCount : 0;
    const previousLLM = debateProviders[prevIdx] || session.secondLLM || session.firstLLM;
    const otherLLM = providerCount > 2 ? previousLLM : (expectedLLM === session.firstLLM ? session.secondLLM : session.firstLLM);
    const otherLabel = formatLLMLabel(otherLLM);
    const safeOtherResponse = getLastResponse(session, otherLLM) || '[No prior response captured yet]';
    const safeFirstResponse = getLastResponse(session, session.firstLLM) || '[No prior response captured yet]';

    const totalTurns = Number.isFinite(session.totalTurns) ? session.totalTurns : session.rounds * providerCount;
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
        raw_user_msg: session.userQuery,
        conversation_context: session.conversationContext || '',
        user_query: session.userQuery,
        first_answer: safeFirstResponse,
        other_answer: safeOtherResponse,
        last_other_answer: safeOtherResponse
    };

    const header = renderPromptTemplate(templates.header, baseVariables);
    const userMsg = renderUserMessageForSession(session, templates, { ...baseVariables, header });
    const renderedIntermediary = renderPromptTemplate(templates.intermediary_message, { ...baseVariables, header });
    const renderedFinal = renderPromptTemplate(templates.final_message, { ...baseVariables, header });
    const isFinalTurn = turnIndex === totalTurns;
    const renderedInitialInstruction = renderPromptTemplate(
        typeof templates.first_turn_instruction === 'string' ? templates.first_turn_instruction : 'Provide your best answer.',
        { ...baseVariables, header }
    );
    const turnInstruction = turnIndex === 1
        ? renderedInitialInstruction
        : (isFinalTurn
            ? (session.rounds === 1
                ? `${renderedInitialInstruction}\n\n${renderedFinal}`
                : renderedFinal)
            : (session.rounds >= 3 ? renderedIntermediary : renderedInitialInstruction));
    const variables = {
        ...baseVariables,
        header,
        user_msg: userMsg,
        first_turn_instruction: renderedInitialInstruction,
        intermediary_message: turnInstruction,
        final_message: renderedFinal
    };

    if (providerCount > 2) {
        const isFinalTurn = turnIndex === totalTurns;
        const instruction = turnIndex === 1
            ? renderedInitialInstruction
            : (isFinalTurn ? renderedFinal : renderedIntermediary);

        const utils = globalThis.MLCDebatePromptUtils;
        if (utils && typeof utils.buildMultiProviderDebatePrompt === 'function') {
            return utils.buildMultiProviderDebatePrompt({
                header,
                roundIndex,
                rounds: session.rounds,
                expectedProvider: expectedLLM,
                expectedLabel,
                messages: Array.isArray(session?.messages) ? session.messages : [],
                roleLabelFn: describeMessageRoleForContext,
                userMessageOverride: userMsg,
                instruction,
                maxChars: 48000
            }).trim();
        }

        // Fallback (should not normally run): include all transcript messages since this provider last responded.
        const messages = Array.isArray(session?.messages) ? session.messages : [];
        let lastOwnIndex = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]?.role === expectedLLM) {
                lastOwnIndex = i;
                break;
            }
        }
        const delta = messages.slice(Math.max(0, lastOwnIndex + 1)).map((msg) => {
            if (!msg) return null;
            if (msg.role === 'user') return { ...msg, content: userMsg };
            return msg;
        }).filter(Boolean);
        const deltaText = formatTranscriptForPrompt(delta, { maxChars: 48000 }).trim();

        const blocks = [
            header,
            '',
            `Iteration ${roundIndex}/${session.rounds}`,
            '',
            lastOwnIndex < 0 ? 'Conversation so far:' : 'New messages since your last turn:',
            deltaText || '[No new messages]',
            '',
            instruction
        ];
        return blocks.join('\n').trim();
    }

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

async function buildSinglePrompt(session, turnIndex) {
    const promptConfig = await loadDebatePromptConfig();
    const baseTemplates = promptConfig?.single || getDefaultDebatePromptConfig().single;
    const overrides = session?.promptOverrides?.single && typeof session.promptOverrides.single === 'object'
        ? session.promptOverrides.single
        : null;
    const templates = overrides ? { ...baseTemplates, ...overrides } : baseTemplates;

    const roundIndex = Math.max(1, turnIndex);
    const expectedLLM = getTurnLLM(session, turnIndex);
    const expectedLabel = formatLLMLabel(expectedLLM);
    const safePrevAnswer = getLastResponse(session, expectedLLM) || '[No prior response captured yet]';

    const totalTurns = Number.isFinite(session.totalTurns) ? session.totalTurns : session.rounds;
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
        user_msg: session.userQuery,
        raw_user_msg: session.userQuery,
        conversation_context: session.conversationContext || '',
        user_query: session.userQuery,
        prev_answer: safePrevAnswer
    };

    const header = renderPromptTemplate(templates.header, baseVariables);
    const userMsg = renderUserMessageForSession(session, templates, { ...baseVariables, header });
    const renderedIntermediary = renderPromptTemplate(templates.intermediary_message, { ...baseVariables, header });
    const renderedFinal = renderPromptTemplate(templates.final_message, { ...baseVariables, header });
    const isFinalTurn = turnIndex === totalTurns;
    const renderedInitialInstruction = renderPromptTemplate(
        typeof templates.first_turn_instruction === 'string' ? templates.first_turn_instruction : 'Provide your best answer.',
        { ...baseVariables, header }
    );
    const turnInstruction = turnIndex === 1
        ? renderedInitialInstruction
        : (isFinalTurn
            ? (session.rounds === 1
                ? `${renderedInitialInstruction}\n\n${renderedFinal}`
                : renderedFinal)
            : renderedIntermediary);

    const variables = {
        ...baseVariables,
        header,
        user_msg: userMsg,
        first_turn_instruction: renderedInitialInstruction,
        intermediary_message: turnInstruction,
        final_message: renderedFinal
    };

    if (turnIndex === 1) {
        return renderPromptTemplate(templates.turn1, variables).trim();
    }

    return renderPromptTemplate(templates.turn2plus, variables).trim();
}

async function buildDirectPrompt(session, turnIndex) {
    const promptConfig = await loadDebatePromptConfig();
    const defaults = getDefaultDebatePromptConfig();
    const templates = promptConfig?.direct || defaults.direct;

    const expectedLLM = getTurnLLM(session, turnIndex);
    const expectedLabel = formatLLMLabel(expectedLLM);
    const rawUserMsg = String(session?.userQuery || '').trim();

    let conversationHistory = '';
    try {
        const store = await requireHistoryUnlocked();
        const deliveryState = await getChatDeliveryState(store, session?.chatId);
        const contextKey = getProviderContextKey(session, expectedLLM);
        const deliveredUpTo = getEffectiveDeliveredUpTo(deliveryState, expectedLLM, contextKey);
        conversationHistory = await buildDirectHistoryDelta(store, session?.chatId, {
            afterSequence: deliveredUpTo,
            cutoffSequence: session?.userMessageSequence,
            maxMessages: 400,
            maxChars: 48000
        });
    } catch (error) {
        conversationHistory = '';
    }

    const baseVariables = {
        llm: expectedLabel,
        expected_llm: expectedLabel,
        raw_user_msg: rawUserMsg,
        user_msg: rawUserMsg,
        conversation_history: conversationHistory,
        conversation_context: session?.conversationContext || ''
    };

    const isBoth = Boolean(session?.secondLLM);
    const useHistory = Boolean(conversationHistory && conversationHistory.trim().length > 0);
    const template = isBoth
        ? (useHistory && typeof templates?.both_turn_with_history === 'string'
            ? templates.both_turn_with_history
            : templates?.both_turn)
        : (useHistory && typeof templates?.single_turn_with_history === 'string'
            ? templates.single_turn_with_history
            : templates?.single_turn);
    const rendered = renderPromptTemplate(template, baseVariables).trim();
    if (rendered) return rendered;

    const header = "Here's a new message from the user:";
    if (isBoth) {
        return `${header}\n${rawUserMsg}\n\nYou are ${expectedLabel}. Please answer independently.`.trim();
    }
    return `${header}\n${rawUserMsg}\n\nPlease ${expectedLabel} answer.`.trim();
}

async function buildSessionPrompt(session, turnIndex) {
    if (session?.mode === 'parallel') {
        return ((session?.userQuery || '') + '').trim();
    }
    if (session?.mode === 'direct') {
        return buildDirectPrompt(session, turnIndex);
    }
    if (session?.mode === 'single') {
        return buildSinglePrompt(session, turnIndex);
    }
    return buildDebatePrompt(session, turnIndex);
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

    if (session.mode === 'parallel') {
        const providers = Array.isArray(session.waitingFor) && session.waitingFor.length > 0
            ? session.waitingFor.map(normalizeProviderKey).filter(Boolean)
            : getParallelProviders(session);
        for (const provider of providers) {
            const validation = await resolveSessionTab(session, provider, { requirePing: true });
            if (!validation.ok) {
                await pauseDebateSession(validation.error, provider);
                return { ok: false, error: validation.error };
            }
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
        await sendParallelTurn(session, { providers });
        return { ok: true };
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

async function prefetchSessionAttachments(session, excludeProvider) {
    try {
        const sessionId = session?.sessionId;
        if (!sessionId) return;
        if (!hasSessionAttachments(sessionId)) return;
        if (!activeSessionAttachments || activeSessionAttachments.sessionId !== sessionId) return;

        const attachments = activeSessionAttachments.attachments;
        if (!Array.isArray(attachments) || attachments.length === 0) return;

        const excludeKey = normalizeProviderKey(excludeProvider);
        const providers = getSessionProviders(session).filter((provider) => provider && provider !== excludeKey);

        for (const provider of providers) {
            if (!hasSessionAttachments(sessionId)) return;
            if (getProviderAttachmentMode(provider) !== 'auto') continue;
            if (activeSessionAttachments.sentTo?.[provider]) continue;
            if (activeSessionAttachments.preparedTo?.[provider]) continue;

            const resolution = await resolveSessionTab(session, provider);
            if (!resolution.ok) {
                console.warn(`[MLC Attachments] Prefetch skipped for ${provider}: ${resolution.error || 'Tab validation failed.'}`);
                continue;
            }

            try {
                await injectAndPrepareAttachments(resolution.tabId, provider, attachments);
                markSessionAttachmentsPrepared(session, provider);
            } catch (error) {
                console.warn(`[MLC Attachments] Prefetch failed for ${provider}:`, error?.message || error);
            }
        }
    } catch (error) {
        console.warn('[MLC Attachments] Prefetch threw unexpectedly:', error);
    }
}

function getParallelProviders(session) {
    const providers = [];
    const candidates = Array.isArray(session?.route?.providers) && session.route.providers.length > 0
        ? session.route.providers
        : listSessionProviders(session);
    for (const candidate of candidates) {
        const key = normalizeProviderKey(candidate);
        if (!isSupportedProviderKey(key)) continue;
        if (!providers.includes(key)) providers.push(key);
    }
    return providers;
}

function buildParallelPromptId(sessionId, provider) {
    return `${sessionId}:parallel:${normalizeProviderKey(provider)}`;
}

function formatProvidersForUi(providers) {
    if (!Array.isArray(providers) || providers.length === 0) return '';
    return providers.map(formatLLMLabel).join(' + ');
}

async function sendParallelTurn(session, { providers: providersOverride } = {}) {
    if (session.isPaused) return;
    const sessionId = session.sessionId;
    if (!sessionId) return;

    const allProviders = getParallelProviders(session);
    const waitingProviders = Array.isArray(session.waitingFor) ? session.waitingFor.map(normalizeProviderKey).filter(Boolean) : [];
    const base = Array.isArray(providersOverride) ? providersOverride : (waitingProviders.length > 0 ? waitingProviders : allProviders);
    const providers = base.map(normalizeProviderKey).filter((provider) => provider && allProviders.includes(provider));
    if (providers.length === 0) return;

    const resolvedTabs = {};
    for (const provider of providers) {
        const resolution = await resolveSessionTab(session, provider);
        if (!resolution.ok) {
            await pauseDebateSession(resolution.error || 'Tab validation failed.', provider);
            return;
        }
        resolvedTabs[provider] = resolution.tabId;
    }

    const promptText = await buildSessionPrompt(session, 1);
    const promptIds = {};
    providers.forEach((provider) => {
        promptIds[provider] = buildParallelPromptId(sessionId, provider);
    });

    const nextWaiting = waitingProviders.length > 0 ? waitingProviders : allProviders;
    activeDebateState.waitingFor = nextWaiting;
    activeDebateState.parallelPromptIds = { ...(activeDebateState.parallelPromptIds || {}), ...promptIds };
    activeDebateState.lastPromptTimestamp = Date.now();
    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_SESSION_PROGRESS',
        sessionId,
        waitingFor: nextWaiting,
        waitingForLabel: formatProvidersForUi(nextWaiting),
        roundIndex: 1,
        totalRounds: 1
    });

    const sessionHasAttachments = hasSessionAttachments(sessionId);

    const results = await Promise.allSettled(providers.map(async (provider) => {
        const tabId = resolvedTabs[provider];
        const promptId = promptIds[provider];

        const attachmentMode = sessionHasAttachments ? getProviderAttachmentMode(provider) : 'auto';
        const shouldSkipAttachments = sessionHasAttachments && attachmentMode !== 'auto';
        const attachmentsToSend = shouldSkipAttachments || !sessionHasAttachments
            ? null
            : getPendingSessionAttachments(sessionId, provider);

        try {
            await injectAndExecute(tabId, provider, promptText, {
                sessionId,
                promptId,
                turnIndex: 1,
                attachments: attachmentsToSend || undefined
            });
            if (sessionHasAttachments) {
                markSessionAttachmentsSent(session, provider);
            }
            return { ok: true, provider };
        } catch (error) {
            const code = error?.code;
            const isAttachmentFailure = code === 'ATTACHMENTS_FAILED'
                || String(error?.message || '').includes('Attachment upload failed');
            if (attachmentsToSend && attachmentsToSend.length > 0 && isAttachmentFailure) {
                try {
                    notifyAttachmentFallback(session, provider);
                    if (sessionHasAttachments) {
                        markSessionAttachmentsSent(session, provider);
                    }
                    await injectAndExecute(tabId, provider, promptText, {
                        sessionId,
                        promptId,
                        turnIndex: 1
                    });
                    return { ok: true, provider, retriedWithoutAttachments: true };
                } catch (retryError) {
                    throw { provider, error: retryError };
                }
            }
            throw { provider, error };
        }
    }));

    const firstFailure = results.find((result) => result.status === 'rejected');
    if (firstFailure && firstFailure.status === 'rejected') {
        const failure = firstFailure.reason;
        const provider = normalizeProviderKey(failure?.provider);
        const error = failure?.error || failure;
        await pauseDebateSession(error?.message || 'Failed to send prompt.', provider || null);
    }
}

async function sendDebateTurn(session) {
    if (session.isPaused) return;
    const turnIndex = session.turnIndex;
    const expectedLLM = getTurnLLM(session, turnIndex);
    const resolution = await resolveSessionTab(session, expectedLLM);
    if (!resolution.ok) {
        await pauseDebateSession(resolution.error || 'Tab validation failed.', expectedLLM);
        return;
    }

    const promptText = await buildSessionPrompt(session, turnIndex);
    const promptId = `${session.sessionId}:turn:${turnIndex}`;

    activeDebateState.waitingFor = expectedLLM;
    activeDebateState.lastPromptId = promptId;
    activeDebateState.lastPromptTimestamp = Date.now();

    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_SESSION_PROGRESS',
        sessionId: session.sessionId,
        waitingFor: expectedLLM,
        roundIndex: getRoundIndex(turnIndex, session),
        totalRounds: session.rounds
    });

    const sessionHasAttachments = hasSessionAttachments(session.sessionId);
    const attachmentMode = sessionHasAttachments ? getProviderAttachmentMode(expectedLLM) : 'auto';
    const shouldSkipAttachments = sessionHasAttachments && attachmentMode !== 'auto';
    const attachmentsToSend = shouldSkipAttachments || !sessionHasAttachments
        ? null
        : getPendingSessionAttachments(session.sessionId, expectedLLM);

    try {
        await injectAndExecute(resolution.tabId, expectedLLM, promptText, {
            sessionId: session.sessionId,
            promptId: promptId,
            turnIndex: turnIndex,
            attachments: attachmentsToSend || undefined
        });
        if (sessionHasAttachments) {
            markSessionAttachmentsSent(session, expectedLLM);
            await prefetchSessionAttachments(session, expectedLLM);
        }

        if (session.mode === 'direct' && session.chatId && Number.isFinite(session.userMessageSequence)) {
            try {
                const store = await requireHistoryUnlocked();
                await bumpProviderDeliveredUpTo(
                    store,
                    session.chatId,
                    expectedLLM,
                    session.userMessageSequence,
                    getProviderContextKey(session, expectedLLM)
                );
            } catch (error) {
                // ignore delivery tracking failures
            }
        }
    } catch (error) {
        const code = error?.code;
        const isAttachmentFailure = code === 'ATTACHMENTS_FAILED' || String(error?.message || '').includes('Attachment upload failed');
        if (attachmentsToSend && attachmentsToSend.length > 0 && isAttachmentFailure) {
            // Attach failed (DOM drift / provider change). Retry immediately without attachments so the run continues.
            try {
                notifyAttachmentFallback(session, expectedLLM);
                markSessionAttachmentsSent(session, expectedLLM);
                await injectAndExecute(resolution.tabId, expectedLLM, promptText, {
                    sessionId: session.sessionId,
                    promptId: promptId,
                    turnIndex: turnIndex
                });
                if (sessionHasAttachments) {
                    await prefetchSessionAttachments(session, expectedLLM);
                }
                return;
            } catch (retryError) {
                await pauseDebateSession(retryError?.message || error?.message || 'Failed to send prompt.', expectedLLM);
                return;
            }
        }

        await pauseDebateSession(error?.message || 'Failed to send prompt.', expectedLLM);
    }
}

async function handleParallelResponse(session, message) {
    const sessionId = session?.sessionId;
    if (!sessionId) return;

    const provider = normalizeProviderKey(message.sourceLLM || message.provider || '');
    if (!isSupportedProviderKey(provider)) return;

    const waitingFor = Array.isArray(session.waitingFor)
        ? session.waitingFor.map(normalizeProviderKey).filter(Boolean)
        : [];
    if (!waitingFor.includes(provider)) {
        return;
    }

    const expectedPromptId = session.parallelPromptIds?.[provider] || buildParallelPromptId(sessionId, provider);
    if (expectedPromptId && message.promptId && expectedPromptId !== message.promptId) {
        console.log('[MLC Parallel] Ignoring response with mismatched promptId.', {
            expectedPromptId,
            messagePromptId: message.promptId,
            provider
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

    const timestamp = Date.now();
    const entry = {
        role: provider,
        content,
        timestamp,
        roundIndex: 1
    };
    if (contentHtml) entry.contentHtml = contentHtml;
    session.messages.push(entry);

    session.waitingFor = waitingFor.filter((item) => item !== provider);

    await persistDebateState();

    sendMessageToPopup({
        type: 'UI_MESSAGE_ADD',
        chatId: session.chatId || null,
        sessionId: sessionId,
        role: provider,
        content: content,
        contentHtml: contentHtml || undefined,
        timestamp: timestamp,
        roundIndex: 1
    });

    if (session.chatId) {
        await appendChatMessage(session.chatId, {
            role: provider,
            content,
            contentHtml: contentHtml || undefined,
            timestamp,
            roundIndex: 1,
            sessionId: sessionId
        });
    }

    if (Array.isArray(session.waitingFor) && session.waitingFor.length === 0) {
        await endDebateSession('Session completed.');
        return;
    }

    sendMessageToPopup({
        type: 'UI_SESSION_PROGRESS',
        sessionId,
        waitingFor: session.waitingFor,
        waitingForLabel: formatProvidersForUi(session.waitingFor)
    });
}

async function handleDebateResponse(message) {
    if (!message.sessionId) return;

    const session = await loadActiveDebateState();
    if (!session.isActive || session.sessionId !== message.sessionId) {
        console.log('[MLC Debate] Ignoring response: session not active or mismatch.');
        return;
    }

    if (session.mode === 'parallel') {
        await handleParallelResponse(session, message);
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
    const roundIndex = getRoundIndex(turnIndex, session);
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
        const persisted = await appendChatMessage(session.chatId, {
            role: expectedLLM || message.sourceLLM,
            content,
            contentHtml: contentHtml || undefined,
            timestamp,
            turnIndex,
            roundIndex,
            sessionId: session.sessionId
        });
        if (persisted?.ok && Number.isFinite(persisted?.message?.sequence)) {
            const provider = expectedLLM || message.sourceLLM;
            if (isSupportedProviderKey(provider)) {
                try {
                    const store = await requireHistoryUnlocked();
                    await bumpProviderDeliveredUpTo(
                        store,
                        session.chatId,
                        provider,
                        persisted.message.sequence,
                        getProviderContextKey(session, provider)
                    );
                } catch (error) {
                    // ignore delivery tracking failures
                }
            }
        }
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

    clearSessionAttachments(session.sessionId);
    resetDebateState();
}

async function handleSendPrompt(message) {
    const { prompt, targets, multiAgent } = message;
    
    console.log('[MLC Background] Processing SEND_PROMPT:', { prompt: `"${prompt.substring(0,50)}..."`, targets, multiAgent });
    
    // Check if multi-agent mode is requested
    if (multiAgent && multiAgent.enabled) {
        const firstLLM = targets.chatgpt
            ? 'chatgpt'
            : (targets.gemini ? 'gemini' : 'claude');
        handleStartDebateSession({
            prompt: prompt,
            firstLLM: firstLLM,
            rounds: multiAgent.maxIterations || 3
        });
        return;
    }
    
    // Regular mode - send to individual LLMs
    if (targets.claude) {
        await processLLM('claude', prompt);
    }
    
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

function handleClaudeResponse(message) {
    if (message.sessionId) return;

    if (!message.content || message.content.trim().length === 0) {
        console.log('[MLC] Received empty Claude response, ignoring.');
        return;
    }

    sendMessageToPopup({
        type: 'LLM_RESPONSE',
        llm: 'claude',
        content: message.content,
        contentHtml: message.contentHtml || undefined
    });
}

function handleGrokResponse(message) {
    if (message.sessionId) return;

    if (!message.content || message.content.trim().length === 0) {
        console.log('[MLC] Received empty Grok response, ignoring.');
        return;
    }

    sendMessageToPopup({
        type: 'LLM_RESPONSE',
        llm: 'grok',
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
            ],
            claude: [
                'textarea[data-testid="chat-input-ssr"]',
                'textarea[placeholder*="Message" i]',
                'textarea[aria-label*="Message" i]',
                'textarea[placeholder*="Send" i]',
                'textarea',
                '.ProseMirror[contenteditable="true"]',
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"]',
                '[contenteditable="true"]'
            ],
            grok: [
                'textarea[aria-label*="message" i]',
                'textarea[placeholder*="message" i]',
                'textarea[placeholder*="ask" i]',
                'textarea',
                'div[contenteditable="true"][role="textbox"]',
                '[contenteditable="true"][role="textbox"]',
                '[contenteditable="true"]',
                '[role="textbox"]'
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
            throw new Error(`${formatLLMLabel(llmType)} tab not found. Please open it in a tab and ensure you're logged in.`);
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
    const normalized = normalizeProviderKey(llmType);
    const patterns = PROVIDER_METADATA?.[normalized]?.urlPatterns;
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

    if (preferredTabId) {
        const preferred = candidates.find(tab => tab.id === preferredTabId);
        if (preferred) return preferred;
    }

    if (llmType === 'claude') {
        const chatTabs = candidates.filter(tab => typeof tab.url === 'string' && /:\/\/claude\.ai\/chat\//i.test(tab.url));
        if (chatTabs.length > 0) {
            return selectTabFromList(chatTabs, null);
        }
    }

    return selectTabFromList(candidates, null);
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

function debuggerAttach(debuggee, protocolVersion = '1.3') {
    return new Promise((resolve, reject) => {
        try {
            chrome.debugger.attach(debuggee, protocolVersion, () => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve();
            });
        } catch (error) {
            reject(error);
        }
    });
}

function debuggerDetach(debuggee) {
    return new Promise((resolve) => {
        try {
            chrome.debugger.detach(debuggee, () => resolve());
        } catch (error) {
            resolve();
        }
    });
}

function debuggerSendCommand(debuggee, method, params = {}) {
    return new Promise((resolve, reject) => {
        try {
            chrome.debugger.sendCommand(debuggee, method, params, (result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                resolve(result);
            });
        } catch (error) {
            reject(error);
        }
    });
}

async function sendTabMessageWithRetry(tabId, message, options = {}) {
    const retries = Number.isFinite(options.retries) ? Math.max(1, Math.floor(options.retries)) : 10;
    const delayMs = Number.isFinite(options.delayMs) ? Math.max(50, Math.floor(options.delayMs)) : 450;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            await chrome.tabs.sendMessage(tabId, message);
            return { ok: true, attempt };
        } catch (error) {
            lastError = error;
        }
        await sleep(delayMs);
    }

    return { ok: false, error: String(lastError?.message || lastError || 'unknown_error') };
}

async function sendPromptViaClaudeDebugger(tabId, promptText, options = null) {
    const debuggee = { tabId };
    await debuggerAttach(debuggee, '1.3');
    try {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const readyTimeoutMs = (() => {
            const value = options && typeof options === 'object' ? options.readyTimeoutMs : null;
            if (!Number.isFinite(value)) return 4000;
            return Math.min(120000, Math.max(1500, Math.floor(value)));
        })();

        // Make the tab active to maximize the chance CDP input targets the correct frame/element.
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab?.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
            }
            await chrome.tabs.update(tabId, { active: true });
        } catch (error) {
            // ignore focus errors
        }

        const focusExpr = `(() => {
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (!(rect.width > 8 && rect.height > 8)) return false;
                if (rect.bottom < 0 || rect.right < 0) return false;
                if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
                return true;
            };

            const bottomMost = (nodes) => {
                let best = null;
                let bestBottom = -Infinity;
                for (const node of nodes) {
                    if (!isVisible(node)) continue;
                    const rect = node.getBoundingClientRect();
                    const bottom = Number.isFinite(rect.bottom) ? rect.bottom : 0;
                    if (bottom >= bestBottom) {
                        bestBottom = bottom;
                        best = node;
                    }
                }
                return best;
            };

            const sendSelectors = [
                'button[aria-label*="message" i]',
                'button[aria-label*="envoyer" i]',
                'button[aria-label*="send" i]'
            ];

            const findComposerRoot = () => {
                const uploadSelectors = [
                    'input[type="file"][data-testid="file-upload"]',
                    'input[type="file"]#chat-input-file-upload-onpage',
                    'input[type="file"][id*="chat-input-file-upload" i]'
                ];
                for (const sel of uploadSelectors) {
                    const upload = bottomMost(Array.from(document.querySelectorAll(sel)));
                    if (upload) {
                        return upload.closest('fieldset')
                            || upload.closest('form')
                            || upload.closest('[role="form"]')
                            || upload.parentElement
                            || document.body;
                    }
                }

                const ta = bottomMost(Array.from(document.querySelectorAll('textarea[data-testid="chat-input-ssr"], textarea')));
                if (ta) {
                    return ta.closest('fieldset')
                        || ta.closest('form')
                        || ta.closest('[role="form"]')
                        || ta.parentElement
                        || document.body;
                }

                for (const sel of sendSelectors) {
                    const btn = bottomMost(Array.from(document.querySelectorAll(sel)));
                    if (btn) {
                        return btn.closest('fieldset')
                            || btn.closest('form')
                            || btn.closest('[role="form"]')
                            || btn.parentElement
                            || document.body;
                    }
                }

                return document.body;
            };

            const root = findComposerRoot();

            let sendBtn = null;
            for (const sel of sendSelectors) {
                const btn = bottomMost(Array.from(root.querySelectorAll(sel)));
                if (btn) {
                    sendBtn = btn;
                    break;
                }
            }
            if (!sendBtn) {
                for (const sel of sendSelectors) {
                    const btn = bottomMost(Array.from(document.querySelectorAll(sel)));
                    if (btn) {
                        sendBtn = btn;
                        break;
                    }
                }
            }

            const isVisibleInput = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (rect.bottom < 0 || rect.right < 0) return false;
                if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
                return true;
            };

            const inputSelectors = [
                'div[data-testid="chat-input"][role="textbox"]',
                '[contenteditable="true"][role="textbox"]',
                '.ProseMirror[contenteditable="true"]',
                '[contenteditable="true"]',
                'textarea[data-testid="chat-input-ssr"]',
                'textarea'
            ];
            const seen = new Set();
            const candidates = [];
            const active = document.activeElement;
            if (active && active !== document.body && !seen.has(active)) {
                const isLikelyEditor = active.matches?.('div[data-testid="chat-input"][role="textbox"]')
                    || (Boolean(active.isContentEditable || String(active.getAttribute?.('contenteditable') || '').toLowerCase() === 'true')
                        && String(active.getAttribute?.('role') || '').toLowerCase() === 'textbox');
                if (isLikelyEditor && isVisibleInput(active)) {
                    seen.add(active);
                    candidates.push(active);
                }
            }
            for (const sel of inputSelectors) {
                for (const scope of [root, document]) {
                    if (!scope?.querySelectorAll) continue;
                    for (const node of Array.from(scope.querySelectorAll(sel))) {
                        if (!node || seen.has(node)) continue;
                        seen.add(node);
                        if (!isVisibleInput(node)) continue;
                        candidates.push(node);
                    }
                }
            }

            const scoreInput = (node) => {
                const rect = node.getBoundingClientRect();
                const bottom = Number.isFinite(rect.bottom) ? rect.bottom : 0;
                const testId = String(node.getAttribute?.('data-testid') || '');
                const aria = String(node.getAttribute?.('aria-label') || '');
                const isTextArea = node.tagName === 'TEXTAREA';
                const role = String(node.getAttribute?.('role') || '');
                const isEditable = Boolean(node.isContentEditable || node.getAttribute?.('contenteditable') === 'true');

                let score = bottom;
                if (testId.toLowerCase() === 'chat-input') score += 250000;
                if (isEditable) score += 100000;
                if (role.toLowerCase() === 'textbox') score += 65000;
                if (isTextArea) score += 40000;
                if (testId.toLowerCase() === 'chat-input-ssr') score -= 150000;
                if (/claude/i.test(aria)) score += 8000;
                if (/invite|prompt|message/i.test(aria)) score += 4000;
                return score;
            };

            let input = null;
            let bestScore = -Infinity;
            for (const candidate of candidates) {
                const score = scoreInput(candidate);
                if (score > bestScore) {
                    bestScore = score;
                    input = candidate;
                }
            }

            if (!input) return { ok: false, error: 'input_not_found', hasSendButton: Boolean(sendBtn) };

            window.__mlcClaudeComposerRoot = root || null;
            window.__mlcClaudeInputEl = input || null;
            window.__mlcClaudeSendBtn = sendBtn || null;

            input.focus();
            if (input.tagName === 'TEXTAREA' && typeof input.select === 'function') {
                input.select();
            } else {
                try {
                    const range = document.createRange();
                    range.selectNodeContents(input);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch (error) {
                    // ignore selection failures
                }
            }

            const resolveClickTarget = (el) => {
                let current = el;
                for (let i = 0; i < 6 && current; i += 1) {
                    const rect = current.getBoundingClientRect();
                    if (rect && rect.width > 8 && rect.height > 8) return current;
                    current = current.parentElement;
                }
                return el;
            };

            const clickTarget = resolveClickTarget(input);
            const inputRect = clickTarget.getBoundingClientRect();
            const sendRect = sendBtn ? sendBtn.getBoundingClientRect() : null;

            return {
                ok: true,
                inputTag: input.tagName.toLowerCase(),
                inputTestId: input.getAttribute('data-testid') || null,
                inputRole: input.getAttribute('role') || null,
                inputContentEditable: input.isContentEditable || input.contentEditable === 'true',
                inputX: inputRect.left + inputRect.width / 2,
                inputY: inputRect.top + inputRect.height / 2,
                hasSendButton: Boolean(sendBtn),
                sendLabel: sendBtn?.getAttribute?.('aria-label') || null,
                sendX: sendRect ? (sendRect.left + sendRect.width / 2) : null,
                sendY: sendRect ? (sendRect.top + sendRect.height / 2) : null,
                rootTag: root?.tagName?.toLowerCase?.() || null
            };
        })()`;

        const focusResult = await debuggerSendCommand(debuggee, 'Runtime.evaluate', {
            expression: focusExpr,
            returnByValue: true
        });
        const focusValue = focusResult?.result?.value;
        if (!focusValue?.ok) {
            const details = focusValue ? ` details=${JSON.stringify(focusValue)}` : '';
            throw new Error(`Claude focus failed: ${focusValue?.error || 'unknown_error'}.${details}`);
        }
        const focusMeta = {
            inputTag: focusValue?.inputTag || null,
            inputTestId: focusValue?.inputTestId || null,
            inputRole: focusValue?.inputRole || null,
            inputContentEditable: Boolean(focusValue?.inputContentEditable),
            sendLabel: focusValue?.sendLabel || null,
            rootTag: focusValue?.rootTag || null
        };
        if (focusMeta.inputTestId === 'chat-input-ssr') {
            console.warn('[MLC Background] Claude focus selected SSR textarea (chat-input-ssr); composer may not be fully hydrated yet.');
        }

        const clickAt = async (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            await debuggerSendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
            await debuggerSendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await debuggerSendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        };

        // Ensure the target input is really focused.
        const inputX = Number(focusValue?.inputX);
        const inputY = Number(focusValue?.inputY);
        if (Number.isFinite(inputX) && Number.isFinite(inputY)) {
            await clickAt(inputX, inputY);
            await sleep(80);
        }

        const dispatchSelectAll = async (modifier) => {
            await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                key: 'a',
                code: 'KeyA',
                modifiers: modifier,
                windowsVirtualKeyCode: 65,
                nativeVirtualKeyCode: 65
            });
            await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'a',
                code: 'KeyA',
                modifiers: modifier,
                windowsVirtualKeyCode: 65,
                nativeVirtualKeyCode: 65
            });
        };

        const dispatchBackspace = async () => {
            await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                key: 'Backspace',
                code: 'Backspace',
                windowsVirtualKeyCode: 8,
                nativeVirtualKeyCode: 8
            });
            await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Backspace',
                code: 'Backspace',
                windowsVirtualKeyCode: 8,
                nativeVirtualKeyCode: 8
            });
        };

        // Clear any existing text (Cmd/Ctrl + A, Backspace).
        await dispatchSelectAll(4); // Meta (Cmd)
        await dispatchBackspace();
        await dispatchSelectAll(2); // Ctrl (fallback)
        await dispatchBackspace();

        const stateExpr = `(() => {
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (!(rect.width > 8 && rect.height > 8)) return false;
                if (rect.bottom < 0 || rect.right < 0) return false;
                if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
                return true;
            };
            const input = window.__mlcClaudeInputEl;
            const btn = window.__mlcClaudeSendBtn;
            const getText = (el) => {
                if (!el) return '';
                const tag = (el.tagName || '').toUpperCase();
                if (tag === 'TEXTAREA' || tag === 'INPUT') return String(el.value || '');
                if (el.isContentEditable || String(el.getAttribute?.('contenteditable') || '').toLowerCase() === 'true') {
                    return String(el.innerText || el.textContent || '');
                }
                return String(el.innerText || el.textContent || '');
            };
            const inputText = getText(input);
            const inputTrim = inputText.trim();
            const inputLen = inputTrim.length;
            const btnStyle = btn ? window.getComputedStyle(btn) : null;
            const pointerEvents = btnStyle ? btnStyle.pointerEvents : null;
            const disabled = !btn || !isVisible(btn)
                || Boolean(btn.disabled) || btn.getAttribute('disabled') !== null
                || String(btn.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
                || pointerEvents === 'none';
            const rect = btn && isVisible(btn) ? btn.getBoundingClientRect() : null;
            return {
                ok: Boolean(input) && Boolean(btn),
                inputConnected: Boolean(input?.isConnected),
                sendConnected: Boolean(btn?.isConnected),
                inputTag: input?.tagName?.toLowerCase?.() || null,
                inputContentEditable: Boolean(input?.isContentEditable || String(input?.getAttribute?.('contenteditable') || '').toLowerCase() === 'true'),
                inputLen,
                inputPreview: inputTrim.slice(0, 160),
                sendDisabled: disabled,
                sendPointerEvents: pointerEvents,
                sendLabel: btn?.getAttribute?.('aria-label') || '',
                sendX: rect ? rect.left + rect.width / 2 : null,
                sendY: rect ? rect.top + rect.height / 2 : null
            };
        })()`;

        const evalState = async () => {
            const result = await debuggerSendCommand(debuggee, 'Runtime.evaluate', {
                expression: stateExpr,
                returnByValue: true
            });
            return result?.result?.value || null;
        };

        const text = String(promptText || '');
        await debuggerSendCommand(debuggee, 'Input.insertText', { text });
        // Nudge: generate a real text input via key events (some apps ignore insertText-only changes).
        await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', { type: 'char', text: ' ' });
        await dispatchBackspace();
        await sleep(120);

        let state = await evalState();
        if (!state?.ok) {
            throw new Error(`Claude composer state unavailable after typing (input/send references lost). focus=${JSON.stringify(focusMeta)}`);
        }
        if (!state.inputLen) {
            throw new Error(`Claude input stayed empty after typing (input did not receive programmatic text). focus=${JSON.stringify(focusMeta)}`);
        }

        // Wait for Send to become enabled (or at least clickable).
        const startedAt = Date.now();
        while (Date.now() - startedAt < readyTimeoutMs) {
            state = await evalState();
            if (state?.ok && state.sendDisabled === false && Number.isFinite(state.sendX) && Number.isFinite(state.sendY)) {
                break;
            }
            await sleep(150);
        }

        if (!state?.ok) {
            throw new Error('Claude send readiness check failed (composer missing).');
        }
        if (state.sendDisabled) {
            throw new Error(`Claude send button stayed disabled after typing. inputLen=${state.inputLen} pointerEvents=${state.sendPointerEvents || 'unknown'} waitMs=${readyTimeoutMs} focus=${JSON.stringify(focusMeta)}`);
        }

        const ackExpr = `(() => {
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                if (!(rect.width > 4 && rect.height > 4)) return false;
                if (rect.bottom < 0 || rect.right < 0) return false;
                if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
                return true;
            };

            const composerRoot = window.__mlcClaudeComposerRoot || null;
            const input = window.__mlcClaudeInputEl || null;
            const getText = (el) => {
                if (!el) return '';
                const tag = (el.tagName || '').toUpperCase();
                if (tag === 'TEXTAREA' || tag === 'INPUT') return String(el.value || '');
                if (el.isContentEditable || String(el.getAttribute?.('contenteditable') || '').toLowerCase() === 'true') {
                    return String(el.innerText || el.textContent || '');
                }
                return String(el.innerText || el.textContent || '');
            };

            const inputText = getText(input);
            const inputTrim = inputText.trim();

            const stopSelectors = [
                'button[aria-label*="stop" i]',
                'button[aria-label*="cancel" i]',
                'button[aria-label*="annuler" i]',
                'button[aria-label*="arrêter" i]',
                'button[title*="stop" i]',
                'button[title*="cancel" i]',
                'button[data-testid*="stop" i]'
            ];
            const stopButton = document.querySelector(stopSelectors.join(','));

            const spinnerSelectors = [
                '[role="progressbar"]',
                '.animate-spin',
                '.spinner',
                '.loading'
            ];
            const spinner = document.querySelector(spinnerSelectors.join(','));

            const hasStop = Boolean(stopButton && isVisible(stopButton));
            const hasSpinner = Boolean(spinner && isVisible(spinner));
            const generating = hasStop || hasSpinner;

            const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
            const candidates = [];
            const addCandidates = (sel, limit) => {
                let nodes = [];
                try {
                    nodes = Array.from(main.querySelectorAll(sel));
                } catch (error) {
                    nodes = [];
                }
                if (nodes.length > limit) {
                    nodes = nodes.slice(nodes.length - limit);
                }
                for (const node of nodes) {
                    if (!node) continue;
                    if (composerRoot && (node === composerRoot || composerRoot.contains(node) || node.contains(composerRoot))) continue;
                    if (!isVisible(node)) continue;
                    candidates.push(node);
                }
            };
            addCandidates('article', 60);
            addCandidates('[role="article"]', 60);
            addCandidates('[data-testid*="message" i]', 80);
            addCandidates('[data-testid*="chat" i]', 80);
            addCandidates('.markdown', 80);
            addCandidates('.prose', 80);
            addCandidates('[class*="message" i]', 120);
            addCandidates('[class*="assistant" i]', 120);

            let bestNode = null;
            let bestBottom = -Infinity;
            for (const node of candidates) {
                let rect;
                try {
                    rect = node.getBoundingClientRect();
                } catch (error) {
                    rect = null;
                }
                const bottom = rect && Number.isFinite(rect.bottom) ? rect.bottom : 0;
                if (bottom >= bestBottom) {
                    bestBottom = bottom;
                    bestNode = node;
                }
            }

            const bottomText = bestNode ? getText(bestNode).trim() : '';
            return {
                href: String(location.href || ''),
                inputLen: inputTrim.length,
                inputPreview: inputTrim.slice(0, 120),
                generating,
                hasStop,
                hasSpinner,
                bottomLen: bottomText.length,
                bottomPreview: bottomText.slice(0, 200)
            };
        })()`;

        const evalAck = async () => {
            const result = await debuggerSendCommand(debuggee, 'Runtime.evaluate', {
                expression: ackExpr,
                returnByValue: true
            });
            return result?.result?.value || null;
        };

        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const probe = normalize(text).slice(0, 80);

        const beforeSend = await evalAck();

        await clickAt(Number(state.sendX), Number(state.sendY));

        const pressEnter = async () => {
            await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                key: 'Enter',
                code: 'Enter',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13
            });
            await debuggerSendCommand(debuggee, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Enter',
                code: 'Enter',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13
            });
        };

        const detectAckReason = (current) => {
            if (!current) return null;

            if (beforeSend?.href && current.href && current.href !== beforeSend.href) {
                return 'navigation';
            }

            if (beforeSend && beforeSend.generating === false && current.generating === true) {
                return current.hasStop ? 'generating_stop' : 'generating_spinner';
            }

            if (beforeSend && beforeSend.inputLen > 0 && current.inputLen === 0) {
                return 'input_cleared';
            }

            const beforeBottom = normalize(beforeSend?.bottomPreview || '');
            const currentBottom = normalize(current.bottomPreview || '');
            if (beforeBottom && currentBottom && currentBottom !== beforeBottom) {
                if (probe && probe.length >= 16 && currentBottom.includes(probe.slice(0, 16))) {
                    return 'message_appended';
                }
            }

            return null;
        };

        const waitForAck = async (timeoutMs) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                const current = await evalAck();
                const reason = detectAckReason(current);
                if (reason) return { ok: true, reason, current };
                await sleep(150);
            }
            return { ok: false, reason: null, current: await evalAck() };
        };

        let ack = await waitForAck(3500);
        if (!ack.ok) {
            await pressEnter();
            ack = await waitForAck(3500);
        }

        if (ack.ok) {
            return { ok: true, meta: { ...focusMeta, ack: ack.reason } };
        }

        const finalState = await evalState();
        const finalAck = ack.current;
        throw new Error(
            `Claude send could not be confirmed. `
            + `inputLen=${finalState?.inputLen ?? 'unknown'} `
            + `sendDisabled=${finalState?.sendDisabled ?? 'unknown'} `
            + `ackBottomLen=${finalAck?.bottomLen ?? 'unknown'} `
            + `ackGenerating=${finalAck?.generating ?? 'unknown'} `
            + `focus=${JSON.stringify(focusMeta)}`
        );
    } finally {
        await debuggerDetach(debuggee);
    }
}

async function injectAndExecute(tabId, llmType, prompt, context = {}) {
    try {
        if (llmType === 'claude') {
            console.log(`[MLC Background] Preparing Claude send for Tab ID ${tabId}.`);
        } else {
            console.log(`[MLC Background] Injecting simpleInteraction into Tab ID ${tabId} for ${llmType}.`);
        }
        
        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Sending prompt...' });

        if (llmType === 'claude') {
            const promptId = context.promptId || generatePromptId();
            try {
                const attachments = Array.isArray(context.attachments)
                    ? context.attachments.filter(Boolean)
                    : [];

                if (attachments.length > 0) {
                    console.log(`[MLC Background] Preparing ${attachments.length} attachment(s) for Claude before sending...`);
                    await injectAndPrepareAttachments(tabId, llmType, attachments);
                    if (context.sessionId) {
                        markSessionAttachmentsPrepared({ sessionId: context.sessionId }, llmType);
                    }
                }

                console.log('[MLC Background] Sending prompt to Claude via chrome.debugger...');
                const result = await sendPromptViaClaudeDebugger(tabId, prompt, {
                    readyTimeoutMs: attachments.length > 0 ? 30000 : undefined
                });
                if (result?.ok) {
                    console.log('[MLC Background] Claude debugger send succeeded (verified input cleared).', result?.meta || null);
                    const preview = typeof prompt === 'string' ? prompt.trim().slice(0, 800) : '';
                    const ack = result?.meta?.ack || null;
                    try {
                        const payload = {
                            type: 'MLC_PROMPT_SENT',
                            sessionId: context.sessionId || null,
                            promptId: promptId,
                            llmType: llmType,
                            turnIndex: context.turnIndex || null,
                            timestamp: Date.now(),
                            promptPreview: preview
                        };
                        // Claude often navigates `/new` -> `/chat/...` on send; retry until the content script is ready.
                        if (ack === 'navigation') {
                            await new Promise((resolve) => setTimeout(resolve, 600));
                        }
                        const notify = await sendTabMessageWithRetry(tabId, payload, { retries: 14, delayMs: 500 });
                        if (!notify.ok) {
                            console.warn('[MLC Background] Failed to notify Claude content script about prompt after retries:', notify.error);
                        }
                    } catch (error) {
                        console.warn('[MLC Background] Failed to notify Claude content script about prompt:', error);
                    }
                    sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Prompt sent.' });
                    return promptId;
                }
            } catch (error) {
                const rawMessage = String(error?.message || error || '').trim();
                const tips = [];
                if (/another debugger|already attached/i.test(rawMessage)) {
                    tips.push('Close DevTools on the Claude tab (only one debugger can attach).');
                }
                if (/missing.*permission|permission|not allowed|cannot access chrome\\.debugger/i.test(rawMessage)) {
                    tips.push('Reload the extension and re-enable it to grant the "debugger" permission.');
                }
                if (/focus failed|input_not_found/i.test(rawMessage)) {
                    tips.push('Open an actual Claude chat (not the landing/login page) and ensure the message box is visible.');
                }
                if (/input stayed empty after typing|did not receive programmatic text/i.test(rawMessage)) {
                    tips.push('Click inside the Claude message box once, then retry (some sessions require a real user focus).');
                }
                if (/send button stayed disabled/i.test(rawMessage)) {
                    tips.push('Verify you can type and send manually in that Claude tab; if not, Claude is blocking input (or the composer is not ready).');
                }
                const suffix = tips.length ? ` ${tips.join(' ')}` : '';
                const err = new Error(`Failed to send to Claude via debugger.${rawMessage ? ` (${rawMessage})` : ''}${suffix}`);
                err.code = 'CLAUDE_DEBUGGER_FAILED';
                err.provider = 'claude';
                throw err;
            }
        }
        
        const execOptions = {
            target: { tabId: tabId },
            func: simpleInteraction, // This function is defined below
            args: [prompt, llmType, context.attachments || null]
        };
        if (llmType === 'claude') {
            execOptions.world = 'MAIN';
        }

        let results;
        try {
            results = await chrome.scripting.executeScript(execOptions);
        } catch (error) {
            if (execOptions.world === 'MAIN') {
                delete execOptions.world;
                results = await chrome.scripting.executeScript(execOptions);
            } else {
                throw error;
            }
        }
        
        console.log(`[MLC Background] Injection results for ${llmType} (Tab ID: ${tabId}):`, JSON.stringify(results, null, 2));
        
        if (results && results[0] && results[0].result) {
            const result = results[0].result;
            if (result.success) {
                console.log(`[MLC Background] simpleInteraction SUCCEEDED for ${llmType}: ${result.method}`);
                const promptId = context.promptId || generatePromptId();
                try {
                    const preview = typeof prompt === 'string' ? prompt.trim().slice(0, 800) : '';
                    chrome.tabs.sendMessage(tabId, {
                        type: 'MLC_PROMPT_SENT',
                        sessionId: context.sessionId || null,
                        promptId: promptId,
                        llmType: llmType,
                        turnIndex: context.turnIndex || null,
                        timestamp: Date.now(),
                        promptPreview: preview
                    });
                } catch (error) {
                    console.warn('[MLC Background] Failed to notify content script about prompt:', error);
                }
                sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Prompt sent.' });
                return promptId;
            } else {
                console.error(`[MLC Background] simpleInteraction FAILED for ${llmType}:`, result.error);
                const err = new Error(result.error || `Unknown error in simpleInteraction for ${llmType}`);
                err.code = result.details?.stage === 'attachments' ? 'ATTACHMENTS_FAILED' : 'INTERACTION_FAILED';
                err.provider = llmType;
                err.details = result.details || null;
                throw err;
            }
        } else {
            const noResultError = `No result or unexpected result structure from injection for ${llmType}.`;
            console.error(`[MLC Background] ${noResultError} Results:`, results);
            const err = new Error(noResultError);
            err.code = 'INJECT_NO_RESULT';
            err.provider = llmType;
            throw err;
        }
        
    } catch (error) {
        console.error(`[MLC Background] Error injecting script for ${llmType} into Tab ID ${tabId}:`, error.message, error.stack);
        const wrapped = new Error(`Failed to interact with ${llmType}: ${error.message}`);
        wrapped.code = error?.code || 'INTERACTION_FAILED';
        wrapped.provider = llmType;
        wrapped.details = error?.details || null;
        wrapped.cause = error;
        throw wrapped;
    }
}

async function injectAndPrepareAttachments(tabId, llmType, attachments) {
    try {
        console.log(`[MLC Background] Prefetching attachments into Tab ID ${tabId} for ${llmType}.`);
        const execOptions = {
            target: { tabId: tabId },
            func: simpleInteraction,
            args: ['', llmType, attachments || null, { mode: 'prepare_attachments' }]
        };
        if (llmType === 'claude') {
            execOptions.world = 'MAIN';
        }

        let results;
        try {
            results = await chrome.scripting.executeScript(execOptions);
        } catch (error) {
            if (execOptions.world === 'MAIN') {
                delete execOptions.world;
                results = await chrome.scripting.executeScript(execOptions);
            } else {
                throw error;
            }
        }

        if (results && results[0] && results[0].result) {
            const result = results[0].result;
            if (result.success) {
                console.log(`[MLC Background] simpleInteraction prepare_attachments SUCCEEDED for ${llmType}: ${result.method}`);
                return result;
            }
            console.error(`[MLC Background] simpleInteraction prepare_attachments FAILED for ${llmType}:`, result.error);
            const err = new Error(result.error || `Unknown error preparing attachments for ${llmType}`);
            err.code = result.details?.stage === 'attachments' ? 'ATTACHMENTS_FAILED' : 'INTERACTION_FAILED';
            err.provider = llmType;
            err.details = result.details || null;
            throw err;
        }

        const noResultError = `No result or unexpected result structure from preparation injection for ${llmType}.`;
        console.error(`[MLC Background] ${noResultError} Results:`, results);
        const err = new Error(noResultError);
        err.code = 'INJECT_NO_RESULT';
        err.provider = llmType;
        throw err;
    } catch (error) {
        console.error(`[MLC Background] Error preparing attachments for ${llmType} in Tab ID ${tabId}:`, error.message, error.stack);
        const wrapped = new Error(`Failed to prepare attachments for ${llmType}: ${error.message}`);
        wrapped.code = error?.code || 'INTERACTION_FAILED';
        wrapped.provider = llmType;
        wrapped.details = error?.details || null;
        wrapped.cause = error;
        throw wrapped;
    }
}

// This function is injected and executed in the context of the target LLM's page
// ... (keep all other parts of background.js from the previous good version) ...
// ... (including onInstalled, sendMessageToPopup, onMessage, handleSendPrompt, handleForwardPrompt, processLLM, findLLMTab, injectAndExecute, checkConnectionStatus) ...

// THIS IS THE FUNCTION THAT GETS INJECTED AND EXECUTED IN THE TARGET PAGE
async function simpleInteraction(prompt, llmType, attachments, options = null) { // Added async here for the setTimeout
    const mode = options && typeof options === 'object' ? options.mode : null;
    const prepareAttachmentsOnly = mode === 'prepare_attachments';
    const promptText = typeof prompt === 'string' ? prompt : String(prompt || '');

    console.log(`[SimpleInteraction INJECTED] Attempting on ${llmType} (mode=${prepareAttachmentsOnly ? 'prepare_attachments' : 'send'}) with prompt: "${promptText.substring(0, 50)}..."`);

    try {
        let inputElement = null;
        let sendButton = null;
        const attachmentPayloads = Array.isArray(attachments) ? attachments.filter(Boolean) : [];

        function base64ToUint8Array(base64) {
            const cleaned = String(base64 || '').replace(/\s+/g, '');
            const binary = atob(cleaned);
            const len = binary.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes;
        }

        function acceptAllowsFile(accept, file) {
            const acceptValue = String(accept || '').trim().toLowerCase();
            if (!acceptValue) return true;
            const tokens = acceptValue
                .split(',')
                .map((token) => token.trim())
                .filter(Boolean);
            if (tokens.length === 0) return true;

            const name = String(file?.name || '').toLowerCase();
            const mime = String(file?.type || '').toLowerCase();

            return tokens.some((token) => {
                if (token === '*/*') return true;
                if (token.endsWith('/*')) {
                    const prefix = token.slice(0, -1);
                    return mime.startsWith(prefix);
                }
                if (token.startsWith('.')) {
                    return name.endsWith(token);
                }
                if (token.includes('/')) {
                    return mime === token;
                }
                return false;
            });
        }

        async function attachFilesToComposer(targetInput) {
            if (attachmentPayloads.length === 0) return { success: true, attached: 0 };

            const files = [];
            for (const att of attachmentPayloads) {
                const base64 = String(att?.base64 || '').trim();
                if (!base64) continue;
                const name = typeof att?.name === 'string' && att.name.trim() ? att.name.trim() : 'attachment';
                const type = typeof att?.type === 'string' && att.type.trim() ? att.type.trim() : 'application/octet-stream';
                const lastModified = Number.isFinite(att?.lastModified) ? att.lastModified : Date.now();
                try {
                    const bytes = base64ToUint8Array(base64);
                    files.push(new File([bytes], name, { type, lastModified }));
                } catch (error) {
                    return { success: false, error: `Failed to decode ${name}: ${error?.message || error}` };
                }
            }

            if (files.length === 0) return { success: true, attached: 0 };

            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const container = targetInput?.closest?.('form') || targetInput?.closest?.('main') || targetInput?.parentElement || document.body;

            const collectSearchRoots = (rootNode) => {
                const roots = [];
                const queue = [];
                const seen = new Set();
                if (rootNode) queue.push(rootNode);

                while (queue.length > 0) {
                    const current = queue.shift();
                    if (!current || seen.has(current)) continue;
                    seen.add(current);
                    roots.push(current);

                    let walker = null;
                    try {
                        walker = document.createTreeWalker(current, NodeFilter.SHOW_ELEMENT);
                    } catch (error) {
                        walker = null;
                    }
                    if (!walker) continue;

                    let node = walker.currentNode;
                    while (node) {
                        if (node.shadowRoot) queue.push(node.shadowRoot);
                        if (node.tagName === 'IFRAME') {
                            try {
                                if (node.contentDocument) queue.push(node.contentDocument);
                            } catch (error) {
                                // ignore cross-origin frames
                            }
                        }
                        node = walker.nextNode();
                    }
                }

                return roots;
            };

            const querySelectorAllDeep = (rootNode, selector) => {
                const results = [];
                const seenNodes = new Set();
                const roots = collectSearchRoots(rootNode);
                for (const root of roots) {
                    let matches = [];
                    try {
                        matches = Array.from(root.querySelectorAll(selector));
                    } catch (error) {
                        continue;
                    }
                    for (const match of matches) {
                        if (!match || seenNodes.has(match)) continue;
                        seenNodes.add(match);
                        results.push(match);
                    }
                }
                return results;
            };

            const findFileInputs = () => {
                let found = querySelectorAllDeep(container, 'input[type="file"]');
                if (found.length === 0) {
                    found = querySelectorAllDeep(document, 'input[type="file"]');
                }
                return found.filter((input) => input && !input.disabled);
            };

            const assignFiles = async (input, nextFiles) => {
                const dataTransfer = new DataTransfer();
                nextFiles.forEach((file) => dataTransfer.items.add(file));
                try {
                    input.files = dataTransfer.files;
                } catch (error) {
                    return { success: false, error: `Failed to set input.files: ${error?.message || error}` };
                }
                input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                await sleep(120);
                return { success: true };
            };

            const attachViaInputs = async (candidateInputs) => {
                const inputs = Array.isArray(candidateInputs) ? candidateInputs.filter(Boolean) : [];
                if (inputs.length === 0) {
                    return { success: false, error: 'No usable file inputs found.' };
                }

                const groups = new Map();
                for (const file of files) {
                    const candidates = inputs.filter((input) => acceptAllowsFile(input.getAttribute('accept'), file));
                    const chosen = candidates[0] || inputs[0];
                    if (!groups.has(chosen)) groups.set(chosen, []);
                    groups.get(chosen).push(file);
                }

                let attached = 0;
                for (const [input, groupFiles] of groups.entries()) {
                    if (!input.multiple && groupFiles.length > 1) {
                        for (const single of groupFiles) {
                            const result = await assignFiles(input, [single]);
                            if (!result.success) return result;
                            attached += 1;
                        }
                    } else {
                        const result = await assignFiles(input, groupFiles);
                        if (!result.success) return result;
                        attached += groupFiles.length;
                    }
                }

                return { success: true, attached, method: 'file_input' };
            };

            const dispatchDragEvent = (eventType, target, dataTransfer) => {
                if (!target || !(target instanceof Element)) return false;
                let event;
                try {
                    event = new DragEvent(eventType, { bubbles: true, cancelable: true });
                } catch (error) {
                    event = new Event(eventType, { bubbles: true, cancelable: true });
                }
                try {
                    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
                } catch (error) {
                    // ignore defineProperty failures
                }
                return target.dispatchEvent(event);
            };

            const attachViaDrop = async () => {
                if (!('DataTransfer' in window)) {
                    return { success: false, error: 'DataTransfer is unavailable (cannot use drag/drop fallback).' };
                }

                const dataTransfer = new DataTransfer();
                files.forEach((file) => dataTransfer.items.add(file));

                const rootEl = container instanceof Element ? container : document.body;
                const targets = [targetInput, rootEl, document.body].filter(Boolean);
                const uniqueTargets = [];
                targets.forEach((el) => {
                    if (el instanceof Element && !uniqueTargets.includes(el)) uniqueTargets.push(el);
                });

                for (const target of uniqueTargets) {
                    dispatchDragEvent('dragenter', target, dataTransfer);
                    dispatchDragEvent('dragover', target, dataTransfer);
                    dispatchDragEvent('drop', target, dataTransfer);
                }

                const fileNames = files.map((file) => String(file?.name || '').trim()).filter(Boolean);
                const textRoots = (() => {
                    const roots = [];
                    const preferred = targetInput?.closest?.('form') || targetInput?.parentElement || null;
                    [preferred, rootEl, document.body].forEach((node) => {
                        if (!(node instanceof Element)) return;
                        if (!roots.includes(node)) roots.push(node);
                    });
                    return roots;
                })();
                const startedAt = Date.now();
                const timeoutMs = 8000;
                while (Date.now() - startedAt < timeoutMs) {
                    const inputsNow = findFileInputs();
                    if (inputsNow.some((input) => input?.files && input.files.length > 0)) {
                        return { success: true, attached: files.length, method: 'drop', confirmed: true };
                    }
                    if (fileNames.length > 0) {
                        for (const root of textRoots) {
                            const text = (root?.innerText || root?.textContent || '').trim();
                            if (text && fileNames.some((name) => text.includes(name))) {
                                return { success: true, attached: files.length, method: 'drop', confirmed: true };
                            }
                        }
                    }
                    await sleep(200);
                }

                return { success: false, error: 'Drag/drop fallback did not confirm that files were attached.' };
            };

            let inputs = findFileInputs();
            if (inputs.length > 0) {
                const inputResult = await attachViaInputs(inputs);
                if (inputResult.success) return inputResult;
                console.warn('[SimpleInteraction INJECTED] File-input attach failed; trying drag/drop fallback.', inputResult.error);
            }

            const dropResult = await attachViaDrop();
            if (!dropResult.success) {
                if (inputs.length === 0) {
                    return {
                        success: false,
                        error: `No file input found on the page (including open shadow roots), and drag/drop fallback failed: ${dropResult.error || 'unknown error'}`
                    };
                }
                return dropResult;
            }

            // Drop may have caused a hidden file input to appear. Prefer setting it explicitly if possible.
            inputs = findFileInputs();
            if (inputs.some((input) => input?.files && input.files.length > 0)) {
                return { success: true, attached: files.length, method: 'drop' };
            }
            if (inputs.length > 0) {
                const retry = await attachViaInputs(inputs);
                if (retry.success) return retry;
                return retry;
            }

            return { success: true, attached: files.length, method: 'drop' };
        }

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
            ],
            claude: [
                'textarea[data-testid="chat-input-ssr"]',
                'textarea[placeholder*="Message" i]',
                'textarea[aria-label*="Message" i]',
                'textarea[placeholder*="Send" i]',
                'textarea',
                '.ProseMirror[contenteditable="true"]',
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"]',
                '[contenteditable="true"]'
            ],
            grok: [
                // Grok UI may use textarea or a contentEditable editor; prefer explicit roles/aria when present.
                'textarea[aria-label*="message" i]',
                'textarea[placeholder*="message" i]',
                'textarea[placeholder*="ask" i]',
                'textarea[placeholder*="chat" i]',
                'textarea',
                'div[contenteditable="true"][role="textbox"]',
                '[contenteditable="true"][role="textbox"]',
                '[contenteditable="true"]',
                '[role="textbox"]'
            ]
        };

        const currentInputSelectors = inputSelectors[llmType];
        if (!currentInputSelectors) {
            const errMsg = `[SimpleInteraction INJECTED] Unknown llmType for input selectors: ${llmType}`;
            console.error(errMsg);
            return { success: false, error: errMsg, details: { stage: 'find_input_selectors' } };
        }

        const pickBestVisibleElement = (selector) => {
            let nodes = [];
            try {
                nodes = Array.from(document.querySelectorAll(selector));
            } catch (error) {
                nodes = [];
            }
            if (nodes.length === 0) return null;

            let best = null;
            let bestBottom = -Infinity;
            for (const node of nodes) {
                if (!(node instanceof HTMLElement)) continue;
                const style = window.getComputedStyle(node);
                if (!style || style.display === 'none' || style.visibility === 'hidden') continue;
                const rect = node.getBoundingClientRect();
                if (!rect || rect.width < 4 || rect.height < 4) continue;
                if (rect.bottom < 0 || rect.right < 0) continue;
                if (rect.top > window.innerHeight + 200) continue;
                const bottom = Number.isFinite(rect.bottom) ? rect.bottom : 0;
                if (bottom >= bestBottom) {
                    bestBottom = bottom;
                    best = node;
                }
            }
            return best;
        };

        for (const selector of currentInputSelectors) {
            inputElement = pickBestVisibleElement(selector);
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

        if (attachmentPayloads.length > 0) {
            console.log(`[SimpleInteraction INJECTED] Attaching ${attachmentPayloads.length} file(s) for ${llmType}...`);
            const attachResult = await attachFilesToComposer(inputElement);
            if (!attachResult.success) {
                const errMsg = `[SimpleInteraction INJECTED] Attachment upload failed for ${llmType}: ${attachResult.error || 'unknown error'}`;
                console.error(errMsg);
                return { success: false, error: errMsg, details: { stage: 'attachments' } };
            }
            console.log(`[SimpleInteraction INJECTED] Attached ${attachResult.attached} file(s) for ${llmType}.`);
        }

        // --- Setting the prompt ---
        if (prepareAttachmentsOnly) {
            return { success: true, method: 'prepare_attachments' };
        }

        const dispatchInputEvents = (el, value) => {
            if (!el) return;
            const baseEventInit = { bubbles: true, composed: true };
            try {
                const data = typeof value === 'string' ? value.slice(-1) : '';
                el.dispatchEvent(new InputEvent('input', { ...baseEventInit, inputType: 'insertText', data }));
            } catch (error) {
                el.dispatchEvent(new Event('input', baseEventInit));
            }
            el.dispatchEvent(new Event('change', baseEventInit));
        };

        const setNativeValue = (el, value) => {
            if (!el) return;
            const stringValue = typeof value === 'string' ? value : String(value || '');
            const proto = el instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : (el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : null);
            const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
            if (descriptor && typeof descriptor.set === 'function') {
                descriptor.set.call(el, stringValue);
            } else {
                el.value = stringValue;
            }
        };

        if (inputElement.tagName === 'TEXTAREA') {
            console.log(`[SimpleInteraction INJECTED] Setting prompt for TEXTAREA element (${llmType})`);
            setNativeValue(inputElement, promptText);
            dispatchInputEvents(inputElement, promptText);
            if (llmType === 'chatgpt' || llmType === 'claude') {
                inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, composed: true }));
                inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, composed: true }));
                console.log(`[SimpleInteraction INJECTED] Dispatched extra key events for ${llmType} TEXTAREA.`);
            }
        } else if ((llmType === 'gemini' && (inputElement.isContentEditable || inputElement.contentEditable === 'true')) ||
                   (inputElement.isContentEditable || inputElement.contentEditable === 'true')) { // General contentEditable case
            console.log(`[SimpleInteraction INJECTED] Setting prompt for contentEditable element (${llmType})`);
            document.execCommand('selectAll', false, null);
            const insertSuccess = document.execCommand('insertText', false, promptText);
            console.log(`[SimpleInteraction INJECTED] Used document.execCommand('insertText'). Success: ${insertSuccess}.`);
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true })); // Ensure input event fires for contentEditable too
        } else { // Fallback for other input types (e.g. Gemini using a textarea which is rare)
            console.log(`[SimpleInteraction INJECTED] Setting prompt for standard input element (${llmType})`);
            setNativeValue(inputElement, promptText);
            dispatchInputEvents(inputElement, promptText);
        }

        // Verification Step
        await new Promise(resolve => setTimeout(resolve, 50));
        const currentText = (inputElement.isContentEditable || inputElement.contentEditable === 'true') ? inputElement.textContent : inputElement.value;
        console.log(`[SimpleInteraction INJECTED] Text in input field for ${llmType} after setting: "${currentText.substring(0,100)}..."`);
        if (!currentText.includes(promptText.substring(0, Math.min(promptText.length, 50)))) {
            console.warn(`[SimpleInteraction INJECTED] WARNING: Prompt may not have been set correctly for ${llmType}. Expected start: "${promptText.substring(0,50)}...", Got: "${currentText.substring(0,50)}..."`);
        }

        // --- Send (wait for uploads/attachment processing) ---
        const providerUiConfig = {
            chatgpt: {
                sendSelectors: [
                    'button[data-testid="send-button"]',
                    'button[data-testid="fruitjuice-send-button"]',
                    'button[aria-label="Send message" i]',
                    'button[type="submit"]'
                ],
                sendFallbackSelectors: [
                    'button[aria-label*="send" i]',
                    'button[type="submit"]'
                ],
                stopSelectors: [
                    'button[data-testid="stop-button"]',
                    'button[data-testid="stop-generating-button"]',
                    'button[aria-label*="stop" i]'
                ]
            },
            gemini: {
                sendSelectors: [
                    'button[aria-label="Send message" i]',
                    'button[data-testid="send-button"]',
                    'button.send-button',
                    'button.send-button-container button'
                ],
                sendFallbackSelectors: [
                    'button[aria-label*="send" i]',
                    'button[type="submit"]'
                ],
                stopSelectors: [
                    'button[aria-label*="stop" i]',
                    'button[data-testid*="stop" i]'
                ]
            },
            grok: {
                sendSelectors: [
                    'button[aria-label="Send message" i]',
                    'button[data-testid*="send" i]',
                    'button[title*="send" i]',
                    'button[type="submit"]'
                ],
                sendFallbackSelectors: [
                    'button[aria-label*="send" i]',
                    'button[type="submit"]'
                ],
                stopSelectors: [
                    'button[aria-label*="stop" i]',
                    'button[aria-label*="cancel" i]',
                    'button[title*="stop" i]',
                    'button[data-testid*="stop" i]'
                ]
            },
            generic: {
                sendSelectors: [
                    'button[type="submit"]',
                    'button[aria-label*="send" i]'
                ],
                sendFallbackSelectors: [
                    'button[aria-label*="send" i]',
                    'button[type="submit"]'
                ],
                stopSelectors: [
                    'button[aria-label*="stop" i]',
                    'button[data-testid*="stop" i]'
                ]
            }
        };

        const ui = providerUiConfig[llmType] || providerUiConfig.generic;

        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const resolveInputElement = () => {
            if (inputElement && inputElement.isConnected) return inputElement;
            const selectors = Array.isArray(currentInputSelectors) ? currentInputSelectors : [];
            for (const selector of selectors) {
                const candidate = document.querySelector(selector);
                if (candidate) {
                    inputElement = candidate;
                    break;
                }
            }
            return inputElement;
        };

        const getInputText = () => {
            const el = resolveInputElement();
            if (!el) return '';
            if (el.isContentEditable || el.contentEditable === 'true') return el.textContent || '';
            return el.value || '';
        };

        const isVisible = (el) => {
            if (!el || !(el instanceof Element) || !el.isConnected) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            if (style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 2 && rect.height > 2;
        };

        const isDisabledButton = (btn) => {
            if (!btn) return true;
            if (btn.disabled) return true;
            const aria = btn.getAttribute && btn.getAttribute('aria-disabled');
            if (typeof aria === 'string' && aria.toLowerCase() === 'true') return true;
            if (btn.getAttribute && btn.getAttribute('disabled') !== null) return true;
            return false;
        };

        const resolveComposerRoot = () => {
            const inputEl = resolveInputElement();
            const root = inputEl?.closest?.('form')
                || inputEl?.closest?.('fieldset')
                || inputEl?.closest?.('[role="form"]')
                || inputEl?.closest?.('main')
                || document.body;
            return root && root.isConnected ? root : document.body;
        };

        const findFirstButton = (selectors, { allowDisabled = false } = {}) => {
            const list = Array.isArray(selectors) ? selectors : [];
            for (const selector of list) {
                const roots = (() => {
                    const root = resolveComposerRoot();
                    return root === document.body ? [document.body] : [root, document.body];
                })();
                for (const root of roots) {
                    let nodes = [];
                    try {
                        nodes = Array.from(root.querySelectorAll(selector));
                    } catch (error) {
                        continue;
                    }
                    for (const node of nodes) {
                        if (!(node instanceof HTMLElement)) continue;
                        if (!isVisible(node)) continue;
                        if (!allowDisabled && isDisabledButton(node)) continue;
                        return node;
                    }
                }
            }
            return null;
        };

        const findSendButton = ({ allowDisabled = false, includeFallback = false } = {}) => {
            const selectors = includeFallback
                ? [...ui.sendSelectors, ...ui.sendFallbackSelectors]
                : ui.sendSelectors;
            return findFirstButton(selectors, { allowDisabled });
        };

        const findStopButton = () => findFirstButton(ui.stopSelectors, { allowDisabled: true });

        const waitForSendReady = async ({ timeoutMs, stableMs = 350, pollMs = 200 } = {}) => {
            const startedAt = Date.now();
            let stableSince = 0;
            while (Date.now() - startedAt < timeoutMs) {
                const btn = findSendButton({ allowDisabled: false, includeFallback: false });
                if (btn) {
                    if (!stableSince) stableSince = Date.now();
                    if (Date.now() - stableSince >= stableMs) return btn;
                } else {
                    stableSince = 0;
                }
                await sleep(pollMs);
            }
            const disabledCandidate = findSendButton({ allowDisabled: true, includeFallback: true });
            const hint = disabledCandidate
                ? `found disabled send button (${disabledCandidate.tagName.toLowerCase()})`
                : 'send button not found';
            throw new Error(`Timed out waiting for Send to become ready (${hint}).`);
        };

        const waitForSendAcknowledged = async ({ timeoutMs = 10000, pollMs = 150 } = {}) => {
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                const current = getInputText().trim();
                if (!current) return true;
                const stopBtn = findStopButton();
                if (stopBtn && isVisible(stopBtn) && !isDisabledButton(stopBtn)) return true;
                await sleep(pollMs);
            }
            return false;
        };

        const clickSendButton = (btn) => {
            if (!btn) return;
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, cancelable: true }));
            btn.click();
        };

        const pressEnterToSend = () => {
            const el = resolveInputElement();
            if (!el) return;
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
        };

        const hasAttachments = attachmentPayloads.length > 0;
        const wantsLongReadyWait = (() => {
            if (hasAttachments) return true;
            const candidate = findSendButton({ allowDisabled: true, includeFallback: true });
            return Boolean(candidate && isVisible(candidate) && isDisabledButton(candidate));
        })();
        const readyTimeoutMs = wantsLongReadyWait ? 120000 : 6000;
        const maxAttempts = wantsLongReadyWait ? 3 : 2;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (wantsLongReadyWait || attempt > 1) {
                console.log(`[SimpleInteraction INJECTED] Waiting for Send to be ready for ${llmType} (attempt ${attempt}/${maxAttempts})...`);
                await waitForSendReady({ timeoutMs: readyTimeoutMs });
            } else {
                // Allow the UI to enable the Send button after we set the prompt.
                await sleep(75);
            }

            const button = findSendButton({ allowDisabled: false, includeFallback: true });
            if (button) {
                console.log(`[SimpleInteraction INJECTED] Clicking Send for ${llmType} (attempt ${attempt}).`, button);
                clickSendButton(button);
            } else {
                console.warn(`[SimpleInteraction INJECTED] Send button not found for ${llmType}; attempting Enter (attempt ${attempt}).`);
                pressEnterToSend();
            }

            const acknowledged = await waitForSendAcknowledged();
            if (acknowledged) {
                return {
                    success: true,
                    method: button ? `button_click_for_${llmType}` : `enter_key_for_${llmType}`,
                    details: { stage: 'send', attempts: attempt }
                };
            }
            console.warn(`[SimpleInteraction INJECTED] Send not acknowledged for ${llmType} (attempt ${attempt}).`);
        }

        const errMsg = `[SimpleInteraction INJECTED] Failed to send message for ${llmType}: no acknowledgement after ${maxAttempts} attempt(s).`;
        console.error(errMsg);
        return { success: false, error: errMsg, details: { stage: 'send_not_acknowledged' } };
        
    } catch (error) {
        const errMsg = `[SimpleInteraction INJECTED] Error during interaction with ${llmType}: ${error.message} (Stack: ${error.stack})`;
        console.error(errMsg, error);
        return { success: false, error: errMsg, details: { stage: 'main_catch_block', errorMessage: error.message } };
    }
}
// ... (rest of background.js like checkConnectionStatus) ...


async function checkConnectionStatus() {
    const status = {};
    const providers = getSupportedProviderKeys();
    if (providers.length === 0) {
        status.chatgpt = false;
        status.gemini = false;
        return status;
    }
    providers.forEach((provider) => {
        status[provider] = false;
    });
    
    console.log('[MLC Background] Starting connection status check...');
    
    try {
        const profilesState = await loadTabProfiles();
        for (const provider of providers) {
            const defaultProfileId = profilesState.defaults?.[provider];
            const profile = defaultProfileId ? findProfileById(profilesState, defaultProfileId) : null;

            let tab = null;
            if (profile?.tabId) {
                tab = { id: profile.tabId };
            } else {
                tab = await findLLMTab(provider);
            }

            console.log(`[MLC Background] ${formatLLMLabel(provider)} tab result:`, tab ? `Found tab ${tab.id}` : 'Not found');

            if (!tab) {
                console.log(`[MLC Background] No ${formatLLMLabel(provider)} tab found`);
                status[provider] = false;
                continue;
            }

            try {
                console.log(`[MLC Background] Pinging ${formatLLMLabel(provider)} content script...`);
                const response = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
                console.log(`[MLC Background] ${formatLLMLabel(provider)} ping response:`, response);
                status[provider] = true;
                console.log(`[MLC Background] ${formatLLMLabel(provider)} tab responsive:`, tab.id);
            } catch (error) {
                console.log(`[MLC Background] ${formatLLMLabel(provider)} tab found but content script not responsive:`, error.message);
                status[provider] = false;
            }
        }

    } catch (error) {
        console.error('[MLC Background] Error checking connection status:', error);
    }
    
    console.log('[MLC Background] Final connection status:', status);
    return status;
}
