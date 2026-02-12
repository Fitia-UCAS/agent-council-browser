(function safeLoggerModule(globalScope) {
    'use strict';

    const DEBUG_FLAG_KEY = 'mlc_debug_logs_v3';
    let debugEnabled = false;

    function normalizeMeta(meta) {
        if (!meta || typeof meta !== 'object') return undefined;
        return meta;
    }

    function refreshDebugFlag() {
        if (!globalScope.chrome || !chrome.storage || !chrome.storage.local) return;
        try {
            chrome.storage.local.get(DEBUG_FLAG_KEY, (stored) => {
                if (chrome.runtime && chrome.runtime.lastError) return;
                debugEnabled = Boolean(stored && stored[DEBUG_FLAG_KEY]);
            });
        } catch {
            // ignore
        }
    }

    refreshDebugFlag();

    if (globalScope.chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            if (!changes || !Object.prototype.hasOwnProperty.call(changes, DEBUG_FLAG_KEY)) return;
            debugEnabled = Boolean(changes[DEBUG_FLAG_KEY] && changes[DEBUG_FLAG_KEY].newValue);
        });
    }

    function debug(event, meta) {
        if (!debugEnabled) return;
        const payload = normalizeMeta(meta);
        if (payload) {
            console.log(`[MLC Debug] ${event}`, payload);
            return;
        }
        console.log(`[MLC Debug] ${event}`);
    }

    function info(event, meta) {
        const payload = normalizeMeta(meta);
        if (payload) {
            console.info(`[MLC] ${event}`, payload);
            return;
        }
        console.info(`[MLC] ${event}`);
    }

    function warn(event, meta) {
        const payload = normalizeMeta(meta);
        if (payload) {
            console.warn(`[MLC] ${event}`, payload);
            return;
        }
        console.warn(`[MLC] ${event}`);
    }

    function error(event, meta) {
        const payload = normalizeMeta(meta);
        if (payload) {
            console.error(`[MLC] ${event}`, payload);
            return;
        }
        console.error(`[MLC] ${event}`);
    }

    globalScope.MLCSafeLogger = {
        debug,
        info,
        warn,
        error,
        isDebugEnabled: () => debugEnabled,
        DEBUG_FLAG_KEY,
    };
})(typeof self !== 'undefined' ? self : window);
