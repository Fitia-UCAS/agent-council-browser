import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createElementStub({ hidden = false } = {}) {
    return {
        attrs: {},
        classList: {
            add() {},
            toggle() {},
        },
        disabled: false,
        hidden,
        textContent: '',
        value: '',
        focus() {},
        setAttribute(name, value) {
            this.attrs[name] = value;
        },
    };
}

function loadSidepanelPromptHarness() {
    const filePath = path.resolve(__dirname, '..', '..', 'src', 'sidepanel', 'index.js');
    const source = fs.readFileSync(filePath, 'utf8');
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
        console,
        document: {
            addEventListener() {},
        },
        globalThis: {},
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
globalThis.__passphraseHarness = {
    setElements(next) {
        Object.assign(elements, next || {});
    },
    openPassphrasePrompt,
    submitPassphrasePrompt,
    getPassphrasePrompt() {
        return passphrasePrompt;
    }
};`,
        context,
        { filename: 'sidepanel-index.js' }
    );
    return context.__passphraseHarness;
}

describe('Side panel passphrase modal', () => {
    test('keeps the modal open on an incorrect passphrase and closes after a correct retry', async () => {
        const api = loadSidepanelPromptHarness();
        const elements = {
            passphraseBackdrop: createElementStub({ hidden: true }),
            passphraseModal: createElementStub({ hidden: true }),
            passphraseInput: createElementStub(),
            passphraseConfirm: createElementStub(),
            passphraseConfirmField: createElementStub({ hidden: true }),
            passphraseContinueHelp: createElementStub({ hidden: true }),
            passphraseContinueUnprotected: createElementStub({ hidden: true }),
            passphraseSubmit: createElementStub(),
            passphraseCancel: createElementStub(),
            passphraseError: createElementStub({ hidden: true }),
            passphraseTitle: createElementStub(),
            passphraseNote: createElementStub(),
        };
        api.setElements(elements);

        const attempts = [];
        const promptPromise = api.openPassphrasePrompt({
            mode: 'unlock',
            onSubmitPassphrase: async (passphrase) => {
                attempts.push(passphrase);
                if (attempts.length === 1) {
                    return { ok: false, error: 'Incorrect passphrase.' };
                }
                return { ok: true };
            },
        });

        elements.passphraseInput.value = 'wrong';
        await api.submitPassphrasePrompt();

        expect(attempts).toEqual(['wrong']);
        expect(elements.passphraseModal.hidden).toBe(false);
        expect(elements.passphraseError.hidden).toBe(false);
        expect(elements.passphraseError.textContent).toBe('Incorrect passphrase.');
        expect(api.getPassphrasePrompt()).toBeTruthy();

        elements.passphraseInput.value = 'correct';
        await api.submitPassphrasePrompt();
        await expect(promptPromise).resolves.toMatchObject({
            kind: 'passphrase',
            value: 'correct',
        });

        expect(attempts).toEqual(['wrong', 'correct']);
        expect(elements.passphraseModal.hidden).toBe(true);
        expect(api.getPassphrasePrompt()).toBeNull();
    });
});
