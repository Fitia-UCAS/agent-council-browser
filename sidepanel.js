/* global chrome */

const DEFAULT_PROVIDER_IDS = ['chatgpt', 'gemini', 'claude', 'grok'];

function initProviderMap(value) {
    const out = {};
    DEFAULT_PROVIDER_IDS.forEach((provider) => {
        out[provider] = value;
    });
    return out;
}

const state = {
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
    pausedReason: null,
    autoScroll: true,
    historyStatus: { configured: false, unlocked: false },
    historyUnlockPrompted: false,
    connectionStatus: initProviderMap(false),
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
    manualUploadAckKey: null,
    attachments: [],
    attachmentsLoading: false,
    attachmentsWarning: ''
};

const elements = {};
const HISTORY_PAGE_SIZE = 60;

const ROUTE_STORAGE_KEY = 'mlc_last_route_v1';

const ATTACHMENTS_MAX_FILES = 10;
const ATTACHMENTS_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ATTACHMENTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

let attachmentsModalResolver = null;
let passphrasePrompt = null;
let sessionWatchdogInterval = null;

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
    const value = String(provider || '').trim().toLowerCase();
    if (!value) return null;
    if (DEFAULT_PROVIDER_IDS.includes(value)) return value;
    const capabilities = state.providerCapabilities && typeof state.providerCapabilities === 'object'
        ? state.providerCapabilities
        : null;
    if (capabilities && Object.prototype.hasOwnProperty.call(capabilities, value)) return value;
    return null;
}

function sanitizeRoute(input) {
    const route = input && typeof input === 'object' ? input : {};
    const providers = [];
    const rawProviders = Array.isArray(route.providers) ? route.providers : [];
    for (const item of rawProviders) {
        const normalized = normalizeProviderId(item);
        if (!normalized) continue;
        if (!providers.includes(normalized)) providers.push(normalized);
    }

    const requestedKind = String(route.kind || '').trim().toLowerCase();
    const roundsValue = route.rounds == null ? 3 : route.rounds;
    const rounds = clampInt(roundsValue, 1, 12);

    let kind = 'single';
    if (providers.length >= 2) {
        if (requestedKind === 'debate') kind = 'debate';
        else kind = 'parallel';
    }

    return {
        kind,
        providers,
        rounds
    };
}

function getDefaultRoute() {
    return { kind: 'single', providers: [], rounds: 3 };
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
        return sanitizeRoute({ kind: 'debate', providers: [first, second], rounds: runConfig.rounds });
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
    const stored = await storageGet([ROUTE_STORAGE_KEY]);
    const savedRoute = stored?.[ROUTE_STORAGE_KEY];
    state.route = savedRoute ? sanitizeRoute(savedRoute) : getDefaultRoute();
    state.routeLoaded = true;
}

function saveRoutePreference(route) {
    const next = sanitizeRoute(route);
    state.route = next;
    return storageSet({ [ROUTE_STORAGE_KEY]: next });
}

let routeDragProvider = null;
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
        if (elements.routePopover.contains(target)
            || elements.routeButton.contains(target)
            || (elements.providersButton && elements.providersButton.contains(target))) {
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
    const capabilities = state.providerCapabilities && typeof state.providerCapabilities === 'object'
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

function resetSessionProfiles() {
    const next = {};
    getSupportedProviders().forEach((provider) => {
        next[provider] = null;
    });
    state.sessionProfiles = next;
}

function isRouteProviderSelected(provider) {
    const route = state.route || getDefaultRoute();
    return route.providers.includes(provider);
}

function setRoute(route, { persist = true } = {}) {
    const next = sanitizeRoute(route);
    state.route = next;
    if (persist) {
        storageSet({ [ROUTE_STORAGE_KEY]: next }).catch(() => {});
    }
    renderRouteUi();
    updateSendState();
}

function setRouteKind(kind) {
    const route = state.route || getDefaultRoute();
    const providers = route.providers || [];
    if (providers.length < 2) return;
    const normalizedKind = String(kind || '').trim().toLowerCase();
    if (normalizedKind === 'debate' && providers.length < 2) return;
    if (normalizedKind !== 'parallel' && normalizedKind !== 'debate') return;
    setRoute({ ...route, kind: normalizedKind });
}

function applyRoutePreset(preset) {
    const route = state.route || getDefaultRoute();
    const kind = String(preset || '').trim().toLowerCase();
    if (kind === 'single') {
        const provider = normalizeProviderId(route.providers?.[0]) || 'chatgpt';
        setRoute({ kind: 'single', providers: [provider], rounds: route.rounds });
        return;
    }
    if (kind === 'compare') {
        const supported = getSupportedProviders();
        const baseProviders = route.providers.length >= 2 ? route.providers : supported;
        const providers = baseProviders.length >= 2 ? baseProviders : ['chatgpt', 'gemini'];
        setRoute({ kind: 'parallel', providers, rounds: route.rounds });
        return;
    }
    if (kind === 'debate') {
        const supported = getSupportedProviders();
        const fallbackPair = supported.length >= 2 ? supported.slice(0, 2) : ['chatgpt', 'gemini'];
        const providers = route.providers.length >= 2 ? route.providers : fallbackPair;
        setRoute({ kind: 'debate', providers, rounds: route.rounds || 3 });
    }
}

function swapRouteProviders() {
    const route = state.route || getDefaultRoute();
    if (!Array.isArray(route.providers) || route.providers.length < 2) return;
    const next = [...route.providers].reverse();
    setRoute({ ...route, providers: next });
}

function formatRouteSummary(route) {
    const providers = Array.isArray(route?.providers) ? route.providers : [];
    if (providers.length === 0) return 'Select providers…';
    if (providers.length === 1) return formatProviderLabel(providers[0]);
    const names = providers.map(formatProviderLabel);
    if (route?.kind === 'debate' && providers.length >= 2) {
        const rounds = route.rounds || 1;
        const chain = names.length === 2 ? `${names[0]} ↔ ${names[1]}` : names.join(' ↔ ');
        return `Debate (${chain}, ${rounds})`;
    }
    return names.join(' + ');
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

    const providerCount = route.providers.length;
    if (elements.routeModeSection) {
        elements.routeModeSection.hidden = providerCount < 2;
    }

    if (elements.routeModeDebate) {
        elements.routeModeDebate.hidden = providerCount < 2;
    }

    if (elements.routeModeParallel) {
        elements.routeModeParallel.classList.toggle('is-active', providerCount >= 2 && route.kind === 'parallel');
    }
    if (elements.routeModeDebate) {
        elements.routeModeDebate.classList.toggle('is-active', providerCount >= 2 && route.kind === 'debate');
    }

    const debateEnabled = providerCount >= 2 && route.kind === 'debate';
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
    const anyNeedsConnect = supported.some((provider) => !Boolean(state.connectionStatus?.[provider]));
    if (anyConnecting) {
        elements.routeConnectAll.textContent = 'Connecting…';
        elements.routeConnectAll.disabled = true;
        return;
    }
    if (!anyNeedsConnect) {
        elements.routeConnectAll.textContent = 'All connected';
        elements.routeConnectAll.disabled = true;
        return;
    }
    elements.routeConnectAll.textContent = 'Connect all';
    elements.routeConnectAll.disabled = false;
}

function renderRouteSelectedChips(route) {
    if (!elements.routeSelected) return;
    elements.routeSelected.innerHTML = '';
    const providers = Array.isArray(route?.providers) ? route.providers : [];
    if (providers.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'route-help';
        empty.textContent = 'No providers selected.';
        elements.routeSelected.appendChild(empty);
        return;
    }

    providers.forEach((provider) => {
        const chip = document.createElement('div');
        chip.className = 'route-chip';
        chip.draggable = true;
        chip.dataset.provider = provider;
        chip.textContent = formatProviderLabel(provider);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'route-chip-remove';
        remove.dataset.action = 'remove-route-provider';
        remove.dataset.provider = provider;
        remove.setAttribute('aria-label', `Remove ${formatProviderLabel(provider)}`);

        const icon = document.createElement('span');
        icon.className = 'material-symbols-rounded';
        icon.textContent = 'close';
        remove.appendChild(icon);

        chip.appendChild(remove);
        elements.routeSelected.appendChild(chip);
    });
}

function renderRouteProviderList(route) {
    if (!elements.routeProviderList) return;
    elements.routeProviderList.innerHTML = '';
    const supported = getSupportedProviders();
    supported.forEach((provider) => {
        const selected = isRouteProviderSelected(provider);
        const ready = Boolean(state.connectionStatus?.[provider]);
        const connecting = Boolean(state.connecting?.[provider]);
        const profile = getDefaultProfile(provider);
        const connected = Boolean(profile?.tabId && ready);
        const modelHint = profile?.modelHint ? ` • ${profile.modelHint}` : '';

        let statusText = 'Not connected';
        if (connecting) statusText = 'Connecting…';
        else if (ready) statusText = 'Ready';
        else if (profile?.status === 'wrong_host') statusText = 'Wrong host';
        else if (profile?.status === 'unknown') statusText = 'Loading…';
        else if (profile?.status === 'ok') statusText = 'Waiting…';

        const usingText = connected
            ? `Using: ${profile.label || formatProviderLabel(provider)}${modelHint}`
            : (profile?.label ? `Last: ${profile.label}${modelHint}` : 'No tab yet');

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
        name.appendChild(dot);

        const nameText = document.createElement('span');
        nameText.textContent = formatProviderLabel(provider);
        name.appendChild(nameText);

        meta.appendChild(name);

        const status = document.createElement('div');
        status.className = 'route-provider-status';
        status.textContent = `${statusText} • ${usingText}`;
        meta.appendChild(status);

        const actions = document.createElement('div');
        actions.className = 'route-provider-actions';

        if (!connected) {
            const connect = document.createElement('button');
            connect.type = 'button';
            connect.className = 'ghost-button';
            connect.dataset.action = 'connect-provider';
            connect.dataset.provider = provider;
            connect.textContent = connecting ? 'Connecting…' : 'Connect';
            connect.disabled = connecting;
            actions.appendChild(connect);
        } else {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'ghost-button';
            toggle.dataset.action = 'toggle-provider';
            toggle.dataset.provider = provider;
            toggle.textContent = selected ? 'Remove' : 'Add';
            toggle.setAttribute('aria-pressed', selected ? 'true' : 'false');

            const focus = document.createElement('button');
            focus.type = 'button';
            focus.className = 'ghost-button';
            focus.dataset.provider = provider;
            focus.dataset.action = 'focus-provider';
            focus.textContent = 'Focus';
            focus.disabled = connecting || !profile?.tabId;

            const newTab = document.createElement('button');
            newTab.type = 'button';
            newTab.className = 'ghost-button';
            newTab.dataset.provider = provider;
            newTab.dataset.action = 'new-tab';
            newTab.textContent = connecting ? 'Opening…' : 'New tab';
            newTab.disabled = connecting;

            actions.appendChild(toggle);
            actions.appendChild(focus);
            actions.appendChild(newTab);
        }

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
    const provider = normalizeProviderId(providerFromButton || target.closest('[data-provider]')?.dataset.provider);
    if (!provider) return;

    const connectAndAdd = () => {
        const route = state.route || getDefaultRoute();
        const providers = [...(route.providers || [])];
        if (!providers.includes(provider)) {
            providers.push(provider);
            setRoute({ ...route, providers });
        }
        connectProvider(provider);
    };

    if (action === 'focus-provider') {
        focusProvider(provider);
        return;
    }
    if (action === 'new-tab') {
        connectProvider(provider);
        return;
    }
    if (action === 'connect-provider') {
        connectAndAdd();
        return;
    }
    if (action === 'toggle-provider' || !action) {
        const profile = getDefaultProfile(provider);
        const connected = Boolean(profile?.tabId && Boolean(state.connectionStatus?.[provider]));
        if (!action && !connected) {
            connectAndAdd();
            return;
        }
        const route = state.route || getDefaultRoute();
        const providers = [...(route.providers || [])];
        const existingIndex = providers.indexOf(provider);
        if (existingIndex >= 0) {
            providers.splice(existingIndex, 1);
        } else {
            providers.push(provider);
        }
        setRoute({ ...route, providers });
    }
}

function handleRouteSelectedClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const removeButton = target.closest('button[data-action="remove-route-provider"]');
    if (!removeButton) return;
    const provider = normalizeProviderId(removeButton.dataset.provider);
    if (!provider) return;
    const route = state.route || getDefaultRoute();
    const providers = [...(route.providers || [])].filter((item) => item !== provider);
    setRoute({ ...route, providers });
}

function handleRouteChipDragStart(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const chip = target.closest('.route-chip');
    const provider = normalizeProviderId(chip?.dataset.provider);
    if (!chip || !provider) return;
    routeDragProvider = provider;
    try {
        event.dataTransfer?.setData('text/plain', provider);
        event.dataTransfer?.setDragImage(chip, 10, 10);
    } catch (error) {
        // Ignore DataTransfer restrictions.
    }
}

function handleRouteChipDragOver(event) {
    if (!routeDragProvider) return;
    event.preventDefault();
}

function handleRouteChipDrop(event) {
    if (!routeDragProvider) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const chip = target.closest('.route-chip');
    const dropProvider = normalizeProviderId(chip?.dataset.provider);
    if (!dropProvider || dropProvider === routeDragProvider) return;
    const route = state.route || getDefaultRoute();
    const providers = [...(route.providers || [])];
    const fromIndex = providers.indexOf(routeDragProvider);
    const toIndex = providers.indexOf(dropProvider);
    if (fromIndex === -1 || toIndex === -1) return;
    providers.splice(fromIndex, 1);
    providers.splice(toIndex, 0, routeDragProvider);
    setRoute({ ...route, providers });
}

function handleRouteChipDragEnd() {
    routeDragProvider = null;
}

document.addEventListener('DOMContentLoaded', async () => {
    elements.promptInput = document.getElementById('prompt-input');
    elements.sendButton = document.getElementById('send-button');
    elements.charCount = document.getElementById('char-count');
    elements.refreshProfiles = document.getElementById('refresh-profiles');
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

    elements.connectionsList = document.getElementById('connections-list');
    elements.profileColumns = document.getElementById('profile-columns');
    elements.connectionLabelByProvider = {};
    elements.connectionFocusButtonByProvider = {};
    elements.profileListByProvider = {};

    elements.chatsButton = document.getElementById('chats-button');
    elements.newChatButton = document.getElementById('new-chat-button');
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
    elements.promptJsonEditor = document.getElementById('prompt-json-editor');
    elements.promptJsonSaveButton = document.getElementById('prompt-json-save');
    elements.promptLoadButton = document.getElementById('prompt-load');
    elements.promptSaveButton = document.getElementById('prompt-save');
    elements.promptResetButton = document.getElementById('prompt-reset');
    elements.promptStatus = document.getElementById('prompt-status');

    elements.historyConfigureButton = document.getElementById('history-configure');
    elements.historyUnlockButton = document.getElementById('history-unlock');
	    elements.historyLockButton = document.getElementById('history-lock');
	    elements.historyResetButton = document.getElementById('history-reset');
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

	    elements.modalBackdrop = document.getElementById('modal-backdrop');
	    elements.attachmentsModal = document.getElementById('attachments-modal');
	    elements.attachmentsModalTitle = document.getElementById('attachments-modal-title');
	    elements.attachmentsModalText = document.getElementById('attachments-modal-text');
	    elements.attachmentsModalOk = document.getElementById('attachments-modal-ok');
	    elements.attachmentsModalCancel = document.getElementById('attachments-modal-cancel');
	    elements.attachmentsModalClose = document.getElementById('attachments-modal-close');

	    bindEvents();
        ensureProviderMaps();
        renderProviderSettingsUi();
        await loadRoutePreference();
        renderRouteUi();
	    updateHistoryUi();
	    updateCharCount();
        updateAttachmentsUi();
        updateSendState();

    requestProfiles();
    requestConnectionStatus();
    requestHistoryStatus({ hydrateChats: true, promptUnlock: true });
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

    if (elements.refreshProfiles) {
        elements.refreshProfiles.addEventListener('click', requestProfiles);
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

    if (elements.connectionsList) {
        elements.connectionsList.addEventListener('click', handleConnectionsListClick);
    }

    if (elements.profileColumns) {
        elements.profileColumns.addEventListener('click', handleProfileListClick);
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

    if (elements.promptJsonSaveButton) {
        elements.promptJsonSaveButton.addEventListener('click', savePromptTemplatesJson);
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

    if (elements.historyResetButton) {
        elements.historyResetButton.addEventListener('click', resetHistory);
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

    if (elements.attachmentsModalOk) {
        elements.attachmentsModalOk.addEventListener('click', () => closeAttachmentsModal(true));
    }
    if (elements.attachmentsModalCancel) {
        elements.attachmentsModalCancel.addEventListener('click', () => closeAttachmentsModal(false));
    }
    if (elements.attachmentsModalClose) {
        elements.attachmentsModalClose.addEventListener('click', () => closeAttachmentsModal(false));
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
    if (!chrome?.runtime?.sendMessage) return;
    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
            console.warn('Message failed:', message.type, chrome.runtime.lastError.message);
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
    const configured = Boolean(status?.configured);
    const unlocked = Boolean(status?.unlocked);
    return { configured, unlocked };
}

function isHistoryReady() {
    return Boolean(state.historyStatus?.configured && state.historyStatus?.unlocked);
}

function isHistoryBlocked() {
    return Boolean(state.historyStatus?.configured && !state.historyStatus?.unlocked);
}

function setHistoryStatus(text, isError = false) {
    if (!elements.historyStatus) return;
    elements.historyStatus.textContent = text;
    elements.historyStatus.classList.toggle('is-error', Boolean(isError));
}

function updateHistoryStatus(nextStatus) {
    state.historyStatus = normalizeHistoryStatus(nextStatus);
    updateHistoryUi();
    renderChatList();
    updateSendState();
}

function updateHistoryUi() {
    const configured = Boolean(state.historyStatus?.configured);
    const unlocked = Boolean(state.historyStatus?.unlocked);

    if (!configured) {
        setHistoryStatus('History: off (optional).');
    } else if (!unlocked) {
        setHistoryStatus('History: locked.');
    } else {
        setHistoryStatus('History: unlocked.');
    }

    if (elements.historyConfigureButton) {
        elements.historyConfigureButton.hidden = configured;
    }
    if (elements.historyUnlockButton) {
        elements.historyUnlockButton.hidden = !configured || unlocked;
    }
    if (elements.historyLockButton) {
        elements.historyLockButton.hidden = !configured || !unlocked;
    }
    if (elements.historyResetButton) {
        elements.historyResetButton.hidden = !configured;
    }

    if (elements.historyConfigureButton) {
        elements.historyConfigureButton.disabled = configured;
    }
    if (elements.historyUnlockButton) {
        elements.historyUnlockButton.disabled = !configured || unlocked;
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
        elements.passphraseTitle.textContent = configuring ? 'Enable encryption' : 'Unlock history';
    }
    if (elements.passphraseNote) {
        elements.passphraseNote.textContent = configuring
            ? 'Set a passphrase to enable encrypted history.'
            : 'Enter your passphrase to unlock encrypted history.';
    }
    if (elements.passphraseConfirmField) {
        elements.passphraseConfirmField.hidden = !configuring;
    }
    if (elements.passphraseSubmit) {
        elements.passphraseSubmit.textContent = configuring ? 'Enable' : 'Unlock';
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

    closePassphrasePrompt(passphrase);
}

async function promptForPassphrase({ mode, errorText = null } = {}) {
    if (!elements.passphraseBackdrop || !elements.passphraseModal || !elements.passphraseInput) {
        const label = mode === 'configure' ? 'Set a passphrase' : 'Enter your passphrase';
        const first = window.prompt(label);
        if (first === null) return null;
        const passphrase = String(first || '');
        if (!passphrase.trim()) return null;
        if (mode === 'configure') {
            const confirmValue = window.prompt('Confirm passphrase');
            if (confirmValue === null) return null;
            if (passphrase !== String(confirmValue || '')) {
                window.alert('Passphrases do not match.');
                return null;
            }
        }
        return passphrase;
    }
    return openPassphrasePrompt({ mode, errorText });
}

async function configureHistoryEncryption() {
    if (state.historyStatus?.configured) return;

    const passphrase = await promptForPassphrase({ mode: 'configure' });
    if (passphrase === null) return;

    setHistoryStatus('Configuring encryption…');
    const response = await sendMessageAsync({ type: 'HISTORY_CONFIGURE', passphrase });
    if (!response || response.ok === false) {
        const code = response?.code || '';
        if (code === 'ENCRYPTION_ALREADY_CONFIGURED') {
            setHistoryStatus('Encryption already enabled. Use Unlock instead.', true);
            requestHistoryStatus({ hydrateChats: true, promptUnlock: false });
            return;
        }
        setHistoryStatus(`Error: ${response?.error || 'Failed to configure encryption.'}`, true);
        return;
    }
    updateHistoryStatus(response.status);
    requestChatsState();
}

async function unlockHistory({ auto = false } = {}) {
    if (!state.historyStatus?.configured) {
        if (!auto) setHistoryStatus('Encryption is not configured yet. Enable encryption first.', true);
        return;
    }
    if (state.historyStatus?.unlocked) return;

    let errorText = null;
    while (true) {
        const passphrase = await promptForPassphrase({ mode: 'unlock', errorText });
        if (passphrase === null) return;

        setHistoryStatus('Unlocking…');
        const response = await sendMessageAsync({ type: 'HISTORY_UNLOCK', passphrase });
        if (!response || response.ok === false) {
            const code = response?.code || '';
            if (code === 'PASSPHRASE_INVALID') {
                errorText = 'Incorrect passphrase.';
                continue;
            }
            if (code === 'ENCRYPTION_NOT_CONFIGURED') {
                setHistoryStatus('Encryption is not configured yet. Enable encryption first.', true);
                requestHistoryStatus({ hydrateChats: false, promptUnlock: false });
                return;
            }
            setHistoryStatus(`Error: ${response?.error || 'Failed to unlock history.'}`, true);
            return;
        }
        updateHistoryStatus(response.status);
        requestChatsState();
        return;
    }
}

function lockHistory() {
    setHistoryStatus('Locking…');
    sendMessage({ type: 'HISTORY_LOCK' }, (response) => {
        if (!response || response.ok === false) {
            setHistoryStatus(`Error: ${response?.error || 'Failed to lock history.'}`, true);
            return;
        }
        updateHistoryStatus(response.status);
        state.chats = [];
        state.activeChat = null;
        state.activeChatId = null;
        state.activeChatHasMore = false;
        state.activeChatNextCursorSequence = null;
        clearTranscript();
    });
}

function resetHistory() {
    const confirmed = window.confirm('Reset encrypted history? This will delete all chats and remove your encryption setup.');
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

function getIntermediaryPlaceholderWarning(config) {
    const debate = config?.debate && typeof config.debate === 'object' ? config.debate : {};
    const templates = [
        ['turn2', debate.turn2],
        ['turn3plus_first', debate.turn3plus_first],
        ['turn3plus_second', debate.turn3plus_second]
    ];
    const missing = templates
        .filter(([, value]) => typeof value !== 'string' || !value.includes('{intermediary_message}'))
        .map(([key]) => key);
    if (missing.length === 0) return null;
    return `Note: your templates (${missing.join(', ')}) do not include {intermediary_message}; the intermediary/final fields may have no effect unless you reset to defaults or edit JSON.`;
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

        const debate = state.promptConfig?.debate && typeof state.promptConfig.debate === 'object'
            ? state.promptConfig.debate
            : {};

        if (elements.promptInitial) elements.promptInitial.value = debate.header || '';
        if (elements.promptIntermediary) elements.promptIntermediary.value = debate.intermediary_message || '';
        if (elements.promptFinal) elements.promptFinal.value = debate.final_message || '';

        if (elements.promptJsonEditor) {
            elements.promptJsonEditor.value = JSON.stringify(state.promptConfig, null, 2);
        }

        const sourceLabel = response.source === 'override'
            ? 'Editing custom prompts.'
            : 'Editing defaults (no override saved).';
        const warning = getIntermediaryPlaceholderWarning(state.promptConfig);
        setPromptStatus(warning ? `${sourceLabel}\n${warning}` : sourceLabel);
    });
}

function savePromptTemplates() {
    const baseConfig = state.promptConfig && typeof state.promptConfig === 'object' ? state.promptConfig : {};
    const baseDebate = baseConfig.debate && typeof baseConfig.debate === 'object' ? baseConfig.debate : {};

    const nextConfig = {
        ...baseConfig,
        schemaVersion: 1,
        debate: {
            ...baseDebate,
            header: elements.promptInitial?.value ?? baseDebate.header ?? '',
            intermediary_message: elements.promptIntermediary?.value ?? baseDebate.intermediary_message ?? '',
            final_message: elements.promptFinal?.value ?? baseDebate.final_message ?? ''
        }
    };

    sendMessage({ type: 'SET_DEBATE_PROMPTS', config: nextConfig }, (response) => {
        if (!response || response.ok === false) {
            setPromptStatus(`Error: ${response?.error || 'Failed to save prompts.'}`, true);
            return;
        }
        state.promptConfig = response.config || nextConfig;
        state.promptConfigSource = response.source || 'override';

        const debate = state.promptConfig?.debate && typeof state.promptConfig.debate === 'object'
            ? state.promptConfig.debate
            : {};

        if (elements.promptInitial) elements.promptInitial.value = debate.header || '';
        if (elements.promptIntermediary) elements.promptIntermediary.value = debate.intermediary_message || '';
        if (elements.promptFinal) elements.promptFinal.value = debate.final_message || '';
        if (elements.promptJsonEditor) elements.promptJsonEditor.value = JSON.stringify(state.promptConfig, null, 2);

        const warning = getIntermediaryPlaceholderWarning(state.promptConfig);
        setPromptStatus(warning ? `Saved custom prompts.\n${warning}` : 'Saved custom prompts.');
    });
}

function savePromptTemplatesJson() {
    if (!elements.promptJsonEditor) return;
    let parsed;
    try {
        parsed = JSON.parse(elements.promptJsonEditor.value);
    } catch (error) {
        setPromptStatus(`Invalid JSON: ${error.message}`, true);
        return;
    }

    sendMessage({ type: 'SET_DEBATE_PROMPTS', config: parsed }, (response) => {
        if (!response || response.ok === false) {
            setPromptStatus(`Error: ${response?.error || 'Failed to save prompts.'}`, true);
            return;
        }
        state.promptConfig = response.config || parsed;
        state.promptConfigSource = response.source || 'override';

        const debate = state.promptConfig?.debate && typeof state.promptConfig.debate === 'object'
            ? state.promptConfig.debate
            : {};

        if (elements.promptInitial) elements.promptInitial.value = debate.header || '';
        if (elements.promptIntermediary) elements.promptIntermediary.value = debate.intermediary_message || '';
        if (elements.promptFinal) elements.promptFinal.value = debate.final_message || '';
        elements.promptJsonEditor.value = JSON.stringify(state.promptConfig, null, 2);

        const warning = getIntermediaryPlaceholderWarning(state.promptConfig);
        setPromptStatus(warning ? `Saved custom prompts.\n${warning}` : 'Saved custom prompts.');
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
    const scaled = value / (1024 ** exponent);
    const formatted = scaled >= 10 || exponent === 0 ? scaled.toFixed(0) : scaled.toFixed(1);
    return `${formatted} ${units[exponent]}`;
}

function getAttachmentsTotalBytes() {
    if (!Array.isArray(state.attachments)) return 0;
    return state.attachments.reduce((total, item) => total + (Number.isFinite(item?.size) ? item.size : 0), 0);
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
            warnings.push(`${file.name} is larger than ${formatBytes(ATTACHMENTS_MAX_FILE_BYTES)}.`);
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
                base64
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
    const providers = Array.isArray(route?.providers) ? route.providers : [];
    return providers.length > 0;
}

function isRouteSupported(route) {
    if (!isRouteValid(route)) return false;
    const providers = Array.isArray(route?.providers) ? route.providers : [];
    if (route.kind === 'single') return providers.length === 1;
    const supported = new Set(getSupportedProviders());
    if (providers.some((provider) => !supported.has(provider))) return false;
    if (route.kind === 'debate') return providers.length >= 2;
    if (route.kind === 'parallel') return providers.length >= 2;
    return false;
}

function getRouteRequiredProviders(route) {
    if (!isRouteValid(route)) return [];
    const providers = Array.isArray(route?.providers) ? route.providers : [];
    if (route.kind === 'single') return [providers[0]];
    return [...providers];
}

function getProviderAttachmentMode(provider) {
    const mode = state.providerCapabilities?.[provider]?.attachments?.mode;
    if (mode === 'auto' || mode === 'manual' || mode === 'none') return mode;
    // Safe defaults until a provider is explicitly supported.
    return provider === 'chatgpt' ? 'auto' : 'manual';
}

function buildManualUploadAckKey(route, attachments, manualProviders) {
    const roundsKey = route?.kind === 'debate' ? (route?.rounds || 1) : 1;
    const routeKey = `${route?.kind || 'single'}|${Array.isArray(route?.providers) ? route.providers.join('>') : ''}|${roundsKey}`;
    const providersKey = Array.isArray(manualProviders) ? [...manualProviders].sort().join(',') : '';
    const attachmentKey = Array.isArray(attachments)
        ? attachments.map((item) => String(item?.id || '')).filter(Boolean).join(',')
        : '';
    return `${routeKey}|${providersKey}|${attachmentKey}`;
}

function getAttachmentProviderPlan(route) {
    const required = getRouteRequiredProviders(route);
    const autoProviders = required.filter((provider) => getProviderAttachmentMode(provider) === 'auto');
    const manualProviders = required.filter((provider) => getProviderAttachmentMode(provider) !== 'auto');
    return { required, autoProviders, manualProviders };
}

function isRouteConnected(route) {
    return getRouteRequiredProviders(route).every((provider) => Boolean(state.connectionStatus?.[provider]));
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
        const runConfig = meta?.runConfig && typeof meta.runConfig === 'object' ? meta.runConfig : null;
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
    const connected = validRoute && supportedRoute && isRouteConnected(route);
    const historyBlocked = isHistoryBlocked();
    const readyForPrimaryAction = hasPrompt && attachmentsReady && validRoute && supportedRoute && !historyBlocked;
    elements.sendButton.textContent = connected ? 'Send' : (validRoute && supportedRoute ? 'Connect' : 'Send');
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
    if (elements.refreshProfiles) elements.refreshProfiles.disabled = locked;
    if (elements.attachmentButton) elements.attachmentButton.disabled = locked || state.attachmentsLoading;
    if (elements.attachmentInput) elements.attachmentInput.disabled = locked || state.attachmentsLoading;
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
        const show = state.running || state.paused || (normalized && normalized.toLowerCase() !== 'idle');
        elements.sessionBanner.hidden = !show;
    }
}

function requestProfiles() {
    sendMessage({ type: 'GET_TAB_PROFILES' });
}

function requestConnectionStatus() {
    sendMessage({ type: 'CHECK_CONNECTION' });
}

function requestProviderCapabilities() {
    sendMessage({ type: 'GET_PROVIDER_CAPABILITIES' }, (response) => {
        if (!response || response.ok === false) return;
        state.providerCapabilities = response.capabilities || null;
        ensureProviderMaps();
        renderProviderSettingsUi();
        renderRouteUi();
        updateAttachmentsUi();
        updateSendState();
    });
}

function requestHistoryStatus({ hydrateChats = false, promptUnlock = false } = {}) {
    sendMessage({ type: 'HISTORY_STATUS' }, (response) => {
        if (!response || response.ok === false) {
            updateHistoryStatus(response?.status || { configured: false, unlocked: false });
            return;
        }

        updateHistoryStatus(response.status);

        const configured = Boolean(response.status?.configured);
        const unlocked = Boolean(response.status?.unlocked);

        if (hydrateChats && configured && unlocked) {
            requestChatsState();
        }

        if (promptUnlock && configured && !unlocked && !state.historyUnlockPrompted) {
            state.historyUnlockPrompted = true;
            unlockHistory({ auto: true }).catch((error) => {
                console.warn('Auto-unlock failed:', error);
            });
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
                unlockHistory({ auto: true }).catch((error) => {
                    console.warn('Unlock failed:', error);
                });
            } else if (code === 'HISTORY_NOT_CONFIGURED') {
                setSessionStatus('History is off. Enable encryption in Settings → Security to save chats.');
                openSettingsDrawer();
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
    const nextActiveId = typeof payload.activeChatId === 'string' ? payload.activeChatId : state.activeChatId;
    const shouldLoad = nextActiveId && (!state.activeChat || state.activeChat.chatId !== nextActiveId);
    state.activeChatId = nextActiveId;
    renderChatList();
    if (shouldLoad) {
        loadChat(nextActiveId);
    } else if (state.activeChatId) {
        syncActiveSessionState();
        requestActiveSession();
    }
}

function createNewChat() {
    if (!isHistoryReady()) {
        if (isHistoryBlocked()) {
            setSessionStatus('Unlock history to continue.');
            unlockHistory({ auto: true }).catch((error) => {
                console.warn('Unlock failed:', error);
            });
        } else {
            setSessionStatus('History is off. Enable encryption in Settings → Security to save chats.');
            openSettingsDrawer();
        }
        return;
    }
    sendMessage({ type: 'CREATE_CHAT' }, (response) => {
        if (!response || response.ok === false) {
            handleActionResponse(response || { ok: false, error: 'Failed to create chat.' });
            return;
        }
        if (response.activeChatId) {
            state.activeChatId = response.activeChatId;
            loadChat(response.activeChatId);
        } else if (response.chat?.chatId) {
            state.activeChatId = response.chat.chatId;
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
                unlockHistory({ auto: true }).catch((error) => {
                    console.warn('Unlock failed:', error);
                });
                return;
            }
            if (code === 'HISTORY_NOT_CONFIGURED') {
                setSessionStatus('History is off. Enable encryption in Settings → Security to save chats.');
                openSettingsDrawer();
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
        clearTranscript();
        if (Array.isArray(response.chat?.messages) && response.chat.messages.length) {
            response.chat.messages.forEach(addMessage);
        } else {
            updateEmptyState();
        }
        updateLoadOlderUi();
        renderChatList();
        applyRunDefaultsFromActiveChat();
        updateSendState();
        syncActiveSessionState();
        requestActiveSession();
    });
}

function handleChatListClick(event) {
    if (!isHistoryReady()) {
        if (isHistoryBlocked()) {
            setSessionStatus('Unlock history to continue.');
            unlockHistory({ auto: true }).catch((error) => {
                console.warn('Unlock failed:', error);
            });
        } else {
            setSessionStatus('History is off. Enable encryption in Settings → Security to save chats.');
            openSettingsDrawer();
        }
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
    if (!isHistoryReady()) {
        const empty = document.createElement('div');
        empty.className = 'profile-empty';
        empty.textContent = state.historyStatus?.configured
            ? 'History is locked. Unlock it to access chats.'
            : 'History is off. Enable encryption in Settings → Security to save chats.';
        elements.chatList.appendChild(empty);
        return;
    }
    if (!state.chats.length) {
        const empty = document.createElement('div');
        empty.className = 'profile-empty';
        empty.textContent = 'No chats yet.';
        elements.chatList.appendChild(empty);
        return;
    }
    state.chats.forEach((chat) => {
        const item = document.createElement('div');
        item.className = `chat-item${chat.chatId === state.activeChatId ? ' is-active' : ''}`;
        item.dataset.chatId = chat.chatId;

        const title = document.createElement('div');
        title.className = 'chat-item-title';
        title.textContent = chat.title || 'New chat';

        const meta = document.createElement('div');
        meta.className = 'chat-item-meta';
        const updatedAt = Number.isFinite(chat.updatedAt) ? chat.updatedAt : null;
        const count = Number.isFinite(chat.messageCount) ? chat.messageCount : null;
        const parts = [];
        if (count !== null) parts.push(`${count} msg${count === 1 ? '' : 's'}`);
        if (updatedAt) parts.push(formatRelativeTime(updatedAt));
        meta.textContent = parts.join(' • ');

        item.appendChild(title);
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
    const profileId = state.defaults?.[provider] || null;
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
        requestProfiles();
        requestConnectionStatus();
        window.setTimeout(requestConnectionStatus, 2500);
        window.setTimeout(requestConnectionStatus, 8000);
    });
}

function connectAllProviders() {
    const supported = getSupportedProviders();
    if (supported.length === 0) return;

    const route = state.route || getDefaultRoute();
    const providers = [...(route.providers || [])];
    let didChangeRoute = false;

    supported.forEach((provider) => {
        if (!providers.includes(provider)) {
            providers.push(provider);
            didChangeRoute = true;
        }
    });

    if (didChangeRoute) {
        setRoute({ ...route, providers });
    }

    supported.forEach((provider) => {
        const profile = getDefaultProfile(provider);
        const connected = Boolean(profile?.tabId && Boolean(state.connectionStatus?.[provider]));
        if (connected) return;
        connectProvider(provider);
    });
}

function handleConnectionsListClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    const action = button.dataset.action;
    const provider = normalizeProviderId(button.dataset.provider);
    if (!action || !provider) return;

    if (action === 'connect-provider') {
        connectProvider(provider);
        return;
    }
    if (action === 'focus-provider') {
        focusProvider(provider);
    }
}

function renderProviderSettingsUi() {
    ensureProviderMaps();
    const providers = getSupportedProviders();

    if (elements.connectionLabelByProvider && typeof elements.connectionLabelByProvider === 'object') {
        elements.connectionLabelByProvider = {};
    } else {
        elements.connectionLabelByProvider = {};
    }
    if (elements.connectionFocusButtonByProvider && typeof elements.connectionFocusButtonByProvider === 'object') {
        elements.connectionFocusButtonByProvider = {};
    } else {
        elements.connectionFocusButtonByProvider = {};
    }
    if (elements.profileListByProvider && typeof elements.profileListByProvider === 'object') {
        elements.profileListByProvider = {};
    } else {
        elements.profileListByProvider = {};
    }

    if (elements.connectionsList) {
        elements.connectionsList.innerHTML = '';
        providers.forEach((provider) => {
            const row = document.createElement('div');
            row.className = 'connection-row';
            row.dataset.provider = provider;

            const meta = document.createElement('div');
            meta.className = 'connection-meta';

            const name = document.createElement('div');
            name.className = 'connection-name';
            name.textContent = formatProviderLabel(provider);

            const status = document.createElement('div');
            status.className = 'connection-status';
            status.textContent = 'Checking…';

            meta.appendChild(name);
            meta.appendChild(status);

            const actions = document.createElement('div');
            actions.className = 'connection-actions';

            const connect = document.createElement('button');
            connect.className = 'ghost-button';
            connect.type = 'button';
            connect.textContent = 'Connect';
            connect.dataset.action = 'connect-provider';
            connect.dataset.provider = provider;

            const focus = document.createElement('button');
            focus.className = 'ghost-button';
            focus.type = 'button';
            focus.textContent = 'Focus';
            focus.dataset.action = 'focus-provider';
            focus.dataset.provider = provider;

            actions.appendChild(connect);
            actions.appendChild(focus);

            row.appendChild(meta);
            row.appendChild(actions);
            elements.connectionsList.appendChild(row);

            elements.connectionLabelByProvider[provider] = status;
            elements.connectionFocusButtonByProvider[provider] = focus;
        });
    }

    if (elements.profileColumns) {
        elements.profileColumns.innerHTML = '';
        providers.forEach((provider) => {
            const column = document.createElement('section');
            column.className = 'profile-column';

            const title = document.createElement('div');
            title.className = 'profile-column-title';
            title.textContent = `${formatProviderLabel(provider)} connections`;

            const list = document.createElement('div');
            list.className = 'profile-list';
            list.dataset.provider = provider;

            column.appendChild(title);
            column.appendChild(list);
            elements.profileColumns.appendChild(column);

            elements.profileListByProvider[provider] = list;
        });
    }

    renderProfileLists();
    updateProviderUi();
}

function updateProviderUi() {
    ensureProviderMaps();
    const providers = getSupportedProviders();
    let readyCount = 0;
    let connectingCount = 0;

    providers.forEach((provider) => {
        const ready = Boolean(state.connectionStatus?.[provider]);
        const connecting = Boolean(state.connecting?.[provider]);
        const profile = getDefaultProfile(provider);
        const modelHint = profile?.modelHint ? ` • ${profile.modelHint}` : '';

        if (ready) readyCount += 1;
        if (connecting) connectingCount += 1;

        let labelText = 'Not connected';
        if (connecting) {
            labelText = 'Connecting…';
        } else if (ready) {
            labelText = `Connected${modelHint}`;
        } else if (profile?.status === 'wrong_host') {
            labelText = 'Wrong host';
        } else if (profile?.status === 'unknown') {
            labelText = 'Loading…';
        } else if (profile?.status === 'ok') {
            labelText = 'Waiting…';
        }

        const labelEl = elements.connectionLabelByProvider?.[provider];
        if (labelEl) {
            labelEl.textContent = labelText;
        }

        const focusButton = elements.connectionFocusButtonByProvider?.[provider];
        if (focusButton) {
            focusButton.disabled = !profile?.tabId;
        }
    });

    if (elements.providersButton) {
        let text = 'Providers';
        if (connectingCount > 0) {
            text = 'Providers: connecting…';
        } else {
            text = `Providers: ${readyCount}/${providers.length} ready`;
        }
        elements.providersButton.textContent = text;
        elements.providersButton.classList.toggle('is-ready', readyCount > 0 && connectingCount === 0);
        elements.providersButton.classList.toggle('is-offline', readyCount === 0 && connectingCount === 0);
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
    const requiredProviders = getRouteRequiredProviders(route);
    const requiredLabel = requiredProviders.length > 0
        ? requiredProviders.map(formatProviderLabel).join(' + ')
        : '';
    const connected = validRoute && supportedRoute && isRouteConnected(route);
    const historyBlocked = isHistoryBlocked();
    const hasPrompt = elements.promptInput.value.trim().length > 0;

    let hint = '';
    if (!validRoute) {
        hint = 'Choose a provider in To to start.';
    } else if (!supportedRoute) {
        hint = 'This route is not supported yet.';
    } else if (!connected) {
        hint = `Connect ${requiredLabel} to start.`;
    } else if (historyBlocked) {
        hint = 'Unlock history to continue.';
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
        ? 'Choose a provider in To…'
        : (!supportedRoute
            ? 'Choose a supported route…'
            : (!connected
                ? `Connect ${requiredLabel} to start...`
                : (historyBlocked ? 'Unlock history to continue...' : 'Send a message...')));
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
    const ready = isRouteValid(route) && isRouteSupported(route) && isRouteConnected(route);
    const historyBlocked = isHistoryBlocked();
    const titleEl = elements.emptyState.querySelector('.empty-title');
    const subtitleEl = elements.emptyState.querySelector('.empty-subtitle');
    const actionsEl = elements.emptyState.querySelector('.empty-actions');

    if (ready && historyBlocked) {
        if (titleEl) titleEl.textContent = 'Unlock history';
        if (subtitleEl) subtitleEl.textContent = 'Enter your passphrase to unlock encrypted history.';
        if (actionsEl) {
            actionsEl.hidden = true;
        }
        return;
    }

    if (!isRouteValid(route)) {
        if (titleEl) titleEl.textContent = 'New chat';
        if (subtitleEl) subtitleEl.textContent = 'Choose where to send your message.';
        if (actionsEl) actionsEl.hidden = false;
        return;
    }

    if (!isRouteSupported(route)) {
        if (titleEl) titleEl.textContent = 'Route not supported';
        if (subtitleEl) subtitleEl.textContent = 'This route is not supported yet.';
        if (actionsEl) actionsEl.hidden = false;
        return;
    }

    if (!ready) {
        const label = getRouteRequiredProviders(route).map(formatProviderLabel).join(' + ');
        if (titleEl) titleEl.textContent = 'Connect to start';
        if (subtitleEl) subtitleEl.textContent = `Connect ${label} to start.`;
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

    if (isHistoryBlocked()) {
        setSessionStatus('Unlock history to continue.');
        unlockHistory({ auto: true }).catch((error) => {
            console.warn('Unlock failed:', error);
        });
        return;
    }

    const prompt = elements.promptInput.value.trim();
    if (!prompt) return;

    const route = getRoute();
    if (!isRouteValid(route)) {
        setSessionStatus('Choose a provider to start.');
        openRoutePopover();
        return;
    }
    if (!isRouteSupported(route)) {
        setSessionStatus('This route is not supported yet.');
        openRoutePopover();
        return;
    }

    const required = getRouteRequiredProviders(route);
    if (!isRouteConnected(route)) {
        required.forEach((provider) => connectProvider(provider));
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
	        const autoLabel = autoProviders.length > 0 ? autoProviders.map(formatProviderLabel).join(' + ') : 'none';
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
	                    'After uploading manually, return here and click Send again.'
	                ].join('\n')
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
        chatId: state.activeChatId
    };
    if (attachmentPlan && attachmentPlan.autoProviders.length > 0) {
        payload.attachments = attachments.map((item) => ({
            name: item.name,
            type: item.type,
            size: item.size,
            lastModified: item.lastModified,
            base64: item.base64
        }));
    }

    payload.route = { kind: route.kind, providers: route.providers, rounds };
    if (route.kind === 'debate') {
        payload.mode = 'debate';
        payload.firstLLM = route.providers[0] || 'chatgpt';
    } else {
        payload.mode = 'direct';
        payload.target = route.kind === 'parallel' ? 'both' : (route.providers[0] || 'chatgpt');
    }
    sendMessage(payload);

    elements.promptInput.value = '';
    clearAttachments();
    updateCharCount();
    updateSendState();
}

function stopSession() {
    if (!state.running && !state.paused) return;
    setSessionStatus('Stopping session...');
    if (!state.sessionId) {
        state.stopRequested = true;
    }
    sendMessage({
        type: 'STOP_SESSION',
        sessionId: state.sessionId || undefined,
        chatId: state.activeChatId || undefined,
        reason: 'User requested stop'
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
    return providers.every((provider) => Boolean(state.connectionStatus?.[provider]));
}

function handleBackgroundMessage(message) {
    switch (message.type) {
        case 'PROVIDER_CAPABILITIES':
            state.providerCapabilities = message.capabilities || null;
            ensureProviderMaps();
            renderProviderSettingsUi();
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
                    profileIds: message.profileIds && typeof message.profileIds === 'object' ? message.profileIds : undefined,
                    tabIds: message.tabIds && typeof message.tabIds === 'object' ? message.tabIds : undefined,
                    rounds: message.rounds
                });
            }
            if (isMessageForActiveChat(message)) {
                state.sessionId = message.sessionId;
                state.sessionProfiles = message.profileIds && typeof message.profileIds === 'object'
                    ? message.profileIds
                    : state.sessionProfiles;
                ensureProviderMaps();
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
                    rounds: message.totalRounds || message.rounds
                });
            }
            if (isMessageForActiveChat(message)) {
                handleProgress(message);
            }
            break;
        case 'UI_MESSAGE_ADD':
            if (!message.chatId || message.chatId === state.activeChatId) {
                if (state.activeChat && (!message.chatId || message.chatId === state.activeChat.chatId)) {
                    if (!Array.isArray(state.activeChat.messages)) state.activeChat.messages = [];
                    state.activeChat.messages.push({
                        role: message.role,
                        content: message.content,
                        contentHtml: message.contentHtml,
                        timestamp: message.timestamp,
                        sessionId: message.sessionId,
                        turnIndex: message.turnIndex,
                        roundIndex: message.roundIndex,
                        meta: message.meta
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
                    pausedReason: message.reason || null
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
                    pausedReason: null
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
    state.defaults = message.defaults && typeof message.defaults === 'object' ? message.defaults : {};
    ensureProviderMaps();
    getSupportedProviders().forEach((provider) => {
        if (!Object.prototype.hasOwnProperty.call(state.defaults, provider)) {
            state.defaults[provider] = null;
        }
    });
    if (elements.profileColumns && (!elements.profileListByProvider || Object.keys(elements.profileListByProvider).length === 0)) {
        renderProviderSettingsUi();
    }
    renderProfileLists();
    updateProviderUi();
    updateSendState();
}

function renderProfileLists() {
    const providers = getSupportedProviders();
    providers.forEach((provider) => {
        renderProfileList(elements.profileListByProvider?.[provider] || null, provider);
    });
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
    const incoming = message.status && typeof message.status === 'object' ? message.status : {};
    ensureProviderMaps();
    const next = { ...state.connectionStatus };
    getSupportedProviders().forEach((provider) => {
        next[provider] = Boolean(incoming[provider]);
    });
    state.connectionStatus = next;
    updateProviderUi();
    updateSendState();
}

function hydrateSession(session) {
    if (!session || (!session.isActive && !session.isPaused)) {
        setSessionState({ running: false, paused: false });
        state.sessionId = null;
        resetSessionProfiles();
        state.pausedProvider = null;
        state.pausedReason = null;
        setSessionStatus('Idle');
        return;
    }

    state.sessionId = session.sessionId;
    state.sessionProfiles = session.profileIds && typeof session.profileIds === 'object'
        ? session.profileIds
        : state.sessionProfiles;
    ensureProviderMaps();
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

    if (session.chatId && session.chatId !== state.activeChatId) {
        loadChat(session.chatId);
    }
}

function handleProgress(message) {
    if (!message) return;
    const waitingFor = Array.isArray(message.waitingFor)
        ? message.waitingFor.map(formatProviderLabel).join(' + ')
        : String(message.waitingFor || message.waitingForLabel || '').trim();
    if (message.roundIndex && message.totalRounds) {
        setSessionStatus(`Running round ${message.roundIndex} of ${message.totalRounds} - waiting for ${waitingFor}`);
    } else if (waitingFor) {
        setSessionStatus(`Waiting for ${waitingFor}`);
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
    state.stopRequested = false;
    resetSessionProfiles();
}

function handleSessionError(message) {
    setSessionState({ running: false, paused: false });
    setSessionStatus(`Error: ${message?.error || 'Unknown error'}`);
    state.sessionId = null;
    state.stopRequested = false;
}

function clearTranscript() {
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
        elements.loadOlderButton.textContent = state.loadingOlderMessages ? 'Loading…' : 'Load older messages';
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

    sendMessage({ type: 'GET_MESSAGES_PAGE', chatId, beforeSequence, limit: HISTORY_PAGE_SIZE }, (response) => {
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
    });
}

function isSafeLinkHref(href) {
    if (!href) return false;
    const value = String(href).trim();
    if (!value) return false;
    if (value.startsWith('#')) return true;
    if (value.startsWith('/')) return true;
    if (value.startsWith('./') || value.startsWith('../')) return true;
    return /^https?:\/\//i.test(value) || /^mailto:/i.test(value);
}

function sanitizeRichHtmlToFragment(html) {
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
        'ul'
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
        'semantics'
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
        'video'
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

        const el = isMath
            ? document.createElementNS(mathNs, tag)
            : document.createElement(tag);

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

    const afterLoadOlder = elements.loadOlderWrap && elements.timeline.contains(elements.loadOlderWrap)
        ? elements.loadOlderWrap.nextSibling
        : elements.timeline.firstChild;

    elements.timeline.insertBefore(fragment, afterLoadOlder || null);
    const afterHeight = elements.timeline.scrollHeight;
    elements.timeline.scrollTop += Math.max(0, afterHeight - beforeHeight);
}

function addMessage(message) {
    if (!elements.timeline) return;

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
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getProfilesForProvider(provider) {
    return state.profiles.filter(profile => profile.provider === provider);
}

function getProfileById(profileId) {
    if (!profileId) return null;
    return state.profiles.find(profile => profile.profileId === profileId) || null;
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
