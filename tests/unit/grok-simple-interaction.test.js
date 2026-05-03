import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractSimpleInteractionSource() {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'src', 'background', 'index.js'),
        'utf8'
    );
    const start = source.indexOf('async function simpleInteraction');
    const end = source.indexOf('\nasync function checkConnectionStatus', start);
    if (start < 0 || end < 0) {
        throw new Error('Could not locate simpleInteraction in background source.');
    }
    return source.slice(start, end);
}

function installDomShims(window) {
    let activeElement = null;
    const originalFocus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function focusShim() {
        activeElement = this;
        try {
            originalFocus.call(this);
        } catch (error) {
            // jsdom focus support is partial for contenteditable nodes.
        }
    };

    Object.defineProperty(window.HTMLElement.prototype, 'contentEditable', {
        configurable: true,
        get() {
            return this.getAttribute('contenteditable') || '';
        },
        set(value) {
            this.setAttribute('contenteditable', value);
        },
    });
    Object.defineProperty(window.HTMLElement.prototype, 'isContentEditable', {
        configurable: true,
        get() {
            return String(this.getAttribute('contenteditable') || '').toLowerCase() === 'true';
        },
    });

    window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRectShim() {
        const hidden = this.hasAttribute('hidden') || this.getAttribute('aria-hidden') === 'true';
        const style = this.getAttribute('style') || '';
        if (hidden || /display\s*:\s*none|visibility\s*:\s*hidden|height\s*:\s*0/i.test(style)) {
            return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
        }
        return { x: 10, y: 10, top: 10, left: 10, right: 58, bottom: 58, width: 48, height: 48 };
    };

    window.document.execCommand = (command, _showUi, value) => {
        const target =
            activeElement ||
            window.document.querySelector('[contenteditable="true"], textarea, input');
        if (!target) return false;
        if (command === 'insertText') {
            const next = String(value || '');
            if (next === ' ') {
                target.textContent = `${target.textContent || ''} `;
            } else {
                target.textContent = next;
            }
            return true;
        }
        if (command === 'delete') {
            target.textContent = String(target.textContent || '').replace(/\s$/, '');
            return true;
        }
        return false;
    };
}

function loadSimpleInteractionHarness(html, { onRequestSubmit } = {}) {
    const dom = new JSDOM(html, {
        url: 'https://grok.com/chat/test',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const context = dom.getInternalVMContext();
    installDomShims(context);

    let now = 0;
    class FakeDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }

        static now() {
            now += 250;
            return now;
        }
    }

    context.Date = FakeDate;
    context.window.Date = FakeDate;
    context.setTimeout = (callback, _ms, ...args) => setTimeout(callback, 0, ...args);
    context.clearTimeout = clearTimeout;
    context.console = {
        log() {},
        warn() {},
        error() {},
    };

    let submitCalls = 0;
    for (const form of context.document.querySelectorAll('form')) {
        form.requestSubmit = () => {
            submitCalls += 1;
            if (typeof onRequestSubmit === 'function') {
                onRequestSubmit({ document: context.document, form, submitCalls });
            }
        };
    }

    vm.runInContext(
        `${extractSimpleInteractionSource()}\nglobalThis.__simpleInteraction = simpleInteraction;`,
        context,
        { filename: 'src/background/index.js' }
    );

    return {
        dom,
        document: context.document,
        simpleInteraction: context.__simpleInteraction,
        getSubmitCalls: () => submitCalls,
    };
}

function clearDraftAndShowStop(document, form) {
    const editor = form.querySelector('[contenteditable="true"], textarea, input');
    if (editor) {
        if ('value' in editor) editor.value = '';
        editor.textContent = '';
    }
    if (!form.querySelector('button[aria-label="Stop generating"]')) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.setAttribute('aria-label', 'Stop generating');
        form.appendChild(stop);
    }
}

describe('Grok simpleInteraction send fallback', () => {
    test('falls back after send-ready timeout instead of surfacing button-not-found', async () => {
        const harness = loadSimpleInteractionHarness(
            `<!doctype html><html><body><main>
                <form>
                    <div role="textbox" contenteditable="true"></div>
                </form>
            </main></body></html>`,
            {
                onRequestSubmit({ document, form, submitCalls }) {
                    if (submitCalls >= 2) clearDraftAndShowStop(document, form);
                },
            }
        );

        const result = await harness.simpleInteraction('yo', 'grok', [], null);

        expect(result.success).toBe(true);
        expect(result.details.attempts).toBe(2);
        expect(result.details.ackReason).toBe('stop_visible_after_send');
        expect(harness.getSubmitCalls()).toBe(2);
    });

    test('does not accept a pre-existing stop button as send acknowledgement', async () => {
        const harness = loadSimpleInteractionHarness(
            `<!doctype html><html><body><main>
                <form>
                    <div role="textbox" contenteditable="true"></div>
                    <button type="button" aria-label="Stop generating"></button>
                </form>
            </main></body></html>`
        );

        const result = await harness.simpleInteraction('yo', 'grok', [], null);

        expect(result.success).toBe(false);
        expect(result.details.stage).toBe('send_not_acknowledged');
        expect(result.details.ackReason).toContain('timeout');
        expect(harness.getSubmitCalls()).toBe(2);
    });

    test('does not click a voice-only control as send', async () => {
        let voiceClicked = false;
        const harness = loadSimpleInteractionHarness(
            `<!doctype html><html><body><main>
                <form>
                    <div role="textbox" contenteditable="true"></div>
                    <button type="button" aria-label="Microphone"></button>
                </form>
            </main></body></html>`,
            {
                onRequestSubmit({ document, form }) {
                    clearDraftAndShowStop(document, form);
                },
            }
        );
        harness.document
            .querySelector('button[aria-label="Microphone"]')
            .addEventListener('click', () => {
                voiceClicked = true;
            });

        const result = await harness.simpleInteraction('yo', 'grok', [], null);

        expect(result.success).toBe(true);
        expect(voiceClicked).toBe(false);
        expect(harness.getSubmitCalls()).toBe(1);
    });

    test('clicks a mixed send and microphone labelled submit control as send', async () => {
        let sendClicked = false;
        const harness = loadSimpleInteractionHarness(
            `<!doctype html><html><body><main>
                <form>
                    <div role="textbox" contenteditable="true"></div>
                    <button type="button" aria-label="Send message microphone"></button>
                </form>
            </main></body></html>`
        );
        const sendButton = harness.document.querySelector(
            'button[aria-label="Send message microphone"]'
        );
        const form = harness.document.querySelector('form');
        sendButton.addEventListener('click', () => {
            sendClicked = true;
            clearDraftAndShowStop(harness.document, form);
        });

        const result = await harness.simpleInteraction('yo', 'grok', [], null);

        expect(result.success).toBe(true);
        expect(sendClicked).toBe(true);
        expect(harness.getSubmitCalls()).toBe(0);
    });

    test('waits through a disabled send button and clicks it once enabled', async () => {
        const harness = loadSimpleInteractionHarness(
            `<!doctype html><html><body><main>
                <form>
                    <div role="textbox" contenteditable="true"></div>
                    <button type="button" aria-label="Send message" disabled></button>
                </form>
            </main></body></html>`
        );
        const sendButton = harness.document.querySelector('button[aria-label="Send message"]');
        const form = harness.document.querySelector('form');
        sendButton.addEventListener('click', () => {
            clearDraftAndShowStop(harness.document, form);
        });
        sendButton.disabled = false;
        sendButton.removeAttribute('disabled');

        const result = await harness.simpleInteraction('yo', 'grok', [], null);

        expect(result.success).toBe(true);
        expect(result.method).toBe('button_click_for_grok');
        expect(result.details.ackReason).toBe('stop_visible_after_send');
    });
});
