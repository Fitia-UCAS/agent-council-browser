(function sessionHandlersModule(globalScope) {
    'use strict';

    function createSessionHandlers() {
        return {};
    }

    globalScope.MLCSessionHandlers = {
        createSessionHandlers,
    };
})(typeof self !== 'undefined' ? self : window);
