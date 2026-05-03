import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadPrimaryAction() {
    const filePath = path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'sidepanel',
        'features',
        'primaryAction.js'
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const context = {
        self: {},
        window: {},
        globalThis: {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'primaryAction.js' });
    return (
        context.self.MLCSidepanelPrimaryAction ||
        context.window.MLCSidepanelPrimaryAction ||
        context.globalThis.MLCSidepanelPrimaryAction
    );
}

describe('Side panel primary action decisions', () => {
    test('locked history uses an enabled Unlock action without requiring prompt text', () => {
        const api = loadPrimaryAction();
        const decision = api.getPrimaryActionDecision({
            historyBlocked: true,
            hasPrompt: false,
            validRoute: true,
            supportedRoute: true,
            configuredRoute: true,
            connected: true,
        });

        expect(decision.action).toBe(api.PRIMARY_ACTIONS.UNLOCK_HISTORY);
        expect(decision.label).toBe('Unlock');
        expect(decision.disabled).toBe(false);
    });

    test('schema upgrade uses an enabled Upgrade action without requiring prompt text', () => {
        const api = loadPrimaryAction();
        const decision = api.getPrimaryActionDecision({
            schemaBlocked: true,
            hasPrompt: false,
            validRoute: true,
            supportedRoute: true,
            configuredRoute: true,
            connected: true,
        });

        expect(decision.action).toBe(api.PRIMARY_ACTIONS.SCHEMA_UPGRADE);
        expect(decision.label).toBe('Upgrade');
        expect(decision.disabled).toBe(false);
    });

    test('regular route actions preserve send, connect, and fix-route labels', () => {
        const api = loadPrimaryAction();

        expect(
            api.getPrimaryActionDecision({
                hasPrompt: true,
                attachmentsReady: true,
                validRoute: true,
                supportedRoute: true,
                configuredRoute: true,
                connected: true,
            })
        ).toMatchObject({ action: api.PRIMARY_ACTIONS.SEND, label: 'Send', disabled: false });

        expect(
            api.getPrimaryActionDecision({
                hasPrompt: true,
                attachmentsReady: true,
                validRoute: true,
                supportedRoute: true,
                configuredRoute: true,
                connected: false,
            })
        ).toMatchObject({
            action: api.PRIMARY_ACTIONS.CONNECT,
            label: 'Connect',
            disabled: false,
        });

        expect(
            api.getPrimaryActionDecision({
                hasPrompt: true,
                attachmentsReady: true,
                validRoute: true,
                supportedRoute: true,
                configuredRoute: false,
            })
        ).toMatchObject({
            action: api.PRIMARY_ACTIONS.FIX_ROUTE,
            label: 'Fix route',
            disabled: false,
        });
    });
});

describe('Side panel security recovery controls', () => {
    test('danger zone is open by default and exposes both destructive controls', () => {
        const htmlPath = path.resolve(
            __dirname,
            '..',
            '..',
            'src',
            'sidepanel',
            'index.html'
        );
        const dom = new JSDOM(fs.readFileSync(htmlPath, 'utf8'));
        const document = dom.window.document;

        const dangerZone = document.querySelector('#history-advanced');
        expect(dangerZone?.hasAttribute('open')).toBe(true);
        expect(document.querySelector('#history-reset-protection')?.textContent).toContain(
            'Forget passphrase'
        );
        expect(document.querySelector('#history-reset-protection-help')?.textContent).toContain(
            'Set a passphrase'
        );
        expect(document.querySelector('#history-clear-all')?.textContent).toContain(
            'Delete all chats'
        );
    });
});
