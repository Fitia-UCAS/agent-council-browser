import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadScript(relPath, exportName) {
    const filePath = path.resolve(__dirname, '..', '..', relPath);
    const source = fs.readFileSync(filePath, 'utf8');
    const context = { self: {}, window: {}, globalThis: {} };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: relPath });
    return context.self[exportName] || context.window[exportName] || context.globalThis[exportName];
}

describe('Message router module', () => {
    test('normalizes protocol command to legacy type and dispatches', () => {
        const protocol = loadScript('src/shared/protocolV3.js', 'MLCProtocolV3');
        const routerModule = loadScript(
            'src/background/runtime/messageRouter.js',
            'MLCMessageRouter'
        );
        const calls = [];
        const router = routerModule.createRuntimeMessageRouter({ protocol });
        router.register('GET_CHAT', (message) => {
            calls.push(message.type);
            return { response: { ok: true } };
        });

        const result = router.handle({
            protocolVersion: 3,
            command: 'CHAT_OPEN',
            chatId: 'chat_1',
        });
        expect(result.handled).toBe(true);
        expect(result.response).toEqual({ ok: true });
        expect(calls).toEqual(['GET_CHAT']);
    });

    test('rejects unsupported protocol version', () => {
        const protocol = loadScript('src/shared/protocolV3.js', 'MLCProtocolV3');
        const routerModule = loadScript(
            'src/background/runtime/messageRouter.js',
            'MLCMessageRouter'
        );
        const router = routerModule.createRuntimeMessageRouter({ protocol });
        const result = router.handle({ protocolVersion: 2, type: 'GET_CHAT' });
        expect(result.handled).toBe(true);
        expect(result.response.ok).toBe(false);
        expect(result.response.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
    });

    test('rejects unknown protocol command payloads', () => {
        const protocol = loadScript('src/shared/protocolV3.js', 'MLCProtocolV3');
        const routerModule = loadScript(
            'src/background/runtime/messageRouter.js',
            'MLCMessageRouter'
        );
        const router = routerModule.createRuntimeMessageRouter({ protocol });
        const result = router.handle({ protocolVersion: 3, type: 'UNMAPPED_TYPE' });
        expect(result.handled).toBe(true);
        expect(result.response.ok).toBe(false);
        expect(result.response.code).toBe('UNKNOWN_COMMAND');
    });
});
