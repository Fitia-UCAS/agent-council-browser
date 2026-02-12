import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createContext({ storage = {}, databases = [] } = {}) {
    const storageState = { ...(storage || {}) };
    const dbState = new Set(Array.isArray(databases) ? databases : []);

    const chrome = {
        runtime: { lastError: null },
        storage: {
            local: {
                get(keys, callback) {
                    chrome.runtime.lastError = null;
                    if (keys === null || typeof keys === 'undefined') {
                        callback({ ...storageState });
                        return;
                    }
                    if (Array.isArray(keys)) {
                        const out = {};
                        keys.forEach((key) => {
                            if (Object.prototype.hasOwnProperty.call(storageState, key)) {
                                out[key] = storageState[key];
                            }
                        });
                        callback(out);
                        return;
                    }
                    if (typeof keys === 'string') {
                        callback(
                            Object.prototype.hasOwnProperty.call(storageState, keys)
                                ? { [keys]: storageState[keys] }
                                : {}
                        );
                        return;
                    }
                    callback({ ...storageState });
                },
                set(value, callback) {
                    chrome.runtime.lastError = null;
                    Object.assign(storageState, value || {});
                    callback?.();
                },
                remove(keys, callback) {
                    chrome.runtime.lastError = null;
                    const list = Array.isArray(keys) ? keys : [keys];
                    list.forEach((key) => {
                        delete storageState[key];
                    });
                    callback?.();
                },
            },
        },
    };

    const indexedDB = {
        async databases() {
            return [...dbState].map((name) => ({ name }));
        },
        deleteDatabase(name) {
            const request = {};
            setTimeout(() => {
                if (dbState.has(name)) {
                    dbState.delete(name);
                }
                request.onsuccess?.();
            }, 0);
            return request;
        },
    };

    const context = {
        self: {},
        window: {},
        globalThis: {},
        chrome,
        indexedDB,
        setTimeout,
        clearTimeout,
    };
    context.globalThis = context;

    return {
        context,
        getStorage: () => ({ ...storageState }),
        getDatabases: () => [...dbState],
    };
}

function loadModule(initial) {
    const filePath = path.resolve(__dirname, '..', '..', 'src/background/runtime/schemaResetV3.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const harness = createContext(initial);
    vm.createContext(harness.context);
    vm.runInContext(source, harness.context, { filename: 'schemaResetV3.js' });
    const api =
        harness.context.self.MLCSchemaResetV3 ||
        harness.context.window.MLCSchemaResetV3 ||
        harness.context.globalThis.MLCSchemaResetV3;
    return {
        api,
        getStorage: harness.getStorage,
        getDatabases: harness.getDatabases,
    };
}

describe('Schema reset v3 module', () => {
    test('detects legacy state and requires reset', async () => {
        const { api } = loadModule({
            storage: { mlc_preferred_tabs: { chatgptTabId: 1 } },
            databases: ['mlc_history_v1'],
        });

        const status = await api.detectLegacyState();
        expect(status.version).toBe(3);
        expect(status.initialized).toBe(false);
        expect(status.resetRequired).toBe(true);
        expect(status.legacyDetected).toBe(true);
    });

    test('marks clean state as initialized without reset', async () => {
        const { api, getStorage } = loadModule({ storage: {}, databases: [] });

        const status = await api.primeStatus();
        expect(status.initialized).toBe(true);
        expect(status.resetRequired).toBe(false);

        const stored = getStorage();
        expect(stored.mlc_schema_v3_meta?.initialized).toBe(true);
        expect(stored.mlc_schema_v3_meta?.version).toBe(3);
    });

    test('performReset clears legacy keys/databases and sets schema meta', async () => {
        const { api, getStorage, getDatabases } = loadModule({
            storage: {
                mlc_preferred_tabs: { chatgptTabId: 2 },
                mlc_chats_v1: { chats: [] },
                arbitrary_temp: { value: true },
            },
            databases: ['mlc_history_v1', 'mlc_other_v1'],
        });

        const result = await api.performReset();
        expect(result.ok).toBe(true);

        const stored = getStorage();
        expect(Object.keys(stored)).toContain('mlc_schema_v3_meta');
        expect(Object.keys(stored)).not.toContain('mlc_preferred_tabs');
        expect(Object.keys(stored)).not.toContain('mlc_chats_v1');
        expect(Object.keys(stored)).not.toContain('arbitrary_temp');

        const dbs = getDatabases();
        expect(dbs).toEqual([]);

        const status = await api.detectLegacyState();
        expect(status.initialized).toBe(true);
        expect(status.resetRequired).toBe(false);
        expect(status.legacyDetected).toBe(false);
    });
});
