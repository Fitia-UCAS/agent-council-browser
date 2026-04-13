import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const captureUtilsSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'content', 'captureUtils.js'),
    'utf8'
);
const contentScriptSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'content', 'index.js'),
    'utf8'
);

function readFixture(...segments) {
    return fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', ...segments), 'utf8');
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildProviderRegistry() {
    return {
        chatgpt: {
            id: 'chatgpt',
            matchesHost(hostname) {
                const host = String(hostname || '').toLowerCase();
                return host.includes('chatgpt.com') || host.includes('openai.com');
            },
            forceCaptureStableMs: 45000,
        },
        claude: {
            id: 'claude',
            matchesHost(hostname) {
                return String(hostname || '').toLowerCase().includes('claude.ai');
            },
            forceCaptureStableMs: 20000,
        },
    };
}

function createChromeStub(sentMessages, listeners) {
    return {
        runtime: {
            lastError: null,
            onMessage: {
                addListener(listener) {
                    listeners.push(listener);
                },
            },
            sendMessage(message, callback) {
                sentMessages.push(message);
                this.lastError = null;
                if (typeof callback === 'function') callback({ ok: true });
            },
        },
    };
}

function loadCaptureHarness({ provider, html }) {
    const url =
        provider === 'claude'
            ? 'https://claude.ai/chat/test-fixture'
            : provider === 'gemini'
              ? 'https://gemini.google.com/app/test-fixture'
              : provider === 'grok'
                ? 'https://grok.com/chat/test-fixture'
                : 'https://chatgpt.com/c/test-fixture';
    const dom = new JSDOM(html, {
        url,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const sentMessages = [];
    const listeners = [];
    const chrome = createChromeStub(sentMessages, listeners);
    const context = dom.getInternalVMContext();

    context.console = console;
    context.chrome = chrome;
    context.__MLC_CAPTURE_TEST_MODE__ = true;
    context.MLCCaptureProviders = buildProviderRegistry();
    context.globalThis.__MLC_CAPTURE_TEST_MODE__ = true;
    context.globalThis.MLCCaptureProviders = context.MLCCaptureProviders;
    Object.defineProperty(context.document, 'visibilityState', {
        value: 'visible',
        configurable: true,
    });

    vm.runInContext(captureUtilsSource, context, { filename: 'captureUtils.js' });
    vm.runInContext(contentScriptSource, context, { filename: 'content/index.js' });

    const hooks = context.__MLC_CAPTURE_TEST_HOOKS__;
    if (!hooks) {
        throw new Error('Capture test hooks were not exposed.');
    }

    return {
        dom,
        window: context,
        document: context.document,
        hooks,
        sentMessages,
        listeners,
    };
}

function sendRuntimeMessage(harness, message) {
    let payload = null;
    const listener = harness.listeners[0];
    if (typeof listener !== 'function') {
        throw new Error('No runtime listener registered.');
    }
    listener(message, {}, (response) => {
        payload = response;
    });
    return payload;
}

function buildReadyFixture(provider) {
    if (provider === 'gemini') {
        return `<!doctype html><html><body><main><div class="ql-editor" role="textbox">Draft</div><button aria-label="Send prompt"></button></main></body></html>`;
    }
    if (provider === 'grok') {
        return `<!doctype html><html><body><main><div role="textbox" contenteditable="true">Draft</div><button aria-label="Send"></button></main></body></html>`;
    }
    return readFixture('capture', provider, provider === 'claude' ? 'long-answer-with-noise.html' : 'reference-heavy-answer.html');
}

function buildAuthFixture(label) {
    return `<!doctype html><html><body><main><a href="/login">${label}</a><button>${label}</button></main></body></html>`;
}

function buildLongGrokTailFixture({ controlMarkup = '<button aria-label="Send"></button>' } = {}) {
    const filler = 'baseline tail filler keeps the transcript long enough to force truncation.';
    const history = Array.from(
        { length: 320 },
        (_, index) => `<p>History line ${index + 1}: ${filler} ${filler}</p>`
    ).join('');

    return `<!doctype html>
        <html>
            <body>
                <main>
                    <section class="history-log">${history}</section>
                    <article data-testid="assistant-turn">
                        <div class="response-content-markdown">
                            <p>Previous Grok answer line one.</p>
                            <p>Previous Grok answer line two keeps the primary extractor pinned to the older reply.</p>
                            <p>Previous Grok answer line three closes the prior turn.</p>
                        </div>
                    </article>
                    ${controlMarkup}
                </main>
            </body>
        </html>`;
}

function buildGrokHiddenMirrorComposerFixture() {
    return `<!doctype html>
        <html>
            <body>
                <main>
                    <textarea
                        aria-hidden="true"
                        style="min-height: 0 !important; max-height: none !important; height: 0 !important; visibility: hidden !important; overflow: hidden !important; position: absolute !important; z-index: -1000 !important;"
                    ></textarea>
                    <form>
                        <textarea
                            dir="auto"
                            placeholder="Que voulez-vous savoir ?"
                            aria-label="Poser une question a Grok"
                            style="height: 60px !important;"
                        ></textarea>
                        <button
                            aria-label="Soumettre"
                            style="min-height: 0 !important; max-height: none !important; height: 0 !important; visibility: hidden !important; overflow: hidden !important; position: absolute !important; z-index: -1000 !important;"
                        ></button>
                        <button aria-label="Passer en mode vocal"></button>
                    </form>
                </main>
            </body>
        </html>`;
}

describe('Content capture fixtures', () => {
    test.each([
        ['chatgpt', buildReadyFixture('chatgpt')],
        ['gemini', buildReadyFixture('gemini')],
        ['claude', buildReadyFixture('claude')],
        ['grok', buildReadyFixture('grok')],
    ])('%s readiness probe reports ready on a usable chat surface', (provider, html) => {
        const harness = loadCaptureHarness({ provider, html });
        const readiness = harness.hooks.probeProviderReadiness();

        expect(readiness.ready).toBe(true);
        expect(readiness.reason).toBe('ready');
    });

    test.each([
        ['chatgpt', buildAuthFixture('Se connecter')],
        ['gemini', buildAuthFixture('Sign in')],
        ['claude', buildAuthFixture('Continue with Google')],
        ['grok', buildAuthFixture('Log in')],
    ])('%s readiness probe reports auth_required on an auth wall', (provider, html) => {
        const harness = loadCaptureHarness({ provider, html });
        const payload = sendRuntimeMessage(harness, { type: 'PING' });

        expect(payload.type).toBe('PONG');
        expect(payload.status).toBe('not_ready');
        expect(payload.readiness.ready).toBe(false);
        expect(payload.readiness.reason).toBe('auth_required');
    });

    test('Grok readiness ignores hidden mirror textareas and reports ready from the visible composer', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: buildGrokHiddenMirrorComposerFixture(),
        });

        const readiness = harness.hooks.probeProviderReadiness();

        expect(readiness.ready).toBe(true);
        expect(readiness.reason).toBe('ready');
        expect(readiness.hasInput).toBe(true);
        expect(readiness.hasSendControl).toBe(false);
    });

    test('ChatGPT captures reference-heavy answers without toolbar noise', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        const extraction = harness.hooks.extractLatestResponse({ withMeta: true, withHtml: true });
        const text = normalizeText(extraction.text);

        expect(text).toContain('The capture pipeline should keep the full answer text intact.');
        expect(text).toContain('Reference summary one');
        expect(text).toContain('Reference summary two');
        expect(text).not.toContain('Copy');
        expect(text).not.toContain('Share');
        expect(text).not.toContain('Regenerate');
        expect(extraction.html).toContain('Reference summary one');
        expect(extraction.html).not.toContain('Copy');
        expect(extraction.html).not.toContain('<button');
        expect(extraction.meta.finalWordCount).toBeGreaterThan(10);
    });

    test('ChatGPT preserves interleaved citation ordering from the sanitized fragment collector', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'interleaved-citations.html'),
        });

        const extraction = harness.hooks.extractLatestResponse({ withMeta: true });
        const text = normalizeText(extraction.text);
        const firstParagraphIndex = text.indexOf('Primary answer paragraph one.');
        const citationIndex = text.indexOf('Citation label 1');
        const secondParagraphIndex = text.indexOf('Primary answer paragraph two.');
        const referenceIndex = text.indexOf('Reference summary two');

        expect(firstParagraphIndex).toBeGreaterThanOrEqual(0);
        expect(citationIndex).toBeGreaterThan(firstParagraphIndex);
        expect(secondParagraphIndex).toBeGreaterThan(citationIndex);
        expect(referenceIndex).toBeGreaterThan(secondParagraphIndex);
        expect(text).not.toContain('Copy');
    });

    test('Claude captures long answers with citations while stripping toolbar noise from text and html', () => {
        const harness = loadCaptureHarness({
            provider: 'claude',
            html: readFixture('capture', 'claude', 'long-answer-with-noise.html'),
        });

        const extraction = harness.hooks.extractLatestResponse({ withMeta: true, withHtml: true });
        const text = normalizeText(extraction.text);

        expect(text).toContain(
            'Claude should return the long-form answer without dragging action chrome into the transcript.'
        );
        expect(text).toContain('Citation summary one');
        expect(text).not.toContain('Copy');
        expect(text).not.toContain('Share');
        expect(extraction.html).toContain('Citation summary one');
        expect(extraction.html).not.toContain('Copy');
        expect(extraction.html).not.toContain('<button');
    });

    test('Claude progressed-candidate selection and capture emission prefer the new reply over the baseline answer', () => {
        const harness = loadCaptureHarness({
            provider: 'claude',
            html: readFixture('capture', 'claude', 'previous-long-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'test_prompt',
            sessionId: 'test_session',
            turnIndex: 2,
            agentId: 'agent_claude_1',
            timestamp: Date.now() - 7000,
        });

        harness.document
            .querySelector('main')
            .insertAdjacentHTML(
                'beforeend',
                readFixture('capture', 'claude', 'new-short-reply-fragment.html')
            );

        const preferred = harness.hooks.extractLatestResponse({
            withMeta: true,
            withHtml: true,
            preferAfterOrder: harness.hooks.captureState.baselineBestOrder,
            preferAfterSignature: harness.hooks.captureState.baselineBestSignature,
        });
        const preferredText = normalizeText(preferred.text);

        expect(preferredText).toContain('Short new reply.');
        expect(preferredText).toContain('It answers the latest user turn directly.');
        expect(preferredText).not.toContain('Copy');
        expect(preferred.meta.bestOrder).toBeGreaterThan(harness.hooks.captureState.baselineBestOrder);

        harness.hooks.captureState.startedAt = Date.now() - 7000;
        harness.hooks.evaluateCapture();
        expect(harness.sentMessages).toHaveLength(0);

        harness.hooks.captureState.lastTextChangeAt = Date.now() - 2500;
        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(normalizeText(harness.sentMessages[0].content)).toContain('Short new reply.');
        expect(harness.sentMessages[0].content).not.toContain('Copy');
    });

    test('Universal emit guard rejects prompt-echo captures', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'echo_prompt',
            sessionId: 'echo_session',
            turnIndex: 1,
            agentId: 'agent_chatgpt_1',
            timestamp: Date.now() - 3000,
            promptPreview: 'Reply with exactly: auth-gate-check',
        });

        const emitted = harness.hooks.emitCaptureFromResolvedExtraction('prompt_echo', {
            text: 'Reply with exactly: auth-gate-check',
        });

        expect(emitted).toBe(false);
        expect(harness.sentMessages).toHaveLength(0);
    });

    test('ChatGPT does not force-capture while the stop control still shows generation in progress', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'chatgpt_force_capture_guard',
            sessionId: 'chatgpt_force_capture_guard_session',
            turnIndex: 2,
            agentId: 'agent_chatgpt_1',
            timestamp: Date.now() - 70000,
        });

        const conversation = harness.document.querySelector('[role="log"]');
        if (!conversation) {
            throw new Error('ChatGPT fixture is missing the conversation root.');
        }

        conversation.insertAdjacentHTML(
            'beforeend',
            `
                <article data-message-author-role="assistant">
                    <div data-testid="message-content">
                        <p>This is still a partial streamed answer.</p>
                        <p>ChatGPT has not finished its reasoning yet.</p>
                    </div>
                </article>
            `
        );

        const composer = harness.document.querySelector('textarea');
        if (!composer) {
            throw new Error('ChatGPT fixture is missing the composer textarea.');
        }
        composer.insertAdjacentHTML(
            'afterend',
            '<button data-testid="stop-button" aria-label="Stop generating">Stop</button>'
        );

        harness.hooks.evaluateCapture();
        expect(harness.hooks.captureState.hasNewText).toBe(true);
        harness.hooks.captureState.lastTextChangeAt = Date.now() - 70000;

        harness.hooks.evaluateCapture();
        expect(harness.sentMessages).toHaveLength(0);
        expect(harness.hooks.captureState.active).toBe(true);

        harness.document.querySelector('[data-testid="stop-button"]')?.remove();
        harness.hooks.captureState.lastTextChangeAt = Date.now() - 7000;
        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'This is still a partial streamed answer.'
        );
        expect(harness.hooks.captureState.active).toBe(false);
    });

    test('Grok captures the final incremental answer from a truncated transcript tail after completion controls settle', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: buildLongGrokTailFixture(),
        });

        harness.hooks.armCapture({
            promptId: 'grok_final_turn_prompt',
            sessionId: 'grok_final_turn_session',
            turnIndex: 6,
            agentId: 'agent_grok_1',
            timestamp: Date.now() - 7000,
        });

        const main = harness.document.querySelector('main');
        if (!main) {
            throw new Error('Grok fixture is missing the main transcript root.');
        }

        main.insertAdjacentHTML(
            'beforeend',
            `
                <section class="tail-only-final">
                    <p>Final Grok answer sentence one resolves the last-turn fetch boundary.</p>
                    <p>Final Grok answer sentence two confirms the loop can terminate cleanly.</p>
                </section>
            `
        );

        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(0);
        expect(harness.hooks.captureState.hasNewText).toBe(true);
        expect(normalizeText(harness.hooks.captureState.lastText)).toContain(
            'Final Grok answer sentence one resolves the last-turn fetch boundary.'
        );

        harness.hooks.captureState.lastTextChangeAt = Date.now() - 1500;
        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Final Grok answer sentence one resolves the last-turn fetch boundary.'
        );
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Final Grok answer sentence two confirms the loop can terminate cleanly.'
        );
        expect(harness.sentMessages[0].content).not.toContain('Previous Grok answer line one.');
    });

    test('Grok transcript-tail fallback recovers when completion controls never appear and the primary extractor stays on the previous answer', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: buildLongGrokTailFixture({ controlMarkup: '' }),
        });

        harness.hooks.armCapture({
            promptId: 'grok_no_controls_prompt',
            sessionId: 'grok_no_controls_session',
            turnIndex: 1,
            agentId: 'agent_grok_1',
            timestamp: Date.now() - 10000,
        });

        const main = harness.document.querySelector('main');
        if (!main) {
            throw new Error('Grok fixture is missing the main transcript root.');
        }

        main.insertAdjacentHTML(
            'beforeend',
            `
                <section class="tail-only-final">
                    <p>Final Grok answer sentence one still needs capture without control heuristics.</p>
                    <p>Final Grok answer sentence two confirms the fallback can recover the stalled turn.</p>
                </section>
            `
        );

        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(0);
        expect(harness.hooks.captureState.hasNewText).toBe(true);
        expect(normalizeText(harness.hooks.captureState.lastText)).toContain(
            'Final Grok answer sentence one still needs capture without control heuristics.'
        );

        harness.hooks.captureState.lastTextChangeAt = Date.now() - 7000;
        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Final Grok answer sentence one still needs capture without control heuristics.'
        );
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Final Grok answer sentence two confirms the fallback can recover the stalled turn.'
        );
        expect(harness.sentMessages[0].content).not.toContain('Previous Grok answer line one.');
    });

    test.each([
        ['turn 1', 1, 'Yes.'],
        ['final turn', 6, 'Done.'],
    ])(
        'Grok no-control fallback captures terse valid answers on %s after an extended stability window',
        (_label, turnIndex, answerText) => {
            const harness = loadCaptureHarness({
                provider: 'grok',
                html: buildLongGrokTailFixture({ controlMarkup: '' }),
            });

            harness.hooks.armCapture({
                promptId: `grok_terse_no_controls_${turnIndex}`,
                sessionId: `grok_terse_no_controls_session_${turnIndex}`,
                turnIndex,
                agentId: 'agent_grok_1',
                timestamp: Date.now() - 10000,
            });

            const main = harness.document.querySelector('main');
            if (!main) {
                throw new Error('Grok fixture is missing the main transcript root.');
            }

            main.insertAdjacentHTML(
                'beforeend',
                `
                    <section class="tail-only-final">
                        <p>${answerText}</p>
                    </section>
                `
            );

            harness.hooks.evaluateCapture();

            expect(harness.sentMessages).toHaveLength(0);
            expect(harness.hooks.captureState.hasNewText).toBe(true);
            expect(normalizeText(harness.hooks.captureState.lastText)).toBe(answerText);

            harness.hooks.captureState.lastTextChangeAt = Date.now() - 7000;
            harness.hooks.evaluateCapture();
            expect(harness.sentMessages).toHaveLength(0);

            harness.hooks.captureState.lastTextChangeAt = Date.now() - 13000;
            harness.hooks.evaluateCapture();

            expect(harness.sentMessages).toHaveLength(1);
            expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
            expect(normalizeText(harness.sentMessages[0].content)).toBe(answerText);
        }
    );

    test('Grok transcript-tail emission preserves a repeated opening line in the final answer', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: buildLongGrokTailFixture(),
        });

        harness.hooks.armCapture({
            promptId: 'grok_repeat_opening_prompt',
            sessionId: 'grok_repeat_opening_session',
            turnIndex: 6,
            agentId: 'agent_grok_1',
            timestamp: Date.now() - 7000,
        });

        const main = harness.document.querySelector('main');
        if (!main) {
            throw new Error('Grok fixture is missing the main transcript root.');
        }

        main.insertAdjacentHTML(
            'beforeend',
            `
                <section class="tail-only-final">
                    <p>Previous Grok answer line three closes the prior turn.</p>
                    <p>Final Grok answer detail should still include the repeated opening line.</p>
                </section>
            `
        );

        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(0);
        expect(normalizeText(harness.hooks.captureState.lastText)).toContain(
            'Previous Grok answer line three closes the prior turn.'
        );
        expect(normalizeText(harness.hooks.captureState.lastText)).toContain(
            'Final Grok answer detail should still include the repeated opening line.'
        );

        harness.hooks.captureState.lastTextChangeAt = Date.now() - 1500;
        harness.hooks.evaluateCapture();

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Previous Grok answer line three closes the prior turn.'
        );
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Final Grok answer detail should still include the repeated opening line.'
        );
    });
});
