(function initProfileService(global) {
    function createProfileService(deps = {}) {
        const sendMessageToPopup = typeof deps.sendMessageToPopup === 'function' ? deps.sendMessageToPopup : () => {};
        const checkConnectionStatus = typeof deps.checkConnectionStatus === 'function' ? deps.checkConnectionStatus : null;
        const notifyTabProfiles = typeof deps.notifyTabProfiles === 'function' ? deps.notifyTabProfiles : null;
        const createProfileFromActiveTab = typeof deps.createProfileFromActiveTab === 'function' ? deps.createProfileFromActiveTab : null;
        const claimTabAsProfile = typeof deps.claimTabAsProfile === 'function' ? deps.claimTabAsProfile : null;
        const updateTabProfile = typeof deps.updateTabProfile === 'function' ? deps.updateTabProfile : null;
        const deleteTabProfile = typeof deps.deleteTabProfile === 'function' ? deps.deleteTabProfile : null;
        const setDefaultProfile = typeof deps.setDefaultProfile === 'function' ? deps.setDefaultProfile : null;
        const focusTab = typeof deps.focusTab === 'function' ? deps.focusTab : null;
        const openProviderTab = typeof deps.openProviderTab === 'function' ? deps.openProviderTab : null;
        const connectProvider = typeof deps.connectProvider === 'function' ? deps.connectProvider : null;
        const normalizeProvider = typeof deps.normalizeProvider === 'function'
            ? deps.normalizeProvider
            : (provider) => String(provider || '').trim().toLowerCase();
        const sanitizeModelHint = typeof deps.sanitizeModelHint === 'function'
            ? deps.sanitizeModelHint
            : (provider, hint) => String(hint || '').trim();
        const updateProfileModelHint = typeof deps.updateProfileModelHint === 'function' ? deps.updateProfileModelHint : null;
        const updateProfilesForTab = typeof deps.updateProfilesForTab === 'function' ? deps.updateProfilesForTab : null;
        const handleTabRemoved = typeof deps.handleTabRemoved === 'function' ? deps.handleTabRemoved : null;
        const handleTabActivated = typeof deps.handleTabActivated === 'function' ? deps.handleTabActivated : null;
        const handleWindowFocusChanged = typeof deps.handleWindowFocusChanged === 'function' ? deps.handleWindowFocusChanged : null;
        const getTabUrlCandidate = typeof deps.getTabUrlCandidate === 'function'
            ? deps.getTabUrlCandidate
            : (tab) => {
                if (!tab) return '';
                if (typeof tab.url === 'string' && tab.url) return tab.url;
                if (typeof tab.pendingUrl === 'string' && tab.pendingUrl) return tab.pendingUrl;
                return '';
            };
        const isExpectedHost = typeof deps.isExpectedHost === 'function'
            ? deps.isExpectedHost
            : () => true;
        const logger = {
            warn: typeof deps.warn === 'function' ? deps.warn : (...args) => console.warn(...args),
            error: typeof deps.error === 'function' ? deps.error : (...args) => console.error(...args)
        };

        const PROFILE_MESSAGE_TYPES = new Set([
            'GET_TAB_PROFILES',
            'CREATE_PROFILE_FROM_ACTIVE_TAB',
            'CLAIM_TAB_AS_PROFILE',
            'UPDATE_TAB_PROFILE',
            'DELETE_TAB_PROFILE',
            'SET_DEFAULT_PROFILE',
            'FOCUS_TAB',
            'OPEN_PROVIDER_TAB',
            'CONNECT_PROVIDER',
            'CHECK_CONNECTION',
            'PROVIDER_MODEL_INFO'
        ]);

        function deriveProfileStatus({ provider, tab, tabLookupFailed = false }) {
            if (tabLookupFailed || !tab) return 'offline';
            const url = getTabUrlCandidate(tab);
            if (!url) return 'unknown';
            return isExpectedHost(provider, url) ? 'ok' : 'wrong_host';
        }

        function createMissingHandlerResponse(actionName = 'profile') {
            return {
                ok: false,
                error: `${actionName} handler unavailable`,
                code: 'SERVICE_UNAVAILABLE'
            };
        }

        function callAsync(actionName, handler, args, sendResponse, onSuccess = null) {
            if (typeof handler !== 'function') {
                sendResponse(createMissingHandlerResponse(actionName));
                return true;
            }

            Promise.resolve()
                .then(() => handler(...args))
                .then((result) => {
                    if (typeof onSuccess === 'function') {
                        onSuccess(result);
                    }
                    if (typeof sendResponse === 'function') {
                        sendResponse(result);
                    }
                })
                .catch((error) => {
                    logger.error(`[MLC Profiles] Error during ${actionName}:`, error);
                    if (typeof sendResponse === 'function') {
                        sendResponse({ ok: false, error: error?.message || `${actionName} failed` });
                    }
                });
            return true;
        }

        function handleProfileMessage(message, sender, sendResponse) {
            if (!message || !PROFILE_MESSAGE_TYPES.has(message.type)) {
                return false;
            }

            switch (message.type) {
                case 'GET_TAB_PROFILES':
                    if (typeof notifyTabProfiles !== 'function') {
                        sendResponse(createMissingHandlerResponse('list profiles'));
                        return false;
                    }
                    notifyTabProfiles().then(() => {
                        sendResponse({ status: 'profiles_sent', type: message.type });
                    }).catch((error) => {
                        logger.error('[MLC Profiles] Error listing profiles:', error);
                        sendResponse({ ok: false, error: error?.message || 'Failed to list profiles' });
                    });
                    return true;
                case 'CREATE_PROFILE_FROM_ACTIVE_TAB':
                    return callAsync(
                        'create profile from active tab',
                        createProfileFromActiveTab,
                        [message.provider, message.label, message.profileId],
                        sendResponse
                    );
                case 'CLAIM_TAB_AS_PROFILE':
                    return callAsync('claim tab as profile', claimTabAsProfile, [message], sendResponse);
                case 'UPDATE_TAB_PROFILE':
                    return callAsync('update profile', updateTabProfile, [message.profileId, message.patch || {}], sendResponse);
                case 'DELETE_TAB_PROFILE':
                    return callAsync('delete profile', deleteTabProfile, [message.profileId], sendResponse);
                case 'SET_DEFAULT_PROFILE':
                    return callAsync('set default profile', setDefaultProfile, [message.provider, message.profileId || null], sendResponse);
                case 'FOCUS_TAB':
                    return callAsync('focus tab', focusTab, [message.tabId, { forceWindowFocus: true }], sendResponse);
                case 'OPEN_PROVIDER_TAB':
                    return callAsync('open provider tab', openProviderTab, [message.provider, message], sendResponse);
                case 'CONNECT_PROVIDER':
                    return callAsync('connect provider', connectProvider, [message.provider, { focus: true }], sendResponse);
                case 'CHECK_CONNECTION': {
                    if (typeof checkConnectionStatus !== 'function') {
                        sendResponse(createMissingHandlerResponse('check connection'));
                        return false;
                    }
                    const profileIds = Array.isArray(message.profileIds)
                        ? message.profileIds.map((id) => String(id || '').trim()).filter(Boolean)
                        : [];
                    checkConnectionStatus({ profileIds }).then((result) => {
                        sendMessageToPopup({
                            type: 'CONNECTION_STATUS',
                            status: result.status,
                            profileStatus: result.profileStatus
                        });
                        sendResponse({
                            type: 'CONNECTION_STATUS',
                            status: result.status,
                            profileStatus: result.profileStatus
                        });
                    }).catch((error) => {
                        logger.error('[MLC Profiles] Error checking connections:', error);
                        sendResponse({ ok: false, error: error?.message || 'Connection check failed' });
                    });
                    return true;
                }
                case 'PROVIDER_MODEL_INFO': {
                    if (sender?.tab?.id) {
                        const provider = normalizeProvider(message.provider);
                        const modelLabel = sanitizeModelHint(provider, message.modelLabel || '');
                        if (modelLabel && typeof updateProfileModelHint === 'function') {
                            updateProfileModelHint(sender.tab.id, provider, modelLabel);
                        }
                        sendMessageToPopup({
                            type: 'PROVIDER_MODEL_INFO',
                            provider,
                            tabId: sender.tab.id,
                            modelLabel
                        });
                    }
                    sendResponse({ ok: true });
                    return true;
                }
                default:
                    return false;
            }
        }

        function onTabRemoved(tabId) {
            if (typeof handleTabRemoved !== 'function') return;
            handleTabRemoved(tabId).catch((error) => {
                logger.warn('[MLC Profiles] Failed to handle tab removal:', error);
            });
        }

        function onTabUpdated(tabId, changeInfo, tab) {
            if (!tab || !Number.isFinite(tabId)) return;
            if (!(changeInfo?.url || changeInfo?.status === 'complete' || changeInfo?.title)) return;
            if (typeof updateProfilesForTab !== 'function') return;
            updateProfilesForTab(tab).catch((error) => {
                logger.warn('[MLC Profiles] Failed to handle tab update:', error);
            });
        }

        function onTabActivated(activeInfo) {
            if (typeof handleTabActivated !== 'function') return;
            handleTabActivated(activeInfo).catch((error) => {
                logger.warn('[MLC Profiles] Failed to handle tab activation:', error);
            });
        }

        function onWindowFocusChanged(windowId) {
            if (typeof handleWindowFocusChanged !== 'function') return;
            handleWindowFocusChanged(windowId).catch((error) => {
                logger.warn('[MLC Profiles] Failed to handle window focus change:', error);
            });
        }

        function getHandledMessageTypes() {
            return [...PROFILE_MESSAGE_TYPES];
        }

        return {
            deriveProfileStatus,
            handleProfileMessage,
            onTabRemoved,
            onTabUpdated,
            onTabActivated,
            onWindowFocusChanged,
            getHandledMessageTypes
        };
    }

    global.createProfileService = createProfileService;
}(globalThis));
