(function sidepanelPrimaryActionModule(globalScope) {
    'use strict';

    const PRIMARY_ACTIONS = Object.freeze({
        STOP: 'stop',
        UNLOCK_HISTORY: 'unlock_history',
        SCHEMA_UPGRADE: 'schema_upgrade',
        SEND: 'send',
        CONNECT: 'connect',
        FIX_ROUTE: 'fix_route',
        NOOP: 'noop',
    });

    function getPrimaryActionDecision(input = {}) {
        const running = Boolean(input.running);
        const paused = Boolean(input.paused);
        const historyBlocked = Boolean(input.historyBlocked);
        const schemaBlocked = Boolean(input.schemaBlocked);

        if (running) {
            return {
                action: PRIMARY_ACTIONS.STOP,
                label: 'Stop',
                disabled: false,
            };
        }

        if (historyBlocked) {
            return {
                action: PRIMARY_ACTIONS.UNLOCK_HISTORY,
                label: 'Unlock',
                disabled: false,
            };
        }

        if (paused) {
            return {
                action: PRIMARY_ACTIONS.STOP,
                label: 'Stop',
                disabled: false,
            };
        }

        if (schemaBlocked) {
            return {
                action: PRIMARY_ACTIONS.SCHEMA_UPGRADE,
                label: 'Upgrade',
                disabled: false,
            };
        }

        const hasPrompt = Boolean(input.hasPrompt);
        const attachmentsReady = input.attachmentsReady !== false;
        const validRoute = Boolean(input.validRoute);
        const supportedRoute = Boolean(input.supportedRoute);
        const configuredRoute = Boolean(input.configuredRoute);
        const connected = Boolean(input.connected);
        const canAct = hasPrompt && attachmentsReady && validRoute && supportedRoute;

        if (!validRoute || !supportedRoute) {
            return {
                action: PRIMARY_ACTIONS.NOOP,
                label: 'Send',
                disabled: !canAct,
            };
        }

        if (!configuredRoute) {
            return {
                action: PRIMARY_ACTIONS.FIX_ROUTE,
                label: 'Fix route',
                disabled: !canAct,
            };
        }

        if (!connected) {
            return {
                action: PRIMARY_ACTIONS.CONNECT,
                label: 'Connect',
                disabled: !canAct,
            };
        }

        return {
            action: PRIMARY_ACTIONS.SEND,
            label: 'Send',
            disabled: !canAct,
        };
    }

    globalScope.MLCSidepanelPrimaryAction = {
        PRIMARY_ACTIONS,
        getPrimaryActionDecision,
    };
})(typeof self !== 'undefined' ? self : window);
