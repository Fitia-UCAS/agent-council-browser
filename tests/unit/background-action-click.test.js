import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createEvent() {
    const listeners = [];
    return {
        listeners,
        addListener(listener) {
            listeners.push(listener);
        },
    };
}

function createChromeMock() {
    return {
        action: {
            onClicked: createEvent(),
        },
        debugger: {
            attach: (_debuggee, _version, callback) => callback && callback(),
            detach: (_debuggee, callback) => callback && callback(),
            sendCommand: (_debuggee, _method, _params, callback) => callback && callback({}),
        },
        runtime: {
            lastError: null,
            onInstalled: createEvent(),
            onStartup: createEvent(),
            onMessage: createEvent(),
            sendMessage: vi.fn(),
            getURL: (relPath) => `chrome-extension://test-extension/${relPath}`,
        },
        scripting: {
            executeScript: vi.fn().mockResolvedValue([]),
        },
        sidePanel: {},
        storage: {
            local: {
                get: vi.fn().mockResolvedValue({}),
                set: vi.fn().mockResolvedValue(undefined),
                remove: vi.fn().mockResolvedValue(undefined),
            },
            session: {
                get: vi.fn().mockResolvedValue({}),
                set: vi.fn().mockResolvedValue(undefined),
                remove: vi.fn().mockResolvedValue(undefined),
            },
            onChanged: createEvent(),
        },
        tabs: {
            onRemoved: createEvent(),
            onUpdated: createEvent(),
            onActivated: createEvent(),
            query: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue({ id: 1, windowId: 1 }),
            update: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockResolvedValue({ id: 1, windowId: 1 }),
            sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        windows: {
            WINDOW_ID_NONE: -1,
            onFocusChanged: createEvent(),
            update: vi.fn().mockResolvedValue(undefined),
            getAll: vi.fn().mockResolvedValue([]),
        },
    };
}

function loadBackground({ chrome, extensionUiOpenFlowModule }) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src/background/index.js'), 'utf8');
    const context = {
        chrome,
        console,
        importScripts: () => {},
        setTimeout,
        clearTimeout,
        MLCExtensionUiOpenFlow: extensionUiOpenFlowModule,
    };
    context.self = context;
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'src/background/index.js' });
    return context;
}

describe('Background action click wiring', () => {
    test('registers manual action-click behavior and delegates icon clicks to the open flow', async () => {
        const chrome = createChromeMock();
        const setManualActionClickBehavior = vi.fn().mockResolvedValue({ ok: true });
        const openExtensionUiFromAction = vi.fn().mockResolvedValue({ ok: true, mode: 'tab' });
        const createExtensionUiOpenFlow = vi.fn(() => ({
            setManualActionClickBehavior,
            openExtensionUiFromAction,
        }));

        loadBackground({
            chrome,
            extensionUiOpenFlowModule: {
                createExtensionUiOpenFlow,
            },
        });

        expect(createExtensionUiOpenFlow).toHaveBeenCalledOnce();
        expect(setManualActionClickBehavior).toHaveBeenCalledWith('workerInit');
        expect(chrome.action.onClicked.listeners).toHaveLength(1);

        const actionTab = { id: 42, windowId: 7 };
        chrome.action.onClicked.listeners[0](actionTab);

        expect(openExtensionUiFromAction).toHaveBeenCalledWith(actionTab);
    });
});
