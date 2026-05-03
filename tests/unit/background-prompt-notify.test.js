import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractBetween(source, startNeedle, endNeedle) {
    const start = source.indexOf(startNeedle);
    if (start < 0) throw new Error(`Could not locate ${startNeedle}.`);
    const end = source.indexOf(endNeedle, start + startNeedle.length);
    if (end < 0) throw new Error(`Could not locate ${endNeedle}.`);
    return source.slice(start, end);
}

function loadNotifyHarness(sendMessage) {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'src', 'background', 'index.js'),
        'utf8'
    );
    const context = {
        chrome: {
            tabs: { sendMessage },
        },
        setTimeout(callback) {
            callback();
            return 0;
        },
        console,
    };
    context.self = context;
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(
        `
function formatLLMLabel(provider) {
    const normalized = String(provider || '').toLowerCase();
    if (normalized === 'chatgpt') return 'ChatGPT';
    if (normalized === 'grok') return 'Grok';
    return normalized || 'Provider';
}
function normalizeProviderKey(provider) {
    const normalized = String(provider || '').trim().toLowerCase();
    return ['chatgpt', 'gemini', 'claude', 'grok'].includes(normalized) ? normalized : '';
}
function isMissingContentScriptError() {
    return false;
}
async function ensureProviderContentScripts() {
    return false;
}
${extractBetween(
    source,
    'async function sendTabMessageWithRetry',
    '\nasync function notifyPromptSentWithRetry'
)}
${extractBetween(
    source,
    'async function notifyPromptSentWithRetry',
    '\nasync function sendPromptViaClaudeDebugger'
)}
globalThis.__notifyPromptSentWithRetry = notifyPromptSentWithRetry;
`,
        context,
        { filename: 'background-notify-harness.js' }
    );
    return context.__notifyPromptSentWithRetry;
}

describe('Background prompt notification retry', () => {
    test('arms capture after delayed content-script availability', async () => {
        const delivered = [];
        let attempts = 0;
        const sendMessage = vi.fn(async (_tabId, message) => {
            attempts += 1;
            if (attempts < 3) throw new Error('Receiving end does not exist.');
            delivered.push(message);
            return { ok: true };
        });
        const notifyPromptSentWithRetry = loadNotifyHarness(sendMessage);

        const result = await notifyPromptSentWithRetry(
            42,
            { type: 'MLC_PROMPT_SENT', llmType: 'chatgpt', promptId: 'prompt_1' },
            { retries: 5, delayMs: 1 }
        );

        expect(result).toMatchObject({ ok: true, attempt: 3 });
        expect(sendMessage).toHaveBeenCalledTimes(3);
        expect(delivered).toEqual([
            { type: 'MLC_PROMPT_SENT', llmType: 'chatgpt', promptId: 'prompt_1' },
        ]);
    });

    test('fails clearly when capture cannot be armed', async () => {
        const sendMessage = vi.fn(async () => {
            throw new Error('Could not establish connection.');
        });
        const notifyPromptSentWithRetry = loadNotifyHarness(sendMessage);

        await expect(
            notifyPromptSentWithRetry(
                42,
                { type: 'MLC_PROMPT_SENT', llmType: 'grok', promptId: 'prompt_2' },
                { retries: 3, delayMs: 1 }
            )
        ).rejects.toMatchObject({
            code: 'CAPTURE_ARM_FAILED',
            provider: 'grok',
            details: {
                stage: 'capture_arm',
                attempts: 3,
            },
        });
        expect(sendMessage).toHaveBeenCalledTimes(3);
    });
});
