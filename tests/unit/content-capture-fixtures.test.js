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
                return String(hostname || '')
                    .toLowerCase()
                    .includes('claude.ai');
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

function settleChatGPTCapture(harness, { idleMs = 16000 } = {}) {
    const now = Date.now();
    harness.hooks.captureState.lastTextChangeAt = now - idleMs;
    harness.hooks.captureState.chatgptIdleSince = now - idleMs;
    harness.hooks.captureState.chatgptLastActivityAt = now - idleMs;
    harness.hooks.evaluateCapture();
    harness.hooks.captureState.chatgptFinalTextStableSince = Date.now() - 1500;
    harness.hooks.evaluateCapture();
}

function buildReadyFixture(provider) {
    if (provider === 'gemini') {
        return `<!doctype html><html><body><main><div class="ql-editor" role="textbox">Draft</div><button aria-label="Send prompt"></button></main></body></html>`;
    }
    if (provider === 'grok') {
        return `<!doctype html><html><body><main><div role="textbox" contenteditable="true">Draft</div><button aria-label="Send"></button></main></body></html>`;
    }
    return readFixture(
        'capture',
        provider,
        provider === 'claude' ? 'long-answer-with-noise.html' : 'reference-heavy-answer.html'
    );
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

function buildGrokStructuredRichFixture() {
    return `<!doctype html>
        <html>
            <body>
                <main>
                    <form>
                        <div role="textbox" contenteditable="true">Draft</div>
                        <button aria-label="Send"></button>
                    </form>
                    <article data-testid="assistant-turn">
                        <div class="response-content-markdown">
                            <h2>Policy Summary</h2>
                            <p>Structured Grok answer intro with useful context.</p>
                            <ul>
                                <li>First structured point</li>
                                <li>Second structured point</li>
                            </ul>
                            <table>
                                <thead>
                                    <tr><th>Model</th><th>Status</th></tr>
                                </thead>
                                <tbody>
                                    <tr><td>Grok</td><td>Ready</td></tr>
                                </tbody>
                            </table>
                            <div class="answer-footer">
                                <span>773ms</span>
                                <span>Are you satisfied with Grok's answer?</span>
                                <button>Passer en mode vocal</button>
                            </div>
                        </div>
                    </article>
                    <button aria-label="Passer en mode vocal"></button>
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

    test('Grok readiness reports ready from a usable input without a send control', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: `<!doctype html><html><body><main><form><div role="textbox" contenteditable="true">Draft</div></form></main></body></html>`,
        });
        const readiness = harness.hooks.probeProviderReadiness();

        expect(readiness.ready).toBe(true);
        expect(readiness.reason).toBe('ready');
        expect(readiness.hasInput).toBe(true);
        expect(readiness.hasSendControl).toBe(false);
    });

    test.each([
        ['enabled send control only', '<button aria-label="Send message"></button>', true],
        [
            'disabled send control only',
            '<button aria-label="Send message" disabled></button>',
            false,
        ],
        ['voice control only', '<button aria-label="Microphone"></button>', false],
    ])('Grok readiness does not report ready from %s', (_label, controlMarkup, hasSendControl) => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: `<!doctype html><html><body><main><form>${controlMarkup}</form></main></body></html>`,
        });
        const readiness = harness.hooks.probeProviderReadiness();

        expect(readiness.ready).toBe(false);
        expect(['composer_missing', 'loading']).toContain(readiness.reason);
        expect(readiness.hasInput).toBe(false);
        expect(readiness.hasSendControl).toBe(hasSendControl);
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

    test('ChatGPT accepts same-assistant streamed updates when capture arms after generation starts', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        const conversation = harness.document.querySelector('[role="log"]');
        if (!conversation) {
            throw new Error('ChatGPT fixture is missing the conversation root.');
        }
        conversation.insertAdjacentHTML(
            'beforeend',
            `
                <article data-message-author-role="assistant">
                    <div data-testid="message-content" data-testid-streaming-answer>
                        <p>Parallel ChatGPT partial answer has already started streaming before capture is armed.</p>
                        <p>The capture baseline must not lock this partial text as the final answer.</p>
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

        harness.hooks.armCapture({
            promptId: 'parallel_chatgpt_late_arm',
            sessionId: 'parallel_chatgpt_late_arm_session',
            turnIndex: 1,
            agentId: 'agent_chatgpt_1',
            timestamp: Date.now() - 2500,
        });

        harness.hooks.captureState.lastTextChangeAt = Date.now() - 12000;
        harness.hooks.evaluateCapture();
        expect(harness.sentMessages).toHaveLength(0);
        expect(harness.hooks.captureState.active).toBe(true);

        const streamingNode = harness.document.querySelector('[data-testid-streaming-answer]');
        streamingNode.innerHTML = `
            <p>Parallel ChatGPT final answer sentence one should be captured.</p>
            <p>Sentence two extends the same assistant block after the baseline was recorded.</p>
            <p>Sentence three confirms this is the current parallel reply, not the previous answer.</p>
        `;

        harness.hooks.evaluateCapture();

        expect(harness.hooks.captureState.hasNewText).toBe(true);
        expect(normalizeText(harness.hooks.captureState.lastText)).toContain(
            'Parallel ChatGPT final answer sentence one should be captured.'
        );
        expect(harness.sentMessages).toHaveLength(0);

        harness.document.querySelector('[data-testid="stop-button"]')?.remove();
        settleChatGPTCapture(harness);

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(harness.sentMessages[0].agentId).toBe('agent_chatgpt_1');
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'Parallel ChatGPT final answer sentence one should be captured.'
        );
    });

    test('ChatGPT waits through search tool status before capturing the final answer', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'chatgpt_search_status',
            sessionId: 'chatgpt_search_status_session',
            turnIndex: 1,
            agentId: 'agent_chatgpt_search',
            timestamp: Date.now() - 20000,
        });

        const conversation = harness.document.querySelector('[role="log"]');
        conversation.insertAdjacentHTML(
            'beforeend',
            `
                <article data-message-author-role="assistant" data-search-turn>
                    <div role="status" data-testid="web-search-status">
                        Searching the web and checking Maps for current details
                    </div>
                </article>
            `
        );

        harness.hooks.evaluateCapture();
        expect(harness.sentMessages).toHaveLength(0);
        expect(harness.hooks.captureState.active).toBe(true);

        harness.hooks.captureState.lastTextChangeAt = Date.now() - 20000;
        harness.hooks.evaluateCapture();
        expect(harness.sentMessages).toHaveLength(0);

        const searchTurn = harness.document.querySelector('[data-search-turn]');
        searchTurn.innerHTML = `
            <div data-testid="message-content">
                <p>Final ChatGPT answer after the web search should be captured completely.</p>
                <p>This paragraph proves the answer text, not the transient status, is selected.</p>
            </div>
            <section class="sources-list">
                <div class="reference-row">Reference summary after search</div>
            </section>
        `;

        harness.hooks.evaluateCapture();
        expect(harness.hooks.captureState.hasNewText).toBe(true);
        expect(harness.sentMessages).toHaveLength(0);

        settleChatGPTCapture(harness);

        expect(harness.sentMessages).toHaveLength(1);
        const captured = normalizeText(harness.sentMessages[0].content);
        expect(captured).toContain('Final ChatGPT answer after the web search');
        expect(captured).toContain('Reference summary after search');
        expect(captured).not.toContain('Searching the web');
        expect(harness.sentMessages[0].contentHtml).toContain('Reference summary after search');
        expect(harness.sentMessages[0].contentHtml).not.toContain('web-search-status');
    });

    test('ChatGPT does not suppress concise final answers that mention using search', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'chatgpt_short_answer',
            sessionId: 'chatgpt_short_answer_session',
            turnIndex: 1,
            agentId: 'agent_chatgpt_short',
            timestamp: Date.now() - 12000,
        });

        harness.document.querySelector('[role="log"]').insertAdjacentHTML(
            'beforeend',
            `
                <article data-message-author-role="assistant">
                    <div data-testid="message-content">
                        <p>Using React state is the simplest fix.</p>
                    </div>
                </article>
            `
        );

        harness.hooks.evaluateCapture();
        settleChatGPTCapture(harness, { idleMs: 7000 });

        expect(harness.sentMessages).toHaveLength(1);
        expect(normalizeText(harness.sentMessages[0].content)).toBe(
            'Using React state is the simplest fix.'
        );
    });

    test('ChatGPT does not emit sources-only blocks as final answers', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'chatgpt_sources_only',
            sessionId: 'chatgpt_sources_only_session',
            turnIndex: 1,
            agentId: 'agent_chatgpt_sources',
            timestamp: Date.now() - 20000,
        });

        harness.document.querySelector('[role="log"]').insertAdjacentHTML(
            'beforeend',
            `
                <article data-message-author-role="assistant">
                    <div data-testid="message-content">
                        <p>Sources</p>
                        <p>example.com</p>
                        <p>openai.com</p>
                        <p>maps.google.com</p>
                    </div>
                </article>
            `
        );

        harness.hooks.evaluateCapture();
        settleChatGPTCapture(harness);

        expect(harness.sentMessages).toHaveLength(0);
        expect(harness.hooks.captureState.active).toBe(true);
    });

    test('ChatGPT waits while tool status remains visible beside the final answer', () => {
        const harness = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });

        harness.hooks.armCapture({
            promptId: 'chatgpt_answer_with_visible_status',
            sessionId: 'chatgpt_answer_with_visible_status_session',
            turnIndex: 1,
            agentId: 'agent_chatgpt_status_visible',
            timestamp: Date.now() - 20000,
        });

        harness.document.querySelector('[role="log"]').insertAdjacentHTML(
            'beforeend',
            `
                <article data-message-author-role="assistant">
                    <div role="status" data-testid="web-search-status">
                        Searching the web for current details
                    </div>
                    <div data-testid="message-content">
                        <p>Final answer should wait until the status disappears.</p>
                        <p>The emitted content should not include the status text.</p>
                    </div>
                </article>
            `
        );

        harness.hooks.evaluateCapture();
        harness.hooks.captureState.lastTextChangeAt = Date.now() - 20000;
        harness.hooks.evaluateCapture();
        expect(harness.sentMessages).toHaveLength(0);

        harness.document.querySelector('[data-testid="web-search-status"]')?.remove();
        settleChatGPTCapture(harness);

        expect(harness.sentMessages).toHaveLength(1);
        const captured = normalizeText(harness.sentMessages[0].content);
        expect(captured).toContain('Final answer should wait until the status disappears.');
        expect(captured).not.toContain('Searching the web');
        expect(harness.sentMessages[0].contentHtml).not.toContain('web-search-status');
    });

    test('Parallel ChatGPT captures stay bound to their own agent ids', () => {
        const first = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });
        const second = loadCaptureHarness({
            provider: 'chatgpt',
            html: readFixture('capture', 'chatgpt', 'reference-heavy-answer.html'),
        });
        const sessionId = 'parallel_two_chatgpt_session';
        const cases = [
            {
                harness: first,
                agentId: 'agent_chatgpt_a',
                promptId: `${sessionId}:parallel:agent_chatgpt_a`,
                answer: 'Agent A final parallel answer should stay with the first ChatGPT profile.',
            },
            {
                harness: second,
                agentId: 'agent_chatgpt_b',
                promptId: `${sessionId}:parallel:agent_chatgpt_b`,
                answer: 'Agent B final parallel answer should stay with the second ChatGPT profile.',
            },
        ];

        for (const item of cases) {
            item.harness.hooks.armCapture({
                promptId: item.promptId,
                sessionId,
                turnIndex: 1,
                agentId: item.agentId,
                timestamp: Date.now() - 12000,
            });
            item.harness.document.querySelector('[role="log"]').insertAdjacentHTML(
                'beforeend',
                `
                    <article data-message-author-role="assistant">
                        <div data-testid="message-content">
                            <p>${item.answer}</p>
                            <p>The capture must not reuse another tab's partial response.</p>
                        </div>
                    </article>
                `
            );
            item.harness.hooks.evaluateCapture();
            settleChatGPTCapture(item.harness, { idleMs: 7000 });
        }

        expect(first.sentMessages).toHaveLength(1);
        expect(second.sentMessages).toHaveLength(1);
        expect(first.sentMessages[0].agentId).toBe('agent_chatgpt_a');
        expect(second.sentMessages[0].agentId).toBe('agent_chatgpt_b');
        expect(first.sentMessages[0].promptId).toBe(`${sessionId}:parallel:agent_chatgpt_a`);
        expect(second.sentMessages[0].promptId).toBe(`${sessionId}:parallel:agent_chatgpt_b`);
        expect(normalizeText(first.sentMessages[0].content)).toContain('Agent A final parallel');
        expect(normalizeText(second.sentMessages[0].content)).toContain('Agent B final parallel');
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
        expect(preferred.meta.bestOrder).toBeGreaterThan(
            harness.hooks.captureState.baselineBestOrder
        );

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
        settleChatGPTCapture(harness);

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(normalizeText(harness.sentMessages[0].content)).toContain(
            'This is still a partial streamed answer.'
        );
        expect(harness.hooks.captureState.active).toBe(false);
    });

    test('Grok preserves structured rich HTML when the emitted answer matches the extracted rich content', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: buildGrokStructuredRichFixture(),
        });

        harness.hooks.armCapture({
            promptId: 'grok_rich_html_prompt',
            sessionId: 'grok_rich_html_session',
            turnIndex: 1,
            agentId: 'agent_grok_1',
            timestamp: Date.now() - 4000,
        });

        const extraction = harness.hooks.extractLatestResponse({ withMeta: true, withHtml: true });
        expect(normalizeText(extraction.text)).toContain('Policy Summary');
        expect(normalizeText(extraction.text)).toContain('First structured point');
        expect(extraction.html).toContain('<h2>Policy Summary</h2>');
        expect(extraction.html).toContain('<table>');
        expect(extraction.html).not.toContain('Are you satisfied with Grok');
        expect(extraction.html).not.toContain('773ms');
        expect(extraction.html).not.toContain('<button');

        harness.hooks.emitCaptureFromResolvedExtraction('grok_stop_voice_idle', extraction);

        expect(harness.sentMessages).toHaveLength(1);
        expect(harness.sentMessages[0].type).toBe('MLC_RESPONSE_CAPTURED');
        expect(harness.sentMessages[0].contentHtml).toContain('<h2>Policy Summary</h2>');
        expect(harness.sentMessages[0].contentHtml).toContain('<ul>');
        expect(harness.sentMessages[0].contentHtml).toContain('<table>');
        expect(harness.sentMessages[0].contentHtml).not.toContain('Are you satisfied with Grok');
        expect(harness.sentMessages[0].contentHtml).not.toContain('773ms');
        expect(harness.sentMessages[0].contentHtml).not.toContain('<button');
    });

    test('Grok drops rich HTML when incremental trimming changes the emitted answer text', () => {
        const harness = loadCaptureHarness({
            provider: 'grok',
            html: buildReadyFixture('grok'),
        });

        harness.hooks.armCapture({
            promptId: 'grok_incremental_html_guard_prompt',
            sessionId: 'grok_incremental_html_guard_session',
            turnIndex: 2,
            agentId: 'agent_grok_1',
            timestamp: Date.now() - 4000,
        });
        harness.hooks.captureState.baselineText = 'Previous Grok answer sentence.';
        harness.hooks.captureState.grokBaselineTranscriptTail = 'Previous Grok answer sentence.';

        harness.hooks.emitCaptureFromResolvedExtraction('stable_capture', {
            text: [
                'Previous Grok answer sentence.',
                'Fresh structured heading',
                'Fresh structured detail that should still be emitted.',
            ].join('\n\n'),
            html: [
                '<p>Previous Grok answer sentence.</p>',
                '<h2>Fresh structured heading</h2>',
                '<p>Fresh structured detail that should still be emitted.</p>',
            ].join(''),
            meta: {
                provider: 'grok',
                source: 'assistant_response_markdown',
            },
        });

        expect(harness.sentMessages).toHaveLength(1);
        expect(normalizeText(harness.sentMessages[0].content)).toBe(
            'Fresh structured heading Fresh structured detail that should still be emitted.'
        );
        expect(harness.sentMessages[0].contentHtml).toBe('');
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
        expect(harness.sentMessages[0].contentHtml).toBe('');
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
        expect(harness.sentMessages[0].contentHtml).toBe('');
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
            expect(harness.sentMessages[0].contentHtml).toBe('');
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
        expect(harness.sentMessages[0].contentHtml).toBe('');
    });
});
