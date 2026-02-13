/* global chrome */

const routeBuilderApi =
    globalThis.MLCRouteBuilder && typeof globalThis.MLCRouteBuilder === 'object'
        ? globalThis.MLCRouteBuilder
        : null;
const routeBindingApi =
    globalThis.MLCRouteBinding && typeof globalThis.MLCRouteBinding === 'object'
        ? globalThis.MLCRouteBinding
        : null;
const transcriptViewApi =
    globalThis.MLCTranscriptView && typeof globalThis.MLCTranscriptView === 'object'
        ? globalThis.MLCTranscriptView
        : null;
const sidepanelStoreApi =
    globalThis.MLCSidepanelStore && typeof globalThis.MLCSidepanelStore.createUiStore === 'function'
        ? globalThis.MLCSidepanelStore
        : null;
const sidepanelActionsApi =
    globalThis.MLCSidepanelActions && typeof globalThis.MLCSidepanelActions === 'object'
        ? globalThis.MLCSidepanelActions
        : null;
const sidepanelReducerApi =
    globalThis.MLCSidepanelReducer && typeof globalThis.MLCSidepanelReducer.reducer === 'function'
        ? globalThis.MLCSidepanelReducer
        : null;
const backgroundClientApi =
    globalThis.MLCSidepanelBackgroundClient &&
    typeof globalThis.MLCSidepanelBackgroundClient.send === 'function'
        ? globalThis.MLCSidepanelBackgroundClient
        : null;
const schemaControllerApi =
    globalThis.MLCSidepanelSchemaController &&
    typeof globalThis.MLCSidepanelSchemaController.getSchemaStatus === 'function'
        ? globalThis.MLCSidepanelSchemaController
        : null;

const DEFAULT_PROVIDER_IDS = Array.isArray(routeBuilderApi?.DEFAULT_PROVIDER_IDS)
    ? routeBuilderApi.DEFAULT_PROVIDER_IDS.slice()
    : ['chatgpt', 'gemini', 'claude', 'grok'];

function initProviderMap(value) {
    const out = {};
    DEFAULT_PROVIDER_IDS.forEach((provider) => {
        out[provider] = value;
    });
    return out;
}

const initialState = {
    sessionId: null,
    sessionsByChatId: {},
    activeChatId: null,
    activeChat: null,
    activeChatHasMore: false,
    activeChatNextCursorSequence: null,
    loadingOlderMessages: false,
    chats: [],
    running: false,
    paused: false,
    stopRequested: false,
    pausedProvider: null,
    pausedAgentId: null,
    pausedProfileId: null,
    pausedAgentLabel: null,
    pausedReason: null,
    autoScroll: true,
    historyStatus: {
        historyEnabled: true,
        configured: false,
        unlocked: false,
        protectionMode: 'off',
        lockNewChatsByDefault: false,
    },
    schemaStatus: {
        version: 3,
        initialized: true,
        resetRequired: false,
        legacyDetected: false,
    },
    schemaResetInProgress: false,
    connectionStatus: initProviderMap(false),
    profileConnectionStatus: {},
    connecting: initProviderMap(false),
    profiles: [],
    defaults: initProviderMap(null),
    sessionProfiles: initProviderMap(null),
    promptConfig: null,
    promptConfigSource: null,
    providerCapabilities: null,
    route: null,
    routeLoaded: false,
    lastFocusedProvider: null,
    chatDefaultProfilesByChatId: {},
    newTabOnlyChatIds: {},
    manualUploadAckKey: null,
    attachments: [],
    attachmentsLoading: false,
    attachmentsWarning: '',
    pendingTranscriptEntries: [],
    uiPrefs: null,
    lastTemplateFocusId: 'prompt-intermediary',
};
const uiReducer = sidepanelReducerApi ? sidepanelReducerApi.reducer : null;
const uiStore = sidepanelStoreApi ? sidepanelStoreApi.createUiStore(initialState, uiReducer) : null;
let state = uiStore ? uiStore.getState() : initialState;

function patchState(patch, actionType = 'patch') {
    if (
        uiStore &&
        typeof uiStore.dispatch === 'function' &&
        sidepanelActionsApi &&
        sidepanelActionsApi.ACTION_TYPES &&
        sidepanelActionsApi.ACTION_TYPES.PATCH_STATE
    ) {
        state = uiStore.dispatch({
            type: sidepanelActionsApi.ACTION_TYPES.PATCH_STATE,
            payload: patch,
            meta: { actionType },
        });
        return state;
    }
    if (uiStore && typeof uiStore.patch === 'function') {
        state = uiStore.patch(patch, actionType);
        return state;
    }
    state = { ...state, ...(patch || {}) };
    return state;
}

const elements = {};
const HISTORY_PAGE_SIZE = 60;

const ROUTE_STORAGE_KEY_V1 = 'mlc_last_route_v1';
const ROUTE_STORAGE_KEY_V2 = 'mlc_last_route_v2';
const UI_PREFS_STORAGE_KEY = 'mlc_ui_preferences_v1';
const TEMPLATE_MODE_GUIDED = 'guided';
const TEMPLATE_MODE_ADVANCED = 'advanced';
const TEMPLATE_PRESET_CUSTOM = 'custom';
const TEMPLATE_PRESETS = {
    balanced: {
        header: `You will participate in a multi-agent debate with {other_llm} over {rounds} iterations to produce the most accurate answer for the user.

Guidelines:
- Be precise and objective.
- Critique constructively and improve the answer each round.
- Call out uncertainty briefly when needed.`,
        intermediary_message: `Improve the answer for iteration {round}/{rounds}:
- Short critique of gaps
- Revised answer with concrete fixes`,
        final_message: 'Provide your final best answer for the user. Output only the final answer.',
    },
    concise: {
        header: `You are in a focused debate with {other_llm} for {rounds} iterations.
Prioritize factual correctness and brevity.`,
        intermediary_message: `Iteration {round}/{rounds}: list only essential corrections, then provide a tighter revised answer.`,
        final_message: 'Return a concise final answer only. No critique section.',
    },
    final_only: {
        header: `You will refine with {other_llm} over {rounds} iterations and converge on one final high-quality answer.`,
        intermediary_message:
            'Use this round to validate facts and improve structure. Keep internal critique minimal.',
        final_message:
            'Provide only the final polished answer to the user. No process or critique.',
    },
};
const DEFAULT_UI_PREFS = Object.freeze({
    templateEditorMode: TEMPLATE_MODE_GUIDED,
    templatePreset: TEMPLATE_PRESET_CUSTOM,
});

const ATTACHMENTS_MAX_FILES = 10;
const ATTACHMENTS_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ATTACHMENTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

let attachmentsModalResolver = null;
let passphrasePrompt = null;
let sessionWatchdogInterval = null;
let materialSymbolFallbackObserver = null;
let materialSymbolFallbackEnabled = false;
let materialSymbolFallbackScheduled = false;

const MATERIAL_SYMBOL_FALLBACKS = {
    menu: '☰',
    add: '+',
    settings: '⚙',
    attach_file: '📎',
    expand_more: '▾',
    close: '✕',
    lock_open: '🔓',
    lock: '🔒',
    drag_indicator: '⋮⋮',
};

function hasMaterialSymbolFont() {
    const fonts = document?.fonts;
    if (!fonts || typeof fonts.check !== 'function') return false;
    try {
        return (
            fonts.check('20px "Material Symbols Rounded"') ||
            fonts.check('20px "Material Symbols Outlined"') ||
            fonts.check('20px "Material Icons"')
        );
    } catch {
        return false;
    }
}

function applyMaterialSymbolFallback(root = document) {
    if (!materialSymbolFallbackEnabled) return;
    if (!root || typeof root.querySelectorAll !== 'function') return;

    const nodes = root.querySelectorAll('.material-symbols-rounded');
    nodes.forEach((node) => {
        const raw = String(node.textContent || '').trim();
        if (!raw) return;

        const fallback = MATERIAL_SYMBOL_FALLBACKS[raw];
        if (!fallback) return;

        if (!node.dataset.mlcSymbolRaw) {
            node.dataset.mlcSymbolRaw = raw;
        }
        node.textContent = fallback;
        node.classList.add('material-symbol-fallback');
        node.setAttribute('data-symbol-name', raw);
    });
}

function scheduleMaterialSymbolFallback() {
    if (!materialSymbolFallbackEnabled) return;
    if (materialSymbolFallbackScheduled) return;
    materialSymbolFallbackScheduled = true;
    window.requestAnimationFrame(() => {
        materialSymbolFallbackScheduled = false;
        applyMaterialSymbolFallback(document);
    });
}

function ensureMaterialSymbolFallbackObserver() {
    if (!materialSymbolFallbackEnabled) return;
    if (materialSymbolFallbackObserver) return;
    if (!document?.body || typeof MutationObserver !== 'function') return;

    materialSymbolFallbackObserver = new MutationObserver(() => {
        scheduleMaterialSymbolFallback();
    });

    materialSymbolFallbackObserver.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
    });
}

function initMaterialSymbolFallback() {
    // `document.fonts.check()` is not reliable for ligature fonts in extension pages:
    // it can return true while ligatures still render as raw words (menu/settings/...).
    // Force the glyph fallback path to guarantee visible icons on all hosts.
    materialSymbolFallbackEnabled = true;
    scheduleMaterialSymbolFallback();
    ensureMaterialSymbolFallbackObserver();
}

function storageGet(keys) {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(keys, (result) => {
                if (chrome.runtime?.lastError) {
                    console.warn('[MLC UI] storage.get failed:', chrome.runtime.lastError.message);
                    resolve({});
                    return;
                }
                resolve(result || {});
            });
        } catch (error) {
            console.warn('[MLC UI] storage.get failed:', error);
            resolve({});
        }
    });
}

function storageSet(items) {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.set(items, () => {
                if (chrome.runtime?.lastError) {
                    console.warn('[MLC UI] storage.set failed:', chrome.runtime.lastError.message);
                }
                resolve();
            });
        } catch (error) {
            console.warn('[MLC UI] storage.set failed:', error);
            resolve();
        }
    });
}

function normalizeUiPrefs(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const mode =
        raw.templateEditorMode === TEMPLATE_MODE_ADVANCED
            ? TEMPLATE_MODE_ADVANCED
            : TEMPLATE_MODE_GUIDED;
    const preset = Object.prototype.hasOwnProperty.call(TEMPLATE_PRESETS, raw.templatePreset)
        ? raw.templatePreset
        : TEMPLATE_PRESET_CUSTOM;
    return {
        templateEditorMode: mode,
        templatePreset: preset,
    };
}

async function loadUiPreferences() {
    const data = await storageGet([UI_PREFS_STORAGE_KEY]);
    const prefs = normalizeUiPrefs(data?.[UI_PREFS_STORAGE_KEY]);
    state.uiPrefs = prefs;
    return prefs;
}

function persistUiPreferences(nextPrefs) {
    const prefs = normalizeUiPrefs(nextPrefs);
    state.uiPrefs = prefs;
    storageSet({ [UI_PREFS_STORAGE_KEY]: prefs });
    return prefs;
}

function cacheSession(session) {
    if (!session || !session.chatId) return;
    state.sessionsByChatId[session.chatId] = session;
}

function upsertCachedSession(chatId, patch) {
    if (!chatId) return;
    const current = getCachedSession(chatId) || { chatId };
    state.sessionsByChatId[chatId] = { ...current, ...patch, chatId };
}

function clearCachedSession(chatId) {
    if (!chatId) return;
    delete state.sessionsByChatId[chatId];
}

function getCachedSession(chatId) {
    if (!chatId) return null;
    return state.sessionsByChatId[chatId] || null;
}

function syncActiveSessionState() {
    const cached = getCachedSession(state.activeChatId);
    hydrateSession(cached);
}

function findChatIdBySessionId(sessionId) {
    if (!sessionId) return null;
    const entries = Object.entries(state.sessionsByChatId);
    for (const [chatId, session] of entries) {
        if (session?.sessionId === sessionId) return chatId;
    }
    return null;
}

function isMessageForActiveChat(message) {
    const chatId = message?.chatId || message?.session?.chatId || null;
    if (chatId) return chatId === state.activeChatId;
    if (!chatId && !state.activeChatId) return true;
    if (message?.sessionId && state.sessionId) return message.sessionId === state.sessionId;
    return false;
}

function normalizeProviderId(provider) {
    if (routeBuilderApi && typeof routeBuilderApi.normalizeProviderId === 'function') {
        const normalized = routeBuilderApi.normalizeProviderId(
            provider,
            state.providerCapabilities
        );
        if (normalized) return normalized;
    }
    const value = String(provider || '')
        .trim()
        .toLowerCase();
    if (!value) return null;
    if (DEFAULT_PROVIDER_IDS.includes(value)) return value;
    const capabilities =
        state.providerCapabilities && typeof state.providerCapabilities === 'object'
            ? state.providerCapabilities
            : null;
    if (capabilities && Object.prototype.hasOwnProperty.call(capabilities, value)) return value;
    return null;
}

function generateRouteAgentId() {
    if (routeBuilderApi && typeof routeBuilderApi.generateRouteAgentId === 'function') {
        return routeBuilderApi.generateRouteAgentId();
    }
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `agent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function normalizeProfileSelection(value) {
    if (routeBuilderApi && typeof routeBuilderApi.normalizeProfileSelection === 'function') {
        const normalized = routeBuilderApi.normalizeProfileSelection(value);
        if (normalized !== null) return normalized;
    }
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text === 'default') return 'default';
    if (text.startsWith('profile_')) return text;
    return text;
}

function normalizeRouteAgent(input) {
    if (routeBuilderApi && typeof routeBuilderApi.normalizeRouteAgent === 'function') {
        const normalized = routeBuilderApi.normalizeRouteAgent(input, {
            providerCapabilities: state.providerCapabilities,
        });
        if (normalized) return normalized;
    }
    const raw = input && typeof input === 'object' ? input : {};
    const provider = normalizeProviderId(raw.provider || raw.llm);
    if (!provider) return null;
    const profileId = normalizeProfileSelection(raw.profileId ?? raw.profile ?? raw.profile_id);
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateRouteAgentId();
    return { id, provider, profileId: profileId || null };
}

function sanitizeRoute(input) {
    if (routeBuilderApi && typeof routeBuilderApi.sanitizeRoute === 'function') {
        const normalized = routeBuilderApi.sanitizeRoute(input, {
            providerCapabilities: state.providerCapabilities,
        });
        if (normalized) return normalized;
    }
    const route = input && typeof input === 'object' ? input : {};
    const agents = [];
    const rawAgents = Array.isArray(route.agents) ? route.agents : null;
    if (rawAgents) {
        rawAgents.forEach((item) => {
            if (typeof item === 'string') {
                const provider = normalizeProviderId(item);
                if (provider)
                    agents.push({ id: generateRouteAgentId(), provider, profileId: 'default' });
                return;
            }
            const normalized = normalizeRouteAgent(item);
            if (normalized) agents.push(normalized);
        });
    } else {
        const rawProviders = Array.isArray(route.providers) ? route.providers : [];
        rawProviders.forEach((item) => {
            const provider = normalizeProviderId(item);
            if (provider)
                agents.push({ id: generateRouteAgentId(), provider, profileId: 'default' });
        });
    }

    const defaultCountByProvider = {};
    agents.forEach((agent) => {
        if (!agent?.provider) return;
        const selection = normalizeProfileSelection(agent.profileId);
        if (selection !== 'default') return;
        defaultCountByProvider[agent.provider] = (defaultCountByProvider[agent.provider] || 0) + 1;
        if (defaultCountByProvider[agent.provider] > 1) {
            agent.profileId = null;
        }
    });

    // Back-compat: older routes used `profileId: null` while effectively meaning "Default".
    // We only auto-upgrade to Default when there's a single agent for that provider, so
    // multi-agent same-provider routes can still represent "unassigned" slots.
    const agentCountsByProvider = {};
    agents.forEach((agent) => {
        if (!agent?.provider) return;
        agentCountsByProvider[agent.provider] = (agentCountsByProvider[agent.provider] || 0) + 1;
    });
    agents.forEach((agent) => {
        if (!agent?.provider) return;
        if (normalizeProfileSelection(agent.profileId)) return;
        if (agentCountsByProvider[agent.provider] !== 1) return;
        agent.profileId = 'default';
    });

    const requestedKind = String(route.kind || '')
        .trim()
        .toLowerCase();
    const roundsValue = route.rounds == null ? 3 : route.rounds;
    const rounds = clampInt(roundsValue, 1, 12);

    let kind = 'single';
    if (agents.length >= 2) {
        if (requestedKind === 'debate') kind = 'debate';
        else kind = 'parallel';
    }

    return {
        kind,
        agents,
        rounds,
    };
}

function getDefaultRoute() {
    if (routeBuilderApi && typeof routeBuilderApi.getDefaultRoute === 'function') {
        return routeBuilderApi.getDefaultRoute();
    }
    return { kind: 'single', agents: [], rounds: 3 };
}

function routeFromRunConfig(runConfig) {
    if (!runConfig || typeof runConfig !== 'object') return null;
    if (runConfig.route && typeof runConfig.route === 'object') {
        return sanitizeRoute(runConfig.route);
    }
    const runType = runConfig.runType || runConfig.mode || null;
    if (runType === 'debate') {
        const first = normalizeProviderId(runConfig.firstLLM) || 'chatgpt';
        const second = first === 'chatgpt' ? 'gemini' : 'chatgpt';
        return sanitizeRoute({
            kind: 'debate',
            providers: [first, second],
            rounds: runConfig.rounds,
        });
    }
    if (runType === 'direct') {
        const target = normalizeProviderId(runConfig.target);
        if (runConfig.target === 'both') {
            const supported = getSupportedProviders();
            const providers = supported.length >= 2 ? supported : ['chatgpt', 'gemini'];
            return sanitizeRoute({ kind: 'parallel', providers });
        }
        return sanitizeRoute({ kind: 'single', providers: [target || 'chatgpt'] });
    }
    if (runType === 'single') {
        const llm = normalizeProviderId(runConfig.llm) || 'chatgpt';
        return sanitizeRoute({ kind: 'single', providers: [llm] });
    }
    return null;
}

async function loadRoutePreference() {
    const stored = await storageGet([ROUTE_STORAGE_KEY_V2, ROUTE_STORAGE_KEY_V1]);
    const savedRouteV2 = stored?.[ROUTE_STORAGE_KEY_V2];
    const savedRouteV1 = stored?.[ROUTE_STORAGE_KEY_V1];
    const savedRoute = savedRouteV2 || savedRouteV1;
    patchState(
        {
            route: savedRoute ? sanitizeRoute(savedRoute) : getDefaultRoute(),
            routeLoaded: true,
        },
        'route_loaded'
    );
}

function saveRoutePreference(route) {
    const next = sanitizeRoute(route);
    patchState({ route: next }, 'route_saved');
    return storageSet({ [ROUTE_STORAGE_KEY_V2]: next });
}

let routeDragAgentId = null;
let routeConnectionStatusTimer = null;
let routeOutsideClickHandler = null;
let routeEscapeHandler = null;

function isRoutePopoverOpen() {
    return Boolean(elements.routePopover && !elements.routePopover.hidden);
}

function openRoutePopover() {
    if (!elements.routePopover || !elements.routeButton) return;
    if (state.running || state.paused) return;
    elements.routePopover.hidden = false;
    elements.routePopover.setAttribute('aria-hidden', 'false');
    elements.routeButton.setAttribute('aria-expanded', 'true');

    routeOutsideClickHandler = (event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (
            elements.routePopover.contains(target) ||
            elements.routeButton.contains(target) ||
            (elements.providersButton && elements.providersButton.contains(target))
        ) {
            return;
        }
        closeRoutePopover();
    };
    routeEscapeHandler = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeRoutePopover();
        }
    };
    document.addEventListener('mousedown', routeOutsideClickHandler, true);
    document.addEventListener('keydown', routeEscapeHandler, true);
    renderRouteUi();
}

function closeRoutePopover() {
    if (!elements.routePopover || !elements.routeButton) return;
    elements.routePopover.hidden = true;
    elements.routePopover.setAttribute('aria-hidden', 'true');
    elements.routeButton.setAttribute('aria-expanded', 'false');
    if (routeOutsideClickHandler) {
        document.removeEventListener('mousedown', routeOutsideClickHandler, true);
        routeOutsideClickHandler = null;
    }
    if (routeEscapeHandler) {
        document.removeEventListener('keydown', routeEscapeHandler, true);
        routeEscapeHandler = null;
    }
}

function toggleRoutePopover() {
    if (isRoutePopoverOpen()) closeRoutePopover();
    else openRoutePopover();
}

function getSupportedProviders() {
    const capabilities =
        state.providerCapabilities && typeof state.providerCapabilities === 'object'
            ? Object.keys(state.providerCapabilities)
            : [];
    const normalized = capabilities.map(normalizeProviderId).filter(Boolean);
    const unique = [...new Set(normalized)];
    if (unique.length > 0) return unique;
    return [...DEFAULT_PROVIDER_IDS];
}

function ensureProviderMaps() {
    const providers = getSupportedProviders();
    providers.forEach((provider) => {
        if (!Object.prototype.hasOwnProperty.call(state.connectionStatus, provider)) {
            state.connectionStatus[provider] = false;
        }
        if (!Object.prototype.hasOwnProperty.call(state.connecting, provider)) {
            state.connecting[provider] = false;
        }
        if (!Object.prototype.hasOwnProperty.call(state.defaults, provider)) {
            state.defaults[provider] = null;
        }
        if (!Object.prototype.hasOwnProperty.call(state.sessionProfiles, provider)) {
            state.sessionProfiles[provider] = null;
        }
    });
}

function ensureChatDefaultMap(chatId) {
    const key = String(chatId || '').trim();
    if (!key) return null;
    if (
        !state.chatDefaultProfilesByChatId ||
        typeof state.chatDefaultProfilesByChatId !== 'object'
    ) {
        state.chatDefaultProfilesByChatId = {};
    }
    const current =
        state.chatDefaultProfilesByChatId[key] &&
        typeof state.chatDefaultProfilesByChatId[key] === 'object'
            ? state.chatDefaultProfilesByChatId[key]
            : {};
    const next = { ...current };
    getSupportedProviders().forEach((provider) => {
        if (!Object.prototype.hasOwnProperty.call(next, provider)) {
            next[provider] = null;
        }
    });
    state.chatDefaultProfilesByChatId[key] = next;
    return next;
}

function isChatMarkedNewTabOnly(chatId) {
    const key = String(chatId || '').trim();
    if (!key) return false;
    return Boolean(state.newTabOnlyChatIds && state.newTabOnlyChatIds[key]);
}

function isActiveChatNewTabOnly() {
    const key = String(state.activeChatId || '').trim();
    if (!key) return true;
    return isChatMarkedNewTabOnly(key);
}

function markActiveChatAsNewTabOnly() {
    const key = String(state.activeChatId || '').trim();
    if (!key) return;
    if (!state.newTabOnlyChatIds || typeof state.newTabOnlyChatIds !== 'object') {
        state.newTabOnlyChatIds = {};
    }
    state.newTabOnlyChatIds[key] = true;
    ensureChatDefaultMap(key);
}

function getChatDefaultProfileId(chatId, provider) {
    const normalizedProvider = normalizeProviderId(provider);
    const key = String(chatId || '').trim();
    if (!normalizedProvider || !key) return null;
    const selection = normalizeProfileSelection(
        state.chatDefaultProfilesByChatId?.[key]?.[normalizedProvider]
    );
    if (!selection || selection === 'default') return null;
    return selection;
}

function getEffectiveDefaultProfileId(provider) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) return null;
    if (isActiveChatNewTabOnly()) {
        return getChatDefaultProfileId(state.activeChatId, normalizedProvider);
    }
    return state.defaults?.[normalizedProvider] || null;
}

function setActiveChatDefaultProfile(provider, profileId) {
    if (!isActiveChatNewTabOnly()) return;
    const normalizedProvider = normalizeProviderId(provider);
    const key = String(state.activeChatId || '').trim();
    if (!normalizedProvider || !key) return;
    const map = ensureChatDefaultMap(key);
    if (!map) return;
    const selection = normalizeProfileSelection(profileId);
    map[normalizedProvider] = selection && selection !== 'default' ? selection : null;
}

function getActiveChatScopedProfileIds() {
    if (!isActiveChatNewTabOnly()) return [];
    const key = String(state.activeChatId || '').trim();
    if (!key) return [];
    const map = ensureChatDefaultMap(key);
    if (!map) return [];
    return getSupportedProviders()
        .map((provider) => normalizeProfileSelection(map[provider]))
        .filter((profileId) => profileId && profileId !== 'default');
}

function syncActiveChatConnectionPolicy() {
    const key = String(state.activeChatId || '').trim();
    if (!key) return;
    if (isChatMarkedNewTabOnly(key)) {
        ensureChatDefaultMap(key);
        return;
    }
    const messages = Array.isArray(state.activeChat?.messages) ? state.activeChat.messages : [];
    if (messages.length === 0) {
        markActiveChatAsNewTabOnly();
    }
}

function resetSessionProfiles() {
    const next = {};
    getSupportedProviders().forEach((provider) => {
        next[provider] = null;
    });
    state.sessionProfiles = next;
}

function getRouteAgents(route) {
    if (routeBuilderApi && typeof routeBuilderApi.getRouteAgents === 'function') {
        return routeBuilderApi.getRouteAgents(route);
    }
    return Array.isArray(route?.agents) ? route.agents : [];
}

function countRouteAgentsByProvider(route) {
    if (routeBuilderApi && typeof routeBuilderApi.countRouteAgentsByProvider === 'function') {
        return routeBuilderApi.countRouteAgentsByProvider(route);
    }
    const counts = {};
    getRouteAgents(route).forEach((agent) => {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return;
        counts[provider] = (counts[provider] || 0) + 1;
    });
    return counts;
}

function isRouteProviderSelected(provider) {
    const route = state.route || getDefaultRoute();
    return getRouteAgents(route).some((agent) => agent.provider === provider);
}

function getRouteAgentById(route, agentId) {
    const agents = getRouteAgents(route);
    return agents.find((agent) => agent?.id === agentId) || null;
}

function pickRouteAgentBindingIndex(provider, route, { targetAgentId = null } = {}) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) return -1;
    const sourceRoute = route || state.route || getDefaultRoute();
    const agents = getRouteAgents(sourceRoute);
    if (!Array.isArray(agents) || agents.length === 0) return -1;

    const defaultProfileId = getEffectiveDefaultProfileId(normalizedProvider);
    const profilesById = {};
    (Array.isArray(state.profiles) ? state.profiles : []).forEach((profile) => {
        const profileId = typeof profile?.profileId === 'string' ? profile.profileId : null;
        if (!profileId) return;
        profilesById[profileId] = profile;
    });

    if (
        routeBindingApi &&
        typeof routeBindingApi.pickRouteAgentIndexForNewTabBinding === 'function'
    ) {
        return routeBindingApi.pickRouteAgentIndexForNewTabBinding({
            provider: normalizedProvider,
            agents,
            targetAgentId,
            defaultProfileId,
            profilesById,
            profileConnectionStatus: state.profileConnectionStatus || {},
        });
    }

    if (targetAgentId) {
        const explicitIndex = agents.findIndex(
            (agent) =>
                agent?.id === targetAgentId && normalizeProviderId(agent?.provider) === normalizedProvider
        );
        if (explicitIndex >= 0) return explicitIndex;
    }

    for (let i = agents.length - 1; i >= 0; i -= 1) {
        const agent = agents[i];
        if (normalizeProviderId(agent?.provider) !== normalizedProvider) continue;
        const selection = normalizeProfileSelection(agent?.profileId);
        if (!selection) return i;
        if (selection === 'default') {
            if (!defaultProfileId) return i;
            const profile = profilesById[defaultProfileId] || null;
            if (!profile || !isProfileRoutable(profile, normalizedProvider)) return i;
            if (getKnownProfileConnection(defaultProfileId) === false) return i;
            continue;
        }
        const profile = profilesById[selection] || null;
        if (!profile || !isProfileRoutable(profile, normalizedProvider)) return i;
        if (getKnownProfileConnection(selection) === false) return i;
    }
    return -1;
}

function pickRouteAgentBindingId(provider, route, options = {}) {
    const sourceRoute = route || state.route || getDefaultRoute();
    const agents = getRouteAgents(sourceRoute);
    const index = pickRouteAgentBindingIndex(provider, sourceRoute, options);
    if (index < 0 || !agents[index]?.id) return null;
    return agents[index].id;
}

function resolveAgentProfileId(agent) {
    const provider = normalizeProviderId(agent?.provider);
    if (!provider) return null;
    const selection = normalizeProfileSelection(agent?.profileId);
    if (!selection) return null;
    if (selection === 'default') return getEffectiveDefaultProfileId(provider);
    return selection;
}

function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripProviderPrefix(label, providerLabel) {
    const text = normalizeInlineText(label);
    if (!text) return '';
    const re = new RegExp(`^${escapeRegExp(providerLabel)}\\s*[-–—:]\\s*`, 'i');
    return text.replace(re, '').trim();
}

function formatRouteAgentLabel(agent) {
    const provider = normalizeProviderId(agent?.provider);
    if (!provider) return 'Agent';
    const providerLabel = formatProviderLabel(provider);
    const selection = normalizeProfileSelection(agent?.profileId);

    let suffix = '';
    if (!selection) {
        suffix = 'Assign tab';
    } else if (selection === 'default') {
        const profile = getDefaultProfile(provider);
        const raw = profile?.label ? stripProviderPrefix(profile.label, providerLabel) : '';
        suffix = raw || 'Default';
    } else {
        const profile = getProfileById(selection);
        const raw = profile?.label ? stripProviderPrefix(profile.label, providerLabel) : '';
        suffix = raw || 'Profile';
    }

    if (!suffix || suffix.toLowerCase() === providerLabel.toLowerCase()) return providerLabel;
    return `${providerLabel} • ${suffix}`;
}

function getRouteAgentConnectionInfo(agent) {
    const provider = normalizeProviderId(agent?.provider);
    if (!provider) {
        return {
            statusText: 'Unknown provider',
            statusTone: 'warn',
            canFocus: false,
            focusTabId: null,
            canReconnect: false,
            reconnectLabel: 'Reconnect',
        };
    }

    const selection = normalizeProfileSelection(agent?.profileId);
    if (!selection) {
        return {
            statusText: 'No tab assigned',
            statusTone: 'warn',
            canFocus: false,
            focusTabId: null,
            canReconnect: true,
            reconnectLabel: 'Connect tab',
        };
    }

    const resolvedProfileId = resolveAgentProfileId(agent);
    if (!resolvedProfileId) {
        return {
            statusText: selection === 'default' ? 'Default tab missing' : 'Profile missing',
            statusTone: 'warn',
            canFocus: false,
            focusTabId: null,
            canReconnect: true,
            reconnectLabel: selection === 'default' ? 'New tab' : 'Reconnect',
        };
    }

    const profile = getProfileById(resolvedProfileId);
    if (!profile) {
        return {
            statusText: 'Profile missing',
            statusTone: 'warn',
            canFocus: false,
            focusTabId: null,
            canReconnect: true,
            reconnectLabel: 'Reconnect',
        };
    }

    const canFocus = Number.isFinite(profile.tabId);
    const isConnected = isProfileConnected(provider, resolvedProfileId);
    const ready = isConnected && isProfileRoutable(profile, provider);
    if (ready) {
        return {
            statusText: 'Ready',
            statusTone: 'ready',
            canFocus,
            focusTabId: profile.tabId,
            canReconnect: false,
            reconnectLabel: 'Reconnect',
        };
    }

    let statusText = 'Needs reconnect';
    let statusTone = 'warn';
    if (profile.status === 'wrong_host') {
        statusText = 'Wrong site';
    } else if (profile.status === 'offline') {
        statusText = 'Tab closed';
    } else if (!canFocus) {
        statusText = 'Tab missing';
    } else if (profile.status === 'unknown') {
        statusText = 'Checking tab…';
        statusTone = 'muted';
    } else {
        const knownConnected =
            selection === 'default'
                ? isProviderReady(provider)
                : getKnownProfileConnection(resolvedProfileId);
        if (knownConnected === null) {
            statusText = 'Checking tab…';
            statusTone = 'muted';
        } else if (knownConnected === false) {
            statusText = 'Not responding';
        }
    }

    return {
        statusText,
        statusTone,
        canFocus,
        focusTabId: profile.tabId,
        canReconnect: true,
        reconnectLabel: selection === 'default' ? 'New tab' : 'Reconnect tab',
    };
}

function isProfileRoutable(profile, provider) {
    if (!profile || typeof profile !== 'object') return false;
    const normalizedProvider = normalizeProviderId(provider || profile.provider);
    if (!normalizedProvider) return false;
    if (profile.provider !== normalizedProvider) return false;
    if (profile.inUseBySessionId) return false;
    if (!Number.isFinite(profile.tabId)) return false;
    if (profile.status === 'offline') return false;
    if (profile.status === 'wrong_host') return false;
    return true;
}

function suggestProfileSelectionForNewAgent(provider, route) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) return null;
    const agents = getRouteAgents(route).filter((agent) => agent?.provider === normalizedProvider);
    if (agents.length === 0) return 'default';

    const used = new Set();
    agents.forEach((agent) => {
        const resolved = resolveAgentProfileId(agent);
        if (resolved) used.add(resolved);
    });

    const profiles = getProfilesForProvider(normalizedProvider);
    const usable = profiles.filter((profile) => isProfileRoutable(profile, normalizedProvider));
    const candidate =
        usable.find((profile) => profile.status === 'ok' && !used.has(profile.profileId)) ||
        usable.find((profile) => !used.has(profile.profileId)) ||
        null;
    return candidate ? candidate.profileId : null;
}

function addRouteAgent(provider, { profileId } = {}) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) return;
    const route = state.route || getDefaultRoute();
    const agents = getRouteAgents(route);
    const selection = profileId === undefined ? 'default' : normalizeProfileSelection(profileId);
    const nextAgent = {
        id: generateRouteAgentId(),
        provider: normalizedProvider,
        profileId: selection || null,
    };
    setRoute({ ...route, agents: [...agents, nextAgent] });
}

function setRoute(route, { persist = true } = {}) {
    const next = sanitizeRoute(route);
    patchState({ route: next }, 'route_set');
    if (persist) {
        storageSet({ [ROUTE_STORAGE_KEY_V2]: next }).catch(() => {});
    }
    renderRouteUi();
    updateSendState();
    scheduleRouteConnectionStatusCheck(next);
}

function getRouteProfileIdsForConnection(route) {
    const ids = [];
    const requiredAgents = getRouteRequiredAgents(route);
    requiredAgents.forEach((agent) => {
        const selection = normalizeProfileSelection(agent?.profileId);
        const resolvedProfileId = resolveAgentProfileId(agent);
        if (!resolvedProfileId) return;
        if (selection === 'default' && !isActiveChatNewTabOnly()) return;
        if (!ids.includes(resolvedProfileId)) ids.push(resolvedProfileId);
    });
    return ids;
}

function scheduleRouteConnectionStatusCheck(route) {
    const nextRoute = route || getRoute();
    if (routeConnectionStatusTimer) {
        window.clearTimeout(routeConnectionStatusTimer);
        routeConnectionStatusTimer = null;
    }
    routeConnectionStatusTimer = window.setTimeout(() => {
        routeConnectionStatusTimer = null;
        const profileIds = getRouteProfileIdsForConnection(nextRoute);
        requestConnectionStatus(profileIds.length ? { profileIds } : undefined);
    }, 280);
}

function setRouteKind(kind) {
    const route = state.route || getDefaultRoute();
    const agents = getRouteAgents(route);
    if (agents.length < 2) return;
    const normalizedKind = String(kind || '')
        .trim()
        .toLowerCase();
    if (normalizedKind === 'debate' && agents.length < 2) return;
    if (normalizedKind !== 'parallel' && normalizedKind !== 'debate') return;
    setRoute({ ...route, kind: normalizedKind });
}

function applyRoutePreset(preset) {
    const route = state.route || getDefaultRoute();
    const kind = String(preset || '')
        .trim()
        .toLowerCase();
    if (kind === 'single') {
        const first = getRouteAgents(route)[0] || null;
        const provider = normalizeProviderId(first?.provider) || 'chatgpt';
        setRoute({
            kind: 'single',
            agents: [{ id: generateRouteAgentId(), provider, profileId: 'default' }],
            rounds: route.rounds,
        });
        return;
    }
    if (kind === 'compare') {
        const supported = getSupportedProviders();
        const providers = supported.length >= 2 ? supported : ['chatgpt', 'gemini'];
        setRoute({
            kind: 'parallel',
            agents: providers.map((provider) => ({
                id: generateRouteAgentId(),
                provider,
                profileId: 'default',
            })),
            rounds: route.rounds,
        });
        return;
    }
    if (kind === 'debate') {
        const supported = getSupportedProviders();
        const fallbackPair = supported.length >= 2 ? supported.slice(0, 2) : ['chatgpt', 'gemini'];
        setRoute({
            kind: 'debate',
            agents: fallbackPair.map((provider) => ({
                id: generateRouteAgentId(),
                provider,
                profileId: 'default',
            })),
            rounds: route.rounds || 3,
        });
    }
}

function swapRouteProviders() {
    const route = state.route || getDefaultRoute();
    const agents = getRouteAgents(route);
    if (agents.length < 2) return;
    setRoute({ ...route, agents: [...agents].reverse() });
}

function formatRouteSummary(route) {
    if (routeBuilderApi && typeof routeBuilderApi.formatRouteSummary === 'function') {
        return routeBuilderApi.formatRouteSummary(route, (agent) => formatRouteAgentLabel(agent));
    }
    const agents = getRouteAgents(route);
    if (agents.length === 0) return 'Select agents…';
    if (agents.length === 1) return formatRouteAgentLabel(agents[0]);

    const counts = countRouteAgentsByProvider(route);
    const summary = Object.entries(counts)
        .map(([provider, count]) => {
            const label = formatProviderLabel(provider);
            return count > 1 ? `${label} ×${count}` : label;
        })
        .join(' + ');

    if (route?.kind === 'debate' && agents.length >= 2) {
        const rounds = route.rounds || 1;
        return `Debate (${summary}, ${rounds})`;
    }
    return summary;
}

function renderRouteUi() {
    const route = state.route || getDefaultRoute();
    const summary = formatRouteSummary(route);

    if (elements.routePillText) {
        elements.routePillText.textContent = summary;
    }

    if (elements.routeButton) {
        elements.routeButton.title = summary;
    }

    const agentCount = getRouteAgents(route).length;
    if (elements.routeModeSection) {
        elements.routeModeSection.hidden = agentCount < 2;
    }

    if (elements.routeModeDebate) {
        elements.routeModeDebate.hidden = agentCount < 2;
    }

    if (elements.routeModeParallel) {
        elements.routeModeParallel.classList.toggle(
            'is-active',
            agentCount >= 2 && route.kind === 'parallel'
        );
    }
    if (elements.routeModeDebate) {
        elements.routeModeDebate.classList.toggle(
            'is-active',
            agentCount >= 2 && route.kind === 'debate'
        );
    }

    const debateEnabled = agentCount >= 2 && route.kind === 'debate';
    if (elements.routeDebateSettings) {
        elements.routeDebateSettings.hidden = !debateEnabled;
    }
    if (elements.routeRounds) {
        elements.routeRounds.value = String(clampInt(route.rounds || 3, 1, 12));
    }

    renderRouteSelectedChips(route);
    renderRouteProviderList(route);
    updateRouteConnectAllUi();
}

function updateRouteConnectAllUi() {
    if (!elements.routeConnectAll) return;
    const supported = getSupportedProviders();
    const anyConnecting = supported.some((provider) => Boolean(state.connecting?.[provider]));
    const route = getRoute();
    const routeHasAgents = getRouteAgents(route).length > 0;
    const routeConfigured =
        isRouteValid(route) && isRouteSupported(route) && isRouteConfigured(route);
    const anyNeedsConnect = routeConfigured
        ? !isRouteConnected(route)
        : supported.some((provider) => {
              const profile = getDefaultProfile(provider);
              const ready = isProviderReady(provider);
              if (!profile) return true;
              if (profile.inUseBySessionId) return true;
              if (!Number.isFinite(profile.tabId)) return true;
              if (profile.status === 'offline' || profile.status === 'wrong_host') return true;
              return !ready;
          });
    if (anyConnecting) {
        elements.routeConnectAll.textContent = 'Connecting…';
        elements.routeConnectAll.disabled = true;
        return;
    }
    if (!routeHasAgents) {
        if (anyNeedsConnect) {
            elements.routeConnectAll.textContent = 'Connect all';
        } else {
            elements.routeConnectAll.textContent = 'Add all agents';
        }
        elements.routeConnectAll.disabled = false;
        return;
    }
    if (!anyNeedsConnect) {
        elements.routeConnectAll.textContent = 'All connected';
        elements.routeConnectAll.disabled = true;
        return;
    }
    elements.routeConnectAll.textContent = routeConfigured ? 'Fix connections' : 'Connect all';
    elements.routeConnectAll.disabled = false;
}

function renderRouteSelectedChips(route) {
    if (!elements.routeSelected) return;
    elements.routeSelected.innerHTML = '';
    const agents = getRouteAgents(route);
    if (agents.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'route-help';
        empty.textContent = 'No agents selected.';
        elements.routeSelected.appendChild(empty);
        return;
    }
    const counts = countRouteAgentsByProvider(route);
    const seen = {};

    agents.forEach((agent) => {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return;
        seen[provider] = (seen[provider] || 0) + 1;
        const providerLabel = formatProviderLabel(provider);
        const displayLabel =
            counts[provider] > 1 ? `${providerLabel} ${seen[provider]}` : providerLabel;

        const row = document.createElement('div');
        row.className = 'route-agent';
        row.dataset.agentId = agent.id;

        const handle = document.createElement('span');
        handle.className = 'material-symbols-rounded route-agent-handle';
        handle.textContent = 'drag_indicator';
        handle.draggable = true;
        handle.dataset.agentId = agent.id;
        handle.setAttribute('aria-label', 'Drag to reorder');
        row.appendChild(handle);

        const main = document.createElement('div');
        main.className = 'route-agent-main';

        const name = document.createElement('span');
        name.className = 'route-agent-name';
        name.textContent = displayLabel;
        main.appendChild(name);

        const info = getRouteAgentConnectionInfo(agent);
        const status = document.createElement('span');
        status.className = 'route-agent-status';
        status.classList.toggle('is-ready', info.statusTone === 'ready');
        status.classList.toggle('is-warn', info.statusTone === 'warn');
        status.classList.toggle('is-muted', info.statusTone === 'muted');
        status.textContent = info.statusText;
        main.appendChild(status);

        row.appendChild(main);

        const actions = document.createElement('div');
        actions.className = 'route-agent-actions';

        if (info.canFocus && Number.isFinite(info.focusTabId)) {
            const focus = document.createElement('button');
            focus.type = 'button';
            focus.className = 'ghost-button';
            focus.dataset.action = 'focus-route-agent';
            focus.dataset.agentId = agent.id;
            focus.setAttribute('aria-label', `Focus ${formatRouteAgentLabel(agent)} tab`);
            focus.textContent = 'Focus';
            actions.appendChild(focus);
        }

        if (info.canReconnect) {
            const reconnect = document.createElement('button');
            reconnect.type = 'button';
            reconnect.className = 'ghost-button';
            reconnect.dataset.action = 'reconnect-route-agent';
            reconnect.dataset.agentId = agent.id;
            reconnect.setAttribute(
                'aria-label',
                `${info.reconnectLabel} for ${formatRouteAgentLabel(agent)}`
            );
            reconnect.textContent = info.reconnectLabel;
            actions.appendChild(reconnect);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'route-chip-remove';
        remove.dataset.action = 'remove-route-agent';
        remove.dataset.agentId = agent.id;
        remove.setAttribute('aria-label', `Remove ${formatRouteAgentLabel(agent)}`);

        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = 'close';
        remove.appendChild(icon);

        actions.appendChild(remove);
        row.appendChild(actions);
        elements.routeSelected.appendChild(row);
    });
}

function renderRouteProviderList(route) {
    if (!elements.routeProviderList) return;
    elements.routeProviderList.innerHTML = '';
    const supported = getSupportedProviders();
    const agentCounts = countRouteAgentsByProvider(route);
    supported.forEach((provider) => {
        const selectedCount = agentCounts[provider] || 0;
        const ready = isProviderReady(provider);
        const connecting = Boolean(state.connecting?.[provider]);
        const profile = getDefaultProfile(provider);
        const busy = Boolean(profile?.inUseBySessionId);
        const connected = Boolean(profile?.tabId && ready && !busy);
        const modelHint = profile?.modelHint ? ` • ${profile.modelHint}` : '';

        let statusText = 'Not connected';
        if (connecting) statusText = 'Connecting…';
        else if (busy) statusText = 'In use';
        else if (ready) statusText = 'Ready';
        else if (profile?.status === 'wrong_host') statusText = 'Wrong host';
        else if (profile?.status === 'unknown') statusText = 'Loading…';
        else if (profile?.status === 'ok') statusText = 'Waiting…';

        const usingText = connected
            ? `Using: ${profile.label || formatProviderLabel(provider)}${modelHint}`
            : profile?.label
              ? `Last: ${profile.label}${modelHint}`
              : 'No tab yet';

        const item = document.createElement('div');
        item.className = 'route-provider-item';
        item.classList.toggle('is-active', provider === state.lastFocusedProvider);
        item.dataset.provider = provider;

        const meta = document.createElement('div');
        meta.className = 'route-provider-meta';

        const name = document.createElement('div');
        name.className = 'route-provider-name';

        const dot = document.createElement('span');
        dot.className = 'route-provider-dot';
        dot.classList.toggle('is-ready', ready);
        dot.classList.toggle('is-connecting', connecting);
        dot.classList.toggle('is-busy', busy);
        name.appendChild(dot);

        const nameText = document.createElement('span');
        nameText.textContent = formatProviderLabel(provider);
        name.appendChild(nameText);

        meta.appendChild(name);

        const status = document.createElement('div');
        status.className = 'route-provider-status';
        const inRouteLabel = selectedCount > 0 ? ` • ${selectedCount} in route` : '';
        status.textContent = `${statusText} • ${usingText}${inRouteLabel}`;
        meta.appendChild(status);

        const actions = document.createElement('div');
        actions.className = 'route-provider-actions';

        if (profile?.tabId) {
            const focus = document.createElement('button');
            focus.type = 'button';
            focus.className = 'ghost-button';
            focus.dataset.provider = provider;
            focus.dataset.action = 'focus-provider';
            focus.textContent = 'Focus';
            focus.disabled = connecting || !profile?.tabId;
            actions.appendChild(focus);
        }

        const newTab = document.createElement('button');
        newTab.type = 'button';
        newTab.className = 'ghost-button';
        newTab.dataset.provider = provider;
        newTab.dataset.action = 'new-tab';
        newTab.textContent = connecting
            ? 'Opening…'
            : selectedCount > 0
              ? 'New tab + agent'
              : 'New tab';
        newTab.disabled = connecting;
        actions.appendChild(newTab);

        item.appendChild(meta);
        item.appendChild(actions);
        elements.routeProviderList.appendChild(item);
    });
}

function handleRouteProviderListClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button');
    const providerFromButton = button?.dataset.provider;
    const action = button?.dataset.action || '';
    const provider = normalizeProviderId(
        providerFromButton || target.closest('[data-provider]')?.dataset.provider
    );
    if (!provider) return;

    if (action === 'focus-provider') {
        focusProvider(provider);
        return;
    }
    if (action === 'new-tab' || action === 'connect-provider') {
        const targetAgentId = pickRouteAgentBindingId(provider, state.route || getDefaultRoute());
        openNewTabAndBindAgent(provider, { targetAgentId });
        return;
    }
}

function handleRouteSelectedClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const agentId = button.dataset.agentId;
    if (!agentId) return;

    const route = state.route || getDefaultRoute();

    if (action === 'remove-route-agent') {
        const agents = getRouteAgents(route).filter((agent) => agent?.id !== agentId);
        setRoute({ ...route, agents });
        return;
    }
    if (action === 'focus-route-agent') {
        focusRouteAgent(agentId);
        return;
    }
    if (action === 'reconnect-route-agent') {
        reconnectRouteAgent(agentId);
    }
}

function handleRouteChipDragStart(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const handle = target.closest('.route-agent-handle');
    const row = target.closest('.route-agent');
    const agentId = handle?.dataset.agentId || row?.dataset.agentId || '';
    if (!agentId) return;
    routeDragAgentId = agentId;
    try {
        event.dataTransfer?.setData('text/plain', agentId);
        if (row) event.dataTransfer?.setDragImage(row, 10, 10);
    } catch (error) {
        // Ignore DataTransfer restrictions.
    }
}

function handleRouteChipDragOver(event) {
    if (!routeDragAgentId) return;
    event.preventDefault();
}

function handleRouteChipDrop(event) {
    if (!routeDragAgentId) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const row = target.closest('.route-agent');
    const dropAgentId = row?.dataset.agentId || '';
    if (!dropAgentId || dropAgentId === routeDragAgentId) return;
    const route = state.route || getDefaultRoute();
    const agents = getRouteAgents(route);
    const fromIndex = agents.findIndex((agent) => agent?.id === routeDragAgentId);
    const toIndex = agents.findIndex((agent) => agent?.id === dropAgentId);
    if (fromIndex === -1 || toIndex === -1) return;
    const nextAgents = [...agents];
    const [moved] = nextAgents.splice(fromIndex, 1);
    nextAgents.splice(toIndex, 0, moved);
    setRoute({ ...route, agents: nextAgents });
}

function handleRouteChipDragEnd() {
    routeDragAgentId = null;
}

document.addEventListener('DOMContentLoaded', async () => {
    initMaterialSymbolFallback();

    elements.promptInput = document.getElementById('prompt-input');
    elements.sendButton = document.getElementById('send-button');
    elements.charCount = document.getElementById('char-count');
    elements.autoScroll = document.getElementById('auto-scroll');
    elements.timeline = document.getElementById('timeline');
    elements.emptyState = document.getElementById('empty-state');
    elements.providersButton = document.getElementById('providers-button');
    elements.sessionStatus = document.getElementById('session-status');
    elements.sessionBanner = document.getElementById('session-banner');
    elements.composerHint = document.getElementById('composer-hint');

    elements.routeButton = document.getElementById('route-button');
    elements.routePillText = document.getElementById('route-pill-text');
    elements.routePopover = document.getElementById('route-popover');
    elements.routeClose = document.getElementById('route-close');
    elements.routeSelected = document.getElementById('route-selected');
    elements.routeSelectedHelp = document.getElementById('route-selected-help');
    elements.routeProviderList = document.getElementById('route-provider-list');
    elements.routeModeSection = document.getElementById('route-mode-section');
    elements.routeModeParallel = document.getElementById('route-mode-parallel');
    elements.routeModeDebate = document.getElementById('route-mode-debate');
    elements.routeDebateSettings = document.getElementById('route-debate-settings');
    elements.routeRounds = document.getElementById('route-rounds');
    elements.routeSwap = document.getElementById('route-swap');
    elements.routePresetSingle = document.getElementById('route-preset-single');
    elements.routePresetCompare = document.getElementById('route-preset-compare');
    elements.routePresetDebate = document.getElementById('route-preset-debate');
    elements.routeConnectAll = document.getElementById('route-connect-all');
    elements.routeManageProviders = document.getElementById('route-manage-providers');
    elements.routeDone = document.getElementById('route-done');

    elements.emptyOpenRoute = document.getElementById('empty-open-route');

    elements.attachmentInput = document.getElementById('attachment-input');
    elements.attachmentButton = document.getElementById('attachment-button');
    elements.attachmentSummary = document.getElementById('attachment-summary');
    elements.attachmentClear = document.getElementById('attachment-clear');
    elements.attachmentList = document.getElementById('attachment-list');

    elements.chatsButton = document.getElementById('chats-button');
    elements.newChatButton = document.getElementById('new-chat-button');
    elements.chatLockButton = document.getElementById('chat-lock-button');
    elements.chatLockIcon = document.getElementById('chat-lock-icon');
    elements.settingsButton = document.getElementById('settings-button');

    elements.chatsDrawer = document.getElementById('chats-drawer');
    elements.chatsBackdrop = document.getElementById('chats-backdrop');
    elements.closeChatsButton = document.getElementById('close-chats');
    elements.drawerNewChatButton = document.getElementById('drawer-new-chat');
    elements.chatList = document.getElementById('chat-list');

    elements.settingsDrawer = document.getElementById('settings-drawer');
    elements.settingsBackdrop = document.getElementById('settings-backdrop');
    elements.closeSettingsButton = document.getElementById('close-settings');

    elements.pausedActions = document.getElementById('paused-actions');
    elements.resumeButton = document.getElementById('resume-session');
    elements.pausedFocusButton = document.getElementById('paused-focus');
    elements.pausedRebindButton = document.getElementById('paused-rebind');
    elements.promptInitial = document.getElementById('prompt-initial');
    elements.promptIntermediary = document.getElementById('prompt-intermediary');
    elements.promptFinal = document.getElementById('prompt-final');
    elements.promptLoadButton = document.getElementById('prompt-load');
    elements.promptSaveButton = document.getElementById('prompt-save');
    elements.promptResetButton = document.getElementById('prompt-reset');
    elements.promptStatus = document.getElementById('prompt-status');
    elements.promptModeGuidedButton = document.getElementById('prompt-mode-guided');
    elements.promptModeAdvancedButton = document.getElementById('prompt-mode-advanced');
    elements.promptTemplateFields = document.getElementById('prompt-template-fields');
    elements.promptGuidedPresets = document.getElementById('prompt-guided-presets');
    elements.promptTokenBlock = document.getElementById('prompt-token-block');
    elements.promptPresetButtons = Array.from(
        document.querySelectorAll('.template-preset-button[data-preset]')
    );
    elements.promptTokenButtons = Array.from(
        document.querySelectorAll('.template-token[data-token]')
    );
    elements.promptAdvancedPanel = document.getElementById('prompt-advanced-panel');
    elements.promptAdvancedJson = document.getElementById('prompt-advanced-json');
    elements.promptAdvancedHelp = document.getElementById('prompt-advanced-help');

    elements.historyConfigureButton = document.getElementById('history-configure');
    elements.historyUnlockButton = document.getElementById('history-unlock');
    elements.historyLockButton = document.getElementById('history-lock');
    elements.historyBadge = document.getElementById('history-badge');
    elements.historyOverviewText = document.getElementById('history-overview-text');
    elements.historyAdvanced = document.getElementById('history-advanced');
    elements.historyLockNewRow = document.getElementById('history-lock-new-row');
    elements.historyLockNew = document.getElementById('history-lock-new');
    elements.historyResetProtection = document.getElementById('history-reset-protection');
    elements.historyClearAll = document.getElementById('history-clear-all');
    elements.historyStatus = document.getElementById('history-status');

    elements.passphraseBackdrop = document.getElementById('passphrase-backdrop');
    elements.passphraseModal = document.getElementById('passphrase-modal');
    elements.passphraseTitle = document.getElementById('passphrase-title');
    elements.passphraseNote = document.getElementById('passphrase-note');
    elements.passphraseInput = document.getElementById('passphrase-input');
    elements.passphraseConfirmField = document.getElementById('passphrase-confirm-field');
    elements.passphraseConfirm = document.getElementById('passphrase-confirm');
    elements.passphraseError = document.getElementById('passphrase-error');
    elements.passphraseCancel = document.getElementById('passphrase-cancel');
    elements.passphraseClose = document.getElementById('passphrase-close');
    elements.passphraseSubmit = document.getElementById('passphrase-submit');

    elements.schemaResetBackdrop = document.getElementById('schema-reset-backdrop');
    elements.schemaResetModal = document.getElementById('schema-reset-modal');
    elements.schemaResetConfirm = document.getElementById('schema-reset-confirm');

    elements.modalBackdrop = document.getElementById('modal-backdrop');
    elements.attachmentsModal = document.getElementById('attachments-modal');
    elements.attachmentsModalTitle = document.getElementById('attachments-modal-title');
    elements.attachmentsModalText = document.getElementById('attachments-modal-text');
    elements.attachmentsModalOk = document.getElementById('attachments-modal-ok');
    elements.attachmentsModalCancel = document.getElementById('attachments-modal-cancel');
    elements.attachmentsModalClose = document.getElementById('attachments-modal-close');

    bindEvents();
    await loadUiPreferences();
    updatePromptEditorUi();
    await loadRoutePreference();
    renderRouteUi();
    scheduleRouteConnectionStatusCheck();
    updateHistoryUi();
    updateCharCount();
    updateAttachmentsUi();
    updateSendState();

    requestProfiles();
    requestConnectionStatus();
    requestHistoryStatus({ hydrateChats: true });
    requestSchemaStatus();
    requestActiveSession();
    requestProviderCapabilities();
    loadPromptTemplates();
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
                handlePrimaryAction();
            }
        });
    }

    if (elements.sendButton) {
        elements.sendButton.addEventListener('click', handlePrimaryAction);
    }

    if (elements.attachmentButton && elements.attachmentInput) {
        elements.attachmentButton.addEventListener('click', () => {
            if (state.running || state.paused || state.attachmentsLoading) return;
            elements.attachmentInput.click();
        });
    }

    if (elements.attachmentInput) {
        elements.attachmentInput.addEventListener('change', (event) => {
            const files = Array.from(event.target?.files || []);
            // Allow selecting the same file twice in a row.
            event.target.value = '';
            if (files.length === 0) return;
            addAttachments(files).catch((error) => {
                console.warn('[MLC UI] Failed to add attachments:', error);
                state.attachmentsLoading = false;
                state.attachmentsWarning = 'Failed to read attachments.';
                updateAttachmentsUi();
                updateSendState();
            });
        });
    }

    if (elements.attachmentClear) {
        elements.attachmentClear.addEventListener('click', clearAttachments);
    }

    if (elements.attachmentList) {
        elements.attachmentList.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const removeButton = target.closest('button[data-action="remove-attachment"]');
            if (!removeButton) return;
            const id = removeButton.dataset.attachmentId;
            if (id) removeAttachment(id);
        });
    }

    if (elements.routeButton) {
        elements.routeButton.addEventListener('click', () => {
            if (state.running || state.paused) return;
            toggleRoutePopover();
        });
    }

    if (elements.routeClose) {
        elements.routeClose.addEventListener('click', closeRoutePopover);
    }

    if (elements.routeDone) {
        elements.routeDone.addEventListener('click', closeRoutePopover);
    }

    if (elements.routeConnectAll) {
        elements.routeConnectAll.addEventListener('click', connectAllProviders);
    }

    if (elements.routeManageProviders) {
        elements.routeManageProviders.addEventListener('click', () => {
            closeRoutePopover();
            openSettingsDrawer();
        });
    }

    if (elements.routePresetSingle) {
        elements.routePresetSingle.addEventListener('click', () => applyRoutePreset('single'));
    }

    if (elements.routePresetCompare) {
        elements.routePresetCompare.addEventListener('click', () => applyRoutePreset('compare'));
    }

    if (elements.routePresetDebate) {
        elements.routePresetDebate.addEventListener('click', () => applyRoutePreset('debate'));
    }

    if (elements.routeProviderList) {
        elements.routeProviderList.addEventListener('click', handleRouteProviderListClick);
    }

    if (elements.routeSelected) {
        elements.routeSelected.addEventListener('click', handleRouteSelectedClick);
        elements.routeSelected.addEventListener('dragstart', handleRouteChipDragStart);
        elements.routeSelected.addEventListener('dragover', handleRouteChipDragOver);
        elements.routeSelected.addEventListener('drop', handleRouteChipDrop);
        elements.routeSelected.addEventListener('dragend', handleRouteChipDragEnd);
    }

    if (elements.routeModeParallel) {
        elements.routeModeParallel.addEventListener('click', () => setRouteKind('parallel'));
    }

    if (elements.routeModeDebate) {
        elements.routeModeDebate.addEventListener('click', () => setRouteKind('debate'));
    }

    if (elements.routeRounds) {
        elements.routeRounds.addEventListener('change', () => {
            const nextRounds = clampInt(elements.routeRounds.value, 1, 12);
            elements.routeRounds.value = String(nextRounds);
            setRoute({ ...state.route, rounds: nextRounds });
        });
    }

    if (elements.routeSwap) {
        elements.routeSwap.addEventListener('click', swapRouteProviders);
    }

    if (elements.autoScroll) {
        elements.autoScroll.addEventListener('change', () => {
            state.autoScroll = elements.autoScroll.checked;
        });
    }

    if (elements.providersButton) {
        elements.providersButton.addEventListener('click', () => {
            if (state.running || state.paused) {
                openSettingsDrawer();
                return;
            }
            toggleRoutePopover();
        });
    }

    if (elements.chatsButton) {
        elements.chatsButton.addEventListener('click', openChatsDrawer);
    }

    if (elements.newChatButton) {
        elements.newChatButton.addEventListener('click', createNewChat);
    }

    if (elements.chatsBackdrop) {
        elements.chatsBackdrop.addEventListener('click', closeChatsDrawer);
    }

    if (elements.closeChatsButton) {
        elements.closeChatsButton.addEventListener('click', closeChatsDrawer);
    }

    if (elements.drawerNewChatButton) {
        elements.drawerNewChatButton.addEventListener('click', () => {
            createNewChat();
            closeChatsDrawer();
        });
    }

    if (elements.chatList) {
        elements.chatList.addEventListener('click', handleChatListClick);
    }

    if (elements.settingsButton) {
        elements.settingsButton.addEventListener('click', openSettingsDrawer);
    }

    if (elements.settingsBackdrop) {
        elements.settingsBackdrop.addEventListener('click', closeSettingsDrawer);
    }

    if (elements.closeSettingsButton) {
        elements.closeSettingsButton.addEventListener('click', closeSettingsDrawer);
    }

    if (elements.emptyOpenRoute) {
        elements.emptyOpenRoute.addEventListener('click', () => {
            openRoutePopover();
            elements.routeButton?.focus();
        });
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

    if (elements.promptLoadButton) {
        elements.promptLoadButton.addEventListener('click', loadPromptTemplates);
    }

    if (elements.promptSaveButton) {
        elements.promptSaveButton.addEventListener('click', savePromptTemplates);
    }

    if (elements.promptResetButton) {
        elements.promptResetButton.addEventListener('click', resetPromptTemplates);
    }

    if (elements.promptModeGuidedButton) {
        elements.promptModeGuidedButton.addEventListener('click', () => {
            setTemplateEditorMode(TEMPLATE_MODE_GUIDED);
        });
    }

    if (elements.promptModeAdvancedButton) {
        elements.promptModeAdvancedButton.addEventListener('click', () => {
            setTemplateEditorMode(TEMPLATE_MODE_ADVANCED);
        });
    }

    if (Array.isArray(elements.promptPresetButtons)) {
        elements.promptPresetButtons.forEach((button) => {
            button.addEventListener('click', () => {
                applyPromptPreset(button.dataset.preset || '');
            });
        });
    }

    if (Array.isArray(elements.promptTokenButtons)) {
        elements.promptTokenButtons.forEach((button) => {
            button.addEventListener('click', () => {
                insertTemplateToken(button.dataset.token || '');
            });
        });
    }

    if (elements.promptInitial) {
        elements.promptInitial.addEventListener('focus', () => setTemplateFocus('prompt-initial'));
        elements.promptInitial.addEventListener('input', () => {
            setTemplatePresetSelection(detectTemplatePreset(getPromptGuidedValues()), {
                persist: false,
            });
            syncAdvancedPromptEditor(
                buildPromptConfigFromGuided(
                    state.promptConfig && typeof state.promptConfig === 'object'
                        ? state.promptConfig
                        : {}
                )
            );
        });
    }
    if (elements.promptIntermediary) {
        elements.promptIntermediary.addEventListener('focus', () =>
            setTemplateFocus('prompt-intermediary')
        );
        elements.promptIntermediary.addEventListener('input', () => {
            setTemplatePresetSelection(detectTemplatePreset(getPromptGuidedValues()), {
                persist: false,
            });
            syncAdvancedPromptEditor(
                buildPromptConfigFromGuided(
                    state.promptConfig && typeof state.promptConfig === 'object'
                        ? state.promptConfig
                        : {}
                )
            );
        });
    }
    if (elements.promptFinal) {
        elements.promptFinal.addEventListener('focus', () => setTemplateFocus('prompt-final'));
        elements.promptFinal.addEventListener('input', () => {
            setTemplatePresetSelection(detectTemplatePreset(getPromptGuidedValues()), {
                persist: false,
            });
            syncAdvancedPromptEditor(
                buildPromptConfigFromGuided(
                    state.promptConfig && typeof state.promptConfig === 'object'
                        ? state.promptConfig
                        : {}
                )
            );
        });
    }
    if (elements.promptAdvancedJson) {
        elements.promptAdvancedJson.addEventListener('focus', () =>
            setTemplateFocus('prompt-advanced-json')
        );
        elements.promptAdvancedJson.addEventListener('input', () => {
            setTemplatePresetSelection(TEMPLATE_PRESET_CUSTOM, { persist: false });
        });
    }

    if (elements.chatLockButton) {
        elements.chatLockButton.addEventListener('click', toggleActiveChatProtection);
    }

    if (elements.historyConfigureButton) {
        elements.historyConfigureButton.addEventListener('click', configureHistoryEncryption);
    }

    if (elements.historyUnlockButton) {
        elements.historyUnlockButton.addEventListener('click', unlockHistory);
    }

    if (elements.historyLockButton) {
        elements.historyLockButton.addEventListener('click', lockHistory);
    }

    if (elements.historyLockNew) {
        elements.historyLockNew.addEventListener('change', (event) => {
            setLockNewChatsByDefault(Boolean(event?.target?.checked));
        });
    }

    if (elements.historyResetProtection) {
        elements.historyResetProtection.addEventListener('click', resetProtection);
    }

    if (elements.historyClearAll) {
        elements.historyClearAll.addEventListener('click', clearAllChats);
    }

    if (elements.passphraseClose) {
        elements.passphraseClose.addEventListener('click', cancelPassphrasePrompt);
    }

    if (elements.passphraseCancel) {
        elements.passphraseCancel.addEventListener('click', cancelPassphrasePrompt);
    }

    if (elements.passphraseBackdrop) {
        elements.passphraseBackdrop.addEventListener('click', cancelPassphrasePrompt);
    }

    if (elements.passphraseSubmit) {
        elements.passphraseSubmit.addEventListener('click', submitPassphrasePrompt);
    }

    if (elements.schemaResetConfirm) {
        elements.schemaResetConfirm.addEventListener('click', runSchemaReset);
    }

    if (elements.attachmentsModalOk) {
        elements.attachmentsModalOk.addEventListener('click', () => closeAttachmentsModal(true));
    }
    if (elements.attachmentsModalCancel) {
        elements.attachmentsModalCancel.addEventListener('click', () =>
            closeAttachmentsModal(false)
        );
    }
    if (elements.attachmentsModalClose) {
        elements.attachmentsModalClose.addEventListener('click', () =>
            closeAttachmentsModal(false)
        );
    }
    if (elements.modalBackdrop) {
        elements.modalBackdrop.addEventListener('click', () => closeAttachmentsModal(false));
    }

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (isAttachmentsModalOpen()) {
                event.preventDefault();
                closeAttachmentsModal(false);
                return;
            }
            if (passphrasePrompt) {
                event.preventDefault();
                cancelPassphrasePrompt();
                return;
            }
            return;
        }
        if (event.key === 'Enter' && passphrasePrompt) {
            event.preventDefault();
            submitPassphrasePrompt();
        }
    });

    if (chrome?.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    }
}

function sendMessage(message, callback) {
    if (backgroundClientApi) {
        backgroundClientApi.send(message, callback);
        return;
    }
    if (!chrome?.runtime?.sendMessage) return;
    const protocol =
        window.MLCProtocolV3 && typeof window.MLCProtocolV3.withProtocolEnvelope === 'function'
            ? window.MLCProtocolV3
            : null;
    const outbound = protocol ? protocol.withProtocolEnvelope(message) : message;
    if (protocol && (!outbound || typeof outbound !== 'object' || !outbound.command)) {
        const response = {
            ok: false,
            error: 'Unsupported control message: missing protocol command.',
            code: 'UNKNOWN_COMMAND',
        };
        if (callback) callback(response);
        return;
    }
    chrome.runtime.sendMessage(outbound, (response) => {
        if (chrome.runtime.lastError) {
            const msgType = outbound?.command || outbound?.type || 'unknown';
            console.warn('Message failed:', msgType, chrome.runtime.lastError.message);
        }
        if (callback) callback(response);
    });
}

function sendMessageAsync(message) {
    return new Promise((resolve) => {
        sendMessage(message, (response) => resolve(response));
    });
}

function isAttachmentsModalOpen() {
    return Boolean(elements.attachmentsModal && elements.attachmentsModal.hidden === false);
}

function showAttachmentsModal({ title, text }) {
    if (!elements.attachmentsModal || !elements.modalBackdrop) {
        return Promise.resolve(true);
    }

    if (attachmentsModalResolver) {
        attachmentsModalResolver(true);
        attachmentsModalResolver = null;
    }

    if (elements.attachmentsModalTitle) {
        elements.attachmentsModalTitle.textContent = title || 'Attachments';
    }
    if (elements.attachmentsModalText) {
        elements.attachmentsModalText.textContent = text || '';
    }

    elements.modalBackdrop.hidden = false;
    elements.attachmentsModal.hidden = false;

    window.setTimeout(() => {
        if (elements.attachmentsModalOk) elements.attachmentsModalOk.focus();
    }, 0);

    return new Promise((resolve) => {
        attachmentsModalResolver = resolve;
    });
}

function closeAttachmentsModal(result) {
    if (elements.attachmentsModal) {
        elements.attachmentsModal.hidden = true;
    }
    if (elements.modalBackdrop) {
        elements.modalBackdrop.hidden = true;
    }
    const resolver = attachmentsModalResolver;
    attachmentsModalResolver = null;
    if (resolver) resolver(Boolean(result));
}
function handleActionResponse(response) {
    if (response && response.ok === false && response.error) {
        setSessionStatus(`Error: ${response.error}`);
    }
}

function normalizeHistoryStatus(status) {
    const raw = status && typeof status === 'object' ? status : {};
    const configured = Boolean(raw.configured);
    const hasLockNewFlag = typeof raw.lockNewChatsByDefault === 'boolean';
    return {
        historyEnabled: true,
        configured,
        unlocked: Boolean(raw.unlocked),
        protectionMode: configured ? 'per_chat' : 'off',
        lockNewChatsByDefault: hasLockNewFlag ? Boolean(raw.lockNewChatsByDefault) : configured,
    };
}

function getActiveChatSummary() {
    const chatId = state.activeChatId;
    if (!chatId) return null;
    const fromList = Array.isArray(state.chats)
        ? state.chats.find((chat) => chat?.chatId === chatId)
        : null;
    if (fromList) return fromList;
    if (state.activeChat && state.activeChat.chatId === chatId) return state.activeChat;
    return null;
}

function isHistoryAppLocked() {
    // Passphrase protection is per-chat only; there is no global app lock state.
    return false;
}

function isActiveChatLocked() {
    const summary = getActiveChatSummary();
    return Boolean(summary?.locked);
}

function isHistoryBlocked() {
    return Boolean(isActiveChatLocked());
}

function getHistoryBlockedHint() {
    if (isActiveChatLocked()) return 'Unlock this chat to continue.';
    return '';
}

function normalizeSchemaStatus(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return {
        version: Number.isFinite(Number(value.version)) ? Number(value.version) : 3,
        initialized: Boolean(value.initialized),
        resetRequired: Boolean(value.resetRequired),
        legacyDetected: Boolean(value.legacyDetected),
    };
}

function isSchemaResetRequired() {
    return Boolean(state.schemaStatus?.resetRequired);
}

function renderSchemaResetModal() {
    const shouldShow = isSchemaResetRequired();
    if (elements.schemaResetBackdrop) {
        elements.schemaResetBackdrop.hidden = !shouldShow;
    }
    if (elements.schemaResetModal) {
        elements.schemaResetModal.hidden = !shouldShow;
    }
    if (elements.schemaResetConfirm) {
        elements.schemaResetConfirm.disabled = state.schemaResetInProgress;
        elements.schemaResetConfirm.textContent = state.schemaResetInProgress
            ? 'Resetting...'
            : 'Reset and continue';
    }
}

function updateSchemaStatus(nextStatus) {
    state.schemaStatus = normalizeSchemaStatus(nextStatus);
    renderSchemaResetModal();
    updateSendState();
}

function requestSchemaStatus() {
    if (schemaControllerApi && typeof schemaControllerApi.getSchemaStatus === 'function') {
        schemaControllerApi
            .getSchemaStatus()
            .then((response) => {
                if (!response || response.ok === false) return;
                updateSchemaStatus(response.status);
            })
            .catch(() => {});
        return;
    }
    sendMessage({ command: 'SCHEMA_STATUS' }, (response) => {
        if (!response || response.ok === false) return;
        updateSchemaStatus(response.status);
    });
}

async function runSchemaReset() {
    if (state.schemaResetInProgress) return;
    state.schemaResetInProgress = true;
    renderSchemaResetModal();
    setSessionStatus('Resetting local data for schema v3 upgrade...');

    const response =
        schemaControllerApi && typeof schemaControllerApi.runSchemaReset === 'function'
            ? await schemaControllerApi.runSchemaReset()
            : await sendMessageAsync({ command: 'SCHEMA_RESET' });
    state.schemaResetInProgress = false;

    if (!response || response.ok === false) {
        setSessionStatus(`Error: ${response?.error || 'Schema reset failed.'}`);
        renderSchemaResetModal();
        return;
    }

    updateSchemaStatus({
        version: 3,
        initialized: true,
        resetRequired: false,
        legacyDetected: false,
    });
    setSessionStatus('Schema v3 upgrade complete. Local state was reset.');
    requestHistoryStatus({ hydrateChats: true });
    requestProfiles();
    requestConnectionStatus();
    requestActiveSession();
}

function updateChatLockButton() {
    if (!elements.chatLockButton || !elements.chatLockIcon) return;
    // Keep chat-level protection controls hidden to preserve a simpler global passphrase UX.
    elements.chatLockButton.hidden = true;
}

function setHistoryStatus(text, isError = false) {
    if (!elements.historyStatus) return;
    elements.historyStatus.textContent = text;
    elements.historyStatus.classList.toggle('is-error', Boolean(isError));
}

function updateHistoryStatus(nextStatus) {
    const prev = state.historyStatus;
    state.historyStatus = normalizeHistoryStatus(nextStatus);
    const didLock = Boolean(prev?.unlocked && !state.historyStatus.unlocked);
    updateHistoryUi();
    updateChatLockButton();

    if (didLock) {
        const summary = getActiveChatSummary();
        const shouldClearActive = isHistoryAppLocked() || Boolean(summary?.isProtected);
        if (shouldClearActive) {
            state.activeChat = null;
            state.activeChatHasMore = false;
            state.activeChatNextCursorSequence = null;
            clearTranscript();
        }
    }

    renderChatList();
    updateSendState();
}

function updateHistoryUi() {
    const configured = Boolean(state.historyStatus?.configured);
    const unlocked = Boolean(state.historyStatus?.unlocked);
    const protectNewChats = Boolean(configured && state.historyStatus?.lockNewChatsByDefault);
    const uiLocked = Boolean(state.running || state.paused);

    if (!configured) {
        setHistoryStatus('Passphrase: off. New chats are saved without encryption.');
    } else if (protectNewChats && !unlocked) {
        setHistoryStatus(
            'Passphrase: on. New chats are protected. Unlock to open protected chats.'
        );
    } else if (protectNewChats) {
        setHistoryStatus('Passphrase: on and unlocked. New chats are protected.');
    } else if (!unlocked) {
        setHistoryStatus(
            'Passphrase: off for new chats. Protected chats stay locked until unlocked.'
        );
    } else {
        setHistoryStatus('Passphrase: off for new chats. Protected chats are currently unlocked.');
    }

    if (elements.historyBadge) {
        if (!configured) {
            elements.historyBadge.textContent = 'Off';
        } else if (protectNewChats) {
            elements.historyBadge.textContent = unlocked ? 'On (unlocked)' : 'On (locked)';
        } else {
            elements.historyBadge.textContent = 'Paused';
        }
        elements.historyBadge.classList.toggle('is-off', !configured);
        elements.historyBadge.classList.toggle(
            'is-locked',
            configured && protectNewChats && !unlocked
        );
        elements.historyBadge.classList.toggle(
            'is-unlocked',
            configured && protectNewChats && unlocked
        );
        elements.historyBadge.classList.toggle('is-paused', configured && !protectNewChats);
    }
    if (elements.historyOverviewText) {
        if (!configured) {
            elements.historyOverviewText.textContent =
                'History is always saved on this device. Set a passphrase to protect new chats.';
        } else if (protectNewChats) {
            elements.historyOverviewText.textContent =
                'Passphrase protection is active for new chats. Protected chats require unlock to open.';
        } else {
            elements.historyOverviewText.textContent =
                'Passphrase is paused for new chats. Existing protected chats remain protected and require unlock.';
        }
    }

    if (elements.historyConfigureButton) {
        elements.historyConfigureButton.textContent = 'Set passphrase…';
        elements.historyConfigureButton.hidden = configured;
        elements.historyConfigureButton.disabled = uiLocked || configured;
    }
    if (elements.historyUnlockButton) {
        elements.historyUnlockButton.textContent = 'Unlock protected chats';
        elements.historyUnlockButton.hidden = !configured || unlocked;
        elements.historyUnlockButton.disabled = uiLocked || !configured || unlocked;
    }
    if (elements.historyLockButton) {
        elements.historyLockButton.textContent = 'Lock protected chats';
        elements.historyLockButton.hidden = !configured || !unlocked;
        elements.historyLockButton.disabled = uiLocked || !configured || !unlocked;
    }

    if (elements.historyAdvanced) {
        elements.historyAdvanced.hidden = false;
    }

    if (elements.historyLockNewRow) {
        elements.historyLockNewRow.hidden = !configured;
    }
    if (elements.historyLockNew) {
        elements.historyLockNew.checked = protectNewChats;
        elements.historyLockNew.disabled = uiLocked || !configured;
    }
    if (elements.historyResetProtection) {
        elements.historyResetProtection.hidden = !configured;
        elements.historyResetProtection.disabled = uiLocked || !configured;
    }
    if (elements.historyClearAll) {
        elements.historyClearAll.hidden = false;
        elements.historyClearAll.disabled = uiLocked;
    }
}

function setPassphrasePromptError(text) {
    if (!elements.passphraseError) return;
    const normalized = String(text || '').trim();
    elements.passphraseError.textContent = normalized;
    elements.passphraseError.hidden = !normalized;
}

function openPassphrasePrompt({ mode, errorText = null } = {}) {
    if (passphrasePrompt?.promise) {
        setPassphrasePromptError(errorText);
        return passphrasePrompt.promise;
    }
    if (!elements.passphraseBackdrop || !elements.passphraseModal || !elements.passphraseInput) {
        return Promise.resolve(null);
    }

    const promptPromise = new Promise((resolve) => {
        passphrasePrompt = { mode, resolve, promise: null };
    });
    passphrasePrompt.promise = promptPromise;

    const configuring = mode === 'configure';
    if (elements.passphraseTitle) {
        elements.passphraseTitle.textContent = configuring
            ? 'Set passphrase'
            : 'Unlock protected chats';
    }
    if (elements.passphraseNote) {
        elements.passphraseNote.textContent = configuring
            ? 'Set a passphrase to protect your new chats.'
            : 'Enter your passphrase to unlock protected chats.';
    }
    if (elements.passphraseConfirmField) {
        elements.passphraseConfirmField.hidden = !configuring;
    }
    if (elements.passphraseSubmit) {
        elements.passphraseSubmit.textContent = configuring ? 'Save' : 'Unlock';
    }

    elements.passphraseBackdrop.hidden = false;
    elements.passphraseModal.hidden = false;
    elements.passphraseModal.setAttribute('aria-hidden', 'false');
    setPassphrasePromptError(errorText);

    elements.passphraseInput.value = '';
    if (elements.passphraseConfirm) elements.passphraseConfirm.value = '';

    window.setTimeout(() => {
        elements.passphraseInput?.focus();
    }, 0);

    return promptPromise;
}

function closePassphrasePrompt(result) {
    if (!passphrasePrompt) return;
    const { resolve } = passphrasePrompt;
    passphrasePrompt = null;

    if (elements.passphraseBackdrop) elements.passphraseBackdrop.hidden = true;
    if (elements.passphraseModal) {
        elements.passphraseModal.hidden = true;
        elements.passphraseModal.setAttribute('aria-hidden', 'true');
    }
    if (elements.passphraseInput) elements.passphraseInput.value = '';
    if (elements.passphraseConfirm) elements.passphraseConfirm.value = '';
    setPassphrasePromptError(null);

    resolve(result === undefined ? null : result);
}

function cancelPassphrasePrompt() {
    closePassphrasePrompt(null);
}

function submitPassphrasePrompt() {
    if (!passphrasePrompt) return;
    const mode = passphrasePrompt.mode;
    const passphrase = String(elements.passphraseInput?.value || '');
    const confirm = String(elements.passphraseConfirm?.value || '');

    if (!passphrase.trim()) {
        setPassphrasePromptError('Passphrase is empty.');
        elements.passphraseInput?.focus();
        return;
    }
    if (mode === 'configure' && passphrase !== confirm) {
        setPassphrasePromptError('Passphrases do not match.');
        elements.passphraseConfirm?.focus();
        return;
    }

    if (mode === 'configure') {
        closePassphrasePrompt(passphrase);
        return;
    }

    closePassphrasePrompt(passphrase);
}

async function promptForPassphrase({ mode, errorText = null } = {}) {
    if (!elements.passphraseBackdrop || !elements.passphraseModal || !elements.passphraseInput) {
        const first = window.prompt('Enter your passphrase');
        if (first === null) return null;
        const passphrase = String(first || '');
        if (!passphrase.trim()) return null;
        return passphrase;
    }
    return openPassphrasePrompt({ mode, errorText });
}

async function promptForPassphraseSetup({ errorText = null } = {}) {
    if (!elements.passphraseBackdrop || !elements.passphraseModal || !elements.passphraseInput) {
        const first = window.prompt('Set a passphrase');
        if (first === null) return null;
        const passphrase = String(first || '');
        if (!passphrase.trim()) return null;
        const confirmValue = window.prompt('Confirm passphrase');
        if (confirmValue === null) return null;
        if (passphrase !== String(confirmValue || '')) {
            window.alert('Passphrases do not match.');
            return null;
        }
        return passphrase;
    }

    const result = await openPassphrasePrompt({ mode: 'configure', errorText });
    const passphrase = String(result || '');
    if (!passphrase.trim()) return null;
    return passphrase;
}

async function configureHistoryEncryption() {
    if (state.historyStatus?.configured) return;

    const passphrase = await promptForPassphraseSetup();
    if (passphrase === null) return;

    setHistoryStatus('Setting passphrase…');
    const response = await sendMessageAsync({
        type: 'HISTORY_CONFIGURE',
        passphrase,
        protectionMode: 'per_chat',
    });
    if (!response || response.ok === false) {
        const code = response?.code || '';
        if (code === 'ENCRYPTION_ALREADY_CONFIGURED') {
            setHistoryStatus('Passphrase already set. Use Unlock protected chats.', true);
            requestHistoryStatus({ hydrateChats: true });
            return;
        }
        setHistoryStatus(`Error: ${response?.error || 'Failed to set passphrase.'}`, true);
        return;
    }
    updateHistoryStatus(response.status);
    requestChatsState();
}

async function setLockNewChatsByDefault(enabled) {
    if (!state.historyStatus?.configured) return;
    const nextEnabled = Boolean(enabled);
    const wasUnlocked = Boolean(state.historyStatus?.unlocked);
    const response = await sendMessageAsync({
        type: 'HISTORY_SET_LOCK_NEW_CHATS',
        enabled: nextEnabled,
    });
    if (!response || response.ok === false) {
        setHistoryStatus(`Error: ${response?.error || 'Failed to update settings.'}`, true);
        requestHistoryStatus({ hydrateChats: false });
        return;
    }
    updateHistoryStatus(response.status);
    if (!nextEnabled && wasUnlocked) {
        await lockHistory({
            statusText: 'Pausing passphrase for new chats…',
            finalStatus: 'New chats no longer require passphrase. Protected chats are locked.',
        });
        return;
    }
    requestChatsState();
}

async function resetProtection() {
    if (!state.historyStatus?.configured) return;
    const confirmed = window.confirm(
        'Reset passphrase? Protected chats will be deleted. Unprotected chats will remain.'
    );
    if (!confirmed) return;

    setHistoryStatus('Resetting passphrase…');
    const response = await sendMessageAsync({ type: 'HISTORY_RESET_PROTECTION' });
    if (!response || response.ok === false) {
        setHistoryStatus(`Error: ${response?.error || 'Failed to reset passphrase.'}`, true);
        return;
    }
    updateHistoryStatus(response.status);
    requestChatsState();
}

async function clearAllChats() {
    const confirmed = window.confirm(
        'Delete all chats on this device? This removes both protected and unprotected chats and cannot be undone.'
    );
    if (!confirmed) return;

    setHistoryStatus('Deleting chats…');
    const response = await sendMessageAsync({ type: 'HISTORY_CLEAR_ALL' });
    if (!response || response.ok === false) {
        setHistoryStatus(`Error: ${response?.error || 'Failed to delete chats.'}`, true);
        return;
    }

    updateHistoryStatus(response.status);
    state.chats = [];
    state.activeChat = null;
    state.activeChatId = null;
    state.activeChatHasMore = false;
    state.activeChatNextCursorSequence = null;
    clearTranscript();
    updateChatLockButton();
    renderChatList();
    updateSendState();
    requestChatsState();
}

async function toggleActiveChatProtection() {
    const chatId = state.activeChatId;
    if (!chatId) return;
    if (!state.historyStatus?.configured) {
        openSettingsDrawer();
        configureHistoryEncryption().catch(() => {});
        return;
    }

    const unlocked = await unlockHistory({ auto: false });
    if (!unlocked) return;

    const summary = getActiveChatSummary();
    const isProtected = Boolean(summary?.isProtected);
    if (isProtected) {
        const confirmed = window.confirm(
            'Unprotect this chat? It will be stored unencrypted on this device.'
        );
        if (!confirmed) return;
        setSessionStatus('Unprotecting chat…');
        const response = await sendMessageAsync({ type: 'UNPROTECT_CHAT', chatId });
        if (!response || response.ok === false) {
            setSessionStatus(`Error: ${response?.error || 'Failed to unprotect chat.'}`);
            return;
        }
        requestChatsState();
        loadChat(chatId);
        return;
    }

    setSessionStatus('Protecting chat…');
    const response = await sendMessageAsync({ type: 'PROTECT_CHAT', chatId });
    if (!response || response.ok === false) {
        setSessionStatus(`Error: ${response?.error || 'Failed to protect chat.'}`);
        return;
    }
    requestChatsState();
    updateChatLockButton();
}

async function unlockHistory({ auto = false } = {}) {
    if (!state.historyStatus?.configured) {
        if (!auto) setHistoryStatus('Passphrase is not set yet.', true);
        return false;
    }
    if (state.historyStatus?.unlocked) return true;

    let errorText = null;
    while (true) {
        const passphrase = await promptForPassphrase({ mode: 'unlock', errorText });
        if (passphrase === null) return false;

        setHistoryStatus('Unlocking…');
        const response = await sendMessageAsync({ type: 'HISTORY_UNLOCK', passphrase });
        if (!response || response.ok === false) {
            const code = response?.code || '';
            if (code === 'PASSPHRASE_INVALID') {
                errorText = 'Incorrect passphrase.';
                continue;
            }
            if (code === 'ENCRYPTION_NOT_CONFIGURED') {
                setHistoryStatus('Passphrase is not set yet.', true);
                requestHistoryStatus({ hydrateChats: false });
                return false;
            }
            setHistoryStatus(`Error: ${response?.error || 'Failed to unlock history.'}`, true);
            return false;
        }
        updateHistoryStatus(response.status);
        requestChatsState();
        return true;
    }
}

async function lockHistory({ statusText = 'Locking…', finalStatus = '' } = {}) {
    setHistoryStatus(statusText);
    const response = await sendMessageAsync({ type: 'HISTORY_LOCK' });
    if (!response || response.ok === false) {
        setHistoryStatus(`Error: ${response?.error || 'Failed to lock history.'}`, true);
        return false;
    }
    if (Array.isArray(state.chats)) {
        state.chats = state.chats.map((chat) => {
            if (!chat || !chat.isProtected) return chat;
            return { ...chat, title: 'Locked chat', lastPreview: '', locked: true };
        });
    }
    updateHistoryStatus(response.status);
    requestChatsState();
    if (finalStatus) setHistoryStatus(finalStatus);
    return true;
}

function resetHistory() {
    const confirmed = window.confirm(
        'Reset encrypted history? This will delete all chats and remove your encryption setup.'
    );
    if (!confirmed) return;
    setHistoryStatus('Resetting history…');
    sendMessage({ type: 'HISTORY_RESET' }, (response) => {
        if (!response || response.ok === false) {
            setHistoryStatus(`Error: ${response?.error || 'Failed to reset history.'}`, true);
            return;
        }
        updateHistoryStatus(response.status);
        state.chats = [];
        state.activeChat = null;
        state.activeChatId = null;
        state.activeChatHasMore = false;
        state.activeChatNextCursorSequence = null;
        clearTranscript();
        renderChatList();
    });
}

function setPromptStatus(text, isError = false) {
    if (!elements.promptStatus) return;
    elements.promptStatus.textContent = text;
    elements.promptStatus.classList.toggle('is-error', Boolean(isError));
}

function getTemplateEditorMode() {
    return state.uiPrefs?.templateEditorMode === TEMPLATE_MODE_ADVANCED
        ? TEMPLATE_MODE_ADVANCED
        : TEMPLATE_MODE_GUIDED;
}

function normalizeTemplatePresetId(value) {
    if (Object.prototype.hasOwnProperty.call(TEMPLATE_PRESETS, value)) return value;
    return TEMPLATE_PRESET_CUSTOM;
}

function getPromptGuidedValues() {
    return {
        header: String(elements.promptInitial?.value || '').trim(),
        intermediary_message: String(elements.promptIntermediary?.value || '').trim(),
        final_message: String(elements.promptFinal?.value || '').trim(),
    };
}

function detectTemplatePreset(values) {
    const candidate = values && typeof values === 'object' ? values : {};
    const header = String(candidate.header || '').trim();
    const intermediary = String(candidate.intermediary_message || '').trim();
    const finalMessage = String(candidate.final_message || '').trim();
    const presetId = Object.keys(TEMPLATE_PRESETS).find((id) => {
        const preset = TEMPLATE_PRESETS[id];
        return (
            String(preset.header || '').trim() === header &&
            String(preset.intermediary_message || '').trim() === intermediary &&
            String(preset.final_message || '').trim() === finalMessage
        );
    });
    return normalizeTemplatePresetId(presetId || TEMPLATE_PRESET_CUSTOM);
}

function setTemplatePresetSelection(presetId, { persist = false } = {}) {
    const nextPreset = normalizeTemplatePresetId(presetId);
    const current = normalizeUiPrefs(state.uiPrefs || DEFAULT_UI_PREFS);
    const nextPrefs = { ...current, templatePreset: nextPreset };
    if (persist) {
        persistUiPreferences(nextPrefs);
    } else {
        state.uiPrefs = nextPrefs;
    }
    updatePromptEditorUi();
}

function setTemplateEditorMode(mode, { persist = true } = {}) {
    const nextMode =
        mode === TEMPLATE_MODE_ADVANCED ? TEMPLATE_MODE_ADVANCED : TEMPLATE_MODE_GUIDED;
    const current = normalizeUiPrefs(state.uiPrefs || DEFAULT_UI_PREFS);
    const nextPrefs = { ...current, templateEditorMode: nextMode };
    if (persist) {
        persistUiPreferences(nextPrefs);
    } else {
        state.uiPrefs = nextPrefs;
    }
    updatePromptEditorUi();
}

function updatePromptEditorUi() {
    const mode = getTemplateEditorMode();
    const prefs = normalizeUiPrefs(state.uiPrefs || DEFAULT_UI_PREFS);

    if (elements.promptModeGuidedButton) {
        const active = mode === TEMPLATE_MODE_GUIDED;
        elements.promptModeGuidedButton.classList.toggle('is-active', active);
        elements.promptModeGuidedButton.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (elements.promptModeAdvancedButton) {
        const active = mode === TEMPLATE_MODE_ADVANCED;
        elements.promptModeAdvancedButton.classList.toggle('is-active', active);
        elements.promptModeAdvancedButton.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    if (elements.promptTemplateFields) {
        elements.promptTemplateFields.hidden = mode === TEMPLATE_MODE_ADVANCED;
    }
    if (elements.promptGuidedPresets) {
        elements.promptGuidedPresets.hidden = mode === TEMPLATE_MODE_ADVANCED;
    }
    if (elements.promptTokenBlock) {
        elements.promptTokenBlock.hidden = mode === TEMPLATE_MODE_ADVANCED;
    }
    if (elements.promptAdvancedPanel) {
        elements.promptAdvancedPanel.open = mode === TEMPLATE_MODE_ADVANCED;
    }

    if (Array.isArray(elements.promptPresetButtons)) {
        elements.promptPresetButtons.forEach((button) => {
            const presetId = normalizeTemplatePresetId(button?.dataset?.preset || '');
            button.classList.toggle('is-active', prefs.templatePreset === presetId);
        });
    }
}

function syncAdvancedPromptEditor(config) {
    if (!elements.promptAdvancedJson) return;
    const safe = config && typeof config === 'object' ? config : {};
    elements.promptAdvancedJson.value = `${JSON.stringify(safe, null, 2)}\n`;
}

function setTemplateFocus(templateId) {
    state.lastTemplateFocusId = templateId || 'prompt-intermediary';
}

function getTemplateFocusElement() {
    if (getTemplateEditorMode() === TEMPLATE_MODE_ADVANCED && elements.promptAdvancedJson) {
        return elements.promptAdvancedJson;
    }
    const focusId = state.lastTemplateFocusId || 'prompt-intermediary';
    if (focusId === 'prompt-initial') return elements.promptInitial || null;
    if (focusId === 'prompt-final') return elements.promptFinal || null;
    if (focusId === 'prompt-intermediary') return elements.promptIntermediary || null;
    return elements.promptIntermediary || elements.promptInitial || elements.promptFinal || null;
}

function insertTemplateToken(token) {
    const safeToken = String(token || '').trim();
    if (!safeToken) return;
    const field = getTemplateFocusElement();
    if (!field) return;

    const value = String(field.value || '');
    const start = Number.isFinite(field.selectionStart) ? field.selectionStart : value.length;
    const end = Number.isFinite(field.selectionEnd) ? field.selectionEnd : value.length;
    field.value = `${value.slice(0, start)}${safeToken}${value.slice(end)}`;
    if (typeof field.setSelectionRange === 'function') {
        const caret = start + safeToken.length;
        field.setSelectionRange(caret, caret);
    }
    field.focus();
    field.dispatchEvent(new Event('input', { bubbles: true }));
    setPromptStatus(`Inserted ${safeToken}.`);
}

function applyPromptPreset(presetId) {
    const normalizedPreset = normalizeTemplatePresetId(presetId);
    const preset = TEMPLATE_PRESETS[normalizedPreset];
    if (!preset) return;
    if (elements.promptInitial) elements.promptInitial.value = preset.header;
    if (elements.promptIntermediary)
        elements.promptIntermediary.value = preset.intermediary_message;
    if (elements.promptFinal) elements.promptFinal.value = preset.final_message;
    syncAdvancedPromptEditor(
        buildPromptConfigFromGuided(
            state.promptConfig && typeof state.promptConfig === 'object' ? state.promptConfig : {}
        )
    );
    setTemplatePresetSelection(normalizedPreset, { persist: true });
    setPromptStatus('Preset applied. Review and click Save to persist.');
}

function buildPromptConfigFromGuided(baseConfig) {
    const config = baseConfig && typeof baseConfig === 'object' ? baseConfig : {};
    const baseDebate = config.debate && typeof config.debate === 'object' ? config.debate : {};
    const guided = getPromptGuidedValues();
    return {
        ...config,
        schemaVersion: 1,
        debate: {
            ...baseDebate,
            header: guided.header,
            intermediary_message: guided.intermediary_message,
            final_message: guided.final_message,
        },
    };
}

function parsePromptConfigFromAdvancedEditor() {
    const raw = String(elements.promptAdvancedJson?.value || '').trim();
    if (!raw) throw new Error('Advanced JSON is empty.');
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error('Advanced JSON is invalid.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Advanced JSON must be an object.');
    }
    if (!parsed.schemaVersion) parsed.schemaVersion = 1;
    return parsed;
}

function loadPromptTemplates() {
    setPromptStatus('Loading prompt templates...');
    sendMessage({ type: 'GET_DEBATE_PROMPTS' }, (response) => {
        if (!response || response.ok === false) {
            setPromptStatus(`Error: ${response?.error || 'Failed to load prompts.'}`, true);
            return;
        }
        state.promptConfig = response.config || {};
        state.promptConfigSource = response.source || 'default';

        const debate =
            state.promptConfig?.debate && typeof state.promptConfig.debate === 'object'
                ? state.promptConfig.debate
                : {};

        if (elements.promptInitial) elements.promptInitial.value = debate.header || '';
        if (elements.promptIntermediary)
            elements.promptIntermediary.value = debate.intermediary_message || '';
        if (elements.promptFinal) elements.promptFinal.value = debate.final_message || '';
        syncAdvancedPromptEditor(state.promptConfig);

        const detectedPreset = detectTemplatePreset(getPromptGuidedValues());
        setTemplatePresetSelection(detectedPreset, { persist: true });
        updatePromptEditorUi();

        setPromptStatus(
            response.source === 'override'
                ? 'Loaded custom templates.'
                : 'Loaded default templates (no override saved).'
        );
    });
}

function savePromptTemplates() {
    const baseConfig =
        state.promptConfig && typeof state.promptConfig === 'object' ? state.promptConfig : {};
    let nextConfig = null;

    if (getTemplateEditorMode() === TEMPLATE_MODE_ADVANCED) {
        try {
            nextConfig = parsePromptConfigFromAdvancedEditor();
        } catch (error) {
            setPromptStatus(`Error: ${error?.message || 'Invalid advanced JSON.'}`, true);
            return;
        }
    } else {
        nextConfig = buildPromptConfigFromGuided(baseConfig);
    }

    sendMessage({ type: 'SET_DEBATE_PROMPTS', config: nextConfig }, (response) => {
        if (!response || response.ok === false) {
            setPromptStatus(`Error: ${response?.error || 'Failed to save prompts.'}`, true);
            return;
        }
        state.promptConfig = response.config || nextConfig;
        state.promptConfigSource = response.source || 'override';

        const debate =
            state.promptConfig?.debate && typeof state.promptConfig.debate === 'object'
                ? state.promptConfig.debate
                : {};

        if (elements.promptInitial) elements.promptInitial.value = debate.header || '';
        if (elements.promptIntermediary)
            elements.promptIntermediary.value = debate.intermediary_message || '';
        if (elements.promptFinal) elements.promptFinal.value = debate.final_message || '';
        syncAdvancedPromptEditor(state.promptConfig);

        const detectedPreset = detectTemplatePreset(getPromptGuidedValues());
        setTemplatePresetSelection(detectedPreset, { persist: true });
        setPromptStatus('Saved templates.');
    });
}

function resetPromptTemplates() {
    sendMessage({ type: 'RESET_DEBATE_PROMPTS' }, (response) => {
        if (!response || response.ok === false) {
            setPromptStatus(`Error: ${response?.error || 'Failed to reset prompts.'}`, true);
            return;
        }
        loadPromptTemplates();
    });
}

function updateCharCount() {
    if (!elements.charCount || !elements.promptInput) return;
    elements.charCount.textContent = String(elements.promptInput.value.length);
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    const scaled = value / 1024 ** exponent;
    const formatted = scaled >= 10 || exponent === 0 ? scaled.toFixed(0) : scaled.toFixed(1);
    return `${formatted} ${units[exponent]}`;
}

function getAttachmentsTotalBytes() {
    if (!Array.isArray(state.attachments)) return 0;
    return state.attachments.reduce(
        (total, item) => total + (Number.isFinite(item?.size) ? item.size : 0),
        0
    );
}

function updateAttachmentsUi() {
    const locked = state.running || state.paused;
    if (elements.attachmentButton) {
        elements.attachmentButton.disabled = locked || state.attachmentsLoading;
    }
    if (elements.attachmentInput) {
        elements.attachmentInput.disabled = locked || state.attachmentsLoading;
    }

    const count = Array.isArray(state.attachments) ? state.attachments.length : 0;
    const totalBytes = getAttachmentsTotalBytes();

    if (elements.attachmentSummary) {
        let summaryText = '';
        let showSummary = false;
        if (state.attachmentsLoading) {
            summaryText = 'Reading…';
            showSummary = true;
        } else if (count > 0) {
            const label = count === 1 ? '1 file' : `${count} files`;
            summaryText = `${label} • ${formatBytes(totalBytes)}`;
            showSummary = true;
        }
        elements.attachmentSummary.textContent = summaryText;
        elements.attachmentSummary.hidden = !showSummary;
    }

    if (elements.attachmentClear) {
        elements.attachmentClear.hidden = locked || state.attachmentsLoading || count === 0;
    }

    if (!elements.attachmentList) return;
    elements.attachmentList.replaceChildren();

    if (count === 0) {
        elements.attachmentList.hidden = true;
        return;
    }

    state.attachments.forEach((attachment) => {
        const item = document.createElement('div');
        item.className = 'attachment-item';
        const typeLabel = attachment.type ? attachment.type : 'unknown type';
        const sizeLabel = Number.isFinite(attachment.size) ? formatBytes(attachment.size) : '';
        item.title = [typeLabel, sizeLabel].filter(Boolean).join(' • ');

        const meta = document.createElement('div');
        meta.className = 'attachment-meta';

        const name = document.createElement('div');
        name.className = 'attachment-name';
        name.textContent = attachment.name || 'attachment';

        meta.appendChild(name);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.dataset.action = 'remove-attachment';
        remove.dataset.attachmentId = attachment.id;
        remove.title = 'Remove';
        remove.setAttribute('aria-label', `Remove ${attachment.name || 'attachment'}`);
        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = 'close';
        remove.appendChild(icon);

        item.appendChild(meta);
        item.appendChild(remove);
        elements.attachmentList.appendChild(item);
    });

    elements.attachmentList.hidden = false;
}

function clearAttachments() {
    state.attachments = [];
    state.attachmentsLoading = false;
    state.attachmentsWarning = '';
    updateAttachmentsUi();
    updateSendState();
}

function removeAttachment(id) {
    if (!id) return;
    const next = Array.isArray(state.attachments)
        ? state.attachments.filter((item) => item.id !== id)
        : [];
    state.attachments = next;
    updateAttachmentsUi();
    updateSendState();
}

function generateAttachmentId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('File read failed.'));
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            const commaIndex = result.indexOf(',');
            if (commaIndex === -1) {
                reject(new Error('Unexpected DataURL format.'));
                return;
            }
            resolve(result.slice(commaIndex + 1));
        };
        reader.readAsDataURL(file);
    });
}

async function addAttachments(files) {
    if (state.running || state.paused) return;
    if (!Array.isArray(files) || files.length === 0) return;

    const existing = Array.isArray(state.attachments) ? state.attachments : [];
    const remainingSlots = Math.max(0, ATTACHMENTS_MAX_FILES - existing.length);
    const warnings = [];

    if (remainingSlots === 0) {
        state.attachmentsWarning = `Attachment limit reached (${ATTACHMENTS_MAX_FILES}).`;
        updateAttachmentsUi();
        updateSendState();
        return;
    }

    const selected = files.slice(0, remainingSlots);
    if (files.length > selected.length) {
        warnings.push(`Only the first ${selected.length} file(s) were kept.`);
    }

    let totalBytes = getAttachmentsTotalBytes();
    state.attachmentsLoading = true;
    state.attachmentsWarning = '';
    updateAttachmentsUi();
    updateSendState();

    for (const file of selected) {
        if (!file) continue;
        if (Number.isFinite(file.size) && file.size > ATTACHMENTS_MAX_FILE_BYTES) {
            warnings.push(
                `${file.name} is larger than ${formatBytes(ATTACHMENTS_MAX_FILE_BYTES)}.`
            );
            continue;
        }
        if (Number.isFinite(file.size) && totalBytes + file.size > ATTACHMENTS_MAX_TOTAL_BYTES) {
            warnings.push(`Total attachments exceed ${formatBytes(ATTACHMENTS_MAX_TOTAL_BYTES)}.`);
            break;
        }

        try {
            const base64 = await readFileAsBase64(file);
            const type = file.type || 'application/octet-stream';
            state.attachments.push({
                id: generateAttachmentId(),
                name: file.name || 'attachment',
                type,
                size: file.size,
                lastModified: file.lastModified,
                base64,
            });
            totalBytes += file.size;
        } catch (error) {
            warnings.push(`Failed to read ${file.name}.`);
        }
    }

    state.attachmentsLoading = false;
    state.attachmentsWarning = warnings.join(' ');
    updateAttachmentsUi();
    updateSendState();
}

function getRoute() {
    return state.route || getDefaultRoute();
}

function isRouteValid(route) {
    return getRouteAgents(route).length > 0;
}

function isRouteSupported(route) {
    if (!isRouteValid(route)) return false;
    const agents = getRouteAgents(route);
    if (route.kind === 'single') return agents.length === 1;
    const supported = new Set(getSupportedProviders());
    if (agents.some((agent) => !supported.has(agent.provider))) return false;
    if (route.kind === 'debate') return agents.length >= 2;
    if (route.kind === 'parallel') return agents.length >= 2;
    return false;
}

function getRouteRequiredProviders(route) {
    if (routeBuilderApi && typeof routeBuilderApi.getRouteRequiredProviders === 'function') {
        return routeBuilderApi.getRouteRequiredProviders(route);
    }
    if (!isRouteValid(route)) return [];
    const agents = getRouteAgents(route);
    const requiredAgents = route.kind === 'single' ? agents.slice(0, 1) : agents;
    const providers = [];
    requiredAgents.forEach((agent) => {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return;
        if (!providers.includes(provider)) providers.push(provider);
    });
    return providers;
}

function getRouteRequiredAgents(route) {
    if (routeBuilderApi && typeof routeBuilderApi.getRouteRequiredAgents === 'function') {
        return routeBuilderApi.getRouteRequiredAgents(route);
    }
    if (!isRouteValid(route)) return [];
    const agents = getRouteAgents(route);
    return route.kind === 'single' ? agents.slice(0, 1) : agents;
}

function isProfileConnected(provider, profileId) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider || !profileId) return false;
    const defaultProfileId = getEffectiveDefaultProfileId(normalizedProvider);
    if (defaultProfileId && profileId === defaultProfileId) {
        if (isActiveChatNewTabOnly()) {
            return Boolean(state.profileConnectionStatus?.[profileId]);
        }
        return Boolean(state.connectionStatus?.[normalizedProvider]);
    }
    return Boolean(state.profileConnectionStatus?.[profileId]);
}

function getKnownProfileConnection(profileId) {
    const map = state.profileConnectionStatus;
    if (!map || typeof map !== 'object') return null;
    if (!Object.prototype.hasOwnProperty.call(map, profileId)) return null;
    return Boolean(map[profileId]);
}

function isProviderReady(provider) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) return false;
    if (!isActiveChatNewTabOnly()) {
        return Boolean(state.connectionStatus?.[normalizedProvider]);
    }
    const profileId = getEffectiveDefaultProfileId(normalizedProvider);
    if (!profileId) return false;
    const known = getKnownProfileConnection(profileId);
    return known === true;
}

function isRouteConfigured(route) {
    if (!isRouteValid(route)) return false;
    const requiredAgents = getRouteRequiredAgents(route);
    const seen = new Set();
    for (const agent of requiredAgents) {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return false;
        const resolvedProfileId = resolveAgentProfileId(agent);
        if (!resolvedProfileId) return false;
        if (seen.has(resolvedProfileId)) return false;
        const profile = getProfileById(resolvedProfileId);
        if (!profile) return false;
        if (!isProfileRoutable(profile, provider)) return false;
        seen.add(resolvedProfileId);
    }
    return true;
}

function getRouteConfigurationIssue(route) {
    if (!isRouteValid(route)) return 'Choose an agent to start.';
    const requiredAgents = getRouteRequiredAgents(route);
    const seen = new Set();
    for (const agent of requiredAgents) {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return 'Choose a supported provider.';
        const selection = normalizeProfileSelection(agent?.profileId);
        const resolvedProfileId = resolveAgentProfileId(agent);
        if (!resolvedProfileId) {
            if (selection === 'default')
                return `Connect ${formatProviderLabel(provider)} to start.`;
            return `Open a New tab for ${formatProviderLabel(provider)} to give each agent its own tab.`;
        }
        if (seen.has(resolvedProfileId))
            return 'Each agent must use a different tab. Use New tab to create another connection.';
        const profile = getProfileById(resolvedProfileId);
        if (!profile)
            return 'A selected connection no longer exists. Open a New tab to replace it.';
        if (profile.provider !== provider)
            return 'A selected connection does not match the provider.';
        if (profile.status === 'wrong_host')
            return 'A selected tab is on the wrong site. Open a New tab to replace it.';
        if (!Number.isFinite(profile.tabId) || profile.status === 'offline')
            return 'A selected tab is closed. Open a New tab to replace it.';
        if (profile.inUseBySessionId)
            return 'A selected tab is already in use by another session. Open a New tab to create a separate connection.';
        seen.add(resolvedProfileId);
    }
    return '';
}

function getProviderAttachmentMode(provider) {
    const mode = state.providerCapabilities?.[provider]?.attachments?.mode;
    if (mode === 'auto' || mode === 'manual' || mode === 'none') return mode;
    // Safe defaults until a provider is explicitly supported.
    return provider === 'chatgpt' ? 'auto' : 'manual';
}

function buildManualUploadAckKey(route, attachments, manualProviders) {
    const roundsKey = route?.kind === 'debate' ? route?.rounds || 1 : 1;
    const agentKey = getRouteRequiredAgents(route)
        .map(
            (agent) =>
                `${normalizeProviderId(agent?.provider) || ''}:${normalizeProfileSelection(agent?.profileId) || ''}`
        )
        .join('>');
    const routeKey = `${route?.kind || 'single'}|${agentKey}|${roundsKey}`;
    const providersKey = Array.isArray(manualProviders)
        ? [...manualProviders].sort().join(',')
        : '';
    const attachmentKey = Array.isArray(attachments)
        ? attachments
              .map((item) => String(item?.id || ''))
              .filter(Boolean)
              .join(',')
        : '';
    return `${routeKey}|${providersKey}|${attachmentKey}`;
}

function getAttachmentProviderPlan(route) {
    const required = getRouteRequiredProviders(route);
    const autoProviders = required.filter(
        (provider) => getProviderAttachmentMode(provider) === 'auto'
    );
    const manualProviders = required.filter(
        (provider) => getProviderAttachmentMode(provider) !== 'auto'
    );
    return { required, autoProviders, manualProviders };
}

function isRouteConnected(route) {
    if (!isRouteValid(route)) return false;
    const requiredAgents = getRouteRequiredAgents(route);
    return requiredAgents.every((agent) => {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return false;
        const resolvedProfileId = resolveAgentProfileId(agent);
        if (!resolvedProfileId) return false;
        return isProfileConnected(provider, resolvedProfileId);
    });
}

function getRouteDisconnectedAgents(route) {
    const requiredAgents = getRouteRequiredAgents(route);
    return requiredAgents.filter((agent) => {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return true;
        const resolvedProfileId = resolveAgentProfileId(agent);
        if (!resolvedProfileId) return true;
        return !isProfileConnected(provider, resolvedProfileId);
    });
}

function getRouteConnectionCounts(route) {
    const requiredAgents = getRouteRequiredAgents(route);
    let connected = 0;
    requiredAgents.forEach((agent) => {
        const provider = normalizeProviderId(agent?.provider);
        if (!provider) return;
        const resolvedProfileId = resolveAgentProfileId(agent);
        if (!resolvedProfileId) return;
        if (isProfileConnected(provider, resolvedProfileId)) connected += 1;
    });
    return { connected, total: requiredAgents.length };
}

function clampInt(value, min, max) {
    const num = parseInt(value, 10);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
}

function findLastUserRunConfig(chat) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'user') continue;
        const meta = message.meta && typeof message.meta === 'object' ? message.meta : null;
        const runConfig =
            meta?.runConfig && typeof meta.runConfig === 'object' ? meta.runConfig : null;
        if (runConfig) return runConfig;
    }
    return null;
}

function applyRunConfigDefaults(runConfig) {
    const derived = routeFromRunConfig(runConfig);
    if (!derived) return;
    const currentRounds = clampInt(state.route?.rounds || 3, 1, 12);
    const merged = derived.kind === 'debate' ? derived : { ...derived, rounds: currentRounds };
    setRoute(merged);
}

function applyRunDefaultsFromActiveChat() {
    const runConfig = findLastUserRunConfig(state.activeChat);
    if (runConfig) {
        applyRunConfigDefaults(runConfig);
    } else {
        const messages = Array.isArray(state.activeChat?.messages) ? state.activeChat.messages : [];
        const isEmptyChat = messages.length === 0;
        if (isEmptyChat) {
            setRoute(getDefaultRoute(), { persist: false });
            if (!isRoutePopoverOpen()) {
                openRoutePopover();
            }
            return;
        }
        renderRouteUi();
    }
}

function updateSendState() {
    if (!elements.sendButton || !elements.promptInput) return;
    const locked = state.running || state.paused;
    if (locked) {
        elements.sendButton.textContent = 'Stop';
        elements.sendButton.disabled = false;
        updateComposerHint();
        return;
    }
    const hasPrompt = elements.promptInput.value.trim().length > 0;
    const attachmentsReady = !state.attachmentsLoading;
    const route = getRoute();
    const validRoute = isRouteValid(route);
    const supportedRoute = isRouteSupported(route);
    const configuredRoute = validRoute && supportedRoute && isRouteConfigured(route);
    const connected = configuredRoute && isRouteConnected(route);
    const historyBlocked = isHistoryBlocked();
    const schemaBlocked = isSchemaResetRequired();
    const readyForPrimaryAction =
        hasPrompt &&
        attachmentsReady &&
        validRoute &&
        supportedRoute &&
        !historyBlocked &&
        !schemaBlocked;
    if (schemaBlocked) {
        elements.sendButton.textContent = 'Upgrade';
    } else {
        elements.sendButton.textContent = connected
            ? 'Send'
            : validRoute && supportedRoute
              ? configuredRoute
                  ? 'Connect'
                  : 'Fix route'
              : 'Send';
    }
    elements.sendButton.disabled = !readyForPrimaryAction;
    updateComposerHint();
    updateEmptyState();
}

function setSessionState({ running, paused }) {
    state.running = running;
    state.paused = paused;
    const locked = running || paused;

    if (elements.routeButton) elements.routeButton.disabled = locked;
    if (locked && isRoutePopoverOpen()) closeRoutePopover();
    if (elements.attachmentButton)
        elements.attachmentButton.disabled = locked || state.attachmentsLoading;
    if (elements.attachmentInput)
        elements.attachmentInput.disabled = locked || state.attachmentsLoading;
    renderRouteUi();
    updateAttachmentsUi();
    updatePausedActions();
    updateSendState();
    updateSessionWatchdog();
}

function setSessionStatus(text) {
    if (elements.sessionStatus) {
        elements.sessionStatus.textContent = text;
    }
    if (elements.sessionBanner) {
        const normalized = String(text || '').trim();
        const show =
            state.running || state.paused || (normalized && normalized.toLowerCase() !== 'idle');
        elements.sessionBanner.hidden = !show;
    }
}

function requestProfiles() {
    sendMessage({ type: 'GET_TAB_PROFILES' });
}

function requestConnectionStatus(options = {}) {
    const payload = { type: 'CHECK_CONNECTION' };
    const requestedProfileIds = Array.isArray(options?.profileIds)
        ? options.profileIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    const scopedDefaults = getActiveChatScopedProfileIds();
    const profileIds = [...requestedProfileIds, ...scopedDefaults];
    if (profileIds.length > 0) {
        payload.profileIds = [...new Set(profileIds)];
    }
    sendMessage(payload);
}

function requestProviderCapabilities() {
    sendMessage({ type: 'GET_PROVIDER_CAPABILITIES' }, (response) => {
        if (!response || response.ok === false) return;
        state.providerCapabilities = response.capabilities || null;
        ensureProviderMaps();
        renderRouteUi();
        updateAttachmentsUi();
        updateSendState();
    });
}

function requestHistoryStatus({ hydrateChats = false } = {}) {
    sendMessage({ type: 'HISTORY_STATUS' }, (response) => {
        if (!response || response.ok === false) {
            updateHistoryStatus(response?.status || {});
            return;
        }

        updateHistoryStatus(response.status);

        if (hydrateChats) {
            requestChatsState();
        }
    });
}

function requestActiveSession() {
    sendMessage({ type: 'GET_ACTIVE_SESSION', chatId: state.activeChatId || undefined });
}

function updateSessionWatchdog() {
    const locked = state.running || state.paused;
    if (!locked) {
        if (sessionWatchdogInterval) {
            window.clearInterval(sessionWatchdogInterval);
            sessionWatchdogInterval = null;
        }
        return;
    }

    if (sessionWatchdogInterval) return;
    requestActiveSession();
    sessionWatchdogInterval = window.setInterval(() => {
        if (!(state.running || state.paused)) {
            window.clearInterval(sessionWatchdogInterval);
            sessionWatchdogInterval = null;
            return;
        }
        requestActiveSession();
    }, 2000);
}

function requestChatsState() {
    sendMessage({ type: 'GET_CHATS_STATE' }, (response) => {
        if (!response) {
            setSessionStatus('Error: Failed to load chats.');
            return;
        }
        if (response.ok === false) {
            if (response.status) updateHistoryStatus(response.status);
            const code = response.code || '';
            if (code === 'HISTORY_LOCKED') {
                setSessionStatus('Unlock history to continue.');
                unlockHistory({ auto: true })
                    .then((unlocked) => {
                        if (unlocked) requestChatsState();
                    })
                    .catch((error) => {
                        console.warn('Unlock failed:', error);
                    });
            } else {
                setSessionStatus(`Error: ${response.error || 'Failed to load chats.'}`);
            }
            state.chats = [];
            state.activeChat = null;
            state.activeChatId = null;
            state.activeChatHasMore = false;
            state.activeChatNextCursorSequence = null;
            clearTranscript();
            renderChatList();
            updateSendState();
            return;
        }
        handleChatsState(response);
    });
}

function handleChatsState(payload) {
    const chats = Array.isArray(payload.chats) ? payload.chats : [];
    state.chats = chats;
    const nextActiveId =
        typeof payload.activeChatId === 'string' ? payload.activeChatId : state.activeChatId;
    const shouldLoad =
        nextActiveId && (!state.activeChat || state.activeChat.chatId !== nextActiveId);
    state.activeChatId = nextActiveId;
    if (shouldLoad && state.activeChatId) {
        const summary = chats.find((chat) => chat?.chatId === state.activeChatId);
        if (Number.isFinite(summary?.messageCount) && summary.messageCount === 0) {
            markActiveChatAsNewTabOnly();
            requestConnectionStatus();
        }
    }
    updateChatLockButton();
    renderChatList();
    if (shouldLoad) {
        loadChat(nextActiveId);
    } else if (state.activeChatId) {
        syncActiveChatConnectionPolicy();
        syncActiveSessionState();
        requestActiveSession();
    }
}

function createNewChat() {
    if (isHistoryAppLocked()) {
        setSessionStatus('Unlock history to continue.');
        unlockHistory({ auto: true }).catch((error) => {
            console.warn('Unlock failed:', error);
        });
        return;
    }
    sendMessage({ type: 'CREATE_CHAT' }, (response) => {
        if (!response || response.ok === false) {
            const code = response?.code || '';
            if (code === 'HISTORY_LOCKED') {
                setSessionStatus('Unlock history to continue.');
                unlockHistory({ auto: true })
                    .then((unlocked) => {
                        if (unlocked) createNewChat();
                    })
                    .catch((error) => {
                        console.warn('Unlock failed:', error);
                    });
                return;
            }
            handleActionResponse(response || { ok: false, error: 'Failed to create chat.' });
            return;
        }
        if (response.activeChatId) {
            state.activeChatId = response.activeChatId;
            markActiveChatAsNewTabOnly();
            requestConnectionStatus();
            loadChat(response.activeChatId);
        } else if (response.chat?.chatId) {
            state.activeChatId = response.chat.chatId;
            markActiveChatAsNewTabOnly();
            requestConnectionStatus();
            loadChat(response.chat.chatId);
        }
    });
}

function loadChat(chatId) {
    if (!chatId) return;
    sendMessage({ type: 'GET_CHAT', chatId }, (response) => {
        if (!response) {
            setSessionStatus('Error: Failed to load chat.');
            return;
        }
        if (response.ok === false) {
            if (response.status) updateHistoryStatus(response.status);
            const code = response.code || '';
            if (code === 'HISTORY_LOCKED') {
                setSessionStatus('Unlock history to continue.');
                unlockHistory({ auto: true })
                    .then((unlocked) => {
                        if (unlocked) loadChat(chatId);
                    })
                    .catch((error) => {
                        console.warn('Unlock failed:', error);
                    });
                return;
            }
            handleActionResponse(response || { ok: false, error: 'Failed to load chat.' });
            return;
        }
        state.activeChat = response.chat || null;
        state.activeChatId = response.chat?.chatId || chatId;
        state.activeChatHasMore = Boolean(response.chat?.hasMore);
        state.activeChatNextCursorSequence = Number.isFinite(response.chat?.nextCursorSequence)
            ? response.chat.nextCursorSequence
            : null;
        syncActiveChatConnectionPolicy();
        requestConnectionStatus();
        clearTranscript();
        if (Array.isArray(response.chat?.messages) && response.chat.messages.length) {
            response.chat.messages.forEach(addMessage);
        } else {
            updateEmptyState();
        }
        updateLoadOlderUi();
        updateChatLockButton();
        renderChatList();
        applyRunDefaultsFromActiveChat();
        updateSendState();
        syncActiveSessionState();
        requestActiveSession();
    });
}

function handleChatListClick(event) {
    if (isHistoryAppLocked()) {
        setSessionStatus('Unlock history to continue.');
        unlockHistory({ auto: true }).catch((error) => {
            console.warn('Unlock failed:', error);
        });
        return;
    }
    const item = event.target.closest('.chat-item');
    if (!item || !item.dataset.chatId) return;
    const chatId = item.dataset.chatId;
    if (chatId === state.activeChatId) {
        closeChatsDrawer();
        return;
    }
    sendMessage({ type: 'SET_ACTIVE_CHAT', chatId }, (response) => {
        if (!response || response.ok === false) {
            handleActionResponse(response || { ok: false, error: 'Failed to switch chat.' });
            return;
        }
        state.activeChatId = response.activeChatId || chatId;
        loadChat(state.activeChatId);
        closeChatsDrawer();
    });
}

function renderChatList() {
    if (!elements.chatList) return;
    elements.chatList.innerHTML = '';
    if (!state.chats.length) {
        const empty = document.createElement('div');
        empty.className = 'profile-empty';
        empty.textContent = isHistoryAppLocked()
            ? 'History is locked. Unlock it to access chats.'
            : 'No chats yet.';
        elements.chatList.appendChild(empty);
        return;
    }
    state.chats.forEach((chat) => {
        const item = document.createElement('div');
        item.className = `chat-item${chat.chatId === state.activeChatId ? ' is-active' : ''}`;
        item.dataset.chatId = chat.chatId;

        const header = document.createElement('div');
        header.className = 'chat-item-header';

        const title = document.createElement('div');
        title.className = 'chat-item-title';
        title.textContent = chat.title || 'New chat';

        header.appendChild(title);

        if (chat.isProtected) {
            const lock = document.createElement('span');
            lock.className = `chat-item-lock material-symbols-rounded${chat.locked ? ' is-locked' : ''}`;
            lock.textContent = 'lock';
            lock.setAttribute('aria-hidden', 'true');
            header.appendChild(lock);
        }

        const meta = document.createElement('div');
        meta.className = 'chat-item-meta';
        const updatedAt = Number.isFinite(chat.updatedAt) ? chat.updatedAt : null;
        const count = Number.isFinite(chat.messageCount) ? chat.messageCount : null;
        const parts = [];
        if (count !== null) parts.push(`${count} msg${count === 1 ? '' : 's'}`);
        if (updatedAt) parts.push(formatRelativeTime(updatedAt));
        meta.textContent = parts.join(' • ');

        item.appendChild(header);
        if (meta.textContent) item.appendChild(meta);
        elements.chatList.appendChild(item);
    });
}

function formatRelativeTime(timestampMs) {
    const delta = Math.max(0, Date.now() - timestampMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (delta < minute) return 'just now';
    if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
    if (delta < day) return `${Math.floor(delta / hour)}h ago`;
    return `${Math.floor(delta / day)}d ago`;
}

function openChatsDrawer() {
    if (!elements.chatsDrawer || !elements.chatsBackdrop) return;
    elements.chatsBackdrop.hidden = false;
    elements.chatsDrawer.classList.add('is-open');
    elements.chatsDrawer.setAttribute('aria-hidden', 'false');
    renderChatList();
}

function closeChatsDrawer() {
    if (!elements.chatsDrawer || !elements.chatsBackdrop) return;
    elements.chatsDrawer.classList.remove('is-open');
    elements.chatsDrawer.setAttribute('aria-hidden', 'true');
    elements.chatsBackdrop.hidden = true;
}

function openSettingsDrawer() {
    if (!elements.settingsDrawer || !elements.settingsBackdrop) return;
    elements.settingsBackdrop.hidden = false;
    elements.settingsDrawer.classList.add('is-open');
    elements.settingsDrawer.setAttribute('aria-hidden', 'false');
}

function closeSettingsDrawer() {
    if (!elements.settingsDrawer || !elements.settingsBackdrop) return;
    elements.settingsDrawer.classList.remove('is-open');
    elements.settingsDrawer.setAttribute('aria-hidden', 'true');
    elements.settingsBackdrop.hidden = true;
}

function getDefaultProfile(provider) {
    const profileId = getEffectiveDefaultProfileId(provider);
    return profileId ? getProfileById(profileId) : null;
}

function focusProvider(provider) {
    ensureProviderMaps();
    state.lastFocusedProvider = provider;
    renderRouteUi();
    const profile = getDefaultProfile(provider);
    if (profile?.tabId) {
        sendMessage({ type: 'FOCUS_TAB', tabId: profile.tabId }, handleActionResponse);
        return;
    }
    connectProvider(provider);
}

function focusRouteAgent(agentId) {
    const route = state.route || getDefaultRoute();
    const agent = getRouteAgentById(route, agentId);
    const provider = normalizeProviderId(agent?.provider);
    if (!agent || !provider) return;

    const resolvedProfileId = resolveAgentProfileId(agent);
    const profile = resolvedProfileId ? getProfileById(resolvedProfileId) : null;
    if (profile?.tabId) {
        sendMessage({ type: 'FOCUS_TAB', tabId: profile.tabId }, handleActionResponse);
        return;
    }
    focusProvider(provider);
}

function reconnectRouteAgent(agentId) {
    const route = state.route || getDefaultRoute();
    const agent = getRouteAgentById(route, agentId);
    const provider = normalizeProviderId(agent?.provider);
    if (!agent || !provider) return;

    state.lastFocusedProvider = provider;
    openNewTabAndBindAgent(provider, { targetAgentId: agentId });
}

function connectProvider(provider) {
    if (!provider) return;
    ensureProviderMaps();
    if (state.connecting[provider]) return;
    state.lastFocusedProvider = provider;
    state.connecting[provider] = true;
    updateProviderUi();
    sendMessage({ type: 'CONNECT_PROVIDER', provider }, (response) => {
        state.connecting[provider] = false;
        updateProviderUi();
        if (!response || response.ok === false) {
            handleActionResponse(response || { ok: false, error: 'Failed to connect.' });
            return;
        }
        if (response.profile?.profileId) {
            setActiveChatDefaultProfile(provider, response.profile.profileId);
        }
        requestProfiles();
        scheduleRouteConnectionStatusCheck();
        window.setTimeout(scheduleRouteConnectionStatusCheck, 2500);
        window.setTimeout(scheduleRouteConnectionStatusCheck, 8000);
    });
}

function upsertProfileInState(profile) {
    if (!profile || typeof profile !== 'object') return;
    const profileId = typeof profile.profileId === 'string' ? profile.profileId : '';
    if (!profileId) return;
    const existing = Array.isArray(state.profiles)
        ? state.profiles.findIndex((item) => item?.profileId === profileId)
        : -1;
    if (!Array.isArray(state.profiles)) state.profiles = [];
    if (existing >= 0) {
        state.profiles[existing] = profile;
    } else {
        state.profiles = [...state.profiles, profile];
    }
    ensureProviderMaps();
}

async function openNewTabAndBindAgent(provider, { targetAgentId = null } = {}) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!normalizedProvider) return;
    ensureProviderMaps();
    if (state.connecting[normalizedProvider]) return;

    state.lastFocusedProvider = normalizedProvider;
    state.connecting[normalizedProvider] = true;
    updateProviderUi();

    try {
        const opened = await sendMessageAsync({
            type: 'OPEN_PROVIDER_TAB',
            provider: normalizedProvider,
            focus: true,
        });
        if (!opened || opened.ok === false || !Number.isFinite(opened.tabId)) {
            throw new Error(opened?.error || 'Failed to open provider tab.');
        }

        const hasStoredDefault = Boolean(state.defaults?.[normalizedProvider]);
        const hasEffectiveDefault = Boolean(getEffectiveDefaultProfileId(normalizedProvider));
        const claimed = await sendMessageAsync({
            type: 'CLAIM_TAB_AS_PROFILE',
            provider: normalizedProvider,
            tabId: opened.tabId,
            setDefault: !hasStoredDefault,
        });
        if (!claimed || claimed.ok === false || !claimed.profile?.profileId) {
            throw new Error(claimed?.error || 'Failed to bind provider tab.');
        }

        upsertProfileInState(claimed.profile);
        if (!hasStoredDefault) {
            state.defaults[normalizedProvider] = claimed.profile.profileId;
        }
        if (!hasEffectiveDefault) {
            setActiveChatDefaultProfile(normalizedProvider, claimed.profile.profileId);
        }

        const route = state.route || getDefaultRoute();
        const agents = [...getRouteAgents(route)];
        const hasDefaultAgent = agents.some(
            (agent) =>
                agent?.provider === normalizedProvider &&
                normalizeProfileSelection(agent?.profileId) === 'default'
        );
        const reservedForDefault = !hasEffectiveDefault && hasDefaultAgent;

        if (reservedForDefault) {
            requestProfiles();
            scheduleRouteConnectionStatusCheck();
            window.setTimeout(scheduleRouteConnectionStatusCheck, 2500);
            window.setTimeout(scheduleRouteConnectionStatusCheck, 8000);
            updateSendState();
            return;
        }
        const targetIndex = pickRouteAgentBindingIndex(normalizedProvider, route, {
            targetAgentId,
        });
        if (targetIndex >= 0) {
            agents[targetIndex] = { ...agents[targetIndex], profileId: claimed.profile.profileId };
        } else {
            agents.push({
                id: generateRouteAgentId(),
                provider: normalizedProvider,
                profileId: claimed.profile.profileId,
            });
        }
        setRoute({ ...route, agents });

        requestProfiles();
        scheduleRouteConnectionStatusCheck();
        window.setTimeout(scheduleRouteConnectionStatusCheck, 2500);
        window.setTimeout(scheduleRouteConnectionStatusCheck, 8000);
    } catch (error) {
        handleActionResponse({ ok: false, error: error?.message || String(error) });
    } finally {
        state.connecting[normalizedProvider] = false;
        updateProviderUi();
    }
}

function connectAllProviders() {
    const supported = getSupportedProviders();
    if (supported.length === 0) return;

    let route = getRoute();

    // Bootstrap flow: when route is empty, Connect all should create one default
    // agent per provider so users can start immediately after connecting tabs.
    if (getRouteAgents(route).length === 0) {
        const nextAgents = supported.map((provider) => ({
            id: generateRouteAgentId(),
            provider,
            profileId: 'default',
        }));
        const nextKind = nextAgents.length >= 2 ? 'debate' : 'single';
        route = sanitizeRoute({
            ...route,
            kind: nextKind,
            agents: nextAgents,
            rounds: route.rounds || 3,
        });
        setRoute(route);
    }

    const routeConfigured =
        isRouteValid(route) && isRouteSupported(route) && isRouteConfigured(route);
    const providersToConnect = new Set();
    const agentsToRepairByProvider = new Map();
    const unknownProfileIds = [];

    if (routeConfigured) {
        const requiredAgents = getRouteRequiredAgents(route);
        requiredAgents.forEach((agent) => {
            const provider = normalizeProviderId(agent?.provider);
            if (!provider) return;
            const resolvedProfileId = resolveAgentProfileId(agent);
            if (!resolvedProfileId) return;
            if (isProfileConnected(provider, resolvedProfileId)) return;
            const selection = normalizeProfileSelection(agent?.profileId);
            if (selection === 'default') {
                providersToConnect.add(provider);
                return;
            }
            const knownConnected = getKnownProfileConnection(resolvedProfileId);
            if (knownConnected === null) {
                unknownProfileIds.push(resolvedProfileId);
                return;
            }
            if (!agentsToRepairByProvider.has(provider)) {
                agentsToRepairByProvider.set(provider, []);
            }
            agentsToRepairByProvider.get(provider).push(agent);
        });
    }

    supported.forEach((provider) => {
        const shouldConnect = providersToConnect.has(provider);
        const profile = getDefaultProfile(provider);
        const ready = isProviderReady(provider);
        const needsReconnect =
            shouldConnect ||
            !profile ||
            profile.inUseBySessionId ||
            profile.status === 'offline' ||
            profile.status === 'wrong_host' ||
            !Number.isFinite(profile.tabId) ||
            !ready;
        if (!needsReconnect) return;
        connectProvider(provider);
    });

    agentsToRepairByProvider.forEach((agents, provider) => {
        if (!Array.isArray(agents) || agents.length === 0) return;
        if (providersToConnect.has(provider)) return;
        if (state.connecting?.[provider]) return;
        openNewTabAndBindAgent(provider, { targetAgentId: agents[0]?.id || null });
    });

    if (unknownProfileIds.length > 0) {
        requestConnectionStatus({ profileIds: unknownProfileIds });
        scheduleRouteConnectionStatusCheck();
        window.setTimeout(scheduleRouteConnectionStatusCheck, 2500);
        window.setTimeout(scheduleRouteConnectionStatusCheck, 8000);
    }
}

function updateProviderUi() {
    ensureProviderMaps();
    const providers = getSupportedProviders();
    let readyCount = 0;
    let connectingCount = 0;

    providers.forEach((provider) => {
        const ready = isProviderReady(provider);
        const connecting = Boolean(state.connecting?.[provider]);

        if (ready) readyCount += 1;
        if (connecting) connectingCount += 1;
    });

    if (elements.providersButton) {
        const route = getRoute();
        const routeConfigured =
            isRouteValid(route) && isRouteSupported(route) && isRouteConfigured(route);
        const routeCounts = routeConfigured ? getRouteConnectionCounts(route) : null;

        let text = 'Providers';
        if (connectingCount > 0) {
            text = routeConfigured ? 'Route: connecting…' : 'Providers: connecting…';
        } else if (routeCounts) {
            text = `Route: ${routeCounts.connected}/${routeCounts.total} ready`;
        } else {
            text = `Providers: ${readyCount}/${providers.length} ready`;
        }
        elements.providersButton.textContent = text;
        const ready = routeCounts
            ? routeCounts.total > 0 && routeCounts.connected === routeCounts.total
            : readyCount > 0;
        const offline = routeCounts
            ? routeCounts.total > 0 && routeCounts.connected === 0
            : readyCount === 0;
        elements.providersButton.classList.toggle('is-ready', ready && connectingCount === 0);
        elements.providersButton.classList.toggle('is-offline', offline && connectingCount === 0);
        elements.providersButton.classList.toggle('is-connecting', connectingCount > 0);
    }

    renderRouteUi();
}

function updateComposerHint() {
    if (!elements.composerHint || !elements.promptInput) return;

    if (state.running || state.paused) {
        elements.composerHint.hidden = true;
        return;
    }

    const route = getRoute();
    const validRoute = isRouteValid(route);
    const supportedRoute = isRouteSupported(route);
    const configuredRoute = validRoute && supportedRoute && isRouteConfigured(route);
    const requiredProviders = getRouteRequiredProviders(route);
    const requiredLabel =
        requiredProviders.length > 0 ? requiredProviders.map(formatProviderLabel).join(' + ') : '';
    const connected = configuredRoute && isRouteConnected(route);
    const historyBlocked = isHistoryBlocked();
    const schemaBlocked = isSchemaResetRequired();
    const hasPrompt = elements.promptInput.value.trim().length > 0;

    let hint = '';
    if (!validRoute) {
        hint = 'Choose an agent in To to start.';
    } else if (!supportedRoute) {
        hint = 'This route is not supported yet.';
    } else if (!configuredRoute) {
        hint = getRouteConfigurationIssue(route) || 'Fix the route to start.';
    } else if (!connected) {
        const disconnectedAgents = getRouteDisconnectedAgents(route);
        if (disconnectedAgents.length === 1) {
            const agent = disconnectedAgents[0];
            const selection = normalizeProfileSelection(agent?.profileId);
            hint =
                selection === 'default'
                    ? `Connect ${requiredLabel} to start.`
                    : `Reconnect ${formatRouteAgentLabel(agent)} to start.`;
        } else if (disconnectedAgents.length > 1) {
            hint = `Reconnect ${disconnectedAgents.length} tabs to start.`;
        } else {
            hint = `Connect ${requiredLabel} to start.`;
        }
    } else if (historyBlocked) {
        hint = getHistoryBlockedHint() || 'Unlock to continue.';
    } else if (schemaBlocked) {
        hint = 'Complete the schema v3 upgrade reset to continue.';
    } else if (!hasPrompt) {
        hint = '';
    }

    if (!hint) {
        if (state.attachmentsLoading) {
            hint = 'Reading attachments…';
        } else if (state.attachmentsWarning) {
            hint = state.attachmentsWarning;
        } else if (Array.isArray(state.attachments) && state.attachments.length > 0) {
            const { manualProviders } = getAttachmentProviderPlan(route);
            if (manualProviders.length > 0) {
                const label = manualProviders.map(formatProviderLabel).join(' + ');
                hint = `${label} will receive text only (attachments are not auto-uploaded).`;
            }
        }
    }

    elements.composerHint.textContent = hint;
    elements.composerHint.hidden = !hint;
    elements.promptInput.placeholder = !validRoute
        ? 'Choose an agent in To…'
        : !supportedRoute
          ? 'Choose a supported route…'
          : !configuredRoute
            ? 'Fix the route to start…'
            : !connected
              ? `Connect ${requiredLabel} to start...`
              : historyBlocked
                ? 'Unlock to continue...'
                : schemaBlocked
                  ? 'Complete upgrade reset...'
                  : 'Send a message...';
}

function updateEmptyState() {
    if (!elements.emptyState || !elements.timeline) return;
    const hasMessages = Boolean(elements.timeline.querySelector('.message'));
    if (hasMessages) {
        if (elements.timeline.contains(elements.emptyState)) {
            elements.emptyState.remove();
        }
        return;
    }

    if (!elements.timeline.contains(elements.emptyState)) {
        elements.timeline.appendChild(elements.emptyState);
    }

    const route = getRoute();
    const ready =
        isRouteValid(route) &&
        isRouteSupported(route) &&
        isRouteConfigured(route) &&
        isRouteConnected(route);
    const historyBlocked = isHistoryBlocked();
    const titleEl = elements.emptyState.querySelector('.empty-title');
    const subtitleEl = elements.emptyState.querySelector('.empty-subtitle');
    const actionsEl = elements.emptyState.querySelector('.empty-actions');
    const actionButton = elements.emptyState.querySelector('#empty-open-route');

    if (ready && historyBlocked) {
        if (titleEl) titleEl.textContent = isActiveChatLocked() ? 'Unlock chat' : 'Unlock history';
        if (subtitleEl) {
            subtitleEl.textContent = isActiveChatLocked()
                ? 'This chat is protected. Enter your passphrase to continue.'
                : 'Enter your passphrase to unlock encrypted history.';
        }
        if (actionsEl) {
            actionsEl.hidden = true;
        }
        return;
    }

    if (!isRouteValid(route)) {
        if (titleEl) titleEl.textContent = 'New chat';
        if (subtitleEl) subtitleEl.textContent = 'Choose where to send your message.';
        if (actionButton) actionButton.textContent = 'Choose agents';
        if (actionsEl) actionsEl.hidden = false;
        return;
    }

    if (!isRouteSupported(route)) {
        if (titleEl) titleEl.textContent = 'Route not supported';
        if (subtitleEl) subtitleEl.textContent = 'This route is not supported yet.';
        if (actionButton) actionButton.textContent = 'Choose agents';
        if (actionsEl) actionsEl.hidden = false;
        return;
    }

    if (!ready) {
        if (!isRouteConfigured(route)) {
            if (titleEl) titleEl.textContent = 'Fix route';
            if (subtitleEl)
                subtitleEl.textContent =
                    getRouteConfigurationIssue(route) || 'Fix the route to start.';
            if (actionButton) actionButton.textContent = 'Fix route';
            if (actionsEl) actionsEl.hidden = false;
            return;
        }
        const disconnectedAgents = getRouteDisconnectedAgents(route);
        const label = getRouteRequiredProviders(route).map(formatProviderLabel).join(' + ');
        if (titleEl) titleEl.textContent = 'Connect to start';
        if (subtitleEl) {
            if (disconnectedAgents.length === 1) {
                const agent = disconnectedAgents[0];
                const selection = normalizeProfileSelection(agent?.profileId);
                subtitleEl.textContent =
                    selection === 'default'
                        ? `Connect ${label} to start.`
                        : `Reconnect ${formatRouteAgentLabel(agent)} to start.`;
            } else if (disconnectedAgents.length > 1) {
                subtitleEl.textContent = `Reconnect ${disconnectedAgents.length} tabs to start.`;
            } else {
                subtitleEl.textContent = `Connect ${label} to start.`;
            }
        }
        if (actionButton) actionButton.textContent = 'Fix connections';
        if (actionsEl) actionsEl.hidden = false;
        return;
    }

    if (titleEl) titleEl.textContent = 'New chat';
    if (subtitleEl) subtitleEl.textContent = 'Write a message below to start.';
    if (actionsEl) actionsEl.hidden = true;
}

async function handlePrimaryAction() {
    if (state.running || state.paused) {
        stopSession();
        return;
    }
    try {
        await startSession();
    } catch (error) {
        setSessionStatus(`Error: ${error?.message || 'Failed to start session.'}`);
    }
}

async function startSession() {
    if (state.running || state.paused) return;
    if (!elements.promptInput) return;

    if (isSchemaResetRequired()) {
        setSessionStatus('Complete the schema v3 upgrade reset to continue.');
        renderSchemaResetModal();
        return;
    }

    if (isHistoryBlocked()) {
        setSessionStatus(getHistoryBlockedHint() || 'Unlock to continue.');
        unlockHistory({ auto: true }).catch((error) => {
            console.warn('Unlock failed:', error);
        });
        return;
    }

    const prompt = elements.promptInput.value.trim();
    if (!prompt) return;

    const route = getRoute();
    if (!isRouteValid(route)) {
        setSessionStatus('Choose an agent to start.');
        openRoutePopover();
        return;
    }
    if (!isRouteSupported(route)) {
        setSessionStatus('This route is not supported yet.');
        openRoutePopover();
        return;
    }

    if (!isRouteConfigured(route)) {
        setSessionStatus(getRouteConfigurationIssue(route) || 'Fix the route to start.');
        openRoutePopover();
        return;
    }

    const required = getRouteRequiredProviders(route);
    if (!isRouteConnected(route)) {
        const autoConnect = [];
        const unknownProfiles = [];
        const repairAgents = [];
        const requiredAgents = getRouteRequiredAgents(route);

        requiredAgents.forEach((agent) => {
            const provider = normalizeProviderId(agent?.provider);
            if (!provider) return;
            const resolvedProfileId = resolveAgentProfileId(agent);
            const connected = resolvedProfileId
                ? isProfileConnected(provider, resolvedProfileId)
                : false;
            if (connected) return;
            const selection = normalizeProfileSelection(agent?.profileId);
            if (selection === 'default') {
                if (!autoConnect.includes(provider)) autoConnect.push(provider);
            } else if (resolvedProfileId) {
                const knownConnected = getKnownProfileConnection(resolvedProfileId);
                if (knownConnected === null) {
                    unknownProfiles.push({ provider, profileId: resolvedProfileId });
                    return;
                }
                repairAgents.push({ agent, provider, profileId: resolvedProfileId });
            }
        });

        if (autoConnect.length > 0) {
            autoConnect.forEach((provider) => connectProvider(provider));
            setSessionStatus(
                `Connect ${autoConnect.map(formatProviderLabel).join(' + ')} to start.`
            );
            return;
        }

        if (unknownProfiles.length > 0) {
            requestConnectionStatus({ profileIds: unknownProfiles.map((item) => item.profileId) });
            scheduleRouteConnectionStatusCheck();
            window.setTimeout(scheduleRouteConnectionStatusCheck, 2500);
            window.setTimeout(scheduleRouteConnectionStatusCheck, 8000);
            setSessionStatus('Checking connections…');
            return;
        }

        if (repairAgents.length > 0) {
            const repaired = [];
            const seenProviders = new Set();
            repairAgents.forEach((item) => {
                if (seenProviders.has(item.provider)) return;
                seenProviders.add(item.provider);
                openNewTabAndBindAgent(item.provider, { targetAgentId: item.agent?.id || null });
                repaired.push(item);
            });
            const first = repaired[0]?.agent;
            const label = first ? formatRouteAgentLabel(first) : 'connection';
            setSessionStatus(
                repaired.length > 1
                    ? `Reconnecting ${repaired.length} tabs…`
                    : `Reconnecting ${label}…`
            );
            return;
        }

        setSessionStatus(`Connect ${required.map(formatProviderLabel).join(' + ')} to start.`);
        return;
    }

    const rounds = route.kind === 'debate' ? clampInt(route.rounds || 3, 1, 12) : 1;

    const attachments = Array.isArray(state.attachments) ? state.attachments : [];
    const attachmentPlan = attachments.length > 0 ? getAttachmentProviderPlan(route) : null;

    if (attachmentPlan && attachmentPlan.manualProviders.length > 0) {
        const { autoProviders, manualProviders } = attachmentPlan;
        const count = attachments.length;
        const totalBytes = getAttachmentsTotalBytes();
        const countLabel = count === 1 ? '1 attachment' : `${count} attachments`;
        const manualLabel = manualProviders.map(formatProviderLabel).join(' + ');
        const autoLabel =
            autoProviders.length > 0 ? autoProviders.map(formatProviderLabel).join(' + ') : 'none';
        const ackKey = buildManualUploadAckKey(route, attachments, manualProviders);
        const alreadyAcknowledged = state.manualUploadAckKey === ackKey;

        if (!alreadyAcknowledged) {
            const ok = await showAttachmentsModal({
                title: 'Manual upload required',
                text: [
                    `You attached ${countLabel} (${formatBytes(totalBytes)}).`,
                    '',
                    `Auto upload: ${autoLabel}`,
                    `Manual upload required: ${manualLabel}`,
                    '',
                    `We will send your message text-only to ${manualLabel} (no files).`,
                    `If you want ${manualLabel} to use the file, attach it manually in the ${manualLabel} tab.`,
                    '',
                    'Click OK to acknowledge this notice. This will not send your message.',
                    'After uploading manually, return here and click Send again.',
                ].join('\n'),
            });
            if (!ok) return;
            state.manualUploadAckKey = ackKey;
            setSessionStatus(`Upload the file manually in ${manualLabel}, then click Send again.`);
            updateComposerHint();
            updateSendState();
            return;
        }
    }

    state.manualUploadAckKey = null;
    state.stopRequested = false;
    setSessionState({ running: true, paused: false });
    setSessionStatus('Starting session...');

    const payload = {
        type: 'START_RUN',
        prompt,
        rounds,
        chatId: state.activeChatId,
    };
    if (attachmentPlan && attachmentPlan.autoProviders.length > 0) {
        payload.attachments = attachments.map((item) => ({
            name: item.name,
            type: item.type,
            size: item.size,
            lastModified: item.lastModified,
            base64: item.base64,
        }));
    }

    const routeAgents = getRouteRequiredAgents(route);
    payload.route = {
        kind: route.kind,
        agents: routeAgents,
        providers: routeAgents.map((agent) => agent.provider),
        rounds,
    };
    if (route.kind === 'debate') {
        payload.mode = 'debate';
        payload.firstLLM = routeAgents[0]?.provider || 'chatgpt';
    } else {
        payload.mode = 'direct';
        payload.target = route.kind === 'parallel' ? 'both' : routeAgents[0]?.provider || 'chatgpt';
    }
    sendMessage(payload);

    elements.promptInput.value = '';
    clearAttachments();
    updateCharCount();
    updateSendState();
}

function stopSession() {
    if (!state.running && !state.paused) return;
    clearPendingTranscriptEntries();
    setSessionStatus('Stopping session...');
    if (!state.sessionId) {
        state.stopRequested = true;
    }
    sendMessage({
        type: 'STOP_SESSION',
        sessionId: state.sessionId || undefined,
        chatId: state.activeChatId || undefined,
        reason: 'User requested stop',
    });
}

function resumeSession() {
    if (!state.sessionId || !state.paused) return;
    setSessionStatus('Resuming session...');
    sendMessage({ type: 'RESUME_SESSION', sessionId: state.sessionId }, handleActionResponse);
}

function isFullyConnected() {
    const providers = getSupportedProviders();
    if (providers.length === 0) return false;
    return providers.every((provider) => isProviderReady(provider));
}

function handleBackgroundMessage(message) {
    switch (message.type) {
        case 'PROVIDER_CAPABILITIES':
            state.providerCapabilities = message.capabilities || null;
            ensureProviderMaps();
            renderRouteUi();
            updateAttachmentsUi();
            updateSendState();
            break;
        case 'TAB_PROFILES':
            handleProfileList(message);
            break;
        case 'CONNECTION_STATUS':
            handleConnectionStatus(message);
            break;
        case 'HISTORY_STATUS':
            updateHistoryStatus(message.status);
            break;
        case 'CHATS_STATE':
            handleChatsState(message);
            break;
        case 'ACTIVE_SESSION':
            if (message.session) {
                cacheSession(message.session);
                if (isMessageForActiveChat(message) || !state.activeChatId) {
                    hydrateSession(message.session);
                }
            } else if (state.activeChatId) {
                clearCachedSession(state.activeChatId);
                if (state.sessionId || state.running || state.paused) {
                    hydrateSession(null);
                }
            }
            break;
        case 'UI_SESSION_STARTED':
            if (message.chatId) {
                upsertCachedSession(message.chatId, {
                    sessionId: message.sessionId,
                    isActive: true,
                    isPaused: false,
                    profileIds:
                        message.profileIds && typeof message.profileIds === 'object'
                            ? message.profileIds
                            : undefined,
                    tabIds:
                        message.tabIds && typeof message.tabIds === 'object'
                            ? message.tabIds
                            : undefined,
                    rounds: message.rounds,
                });
            }
            if (isMessageForActiveChat(message)) {
                state.sessionId = message.sessionId;
                state.sessionProfiles =
                    message.profileIds && typeof message.profileIds === 'object'
                        ? message.profileIds
                        : state.sessionProfiles;
                ensureProviderMaps();
                clearPendingTranscriptEntries();
                setSessionState({ running: true, paused: false });
                setSessionStatus(`Running round 1 of ${message.rounds}`);
                if (message.chatId && message.chatId !== state.activeChatId) {
                    loadChat(message.chatId);
                }
                if (state.stopRequested) {
                    state.stopRequested = false;
                    stopSession();
                }
            }
            break;
        case 'UI_SESSION_PROGRESS':
            if (message.chatId) {
                upsertCachedSession(message.chatId, {
                    sessionId: message.sessionId,
                    isActive: true,
                    isPaused: false,
                    roundIndex: message.roundIndex,
                    rounds: message.totalRounds || message.rounds,
                });
            }
            if (isMessageForActiveChat(message)) {
                handleProgress(message);
            }
            break;
        case 'UI_MESSAGE_ADD':
            if (!message.chatId || message.chatId === state.activeChatId) {
                if (
                    state.activeChat &&
                    (!message.chatId || message.chatId === state.activeChat.chatId)
                ) {
                    if (!Array.isArray(state.activeChat.messages)) state.activeChat.messages = [];
                    state.activeChat.messages.push({
                        role: message.role,
                        agentId: message.agentId,
                        agentLabel: message.agentLabel,
                        content: message.content,
                        contentHtml: message.contentHtml,
                        timestamp: message.timestamp,
                        sessionId: message.sessionId,
                        turnIndex: message.turnIndex,
                        roundIndex: message.roundIndex,
                        meta: message.meta,
                    });
                }
                addMessage(message);
            }
            break;
        case 'UI_SESSION_PAUSED':
            if (message.chatId) {
                upsertCachedSession(message.chatId, {
                    sessionId: message.sessionId,
                    isActive: true,
                    isPaused: true,
                    pausedProvider: message.provider || null,
                    pausedAgentId: message.agentId || null,
                    pausedProfileId: message.profileId || null,
                    pausedAgentLabel: message.agentLabel || null,
                    pausedReason: message.reason || null,
                });
            }
            if (isMessageForActiveChat(message)) {
                handleSessionPaused(message);
            }
            break;
        case 'UI_SESSION_RESUMED':
            if (message.chatId) {
                upsertCachedSession(message.chatId, {
                    sessionId: message.sessionId,
                    isActive: true,
                    isPaused: false,
                    pausedProvider: null,
                    pausedAgentId: null,
                    pausedProfileId: null,
                    pausedAgentLabel: null,
                    pausedReason: null,
                });
            }
            if (isMessageForActiveChat(message)) {
                handleSessionResumed(message);
            }
            break;
        case 'UI_SESSION_ENDED':
            if (message.chatId) {
                clearCachedSession(message.chatId);
            } else if (message.sessionId) {
                const chatId = findChatIdBySessionId(message.sessionId);
                if (chatId) clearCachedSession(chatId);
            }
            if (isMessageForActiveChat(message)) {
                handleSessionEnded(message);
            }
            break;
        case 'UI_SESSION_ERROR':
            if (message.chatId) {
                clearCachedSession(message.chatId);
            } else if (message.sessionId) {
                const chatId = findChatIdBySessionId(message.sessionId);
                if (chatId) clearCachedSession(chatId);
            }
            if (isMessageForActiveChat(message)) {
                handleSessionError(message);
            }
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
    state.defaults =
        message.defaults && typeof message.defaults === 'object' ? message.defaults : {};
    ensureProviderMaps();
    getSupportedProviders().forEach((provider) => {
        if (!Object.prototype.hasOwnProperty.call(state.defaults, provider)) {
            state.defaults[provider] = null;
        }
    });
    updateProviderUi();
    updateSendState();
    scheduleRouteConnectionStatusCheck();
}

function updatePausedActions() {
    if (!elements.pausedActions) return;
    elements.pausedActions.hidden = !state.paused;
}

function focusPausedProvider() {
    const profileId =
        state.pausedProfileId ||
        (state.pausedProvider ? state.sessionProfiles[state.pausedProvider] : null);
    const profile = getProfileById(profileId);
    if (!profile?.tabId) return;
    sendMessage({ type: 'FOCUS_TAB', tabId: profile.tabId }, handleActionResponse);
}

function rebindPausedProvider() {
    const profileId =
        state.pausedProfileId ||
        (state.pausedProvider ? state.sessionProfiles[state.pausedProvider] : null);
    if (!profileId) return;
    const profile = getProfileById(profileId);
    const provider = profile?.provider || state.pausedProvider;
    if (!provider) return;
    sendMessage(
        {
            type: 'CREATE_PROFILE_FROM_ACTIVE_TAB',
            provider,
            profileId,
        },
        handleActionResponse
    );
}

function handleConnectionStatus(message) {
    const incoming = message.status && typeof message.status === 'object' ? message.status : {};
    const profileIncoming =
        message.profileStatus && typeof message.profileStatus === 'object'
            ? message.profileStatus
            : message.profileConnectionStatus && typeof message.profileConnectionStatus === 'object'
              ? message.profileConnectionStatus
              : null;
    ensureProviderMaps();
    const next = { ...state.connectionStatus };
    getSupportedProviders().forEach((provider) => {
        next[provider] = Boolean(incoming[provider]);
    });
    state.connectionStatus = next;
    if (profileIncoming) {
        const mergedProfiles = { ...(state.profileConnectionStatus || {}) };
        Object.entries(profileIncoming).forEach(([profileId, value]) => {
            mergedProfiles[profileId] = Boolean(value);
        });
        state.profileConnectionStatus = mergedProfiles;
    }
    updateProviderUi();
    updateSendState();
}

function hydrateSession(session) {
    if (!session || (!session.isActive && !session.isPaused)) {
        clearPendingTranscriptEntries();
        setSessionState({ running: false, paused: false });
        state.sessionId = null;
        resetSessionProfiles();
        state.pausedProvider = null;
        state.pausedAgentId = null;
        state.pausedProfileId = null;
        state.pausedAgentLabel = null;
        state.pausedReason = null;
        setSessionStatus('Idle');
        return;
    }

    state.sessionId = session.sessionId;
    state.sessionProfiles =
        session.profileIds && typeof session.profileIds === 'object'
            ? session.profileIds
            : state.sessionProfiles;
    ensureProviderMaps();
    state.paused = Boolean(session.isPaused);
    state.pausedProvider = session.pausedProvider || null;
    state.pausedAgentId = session.pausedAgentId || null;
    state.pausedProfileId = session.pausedProfileId || null;
    state.pausedReason = session.pausedReason || null;
    state.pausedAgentLabel = null;
    if (state.paused) {
        const profile = state.pausedProfileId ? getProfileById(state.pausedProfileId) : null;
        if (profile?.label) {
            state.pausedAgentLabel = profile.label;
        } else if (state.pausedAgentId && Array.isArray(session.participants)) {
            const match = session.participants.find((p) => p?.agentId === state.pausedAgentId);
            if (match?.label) state.pausedAgentLabel = match.label;
        }
    }

    if (session.isPaused) {
        clearPendingTranscriptEntries();
        setSessionState({ running: false, paused: true });
        const label = normalizeInlineText(state.pausedAgentLabel || '');
        setSessionStatus(
            `Paused${label ? ` (${label})` : ''}: ${state.pausedReason || 'Needs attention'}`
        );
    } else {
        setSessionState({ running: session.isActive, paused: false });
        setSessionStatus(
            session.isActive
                ? `Resumed round ${session.roundIndex || 1} of ${session.rounds}`
                : 'Idle'
        );

        const participantList = Array.isArray(session.participants) ? session.participants : [];
        const waitingAgentIds = Array.isArray(session.waitingFor)
            ? session.waitingFor.map((id) => String(id || '').trim()).filter(Boolean)
            : [String(session.waitingFor || '').trim()].filter(Boolean);
        if (waitingAgentIds.length > 0) {
            const waitingProviders = waitingAgentIds
                .map((agentId) => {
                    const participant = participantList.find(
                        (item) => String(item?.agentId || '').trim() === agentId
                    );
                    return normalizeProviderId(participant?.provider || '');
                })
                .filter(Boolean);
            setPendingTranscriptEntries(
                buildPendingEntriesFromProgress({
                    waitingFor: waitingProviders,
                    waitingForAgentIds,
                    roundIndex: Number.isFinite(session.roundIndex) ? session.roundIndex : null,
                    totalRounds: Number.isFinite(session.rounds) ? session.rounds : null,
                })
            );
        } else {
            clearPendingTranscriptEntries();
        }
    }

    if (session.chatId && session.chatId !== state.activeChatId) {
        loadChat(session.chatId);
    }
}

function buildPendingEntriesFromProgress(message) {
    if (!message || typeof message !== 'object') return [];
    const roundIndex = Number.isFinite(message.roundIndex) ? message.roundIndex : null;
    const totalRounds = Number.isFinite(message.totalRounds)
        ? message.totalRounds
        : Number.isFinite(message.rounds)
          ? message.rounds
          : null;

    const waitingProviders = Array.isArray(message.waitingFor)
        ? message.waitingFor
              .map((provider) => normalizeProviderId(provider) || null)
              .filter(Boolean)
        : [normalizeProviderId(message.waitingFor) || null].filter(Boolean);
    const waitingAgentIds = Array.isArray(message.waitingForAgentIds)
        ? message.waitingForAgentIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [String(message.waitingForAgentId || '').trim()].filter(Boolean);
    const explicitLabel = normalizeInlineText(message.waitingForLabel || '');

    const route = state.route || getDefaultRoute();
    const entries = [];

    if (waitingAgentIds.length > 0) {
        waitingAgentIds.forEach((agentId, index) => {
            const routeAgent = getRouteAgentById(route, agentId);
            const provider =
                normalizeProviderId(routeAgent?.provider) ||
                waitingProviders[index] ||
                waitingProviders[0] ||
                null;
            const label = routeAgent
                ? formatRouteAgentLabel(routeAgent)
                : explicitLabel || formatProviderLabel(provider || 'provider');
            entries.push({
                agentId,
                provider,
                label,
                roundIndex,
                totalRounds,
            });
        });
    } else if (waitingProviders.length > 0) {
        waitingProviders.forEach((provider, index) => {
            const label =
                waitingProviders.length === 1 && explicitLabel
                    ? explicitLabel
                    : formatProviderLabel(provider || `provider_${index + 1}`);
            entries.push({
                agentId: null,
                provider,
                label,
                roundIndex,
                totalRounds,
            });
        });
    } else if (explicitLabel) {
        entries.push({
            agentId: null,
            provider: null,
            label: explicitLabel,
            roundIndex,
            totalRounds,
        });
    }

    const seen = new Set();
    return entries.filter((entry, index) => {
        const key = entry.agentId
            ? `agent:${entry.agentId}`
            : `label:${entry.label.toLowerCase()}::${entry.provider || 'none'}::${index}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function buildPendingTranscriptElement(entry) {
    const container = document.createElement('div');
    container.className = 'message pending is-pending';
    if (entry?.agentId) {
        container.dataset.pendingAgentId = entry.agentId;
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const role = document.createElement('span');
    role.className = 'message-role';
    role.textContent = entry?.provider ? formatProviderLabel(entry.provider) : 'Agent';

    const detail = document.createElement('span');
    const roundText =
        Number.isFinite(entry?.roundIndex) && Number.isFinite(entry?.totalRounds)
            ? `Round ${entry.roundIndex}/${entry.totalRounds}`
            : null;
    detail.textContent = [normalizeInlineText(entry?.label || ''), roundText]
        .filter(Boolean)
        .join(' | ');

    const content = document.createElement('div');
    content.className = 'message-content pending-content';

    const thinking = document.createElement('span');
    thinking.className = 'pending-copy';
    thinking.textContent = 'Thinking';

    const dots = document.createElement('span');
    dots.className = 'pending-dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement('span');
        dot.className = 'pending-dot';
        dots.appendChild(dot);
    }

    content.appendChild(thinking);
    content.appendChild(dots);
    meta.appendChild(role);
    meta.appendChild(detail);
    container.appendChild(meta);
    container.appendChild(content);
    return container;
}

function renderPendingTranscriptEntries() {
    if (!elements.timeline) return;
    elements.timeline.querySelectorAll('.message.is-pending').forEach((node) => node.remove());

    const pendingEntries = Array.isArray(state.pendingTranscriptEntries)
        ? state.pendingTranscriptEntries
        : [];
    if (pendingEntries.length === 0) return;

    if (elements.emptyState && elements.timeline.contains(elements.emptyState)) {
        elements.emptyState.remove();
    }

    const fragment = document.createDocumentFragment();
    pendingEntries.forEach((entry) => {
        fragment.appendChild(buildPendingTranscriptElement(entry));
    });
    elements.timeline.appendChild(fragment);
    if (state.autoScroll) {
        elements.timeline.scrollTop = elements.timeline.scrollHeight;
    }
}

function setPendingTranscriptEntries(entries) {
    state.pendingTranscriptEntries = Array.isArray(entries) ? entries : [];
    renderPendingTranscriptEntries();
}

function clearPendingTranscriptEntries() {
    state.pendingTranscriptEntries = [];
    if (!elements.timeline) return;
    elements.timeline.querySelectorAll('.message.is-pending').forEach((node) => node.remove());
}

function consumePendingEntryForMessage(message) {
    const pendingEntries = Array.isArray(state.pendingTranscriptEntries)
        ? state.pendingTranscriptEntries
        : [];
    if (pendingEntries.length === 0) return;

    const agentId = String(message?.agentId || '').trim();
    let nextEntries = pendingEntries;

    if (agentId) {
        nextEntries = pendingEntries.filter((entry) => entry?.agentId !== agentId);
    } else {
        nextEntries = pendingEntries.slice(1);
    }

    if (nextEntries.length === pendingEntries.length) return;
    state.pendingTranscriptEntries = nextEntries;
    renderPendingTranscriptEntries();
}

function handleProgress(message) {
    if (!message) return;
    setPendingTranscriptEntries(buildPendingEntriesFromProgress(message));
    const explicitLabel = String(message.waitingForLabel || '').trim();
    const waitingFor =
        explicitLabel ||
        (Array.isArray(message.waitingFor)
            ? message.waitingFor.map(formatProviderLabel).join(' + ')
            : formatProviderLabel(message.waitingFor));
    if (message.roundIndex && message.totalRounds) {
        setSessionStatus(
            `Running round ${message.roundIndex} of ${message.totalRounds} - waiting for ${waitingFor}`
        );
    } else if (waitingFor) {
        setSessionStatus(`Waiting for ${waitingFor}`);
    }
}

function handleSessionPaused(message) {
    clearPendingTranscriptEntries();
    state.paused = true;
    state.pausedProvider = message.provider || null;
    state.pausedAgentId = message.agentId || null;
    state.pausedProfileId = message.profileId || null;
    state.pausedAgentLabel = message.agentLabel || null;
    state.pausedReason = message.reason || 'Session paused.';
    setSessionState({ running: false, paused: true });
    const label = normalizeInlineText(state.pausedAgentLabel || '');
    setSessionStatus(`Paused${label ? ` (${label})` : ''}: ${state.pausedReason}`);
}

function handleSessionResumed() {
    state.paused = false;
    state.pausedProvider = null;
    state.pausedAgentId = null;
    state.pausedProfileId = null;
    state.pausedAgentLabel = null;
    state.pausedReason = null;
    setSessionState({ running: true, paused: false });
    setSessionStatus('Resumed session.');
}

function handleSessionEnded(message) {
    clearPendingTranscriptEntries();
    setSessionState({ running: false, paused: false });
    setSessionStatus(message?.reason || 'Session completed');
    state.sessionId = null;
    state.stopRequested = false;
    state.pausedProvider = null;
    state.pausedAgentId = null;
    state.pausedProfileId = null;
    state.pausedAgentLabel = null;
    state.pausedReason = null;
    resetSessionProfiles();
}

function handleSessionError(message) {
    clearPendingTranscriptEntries();
    setSessionState({ running: false, paused: false });
    setSessionStatus(`Error: ${message?.error || 'Unknown error'}`);
    state.sessionId = null;
    state.stopRequested = false;
    state.pausedProvider = null;
    state.pausedAgentId = null;
    state.pausedProfileId = null;
    state.pausedAgentLabel = null;
    state.pausedReason = null;
}

function clearTranscript() {
    clearPendingTranscriptEntries();
    if (!elements.timeline) return;
    elements.timeline.innerHTML = '';
    if (elements.emptyState) {
        elements.timeline.appendChild(elements.emptyState);
    }
}

function ensureLoadOlderElements() {
    if (elements.loadOlderWrap && elements.loadOlderButton) return;
    const wrap = document.createElement('div');
    wrap.className = 'timeline-load-older';
    wrap.hidden = true;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost-button';
    button.textContent = 'Load older messages';
    button.addEventListener('click', loadOlderMessages);

    wrap.appendChild(button);
    elements.loadOlderWrap = wrap;
    elements.loadOlderButton = button;
}

function updateLoadOlderUi() {
    if (!elements.timeline) return;
    ensureLoadOlderElements();
    const hasCursor = Number.isFinite(state.activeChatNextCursorSequence);
    const show = Boolean(state.activeChatId && state.activeChatHasMore && hasCursor);

    if (!show) {
        if (elements.loadOlderWrap && elements.timeline.contains(elements.loadOlderWrap)) {
            elements.loadOlderWrap.remove();
        }
        return;
    }

    if (elements.loadOlderWrap && !elements.timeline.contains(elements.loadOlderWrap)) {
        elements.timeline.insertBefore(elements.loadOlderWrap, elements.timeline.firstChild);
    }

    elements.loadOlderWrap.hidden = false;
    if (elements.loadOlderButton) {
        elements.loadOlderButton.disabled = state.loadingOlderMessages;
        elements.loadOlderButton.textContent = state.loadingOlderMessages
            ? 'Loading…'
            : 'Load older messages';
    }
}

function loadOlderMessages() {
    if (!state.activeChatId) return;
    if (!state.activeChatHasMore) return;
    if (!Number.isFinite(state.activeChatNextCursorSequence)) return;
    if (state.loadingOlderMessages) return;

    state.loadingOlderMessages = true;
    updateLoadOlderUi();

    const chatId = state.activeChatId;
    const beforeSequence = state.activeChatNextCursorSequence;

    sendMessage(
        { type: 'GET_MESSAGES_PAGE', chatId, beforeSequence, limit: HISTORY_PAGE_SIZE },
        (response) => {
            state.loadingOlderMessages = false;
            if (!response) {
                setSessionStatus('Error: Failed to load older messages.');
                updateLoadOlderUi();
                return;
            }
            if (response.ok === false) {
                setSessionStatus(`Error: ${response.error || 'Failed to load older messages.'}`);
                updateLoadOlderUi();
                return;
            }

            const messages = Array.isArray(response.messages) ? response.messages : [];
            if (messages.length === 0) {
                state.activeChatHasMore = false;
                state.activeChatNextCursorSequence = null;
                updateLoadOlderUi();
                return;
            }

            if (state.activeChat && Array.isArray(state.activeChat.messages)) {
                state.activeChat.messages.unshift(...messages);
            }
            prependMessages(messages);

            state.activeChatHasMore = Boolean(response.hasMore);
            state.activeChatNextCursorSequence = Number.isFinite(response.nextCursorSequence)
                ? response.nextCursorSequence
                : null;
            updateLoadOlderUi();
        }
    );
}

function isSafeLinkHref(href) {
    if (transcriptViewApi && typeof transcriptViewApi.isSafeLinkHref === 'function') {
        return transcriptViewApi.isSafeLinkHref(href);
    }
    if (!href) return false;
    const value = String(href).trim();
    if (!value) return false;
    if (value.startsWith('#')) return true;
    if (value.startsWith('/')) return true;
    if (value.startsWith('./') || value.startsWith('../')) return true;
    return /^https?:\/\//i.test(value) || /^mailto:/i.test(value);
}

function sanitizeRichHtmlToFragment(html) {
    if (transcriptViewApi && typeof transcriptViewApi.sanitizeRichHtmlToFragment === 'function') {
        return transcriptViewApi.sanitizeRichHtmlToFragment(html, document);
    }
    const template = document.createElement('template');
    template.innerHTML = String(html || '');

    const htmlTags = new Set([
        'a',
        'b',
        'blockquote',
        'br',
        'caption',
        'code',
        'dd',
        'del',
        'details',
        'div',
        'dl',
        'dt',
        'em',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
        'i',
        'ins',
        'kbd',
        'li',
        'ol',
        'p',
        'pre',
        's',
        'section',
        'small',
        'span',
        'strong',
        'sub',
        'summary',
        'sup',
        'table',
        'tbody',
        'td',
        'tfoot',
        'th',
        'thead',
        'tr',
        'u',
        'ul',
    ]);

    const mathMlTags = new Set([
        'annotation',
        'maction',
        'math',
        'menclose',
        'merror',
        'mfenced',
        'mfrac',
        'mi',
        'mlabeledtr',
        'mmultiscripts',
        'mn',
        'mo',
        'mover',
        'mpadded',
        'mphantom',
        'mroot',
        'mrow',
        'ms',
        'mspace',
        'msqrt',
        'mstyle',
        'msub',
        'msubsup',
        'msup',
        'mtable',
        'mtd',
        'mtext',
        'mtr',
        'munder',
        'munderover',
        'semantics',
    ]);

    const dropTags = new Set([
        'audio',
        'button',
        'canvas',
        'embed',
        'form',
        'iframe',
        'img',
        'input',
        'link',
        'meta',
        'noscript',
        'object',
        'option',
        'script',
        'select',
        'style',
        'svg',
        'textarea',
        'video',
    ]);

    const mathNs = 'http://www.w3.org/1998/Math/MathML';

    const sanitizeNode = (node) => {
        if (!node) return null;
        if (node.nodeType === Node.TEXT_NODE) {
            return document.createTextNode(node.nodeValue || '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            return null;
        }

        const tag = String(node.tagName || '').toLowerCase();
        if (!tag) return null;
        if (dropTags.has(tag)) return null;

        const classAttr = node.getAttribute('class') || '';
        if (/\bkatex-html\b/i.test(classAttr)) return null;

        const isMath = mathMlTags.has(tag);
        const isHtml = htmlTags.has(tag);
        if (!isMath && !isHtml) {
            const fragment = document.createDocumentFragment();
            Array.from(node.childNodes).forEach((child) => {
                const sanitizedChild = sanitizeNode(child);
                if (sanitizedChild) fragment.appendChild(sanitizedChild);
            });
            return fragment;
        }

        const el = isMath ? document.createElementNS(mathNs, tag) : document.createElement(tag);

        if (tag === 'a') {
            const href = node.getAttribute('href') || '';
            if (isSafeLinkHref(href)) {
                el.setAttribute('href', href);
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
                const title = node.getAttribute('title');
                if (title) el.setAttribute('title', title);
            }
        } else if (tag === 'td' || tag === 'th') {
            const colspan = node.getAttribute('colspan');
            const rowspan = node.getAttribute('rowspan');
            if (colspan && /^[0-9]+$/.test(colspan)) el.setAttribute('colspan', colspan);
            if (rowspan && /^[0-9]+$/.test(rowspan)) el.setAttribute('rowspan', rowspan);
        } else if (isMath) {
            const display = node.getAttribute('display');
            if (display) el.setAttribute('display', display);
            const xmlns = node.getAttribute('xmlns');
            if (xmlns) el.setAttribute('xmlns', xmlns);
            const encoding = node.getAttribute('encoding');
            if (encoding && tag === 'annotation') el.setAttribute('encoding', encoding);
        }

        const ariaLabel = node.getAttribute('aria-label');
        if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
        const ariaHidden = node.getAttribute('aria-hidden');
        if (ariaHidden) el.setAttribute('aria-hidden', ariaHidden);

        Array.from(node.childNodes).forEach((child) => {
            const sanitizedChild = sanitizeNode(child);
            if (sanitizedChild) el.appendChild(sanitizedChild);
        });

        return el;
    };

    const fragment = document.createDocumentFragment();
    Array.from(template.content.childNodes).forEach((child) => {
        const sanitized = sanitizeNode(child);
        if (sanitized) fragment.appendChild(sanitized);
    });
    return fragment;
}

function postProcessRichContent(rootEl) {
    if (transcriptViewApi && typeof transcriptViewApi.postProcessRichContent === 'function') {
        transcriptViewApi.postProcessRichContent(rootEl, document);
        return;
    }
    if (!rootEl) return;
    rootEl.querySelectorAll('table').forEach((table) => {
        const parent = table.parentElement;
        if (parent && parent.classList.contains('table-wrap')) return;
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        table.replaceWith(wrap);
        wrap.appendChild(table);
    });
}

function buildMessageElement(message) {
    if (transcriptViewApi && typeof transcriptViewApi.buildMessageElement === 'function') {
        return transcriptViewApi.buildMessageElement(message, {
            document,
            formatRoleLabel,
            normalizeInlineText,
        });
    }
    const roleKey = String(message.role || message.llm || 'system')
        .trim()
        .toLowerCase();
    const container = document.createElement('div');
    container.className = `message ${roleKey || 'system'}`;
    container.dataset.provider = roleKey || 'system';
    if (roleKey && roleKey !== 'user' && roleKey !== 'system') {
        container.classList.add('assistant');
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';

    const role = document.createElement('span');
    role.className = 'message-role';
    role.textContent = formatRoleLabel(message.role || message.llm || 'system');

    const label = document.createElement('span');
    label.className = 'message-label';
    const agent = normalizeInlineText(message.agentLabel || '');
    const round = message.roundIndex ? `Round ${message.roundIndex}` : null;
    const turn = message.turnIndex ? `Turn ${message.turnIndex}` : null;
    label.textContent = [agent || null, round, turn].filter(Boolean).join(' | ');

    meta.appendChild(role);
    meta.appendChild(label);

    const content = document.createElement('div');
    content.className = 'message-content';
    const richHtml = typeof message.contentHtml === 'string' ? message.contentHtml : '';
    if (richHtml && richHtml.trim()) {
        container.classList.add('rich');
        content.classList.add('rich');
        content.replaceChildren(sanitizeRichHtmlToFragment(richHtml));
        postProcessRichContent(content);
    } else {
        content.textContent = message.content || '';
    }

    container.appendChild(meta);
    container.appendChild(content);
    return container;
}

function prependMessages(messages) {
    if (!elements.timeline) return;
    if (!Array.isArray(messages) || messages.length === 0) return;

    if (elements.emptyState && elements.timeline.contains(elements.emptyState)) {
        elements.emptyState.remove();
    }

    const beforeHeight = elements.timeline.scrollHeight;
    const fragment = document.createDocumentFragment();
    messages.forEach((message) => {
        fragment.appendChild(buildMessageElement(message));
    });

    const afterLoadOlder =
        elements.loadOlderWrap && elements.timeline.contains(elements.loadOlderWrap)
            ? elements.loadOlderWrap.nextSibling
            : elements.timeline.firstChild;

    elements.timeline.insertBefore(fragment, afterLoadOlder || null);
    const afterHeight = elements.timeline.scrollHeight;
    elements.timeline.scrollTop += Math.max(0, afterHeight - beforeHeight);
}

function addMessage(message) {
    if (!elements.timeline) return;
    consumePendingEntryForMessage(message);

    if (elements.emptyState && elements.timeline.contains(elements.emptyState)) {
        elements.emptyState.remove();
    }

    elements.timeline.appendChild(buildMessageElement(message));

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
    if (normalized === 'claude') return 'Claude';
    if (normalized === 'grok') return 'Grok';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatProviderLabel(provider) {
    if (!provider) return 'Provider';
    const normalized = String(provider).toLowerCase();
    if (normalized === 'gemini') return 'Gemini';
    if (normalized === 'chatgpt') return 'ChatGPT';
    if (normalized === 'claude') return 'Claude';
    if (normalized === 'grok') return 'Grok';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeInlineText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getProfilesForProvider(provider) {
    return state.profiles.filter((profile) => profile.provider === provider);
}

function getProfileById(profileId) {
    if (!profileId) return null;
    return state.profiles.find((profile) => profile.profileId === profileId) || null;
}
