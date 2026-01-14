/* global chrome */

const state = {
    sessionId: null,
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
    connectionStatus: { chatgpt: false, gemini: false },
    connecting: { chatgpt: false, gemini: false },
    profiles: [],
    defaults: { chatgpt: null, gemini: null },
    sessionProfiles: { chatgpt: null, gemini: null },
    promptConfig: null,
    promptConfigSource: null,
    attachments: [],
    attachmentsLoading: false,
    attachmentsWarning: ''
};

const elements = {};
const HISTORY_PAGE_SIZE = 60;
const ATTACHMENTS_MAX_FILES = 10;
const ATTACHMENTS_MAX_FILE_BYTES = 10 * 1024 * 1024;
const ATTACHMENTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

document.addEventListener('DOMContentLoaded', () => {
    elements.promptInput = document.getElementById('prompt-input');
    elements.sendButton = document.getElementById('send-button');
    elements.charCount = document.getElementById('char-count');
    elements.runTarget = document.getElementById('run-target');
    elements.iterations = document.getElementById('iterations');
    elements.refreshProfiles = document.getElementById('refresh-profiles');
    elements.autoScroll = document.getElementById('auto-scroll');
    elements.timeline = document.getElementById('timeline');
    elements.emptyState = document.getElementById('empty-state');
    elements.statusChatGPT = document.getElementById('status-chatgpt');
    elements.statusGemini = document.getElementById('status-gemini');
    elements.sessionStatus = document.getElementById('session-status');
    elements.sessionBanner = document.getElementById('session-banner');
    elements.composerHint = document.getElementById('composer-hint');

    elements.attachmentInput = document.getElementById('attachment-input');
    elements.attachmentButton = document.getElementById('attachment-button');
    elements.attachmentSummary = document.getElementById('attachment-summary');
    elements.attachmentClear = document.getElementById('attachment-clear');
    elements.attachmentList = document.getElementById('attachment-list');

    elements.profileListChatgpt = document.getElementById('profile-list-chatgpt');
    elements.profileListGemini = document.getElementById('profile-list-gemini');
    elements.connectionLabelChatgpt = document.getElementById('connection-label-chatgpt');
    elements.connectionLabelGemini = document.getElementById('connection-label-gemini');

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
    elements.settingsConnectChatgpt = document.getElementById('settings-connect-chatgpt');
    elements.settingsConnectGemini = document.getElementById('settings-connect-gemini');
    elements.settingsFocusChatgpt = document.getElementById('settings-focus-chatgpt');
    elements.settingsFocusGemini = document.getElementById('settings-focus-gemini');

    elements.connectChatgpt = document.getElementById('connect-chatgpt');
    elements.connectGemini = document.getElementById('connect-gemini');
    elements.connectBoth = document.getElementById('connect-both');

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

    elements.historyPassphrase = document.getElementById('history-passphrase');
    elements.historyPassphraseConfirm = document.getElementById('history-passphrase-confirm');
    elements.historyPassphraseConfirmField = document.getElementById('history-passphrase-confirm-field');
    elements.historyConfigureButton = document.getElementById('history-configure');
    elements.historyUnlockButton = document.getElementById('history-unlock');
    elements.historyLockButton = document.getElementById('history-lock');
    elements.historyResetButton = document.getElementById('history-reset');
    elements.historyStatus = document.getElementById('history-status');

    bindEvents();
    updateHistoryUi();
    updateCharCount();
    updateAttachmentsUi();
    updateSendState();

    requestProfiles();
    requestConnectionStatus();
    requestHistoryStatus();
    requestChatsState();
    requestActiveSession();
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
            if (target.dataset.action === 'remove-attachment') {
                const id = target.dataset.attachmentId;
                if (id) removeAttachment(id);
            }
        });
    }

    if (elements.refreshProfiles) {
        elements.refreshProfiles.addEventListener('click', requestProfiles);
    }

    if (elements.runTarget) {
        elements.runTarget.addEventListener('change', updateSendState);
    }

    if (elements.iterations) {
        elements.iterations.addEventListener('change', updateSendState);
    }

    if (elements.autoScroll) {
        elements.autoScroll.addEventListener('change', () => {
            state.autoScroll = elements.autoScroll.checked;
        });
    }

    if (elements.statusChatGPT) {
        elements.statusChatGPT.addEventListener('click', () => handleProviderPillClick('chatgpt'));
    }

    if (elements.statusGemini) {
        elements.statusGemini.addEventListener('click', () => handleProviderPillClick('gemini'));
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

    if (elements.connectChatgpt) {
        elements.connectChatgpt.addEventListener('click', () => connectProvider('chatgpt'));
    }

    if (elements.connectGemini) {
        elements.connectGemini.addEventListener('click', () => connectProvider('gemini'));
    }

    if (elements.connectBoth) {
        elements.connectBoth.addEventListener('click', connectBothProviders);
    }

    if (elements.settingsConnectChatgpt) {
        elements.settingsConnectChatgpt.addEventListener('click', () => connectProvider('chatgpt'));
    }

    if (elements.settingsConnectGemini) {
        elements.settingsConnectGemini.addEventListener('click', () => connectProvider('gemini'));
    }

    if (elements.settingsFocusChatgpt) {
        elements.settingsFocusChatgpt.addEventListener('click', () => focusProvider('chatgpt'));
    }

    if (elements.settingsFocusGemini) {
        elements.settingsFocusGemini.addEventListener('click', () => focusProvider('gemini'));
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

    if (elements.historyPassphrase) {
        elements.historyPassphrase.addEventListener('input', updateHistoryUi);
    }

    if (elements.historyPassphraseConfirm) {
        elements.historyPassphraseConfirm.addEventListener('input', updateHistoryUi);
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

function normalizeHistoryStatus(status) {
    const configured = Boolean(status?.configured);
    const unlocked = Boolean(status?.unlocked);
    return { configured, unlocked };
}

function isHistoryReady() {
    return Boolean(state.historyStatus?.configured && state.historyStatus?.unlocked);
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
        setHistoryStatus('History: encryption not configured. Set a passphrase and click Enable encryption.');
    } else if (!unlocked) {
        setHistoryStatus('History: locked. Enter your passphrase and click Unlock.');
    } else {
        setHistoryStatus('History: unlocked.');
    }

    if (elements.historyPassphraseConfirmField) {
        elements.historyPassphraseConfirmField.hidden = configured;
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

    const passphrase = String(elements.historyPassphrase?.value || '');
    const confirm = String(elements.historyPassphraseConfirm?.value || '');
    const passphraseReady = passphrase.trim().length > 0;
    const matches = passphrase === confirm;

    if (elements.historyConfigureButton) {
        elements.historyConfigureButton.disabled = configured || !passphraseReady || !matches;
    }
    if (elements.historyUnlockButton) {
        elements.historyUnlockButton.disabled = !configured || unlocked || !passphraseReady;
    }
}

function configureHistoryEncryption() {
    if (!elements.historyPassphrase || !elements.historyPassphraseConfirm) return;
    const passphrase = elements.historyPassphrase.value;
    const confirm = elements.historyPassphraseConfirm.value;
    if (!passphrase.trim()) {
        setHistoryStatus('Passphrase is empty.', true);
        return;
    }
    if (passphrase !== confirm) {
        setHistoryStatus('Passphrases do not match.', true);
        return;
    }

    setHistoryStatus('Configuring encryption…');
    sendMessage({ type: 'HISTORY_CONFIGURE', passphrase }, (response) => {
        if (!response || response.ok === false) {
            const code = response?.code || '';
            if (code === 'ENCRYPTION_ALREADY_CONFIGURED') {
                setHistoryStatus('Encryption already enabled. Use Unlock instead.', true);
                requestHistoryStatus();
                return;
            }
            setHistoryStatus(`Error: ${response?.error || 'Failed to configure encryption.'}`, true);
            return;
        }
        elements.historyPassphrase.value = '';
        elements.historyPassphraseConfirm.value = '';
        updateHistoryStatus(response.status);
        requestChatsState();
    });
}

function unlockHistory() {
    if (!elements.historyPassphrase) return;
    const passphrase = elements.historyPassphrase.value;
    if (!passphrase.trim()) {
        setHistoryStatus('Passphrase is empty.', true);
        return;
    }

    setHistoryStatus('Unlocking…');
    sendMessage({ type: 'HISTORY_UNLOCK', passphrase }, (response) => {
        if (!response || response.ok === false) {
            const code = response?.code || '';
            if (code === 'PASSPHRASE_INVALID') {
                setHistoryStatus('Incorrect passphrase.', true);
                return;
            }
            if (code === 'ENCRYPTION_NOT_CONFIGURED') {
                setHistoryStatus('Encryption is not configured yet. Use Enable encryption first.', true);
                requestHistoryStatus();
                return;
            }
            setHistoryStatus(`Error: ${response?.error || 'Failed to unlock history.'}`, true);
            return;
        }
        elements.historyPassphrase.value = '';
        if (elements.historyPassphraseConfirm) elements.historyPassphraseConfirm.value = '';
        updateHistoryStatus(response.status);
        requestChatsState();
    });
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
        if (state.attachmentsLoading) {
            elements.attachmentSummary.textContent = 'Reading attachments…';
        } else if (count === 0) {
            elements.attachmentSummary.textContent = 'No attachments';
        } else {
            const label = count === 1 ? '1 file' : `${count} files`;
            elements.attachmentSummary.textContent = `${label} • ${formatBytes(totalBytes)}`;
        }
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

        const meta = document.createElement('div');
        meta.className = 'attachment-meta';

        const name = document.createElement('div');
        name.className = 'attachment-name';
        name.textContent = attachment.name || 'attachment';

        const sub = document.createElement('div');
        sub.className = 'attachment-sub';
        const typeLabel = attachment.type ? attachment.type : 'unknown type';
        const sizeLabel = Number.isFinite(attachment.size) ? formatBytes(attachment.size) : '';
        sub.textContent = [typeLabel, sizeLabel].filter(Boolean).join(' • ');

        meta.appendChild(name);
        meta.appendChild(sub);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.dataset.action = 'remove-attachment';
        remove.dataset.attachmentId = attachment.id;
        remove.textContent = 'Remove';

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

function getRunTarget() {
    const value = String(elements.runTarget?.value || '').trim();
    switch (value) {
        case 'debate_chatgpt':
        case 'debate_gemini':
        case 'chatgpt':
        case 'gemini':
        case 'both':
            return value;
        default:
            return 'debate_chatgpt';
    }
}

function isDebateTarget(runTarget) {
    return runTarget === 'debate_chatgpt' || runTarget === 'debate_gemini';
}

function getDebateFirstLLM(runTarget) {
    return runTarget === 'debate_gemini' ? 'gemini' : 'chatgpt';
}

function getDirectTarget(runTarget) {
    if (runTarget === 'both') return 'both';
    if (runTarget === 'gemini') return 'gemini';
    return 'chatgpt';
}

function getRequiredProvidersForRun(runTarget) {
    if (isDebateTarget(runTarget) || runTarget === 'both') return ['chatgpt', 'gemini'];
    return [getDirectTarget(runTarget)];
}

function isRunConnected() {
    const runTarget = getRunTarget();
    return getRequiredProvidersForRun(runTarget).every((provider) => Boolean(state.connectionStatus?.[provider]));
}

function updateRunUi() {
    const runTarget = getRunTarget();
    const locked = state.running || state.paused;
    const debate = isDebateTarget(runTarget);
    if (elements.iterations) {
        if (!debate) {
            elements.iterations.value = '1';
        }
        elements.iterations.disabled = locked || !debate;
    }
    if (elements.runTarget) {
        elements.runTarget.disabled = locked;
    }
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
    if (!runConfig || typeof runConfig !== 'object') return;
    const runType = runConfig.runType || runConfig.mode || null;
    if (runType === 'debate') {
        const firstLLM = runConfig.firstLLM === 'gemini' ? 'gemini' : 'chatgpt';
        if (elements.runTarget) {
            elements.runTarget.value = firstLLM === 'gemini' ? 'debate_gemini' : 'debate_chatgpt';
        }
        if (elements.iterations && runConfig.rounds) {
            elements.iterations.value = String(clampInt(runConfig.rounds, 1, 12));
        }
    } else if (runType === 'direct') {
        const target = runConfig.target;
        if (elements.runTarget) {
            if (target === 'both') elements.runTarget.value = 'both';
            else if (target === 'gemini') elements.runTarget.value = 'gemini';
            else elements.runTarget.value = 'chatgpt';
        }
        if (elements.iterations) {
            elements.iterations.value = '1';
        }
    } else if (runType === 'single') {
        const llm = runConfig.llm === 'gemini' ? 'gemini' : 'chatgpt';
        if (elements.runTarget) {
            elements.runTarget.value = llm;
        }
        if (elements.iterations) {
            elements.iterations.value = '1';
        }
    }
    updateRunUi();
}

function applyRunDefaultsFromActiveChat() {
    const runConfig = findLastUserRunConfig(state.activeChat);
    if (runConfig) {
        applyRunConfigDefaults(runConfig);
    } else {
        updateRunUi();
    }
}

function updateSendState() {
    if (!elements.sendButton || !elements.promptInput || !elements.iterations) return;
    updateRunUi();
    const locked = state.running || state.paused;
    if (locked) {
        elements.sendButton.textContent = 'Stop';
        elements.sendButton.disabled = !isHistoryReady();
        updateComposerHint();
        return;
    }
    const hasPrompt = elements.promptInput.value.trim().length > 0;
    const attachmentsReady = !state.attachmentsLoading;
    const runTarget = getRunTarget();
    const debate = isDebateTarget(runTarget);
    const iterations = debate ? (parseInt(elements.iterations.value, 10) || 0) : 1;
    const connected = isRunConnected();
    elements.sendButton.textContent = 'Send';
    elements.sendButton.disabled = !hasPrompt || !attachmentsReady || iterations <= 0 || !connected || !isHistoryReady();
    updateComposerHint();
    updateEmptyState();
}

function setSessionState({ running, paused }) {
    state.running = running;
    state.paused = paused;
    const locked = running || paused;

    if (elements.runTarget) elements.runTarget.disabled = locked;
    if (elements.iterations) elements.iterations.disabled = locked || !isDebateTarget(getRunTarget());
    if (elements.refreshProfiles) elements.refreshProfiles.disabled = locked;
    if (elements.newChatButton) elements.newChatButton.disabled = locked;
    if (elements.drawerNewChatButton) elements.drawerNewChatButton.disabled = locked;
    if (elements.attachmentButton) elements.attachmentButton.disabled = locked || state.attachmentsLoading;
    if (elements.attachmentInput) elements.attachmentInput.disabled = locked || state.attachmentsLoading;
    updateRunUi();
    updateAttachmentsUi();
    updatePausedActions();
    updateSendState();
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

function requestHistoryStatus() {
    sendMessage({ type: 'HISTORY_STATUS' }, (response) => {
        if (!response || response.ok === false) {
            updateHistoryStatus(response?.status || { configured: false, unlocked: false });
            return;
        }
        updateHistoryStatus(response.status);
    });
}

function requestActiveSession() {
    sendMessage({ type: 'GET_ACTIVE_SESSION' });
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
                setSessionStatus('History is locked. Unlock it in Settings → Security.');
            } else if (code === 'HISTORY_NOT_CONFIGURED') {
                setSessionStatus('Set an encryption passphrase in Settings → Security to enable chat history.');
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
    }
}

function createNewChat() {
    if (!isHistoryReady()) {
        setSessionStatus(state.historyStatus?.configured
            ? 'History is locked. Unlock it in Settings → Security.'
            : 'Set an encryption passphrase in Settings → Security to enable chat history.');
        openSettingsDrawer();
        return;
    }
    if (state.running || state.paused) {
        setSessionStatus('Stop the current run to start a new chat.');
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
                setSessionStatus('History is locked. Unlock it in Settings → Security.');
                openSettingsDrawer();
                return;
            }
            if (code === 'HISTORY_NOT_CONFIGURED') {
                setSessionStatus('Set an encryption passphrase in Settings → Security to enable chat history.');
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
    });
}

function handleChatListClick(event) {
    if (!isHistoryReady()) {
        setSessionStatus(state.historyStatus?.configured
            ? 'History is locked. Unlock it in Settings → Security.'
            : 'Set an encryption passphrase in Settings → Security to enable chat history.');
        openSettingsDrawer();
        return;
    }
    const item = event.target.closest('.chat-item');
    if (!item || !item.dataset.chatId) return;
    const chatId = item.dataset.chatId;
    if (chatId === state.activeChatId) {
        closeChatsDrawer();
        return;
    }
    if (state.running || state.paused) {
        setSessionStatus('Stop the current run to switch chats.');
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
            ? 'History is locked. Unlock it in Settings → Security.'
            : 'Set an encryption passphrase in Settings → Security to enable chat history.';
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
    const profile = getDefaultProfile(provider);
    if (profile?.tabId) {
        sendMessage({ type: 'FOCUS_TAB', tabId: profile.tabId }, handleActionResponse);
        return;
    }
    connectProvider(provider);
}

function handleProviderPillClick(provider) {
    const ready = Boolean(state.connectionStatus?.[provider]);
    const profile = getDefaultProfile(provider);
    if (ready && profile?.tabId) {
        focusProvider(provider);
        return;
    }
    connectProvider(provider);
}

function connectProvider(provider) {
    if (!provider) return;
    if (state.connecting[provider]) return;
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

async function connectBothProviders() {
    connectProvider('chatgpt');
    connectProvider('gemini');
}

function updateProviderUi() {
    const providers = [
        ['chatgpt', elements.statusChatGPT, elements.connectionLabelChatgpt],
        ['gemini', elements.statusGemini, elements.connectionLabelGemini]
    ];

    providers.forEach(([provider, pill, label]) => {
        if (!pill) return;
        const ready = Boolean(state.connectionStatus?.[provider]);
        const connecting = Boolean(state.connecting?.[provider]);
        const profile = getDefaultProfile(provider);
        const modelHint = profile?.modelHint ? ` • ${profile.modelHint}` : '';

        pill.classList.toggle('is-ready', ready);
        pill.classList.toggle('is-offline', !ready && !connecting);
        pill.classList.toggle('is-connecting', connecting);

        const baseLabel = formatProviderLabel(provider);
        let statusText = 'offline';
        let labelText = 'Not connected';

        if (connecting) {
            statusText = 'connecting…';
            labelText = 'Connecting…';
        } else if (ready) {
            statusText = 'ready';
            labelText = `Connected${modelHint}`;
        } else if (profile?.status === 'wrong_host') {
            statusText = 'wrong host';
            labelText = 'Wrong host';
        } else if (profile?.status === 'unknown') {
            statusText = 'loading…';
            labelText = 'Loading…';
        } else if (profile?.status === 'ok') {
            statusText = 'waiting…';
            labelText = 'Waiting…';
        }
        pill.textContent = `${baseLabel}: ${statusText}`;

        if (label) {
            label.textContent = labelText;
        }
    });

    if (elements.settingsFocusChatgpt) {
        elements.settingsFocusChatgpt.disabled = !getDefaultProfile('chatgpt')?.tabId;
    }
    if (elements.settingsFocusGemini) {
        elements.settingsFocusGemini.disabled = !getDefaultProfile('gemini')?.tabId;
    }
}

function updateComposerHint() {
    if (!elements.composerHint || !elements.promptInput) return;

    if (state.running || state.paused) {
        elements.composerHint.hidden = true;
        return;
    }

    const runTarget = getRunTarget();
    const requiredProviders = getRequiredProvidersForRun(runTarget);
    const requiredLabel = requiredProviders.length === 2
        ? 'ChatGPT + Gemini'
        : formatProviderLabel(requiredProviders[0]);
    const connected = isRunConnected();
    const historyReady = isHistoryReady();
    const hasPrompt = elements.promptInput.value.trim().length > 0;
    const debate = isDebateTarget(runTarget);
    const iterations = debate ? (parseInt(elements.iterations?.value, 10) || 0) : 1;

    let hint = '';
    if (!connected && !historyReady) {
        hint = state.historyStatus?.configured
            ? `Connect ${requiredLabel}, then unlock history in Settings → Security.`
            : `Connect ${requiredLabel}, then set a passphrase in Settings → Security.`;
    } else if (!connected) {
        hint = `Connect ${requiredLabel} to start.`;
    } else if (!historyReady) {
        hint = state.historyStatus?.configured
            ? 'Unlock history in Settings → Security.'
            : 'Set an encryption passphrase in Settings → Security to enable chat history.';
    } else if (!hasPrompt) {
        hint = '';
    } else if (debate && iterations <= 0) {
        hint = 'Iterations must be at least 1.';
    }

    if (!hint) {
        if (state.attachmentsLoading) {
            hint = 'Reading attachments…';
        } else if (state.attachmentsWarning) {
            hint = state.attachmentsWarning;
        }
    }

    elements.composerHint.textContent = hint;
    elements.composerHint.hidden = !hint;
    elements.promptInput.placeholder = !connected
        ? `Connect ${requiredLabel} to start...`
        : (historyReady ? 'Send a message...' : 'Unlock history in Settings → Security...');
}

function updateEmptyState() {
    if (!elements.emptyState || !elements.timeline) return;
    const hasMessages = Boolean(state.activeChat && Array.isArray(state.activeChat.messages) && state.activeChat.messages.length > 0);
    if (hasMessages) return;

    if (!elements.timeline.contains(elements.emptyState)) {
        elements.timeline.appendChild(elements.emptyState);
    }

    const connected = isRunConnected();
    const historyReady = isHistoryReady();
    const titleEl = elements.emptyState.querySelector('.empty-title');
    const subtitleEl = elements.emptyState.querySelector('.empty-subtitle');
    const actionsEl = elements.emptyState.querySelector('.empty-actions');

    if (connected && !historyReady) {
        if (titleEl) {
            titleEl.textContent = state.historyStatus?.configured ? 'Unlock history' : 'Set passphrase';
        }
        if (subtitleEl) {
            subtitleEl.textContent = state.historyStatus?.configured
                ? 'Unlock encrypted history in Settings → Security to access your chats.'
                : 'Set an encryption passphrase in Settings → Security to enable chat history.';
        }
        if (actionsEl) {
            actionsEl.hidden = true;
        }
        return;
    }

    if (titleEl) titleEl.textContent = connected ? 'New chat' : 'Connect to start';
    if (subtitleEl) {
        subtitleEl.textContent = connected
            ? 'Write a message below to start.'
            : 'Open ChatGPT and/or Gemini once. Then send messages from this panel.';
    }
    if (actionsEl) {
        actionsEl.hidden = connected;
    }
}

function handlePrimaryAction() {
    if (state.running || state.paused) {
        stopSession();
        return;
    }
    startSession();
}

function startSession() {
    if (state.running || state.paused) return;
    if (!elements.promptInput) return;

    if (!isHistoryReady()) {
        setSessionStatus(state.historyStatus?.configured
            ? 'History is locked. Unlock it in Settings → Security.'
            : 'Set an encryption passphrase in Settings → Security to enable chat history.');
        openSettingsDrawer();
        return;
    }

    const prompt = elements.promptInput.value.trim();
    if (!prompt) return;

    const runTarget = getRunTarget();
    const debate = isDebateTarget(runTarget);
    const rounds = debate ? (parseInt(elements.iterations?.value, 10) || 0) : 1;
    if (rounds <= 0) return;

    if (!isRunConnected()) {
        const required = getRequiredProvidersForRun(runTarget);
        if (required.length === 2) {
            setSessionStatus('Connect ChatGPT and Gemini to start.');
        } else {
            setSessionStatus(`Connect ${formatProviderLabel(required[0])} to start.`);
        }
        return;
    }

    state.stopRequested = false;
    setSessionState({ running: true, paused: false });
    setSessionStatus('Starting session...');

    const payload = {
        type: 'START_RUN',
        prompt,
        rounds,
        chatId: state.activeChatId
    };
    if (Array.isArray(state.attachments) && state.attachments.length > 0) {
        payload.attachments = state.attachments.map((item) => ({
            name: item.name,
            type: item.type,
            size: item.size,
            lastModified: item.lastModified,
            base64: item.base64
        }));
    }

    if (debate) {
        payload.mode = 'debate';
        payload.firstLLM = getDebateFirstLLM(runTarget);
    } else {
        payload.mode = 'direct';
        payload.target = getDirectTarget(runTarget);
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
        reason: 'User requested stop'
    });
}

function resumeSession() {
    if (!state.sessionId || !state.paused) return;
    setSessionStatus('Resuming session...');
    sendMessage({ type: 'RESUME_SESSION' }, handleActionResponse);
}

function isFullyConnected() {
    return Boolean(state.connectionStatus.chatgpt && state.connectionStatus.gemini);
}

function handleBackgroundMessage(message) {
    switch (message.type) {
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
            hydrateSession(message.session);
            break;
        case 'UI_SESSION_STARTED':
            state.sessionId = message.sessionId;
            state.sessionProfiles = message.profileIds || state.sessionProfiles;
            setSessionState({ running: true, paused: false });
            setSessionStatus(`Running round 1 of ${message.rounds}`);
            if (message.chatId && message.chatId !== state.activeChatId) {
                loadChat(message.chatId);
            }
            if (state.stopRequested) {
                state.stopRequested = false;
                stopSession();
            }
            break;
        case 'UI_SESSION_PROGRESS':
            handleProgress(message);
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
    renderProfileLists();
    updateProviderUi();
    updateSendState();
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
    state.connectionStatus = {
        chatgpt: Boolean(chatgpt),
        gemini: Boolean(gemini)
    };
    updateProviderUi();
    updateSendState();
}

function hydrateSession(session) {
    if (!session || (!session.isActive && !session.isPaused)) {
        setSessionState({ running: false, paused: false });
        state.sessionId = null;
        state.sessionProfiles = { chatgpt: null, gemini: null };
        state.pausedProvider = null;
        state.pausedReason = null;
        setSessionStatus('Idle');
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

    if (session.chatId && session.chatId !== state.activeChatId) {
        loadChat(session.chatId);
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
    state.stopRequested = false;
    state.sessionProfiles = { chatgpt: null, gemini: null };
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
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatProviderLabel(provider) {
    return provider === 'gemini' ? 'Gemini' : 'ChatGPT';
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
