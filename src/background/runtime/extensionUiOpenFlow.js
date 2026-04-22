(function extensionUiOpenFlowModule(globalScope) {
    'use strict';

    const DEFAULT_UI_PATH = 'sidepanel.html';
    const SIDE_PANEL_CONTEXT_TYPE = 'SIDE_PANEL';
    const DEFAULT_CONTEXT_POLL_ATTEMPTS = 3;
    const DEFAULT_CONTEXT_POLL_DELAY_MS = 150;

    function createNoopLogger() {
        return {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        };
    }

    function normalizeLogger(logger) {
        if (!logger || typeof logger !== 'object') return createNoopLogger();
        return {
            debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => {},
            info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
            warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
            error: typeof logger.error === 'function' ? logger.error.bind(logger) : () => {},
        };
    }

    function isValidWindowId(value) {
        return Number.isInteger(value) && value >= 0;
    }

    function isValidTabId(value) {
        return Number.isInteger(value) && value >= 0;
    }

    function delay(ms, timers) {
        const timeoutMs = Number.isFinite(ms) && ms >= 0 ? Number(ms) : 0;
        const timerApi =
            timers && typeof timers.setTimeout === 'function'
                ? timers.setTimeout.bind(timers)
                : globalScope.setTimeout.bind(globalScope);
        return new Promise((resolve) => {
            timerApi(resolve, timeoutMs);
        });
    }

    function createExtensionUiOpenFlow(options = {}) {
        const runtime = options.runtime || null;
        const sidePanel = options.sidePanel || null;
        const tabs = options.tabs || null;
        const windows = options.windows || null;
        const timers = options.timers || globalScope;
        const logger = normalizeLogger(options.logger);
        const uiPath =
            typeof options.uiPath === 'string' && options.uiPath.trim()
                ? options.uiPath.trim()
                : DEFAULT_UI_PATH;
        const contextPollAttempts =
            Number.isInteger(options.contextPollAttempts) && options.contextPollAttempts > 0
                ? options.contextPollAttempts
                : DEFAULT_CONTEXT_POLL_ATTEMPTS;
        const contextPollDelayMs =
            Number.isFinite(options.contextPollDelayMs) && options.contextPollDelayMs >= 0
                ? Number(options.contextPollDelayMs)
                : DEFAULT_CONTEXT_POLL_DELAY_MS;

        function getExtensionUiUrl() {
            if (!runtime || typeof runtime.getURL !== 'function') {
                throw new Error('Extension runtime URL helper is unavailable.');
            }
            return runtime.getURL(uiPath);
        }

        async function resolveTargetWindowId(actionTab) {
            if (isValidWindowId(actionTab?.windowId)) {
                return actionTab.windowId;
            }
            if (!tabs || typeof tabs.query !== 'function') {
                return null;
            }
            try {
                const [activeTab] = await tabs.query({ active: true, lastFocusedWindow: true });
                if (isValidWindowId(activeTab?.windowId)) {
                    return activeTab.windowId;
                }
            } catch (error) {
                logger.warn('extension_ui_window_resolution_failed', {
                    error: error?.message || String(error),
                });
            }
            return null;
        }

        async function hasOpenSidePanelContext(windowId) {
            if (!runtime || typeof runtime.getContexts !== 'function') {
                return null;
            }
            try {
                const contexts = await runtime.getContexts({
                    contextTypes: [SIDE_PANEL_CONTEXT_TYPE],
                });
                if (!Array.isArray(contexts) || contexts.length === 0) {
                    return false;
                }
                const uiUrl = getExtensionUiUrl();
                const matching = contexts.filter((context) =>
                    String(context?.documentUrl || '').startsWith(uiUrl)
                );
                if (matching.length === 0) {
                    return false;
                }
                if (!isValidWindowId(windowId)) {
                    return true;
                }
                return matching.some(
                    (context) =>
                        isValidWindowId(context?.windowId) && context.windowId === windowId
                );
            } catch (error) {
                logger.warn('extension_ui_context_query_failed', {
                    error: error?.message || String(error),
                });
                return null;
            }
        }

        async function waitForSidePanelContext(windowId) {
            for (let attempt = 0; attempt < contextPollAttempts; attempt += 1) {
                const status = await hasOpenSidePanelContext(windowId);
                if (status !== false) {
                    return status;
                }
                if (attempt < contextPollAttempts - 1) {
                    await delay(contextPollDelayMs, timers);
                }
            }
            return false;
        }

        async function focusExtensionUiTab(tab) {
            if (!tabs || typeof tabs.update !== 'function' || !isValidTabId(tab?.id)) {
                throw new Error('Cannot focus extension UI tab.');
            }
            await tabs.update(tab.id, { active: true });
            if (isValidWindowId(tab?.windowId) && windows && typeof windows.update === 'function') {
                await windows.update(tab.windowId, { focused: true });
            }
            return {
                ok: true,
                mode: 'tab',
                action: 'focused',
                tabId: tab.id,
                windowId: isValidWindowId(tab?.windowId) ? tab.windowId : null,
            };
        }

        async function focusOrOpenExtensionUiTab(windowId) {
            if (!tabs || typeof tabs.query !== 'function' || typeof tabs.create !== 'function') {
                throw new Error('Extension tab APIs are unavailable.');
            }

            const uiUrl = getExtensionUiUrl();
            const existingTabs = await tabs.query({ url: uiUrl });
            const preferredTab = isValidWindowId(windowId)
                ? existingTabs.find(
                      (tab) =>
                          isValidTabId(tab?.id) &&
                          isValidWindowId(tab?.windowId) &&
                          tab.windowId === windowId
                  )
                : null;
            const reusableTab =
                preferredTab || existingTabs.find((tab) => isValidTabId(tab?.id)) || null;

            if (reusableTab) {
                return focusExtensionUiTab(reusableTab);
            }

            const createOptions = { url: uiUrl, active: true };
            if (isValidWindowId(windowId)) {
                createOptions.windowId = windowId;
            }
            const createdTab = await tabs.create(createOptions);
            return {
                ok: true,
                mode: 'tab',
                action: 'created',
                tabId: isValidTabId(createdTab?.id) ? createdTab.id : null,
                windowId: isValidWindowId(createdTab?.windowId) ? createdTab.windowId : null,
            };
        }

        async function setManualActionClickBehavior(reason) {
            if (!sidePanel || typeof sidePanel.setPanelBehavior !== 'function') {
                return { ok: false, supported: false };
            }
            try {
                await sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
                return { ok: true, supported: true };
            } catch (error) {
                logger.warn('extension_ui_manual_action_click_behavior_failed', {
                    reason,
                    error: error?.message || String(error),
                });
                return {
                    ok: false,
                    supported: true,
                    error: error?.message || String(error),
                };
            }
        }

        async function openExtensionUiFromAction(actionTab) {
            const windowId = await resolveTargetWindowId(actionTab);

            if (sidePanel && typeof sidePanel.open === 'function' && isValidWindowId(windowId)) {
                try {
                    await sidePanel.open({ windowId });
                    const sidePanelReady = await waitForSidePanelContext(windowId);
                    if (sidePanelReady !== false) {
                        return {
                            ok: true,
                            mode: 'side_panel',
                            action: 'opened',
                            windowId,
                            verified: sidePanelReady === true,
                        };
                    }
                    logger.warn('extension_ui_side_panel_context_missing', { windowId });
                } catch (error) {
                    logger.warn('extension_ui_side_panel_open_failed', {
                        windowId,
                        error: error?.message || String(error),
                    });
                }
            } else if (sidePanel && typeof sidePanel.open === 'function') {
                logger.warn('extension_ui_side_panel_window_unresolved', {
                    hasActionTab: Boolean(actionTab),
                });
            }

            return focusOrOpenExtensionUiTab(windowId);
        }

        return {
            getExtensionUiUrl,
            resolveTargetWindowId,
            hasOpenSidePanelContext,
            waitForSidePanelContext,
            focusOrOpenExtensionUiTab,
            setManualActionClickBehavior,
            openExtensionUiFromAction,
        };
    }

    globalScope.MLCExtensionUiOpenFlow = {
        createExtensionUiOpenFlow,
    };
})(typeof self !== 'undefined' ? self : window);
