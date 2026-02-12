(function sidepanelActionsModule(globalScope) {
    'use strict';

    const ACTION_TYPES = {
        PATCH_STATE: 'PATCH_STATE',
        REPLACE_STATE: 'REPLACE_STATE',
        SESSION_STATUS_SET: 'SESSION_STATUS_SET',
        SCHEMA_STATUS_SET: 'SCHEMA_STATUS_SET',
        SCHEMA_RESET_PROGRESS_SET: 'SCHEMA_RESET_PROGRESS_SET',
        HISTORY_STATUS_SET: 'HISTORY_STATUS_SET',
        PROFILES_SET: 'PROFILES_SET',
        CONNECTION_STATUS_SET: 'CONNECTION_STATUS_SET',
        ACTIVE_CHAT_SET: 'ACTIVE_CHAT_SET',
        ATTACHMENTS_SET: 'ATTACHMENTS_SET',
    };

    function createAction(type, payload) {
        return { type, payload };
    }

    globalScope.MLCSidepanelActions = {
        ACTION_TYPES,
        createAction,
    };
})(typeof self !== 'undefined' ? self : window);
