import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadProtocol() {
    const filePath = path.resolve(__dirname, '..', '..', 'src', 'shared', 'protocolV3.js');
    const source = fs.readFileSync(filePath, 'utf8');
    const context = { self: {}, window: {} };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'protocolV3.js' });
    return context.self.MLCProtocolV3 || context.window.MLCProtocolV3;
}

describe('MLC Protocol V3', () => {
    test('wraps legacy messages with protocol version and command', () => {
        const protocol = loadProtocol();
        const wrapped = protocol.withProtocolEnvelope({ type: 'START_RUN' });
        expect(wrapped.protocolVersion).toBe(3);
        expect(wrapped.command).toBe('RUN_START');
    });

    test('normalizes command-only messages into legacy type', () => {
        const protocol = loadProtocol();
        const normalized = protocol.normalizeInboundMessage({
            protocolVersion: 3,
            command: 'CHAT_OPEN',
            chatId: 'chat_1',
        });
        expect(normalized.ok).toBe(true);
        expect(normalized.message.type).toBe('GET_CHAT');
    });

    test('rejects unsupported protocol version', () => {
        const protocol = loadProtocol();
        const normalized = protocol.normalizeInboundMessage({
            protocolVersion: 2,
            type: 'GET_CHAT',
        });
        expect(normalized.ok).toBe(false);
        expect(normalized.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
    });
});
