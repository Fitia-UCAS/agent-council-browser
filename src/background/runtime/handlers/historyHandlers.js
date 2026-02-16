(function historyHandlersModule(globalScope) {
    'use strict';

    function createHistoryHandlers() {
        return {};
    }

    globalScope.MLCHistoryHandlers = {
        createHistoryHandlers,
    };
})(typeof self !== 'undefined' ? self : window);
