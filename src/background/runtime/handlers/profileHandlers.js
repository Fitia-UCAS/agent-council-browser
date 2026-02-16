(function profileHandlersModule(globalScope) {
    'use strict';

    function createProfileHandlers() {
        return {};
    }

    globalScope.MLCProfileHandlers = {
        createProfileHandlers,
    };
})(typeof self !== 'undefined' ? self : window);
