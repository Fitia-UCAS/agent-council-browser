(function sidepanelReducerModule(globalScope) {
    'use strict';

    const actions =
        globalScope.MLCSidepanelActions && globalScope.MLCSidepanelActions.ACTION_TYPES
            ? globalScope.MLCSidepanelActions.ACTION_TYPES
            : {};

    function reducer(state, action) {
        if (!state || typeof state !== 'object') return state;
        if (!action || typeof action !== 'object') return state;

        switch (action.type) {
            case actions.PATCH_STATE:
                return {
                    ...state,
                    ...(action.payload && typeof action.payload === 'object' ? action.payload : {}),
                };
            case actions.REPLACE_STATE:
                return {
                    ...(action.payload && typeof action.payload === 'object' ? action.payload : {}),
                };
            case actions.SESSION_STATUS_SET:
                return {
                    ...state,
                    running: Boolean(action.payload?.running),
                    paused: Boolean(action.payload?.paused),
                };
            case actions.SCHEMA_STATUS_SET:
                return {
                    ...state,
                    schemaStatus: {
                        ...(state.schemaStatus || {}),
                        ...(action.payload && typeof action.payload === 'object'
                            ? action.payload
                            : {}),
                    },
                };
            case actions.SCHEMA_RESET_PROGRESS_SET:
                return {
                    ...state,
                    schemaResetInProgress: Boolean(action.payload),
                };
            case actions.HISTORY_STATUS_SET:
                return {
                    ...state,
                    historyStatus: {
                        ...(state.historyStatus || {}),
                        ...(action.payload && typeof action.payload === 'object'
                            ? action.payload
                            : {}),
                    },
                };
            case actions.PROFILES_SET:
                return {
                    ...state,
                    profiles: Array.isArray(action.payload) ? action.payload : [],
                };
            case actions.CONNECTION_STATUS_SET:
                return {
                    ...state,
                    connectionStatus:
                        action.payload && typeof action.payload === 'object'
                            ? action.payload
                            : state.connectionStatus,
                };
            case actions.ACTIVE_CHAT_SET:
                return {
                    ...state,
                    activeChat: action.payload || null,
                    activeChatId: action.payload?.chatId || state.activeChatId || null,
                };
            case actions.ATTACHMENTS_SET:
                return {
                    ...state,
                    attachments: Array.isArray(action.payload) ? action.payload : [],
                };
            default:
                return state;
        }
    }

    globalScope.MLCSidepanelReducer = {
        reducer,
    };
})(typeof self !== 'undefined' ? self : window);
