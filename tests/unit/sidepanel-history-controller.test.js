import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadHistoryController(sentMessages) {
    const filePath = path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'sidepanel',
        'controllers',
        'historyController.js'
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const context = {
        self: {
            MLCSidepanelBackgroundClient: {
                async sendAsync(message) {
                    sentMessages.push(message);
                    return { ok: true };
                },
            },
        },
        window: {},
        globalThis: {},
    };
    context.globalThis = context.self;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'historyController.js' });
    return context.self.MLCSidepanelHistoryController;
}

describe('Side panel history controller', () => {
    test('dispatches passphrase reset and delete-all chat messages', async () => {
        const sentMessages = [];
        const api = loadHistoryController(sentMessages);

        await api.resetProtection();
        await api.clearAllChats();

        expect(sentMessages).toEqual([
            { type: 'HISTORY_RESET_PROTECTION' },
            { type: 'HISTORY_CLEAR_ALL' },
        ]);
    });
});
