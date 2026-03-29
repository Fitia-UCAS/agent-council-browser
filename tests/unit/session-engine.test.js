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

    test('rejects stale sequential responses when turn attempt id mismatches', () => {
        const moduleApi = loadSessionEngine();
        const engine = moduleApi.createSessionEngine({
            normalizeProviderKey: (provider) =>
                String(provider || '')
                    .trim()
                    .toLowerCase(),
            isSupportedProviderKey: () => true,
            formatProviderLabel: (provider) => provider,
            listSessionProviders: () => ['chatgpt', 'claude'],
        });

        const session = {
            waitingFor: 'agent_claude_1',
            turnIndex: 2,
            lastPromptId: 'session_1:turn:2:agent:agent_claude_1:attempt:new:prompt',
            lastTurnAttemptId: 'session_1:turn:2:agent:agent_claude_1:attempt:new',
        };

        const stale = engine.validateSequentialResponse(session, {
            agentId: 'agent_claude_1',
            promptId: 'session_1:turn:2:agent:agent_claude_1:attempt:old:prompt',
            turnIndex: 2,
            turnAttemptId: 'session_1:turn:2:agent:agent_claude_1:attempt:old',
        });
        expect(stale.ok).toBe(false);
        expect(stale.reason).toBe('turn_attempt_mismatch');

        const current = engine.validateSequentialResponse(session, {
            agentId: 'agent_claude_1',
            promptId: 'session_1:turn:2:agent:agent_claude_1:attempt:new:prompt',
            turnIndex: 2,
            turnAttemptId: 'session_1:turn:2:agent:agent_claude_1:attempt:new',
        });
        expect(current.ok).toBe(true);
    });

    test('rejects missing turn attempt id for attempt-scoped sequential turns', () => {
        const moduleApi = loadSessionEngine();
        const engine = moduleApi.createSessionEngine({
            normalizeProviderKey: (provider) =>
                String(provider || '')
                    .trim()
                    .toLowerCase(),
            isSupportedProviderKey: () => true,
            formatProviderLabel: (provider) => provider,
            listSessionProviders: () => ['chatgpt', 'claude'],
        });

        const session = {
            waitingFor: 'agent_chatgpt_1',
            turnIndex: 3,
            lastPromptId: 'session_1:turn:3:agent:agent_chatgpt_1:attempt:current:prompt',
            lastTurnAttemptId: 'session_1:turn:3:agent:agent_chatgpt_1:attempt:current',
        };

        const wrongPrompt = engine.validateSequentialResponse(session, {
            agentId: 'agent_chatgpt_1',
            promptId: 'session_1:turn:2:agent:agent_chatgpt_1:attempt:old:prompt',
            turnIndex: 3,
        });
        expect(wrongPrompt.ok).toBe(false);
        expect(wrongPrompt.reason).toBe('missing_turn_attempt_id');

        const missingTurn = engine.validateSequentialResponse(session, {
            agentId: 'agent_chatgpt_1',
            promptId: 'session_1:turn:3:agent:agent_chatgpt_1:attempt:current:prompt',
        });
        expect(missingTurn.ok).toBe(false);
        expect(missingTurn.reason).toBe('missing_turn_attempt_id');
    });

    test('keeps legacy prompt and turn fallback for sessions without attempt metadata', () => {
        const moduleApi = loadSessionEngine();
        const engine = moduleApi.createSessionEngine({
            normalizeProviderKey: (provider) =>
                String(provider || '')
                    .trim()
                    .toLowerCase(),
            isSupportedProviderKey: () => true,
            formatProviderLabel: (provider) => provider,
            listSessionProviders: () => ['chatgpt', 'claude'],
        });

        const session = {
            waitingFor: 'agent_chatgpt_1',
            turnIndex: 3,
            lastPromptId: 'session_legacy:turn:3',
            lastTurnAttemptId: null,
        };

        const fallbackCurrent = engine.validateSequentialResponse(session, {
            agentId: 'agent_chatgpt_1',
            promptId: 'session_legacy:turn:3',
            turnIndex: 3,
        });
        expect(fallbackCurrent.ok).toBe(true);

        const missingPrompt = engine.validateSequentialResponse(session, {
            agentId: 'agent_chatgpt_1',
            turnIndex: 3,
        });
        expect(missingPrompt.ok).toBe(false);
        expect(missingPrompt.reason).toBe('missing_prompt_id');
    });
});
