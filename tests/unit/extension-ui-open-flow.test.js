import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadScript(relPath, exportName) {
    const filePath = path.resolve(__dirname, '..', '..', relPath);
    const source = fs.readFileSync(filePath, 'utf8');
    const context = { console };
    context.self = context;
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: relPath });
    return context[exportName];
}

function createRuntime() {
    return {
        getURL: (relPath) => `chrome-extension://test-extension/${relPath}`,
        getContexts: vi.fn().mockResolvedValue([]),
    };
}

describe('Extension UI open flow', () => {
    const moduleApi = loadScript(
        'src/background/runtime/extensionUiOpenFlow.js',
        'MLCExtensionUiOpenFlow'
    );

    test('opens the side panel without creating a fallback tab when context is confirmed', async () => {
        const runtime = createRuntime();
        runtime.getContexts.mockResolvedValue([
            {
                contextType: 'SIDE_PANEL',
                documentUrl: 'chrome-extension://test-extension/sidepanel.html',
                windowId: 7,
            },
        ]);
        const sidePanel = {
            open: vi.fn().mockResolvedValue(undefined),
        };
        const tabs = {
            query: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
            update: vi.fn(),
        };
        const windows = { update: vi.fn() };
        const flow = moduleApi.createExtensionUiOpenFlow({
            runtime,
            sidePanel,
            tabs,
            windows,
            contextPollAttempts: 1,
            contextPollDelayMs: 0,
        });

        const result = await flow.openExtensionUiFromAction({ id: 11, windowId: 7 });

        expect(result).toEqual({
            ok: true,
            mode: 'side_panel',
            action: 'opened',
            windowId: 7,
            verified: true,
        });
        expect(sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
        expect(tabs.create).not.toHaveBeenCalled();
        expect(tabs.update).not.toHaveBeenCalled();
        expect(windows.update).not.toHaveBeenCalled();
    });

    test('opens a fallback extension tab when side panel open throws', async () => {
        const runtime = createRuntime();
        const sidePanel = {
            open: vi.fn().mockRejectedValue(new Error('Arc side panel failed')),
        };
        const tabs = {
            query: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({ id: 21, windowId: 7 }),
            update: vi.fn(),
        };
        const flow = moduleApi.createExtensionUiOpenFlow({
            runtime,
            sidePanel,
            tabs,
            windows: { update: vi.fn() },
            contextPollAttempts: 1,
            contextPollDelayMs: 0,
        });

        const result = await flow.openExtensionUiFromAction({ id: 11, windowId: 7 });

        expect(result).toEqual({
            ok: true,
            mode: 'tab',
            action: 'created',
            tabId: 21,
            windowId: 7,
        });
        expect(sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
        expect(tabs.query).toHaveBeenCalledWith({
            url: 'chrome-extension://test-extension/sidepanel.html',
        });
        expect(tabs.create).toHaveBeenCalledWith({
            url: 'chrome-extension://test-extension/sidepanel.html',
            active: true,
            windowId: 7,
        });
    });

    test('falls back to an extension tab when no side panel context appears', async () => {
        const runtime = createRuntime();
        runtime.getContexts.mockResolvedValue([]);
        const sidePanel = {
            open: vi.fn().mockResolvedValue(undefined),
        };
        const tabs = {
            query: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockResolvedValue({ id: 34, windowId: 5 }),
            update: vi.fn(),
        };
        const flow = moduleApi.createExtensionUiOpenFlow({
            runtime,
            sidePanel,
            tabs,
            windows: { update: vi.fn() },
            contextPollAttempts: 1,
            contextPollDelayMs: 0,
        });

        const result = await flow.openExtensionUiFromAction({ id: 11, windowId: 5 });

        expect(result).toEqual({
            ok: true,
            mode: 'tab',
            action: 'created',
            tabId: 34,
            windowId: 5,
        });
        expect(sidePanel.open).toHaveBeenCalledWith({ windowId: 5 });
        expect(runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['SIDE_PANEL'] });
        expect(tabs.create).toHaveBeenCalledTimes(1);
    });

    test('reuses an existing extension tab instead of opening duplicates', async () => {
        const runtime = createRuntime();
        const sidePanel = {
            open: vi.fn().mockRejectedValue(new Error('side panel unavailable')),
        };
        const tabs = {
            query: vi.fn().mockResolvedValue([
                {
                    id: 77,
                    windowId: 9,
                },
            ]),
            create: vi.fn(),
            update: vi.fn().mockResolvedValue(undefined),
        };
        const windows = {
            update: vi.fn().mockResolvedValue(undefined),
        };
        const flow = moduleApi.createExtensionUiOpenFlow({
            runtime,
            sidePanel,
            tabs,
            windows,
            contextPollAttempts: 1,
            contextPollDelayMs: 0,
        });

        const result = await flow.openExtensionUiFromAction({ id: 11, windowId: 9 });

        expect(result).toEqual({
            ok: true,
            mode: 'tab',
            action: 'focused',
            tabId: 77,
            windowId: 9,
        });
        expect(tabs.create).not.toHaveBeenCalled();
        expect(tabs.update).toHaveBeenCalledWith(77, { active: true });
        expect(windows.update).toHaveBeenCalledWith(9, { focused: true });
    });
});
