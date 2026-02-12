import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadSessionEngine() {
    const filePath = path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'background',
        'sessions',
        'sessionEngine.js'
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const context = { self: {}, window: {}, globalThis: {} };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'sessionEngine.js' });
    return (
        context.self.MLCSessionEngine ||
        context.window.MLCSessionEngine ||
        context.globalThis.MLCSessionEngine
    );
}

describe('Session engine module', () => {
    test('selects turn participant in debate mode', () => {
        const moduleApi = loadSessionEngine();
        const engine = moduleApi.createSessionEngine({
            normalizeProviderKey: (provider) =>
                String(provider || '')
                    .trim()
                    .toLowerCase(),
            isSupportedProviderKey: (provider) =>
                ['chatgpt', 'gemini', 'claude', 'grok'].includes(provider),
            formatProviderLabel: (provider) => provider,
            listSessionProviders: () => ['chatgpt', 'gemini'],
        });

        const session = {
            mode: 'debate',
            participants: [
                { agentId: 'a1', provider: 'chatgpt' },
                { agentId: 'a2', provider: 'gemini' },
            ],
        };

        expect(engine.getTurnParticipant(session, 1).provider).toBe('chatgpt');
        expect(engine.getTurnParticipant(session, 2).provider).toBe('gemini');
        expect(engine.getTurnParticipant(session, 3).provider).toBe('chatgpt');
    });

    test('computes round index for debate with two participants', () => {
        const moduleApi = loadSessionEngine();
        const engine = moduleApi.createSessionEngine({
            normalizeProviderKey: (provider) =>
                String(provider || '')
                    .trim()
                    .toLowerCase(),
            isSupportedProviderKey: () => true,
            formatProviderLabel: (provider) => provider,
            listSessionProviders: () => ['chatgpt', 'gemini'],
        });

        const session = {
            mode: 'debate',
            participants: [
                { agentId: 'a1', provider: 'chatgpt' },
                { agentId: 'a2', provider: 'gemini' },
            ],
        };

        expect(engine.getRoundIndex(1, session)).toBe(1);
        expect(engine.getRoundIndex(2, session)).toBe(1);
        expect(engine.getRoundIndex(3, session)).toBe(2);
    });
});
