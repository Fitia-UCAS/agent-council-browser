(function sidepanelStoreModule(globalScope) {
    'use strict';

    function createUiStore(initialState, reducer = null) {
        let state = { ...(initialState || {}) };
        const listeners = new Set();

        function getState() {
            return state;
        }

        function notify(nextState, prevState, actionType) {
            listeners.forEach((listener) => {
                try {
                    listener(nextState, prevState, actionType || 'update');
                } catch (error) {
                    console.warn('[MLC UI Store] subscriber failed:', error);
                }
            });
        }

        function replace(nextState, actionType = 'replace') {
            const prevState = state;
            state = { ...(nextState || {}) };
            notify(state, prevState, actionType);
            return state;
        }

        function patch(patchState, actionType = 'patch') {
            const prevState = state;
            state = { ...state, ...(patchState || {}) };
            notify(state, prevState, actionType);
            return state;
        }

        function dispatch(action) {
            if (!action || typeof action !== 'object') return state;
            if (typeof reducer !== 'function') {
                if (action.patch && typeof action.patch === 'object') {
                    return patch(action.patch, action.type || 'dispatch_patch');
                }
                return state;
            }
            const prevState = state;
            const nextState = reducer(state, action);
            if (!nextState || nextState === state) return state;
            state = nextState;
            notify(state, prevState, action.type || 'dispatch');
            return state;
        }

        function subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
        }

        return {
            getState,
            replace,
            patch,
            dispatch,
            subscribe,
        };
    }

    globalScope.MLCSidepanelStore = {
        createUiStore,
    };
})(typeof self !== 'undefined' ? self : window);
