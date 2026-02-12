import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadProviderRegistry() {
    const filePath = path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'background',
        'providers',
        'providerRegistry.js'
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const context = {
        self: {},
        window: {},
        globalThis: {},
        URL,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'providerRegistry.js' });
    return (
        context.self.MLCProviderRegistry ||
        context.window.MLCProviderRegistry ||
        context.globalThis.MLCProviderRegistry
    );
}

describe('Provider registry module', () => {
    test('returns known attachment modes', () => {
        const moduleApi = loadProviderRegistry();
        const registry = moduleApi.createProviderRegistry();
        expect(registry.getProviderAttachmentMode('gemini')).toBe('manual');
        expect(registry.getProviderAttachmentMode('chatgpt')).toBe('auto');
    });

    test('uses strict content script host checks', () => {
        const moduleApi = loadProviderRegistry();
        const registry = moduleApi.createProviderRegistry();
        expect(registry.isContentScriptInjectableUrl('chatgpt', 'https://chatgpt.com/')).toBe(true);
        expect(registry.isContentScriptInjectableUrl('chatgpt', 'https://chat.openai.com/')).toBe(
            true
        );
        expect(registry.isContentScriptInjectableUrl('chatgpt', 'https://openai.com/')).toBe(false);
    });

    test('formats provider labels', () => {
        const moduleApi = loadProviderRegistry();
        const registry = moduleApi.createProviderRegistry();
        expect(registry.formatProviderLabel('claude')).toBe('Claude');
    });
});
