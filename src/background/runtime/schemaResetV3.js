(function schemaResetV3Module(globalScope) {
    'use strict';

    const SCHEMA_VERSION = 3;
    const META_KEY = 'mlc_schema_v3_meta';

    function getChromeApi() {
        if (globalScope?.chrome) return globalScope.chrome;
        if (typeof globalThis !== 'undefined' && globalThis?.chrome) return globalThis.chrome;
        if (typeof chrome !== 'undefined') return chrome;
        return null;
    }

    function getIndexedDbApi() {
        if (globalScope?.indexedDB) return globalScope.indexedDB;
        if (typeof globalThis !== 'undefined' && globalThis?.indexedDB) return globalThis.indexedDB;
        if (typeof indexedDB !== 'undefined') return indexedDB;
        return null;
    }

    function getStorageLocal() {
        const storage = getChromeApi()?.storage?.local;
        if (!storage) {
            throw new Error('chrome.storage.local is unavailable.');
        }
        return storage;
    }

    function getRuntimeLastError() {
        return getChromeApi()?.runtime?.lastError || null;
    }

    function storageGetAll() {
        return new Promise((resolve, reject) => {
            const storage = getStorageLocal();
            storage.get(null, (result) => {
                const runtimeError = getRuntimeLastError();
                if (runtimeError) {
                    reject(
                        new Error(runtimeError.message || 'Failed to read chrome.storage.local.')
                    );
                    return;
                }
                resolve(result && typeof result === 'object' ? result : {});
            });
        });
    }

    function storageSet(value) {
        return new Promise((resolve, reject) => {
            const storage = getStorageLocal();
            storage.set(value || {}, () => {
                const runtimeError = getRuntimeLastError();
                if (runtimeError) {
                    reject(
                        new Error(runtimeError.message || 'Failed to write chrome.storage.local.')
                    );
                    return;
                }
                resolve();
            });
        });
    }

    function storageRemove(keys) {
        const list = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
        if (list.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const storage = getStorageLocal();
            storage.remove(list, () => {
                const runtimeError = getRuntimeLastError();
                if (runtimeError) {
                    reject(new Error(runtimeError.message || 'Failed to remove storage keys.'));
                    return;
                }
                resolve();
            });
        });
    }

    async function listDatabaseNames() {
        const dbApi = getIndexedDbApi();
        if (!dbApi || typeof dbApi.databases !== 'function') {
            return [];
        }
        try {
            const list = await dbApi.databases();
            if (!Array.isArray(list)) return [];
            return list
                .map((entry) => (entry && typeof entry.name === 'string' ? entry.name : ''))
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    function deleteDatabase(name) {
        const dbApi = getIndexedDbApi();
        if (!dbApi || typeof dbApi.deleteDatabase !== 'function' || !name) {
            return Promise.resolve({ name, ok: false });
        }
        return new Promise((resolve) => {
            try {
                const request = dbApi.deleteDatabase(name);
                if (!request || typeof request !== 'object') {
                    resolve({ name, ok: false });
                    return;
                }
                request.onsuccess = () => resolve({ name, ok: true });
                request.onerror = () => resolve({ name, ok: false });
                request.onblocked = () => resolve({ name, ok: false, blocked: true });
            } catch {
                resolve({ name, ok: false });
            }
        });
    }

    function createMetaPatch(reason) {
        const now = Date.now();
        return {
            [META_KEY]: {
                version: SCHEMA_VERSION,
                initialized: true,
                reason: String(reason || 'schema_v3'),
                updatedAt: now,
            },
        };
    }

    async function detectLegacyState() {
        const allStorage = await storageGetAll();
        const meta = allStorage?.[META_KEY];
        const initialized = Boolean(
            meta &&
            typeof meta === 'object' &&
            Number(meta.version) === SCHEMA_VERSION &&
            meta.initialized === true
        );

        const extraStorageKeys = Object.keys(allStorage || {}).filter((key) => key !== META_KEY);
        const dbNames = await listDatabaseNames();
        const legacyDetected = extraStorageKeys.length > 0 || dbNames.length > 0;

        return {
            version: SCHEMA_VERSION,
            initialized,
            resetRequired: legacyDetected,
            legacyDetected,
            extraStorageKeys,
            databaseNames: dbNames,
        };
    }

    async function primeStatus() {
        const status = await detectLegacyState();
        if (status.initialized || status.resetRequired) {
            return status;
        }

        await storageSet(createMetaPatch('prime_status'));
        return {
            version: SCHEMA_VERSION,
            initialized: true,
            resetRequired: false,
            legacyDetected: false,
            extraStorageKeys: [],
            databaseNames: [],
        };
    }

    async function performReset() {
        const allStorage = await storageGetAll();
        const keysToRemove = Object.keys(allStorage || {});
        if (keysToRemove.length > 0) {
            await storageRemove(keysToRemove);
        }

        const dbNames = await listDatabaseNames();
        await Promise.all(dbNames.map((name) => deleteDatabase(name)));

        await storageSet(createMetaPatch('perform_reset'));
        const status = await detectLegacyState();
        return {
            ok: true,
            status,
            removedStorageKeys: keysToRemove,
            removedDatabases: dbNames,
        };
    }

    globalScope.MLCSchemaResetV3 = {
        META_KEY,
        SCHEMA_VERSION,
        detectLegacyState,
        primeStatus,
        performReset,
    };
})(typeof self !== 'undefined' ? self : window);
