(function protocolV3Module(globalScope) {
    'use strict';

    const PROTOCOL_VERSION = 3;

    const COMMAND_TO_LEGACY_TYPE = {
        RUN_START: 'START_RUN',
        RUN_STOP: 'STOP_SESSION',
        RUN_RESUME: 'RESUME_SESSION',
        RUN_START_DEBATE_LEGACY: 'START_DEBATE_SESSION',
        RUN_START_MULTI_AGENT: 'START_MULTI_AGENT_SESSION',
        RUN_END_MULTI_AGENT: 'END_MULTI_AGENT_SESSION',
        RUN_SEND_PROMPT_LEGACY: 'SEND_PROMPT',
        CHAT_LIST: 'GET_CHATS_STATE',
        CHAT_OPEN: 'GET_CHAT',
        CHAT_CREATE: 'CREATE_CHAT',
        CHAT_RENAME: 'RENAME_CHAT',
        CHAT_DELETE: 'DELETE_CHAT',
        CHAT_MESSAGES_PAGE: 'GET_MESSAGES_PAGE',
        CHAT_SET_ACTIVE: 'SET_ACTIVE_CHAT',
        CHAT_PROTECT: 'PROTECT_CHAT',
        CHAT_UNPROTECT: 'UNPROTECT_CHAT',
        HISTORY_STATUS: 'HISTORY_STATUS',
        HISTORY_UNLOCK: 'HISTORY_UNLOCK',
        HISTORY_CONFIGURE: 'HISTORY_CONFIGURE',
        HISTORY_LOCK: 'HISTORY_LOCK',
        HISTORY_SET_ENABLED: 'HISTORY_SET_ENABLED',
        HISTORY_SET_PROTECTION_MODE: 'HISTORY_SET_PROTECTION_MODE',
        HISTORY_SET_LOCK_NEW_CHATS: 'HISTORY_SET_LOCK_NEW_CHATS',
        HISTORY_DISABLE_PROTECTION: 'HISTORY_DISABLE_PROTECTION',
        HISTORY_RESET_PROTECTION: 'HISTORY_RESET_PROTECTION',
        HISTORY_CLEAR_ALL: 'HISTORY_CLEAR_ALL',
        HISTORY_RESET_LEGACY: 'HISTORY_RESET',
        PROFILE_LIST: 'GET_TAB_PROFILES',
        PROFILE_CONNECT: 'CONNECT_PROVIDER',
        PROFILE_REBIND: 'CREATE_PROFILE_FROM_ACTIVE_TAB',
        PROFILE_CLAIM_TAB: 'CLAIM_TAB_AS_PROFILE',
        PROFILE_UPDATE: 'UPDATE_TAB_PROFILE',
        PROFILE_DELETE: 'DELETE_TAB_PROFILE',
        PROFILE_SET_DEFAULT: 'SET_DEFAULT_PROFILE',
        PROFILE_OPEN_PROVIDER_TAB: 'OPEN_PROVIDER_TAB',
        PROFILE_FOCUS: 'FOCUS_TAB',
        PREFERENCES_SET_LEGACY_TABS: 'SET_PREFERRED_TABS',
        TABS_LIST_LEGACY: 'LIST_LLM_TABS',
        PROVIDER_CAPABILITIES: 'GET_PROVIDER_CAPABILITIES',
        CONNECTION_CHECK: 'CHECK_CONNECTION',
        SESSION_GET_ACTIVE: 'GET_ACTIVE_SESSION',
        PROMPTS_GET: 'GET_DEBATE_PROMPTS',
        PROMPTS_SET: 'SET_DEBATE_PROMPTS',
        PROMPTS_RESET: 'RESET_DEBATE_PROMPTS',
        SCHEMA_STATUS: 'SCHEMA_V3_STATUS',
        SCHEMA_RESET: 'SCHEMA_V3_RESET',
    };

    const LEGACY_TYPE_TO_COMMAND = Object.keys(COMMAND_TO_LEGACY_TYPE).reduce((acc, command) => {
        const type = COMMAND_TO_LEGACY_TYPE[command];
        acc[type] = command;
        return acc;
    }, {});

    function normalizeCommand(command) {
        const raw = String(command || '').trim();
        return raw || null;
    }

    function normalizeType(type) {
        const raw = String(type || '').trim();
        return raw || null;
    }

    function commandToLegacyType(command) {
        const normalized = normalizeCommand(command);
        if (!normalized) return null;
        return COMMAND_TO_LEGACY_TYPE[normalized] || null;
    }

    function legacyTypeToCommand(type) {
        const normalized = normalizeType(type);
        if (!normalized) return null;
        return LEGACY_TYPE_TO_COMMAND[normalized] || null;
    }

    function withProtocolEnvelope(message) {
        const input = message && typeof message === 'object' ? message : {};
        const output = { ...input };

        if (!Object.prototype.hasOwnProperty.call(output, 'protocolVersion')) {
            output.protocolVersion = PROTOCOL_VERSION;
        }

        if (!output.command) {
            const mapped = legacyTypeToCommand(output.type);
            if (mapped) output.command = mapped;
        }

        if (!output.type && output.command) {
            const legacy = commandToLegacyType(output.command);
            if (legacy) output.type = legacy;
        }

        return output;
    }

    function normalizeInboundMessage(message) {
        if (!message || typeof message !== 'object') {
            return {
                ok: false,
                error: 'Invalid message payload.',
                code: 'INVALID_MESSAGE',
            };
        }

        const output = { ...message };
        const version = output.protocolVersion;

        if (typeof version !== 'undefined' && Number(version) !== PROTOCOL_VERSION) {
            return {
                ok: false,
                error: `Unsupported protocol version: ${version}. Expected ${PROTOCOL_VERSION}.`,
                code: 'UNSUPPORTED_PROTOCOL_VERSION',
            };
        }

        if (!output.type && output.command) {
            const mappedType = commandToLegacyType(output.command);
            if (!mappedType) {
                return {
                    ok: false,
                    error: `Unknown command: ${output.command}`,
                    code: 'UNKNOWN_COMMAND',
                };
            }
            output.type = mappedType;
        }

        if (!output.command && output.type) {
            const mappedCommand = legacyTypeToCommand(output.type);
            if (mappedCommand) output.command = mappedCommand;
        }

        return { ok: true, message: output };
    }

    function summarizeMessageForLog(message) {
        if (!message || typeof message !== 'object') return { kind: 'empty' };

        const summary = {
            type: normalizeType(message.type),
            command: normalizeCommand(message.command),
            protocolVersion: Number.isFinite(Number(message.protocolVersion))
                ? Number(message.protocolVersion)
                : undefined,
            chatId: typeof message.chatId === 'string' ? message.chatId : undefined,
            sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
            provider: typeof message.provider === 'string' ? message.provider : undefined,
            mode: typeof message.mode === 'string' ? message.mode : undefined,
        };

        if (typeof message.prompt === 'string') {
            summary.promptChars = message.prompt.length;
        }

        if (typeof message.passphrase === 'string') {
            summary.hasPassphrase = message.passphrase.length > 0;
        }

        if (Array.isArray(message.attachments)) {
            summary.attachments = {
                count: message.attachments.length,
                totalBytes: message.attachments.reduce((total, item) => {
                    const size = Number(item && item.size);
                    return Number.isFinite(size) ? total + Math.max(0, size) : total;
                }, 0),
            };
        }

        return summary;
    }

    const api = {
        PROTOCOL_VERSION,
        commandToLegacyType,
        legacyTypeToCommand,
        withProtocolEnvelope,
        normalizeInboundMessage,
        summarizeMessageForLog,
    };

    globalScope.MLCProtocolV3 = api;
})(typeof self !== 'undefined' ? self : window);
