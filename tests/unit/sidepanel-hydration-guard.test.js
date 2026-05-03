import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadSidepanelHydrationHarness() {
    const source = fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'src', 'sidepanel', 'index.js'),
        'utf8'
    );
    const dom = new JSDOM(
        `<!doctype html><html><body>
            <main id="timeline"><div id="empty-state">Empty</div></main>
        </body></html>`,
        { url: 'chrome-extension://test/sidepanel.html' }
    );
    const document = dom.window.document;
    document.addEventListener = () => {};

    const context = {
        chrome: {
            runtime: { lastError: null },
            storage: {
                local: {
                    get(_keys, callback) {
                        callback({});
                    },
                    set(_items, callback) {
                        callback?.();
                    },
                },
            },
        },
        clearTimeout,
        console: {
            ...console,
            warn() {},
        },
        document,
        MLCTranscriptView: {
            buildMessageElement() {
                throw new Error('bad saved rich message');
            },
        },
        setTimeout,
        window: {
            requestAnimationFrame(callback) {
                return setTimeout(callback, 0);
            },
            setTimeout,
        },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(
        `${source}
globalThis.__hydrationHarness = {
    setElements(next) {
        Object.assign(elements, next || {});
    },
    addMessage
};`,
        context,
        { filename: 'sidepanel-index.js' }
    );
    return {
        document,
        harness: context.__hydrationHarness,
    };
}

describe('Side panel transcript hydration guard', () => {
    test('shows a recoverable message instead of leaving the timeline blank', () => {
        const { document, harness } = loadSidepanelHydrationHarness();
        const timeline = document.getElementById('timeline');
        const emptyState = document.getElementById('empty-state');
        harness.setElements({ timeline, emptyState });

        harness.addMessage({ role: 'assistant', contentHtml: '<p>Broken rich message</p>' });

        expect(timeline.contains(emptyState)).toBe(false);
        expect(timeline.textContent).toContain('Could not render one saved message.');
        expect(timeline.querySelector('.message.system')).toBeTruthy();
    });
});
