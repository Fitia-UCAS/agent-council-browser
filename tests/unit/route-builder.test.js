import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadRouteBuilder() {
    const filePath = path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'sidepanel',
        'features',
        'routeBuilder.js'
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const context = {
        self: {},
        window: {},
        globalThis: {},
        crypto: { randomUUID: () => 'uuid-fixed' },
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'routeBuilder.js' });
    return (
        context.self.MLCRouteBuilder ||
        context.window.MLCRouteBuilder ||
        context.globalThis.MLCRouteBuilder
    );
}

describe('Route builder module', () => {
    test('downgrades debate route with one agent to single', () => {
        const api = loadRouteBuilder();
        const route = api.sanitizeRoute({
            kind: 'debate',
            agents: [{ id: 'a1', provider: 'chatgpt', profileId: 'default' }],
            rounds: 3,
        });
        expect(route.kind).toBe('single');
        expect(route.agents).toHaveLength(1);
    });

    test('single route required providers returns first provider only', () => {
        const api = loadRouteBuilder();
        const route = {
            kind: 'single',
            agents: [
                { id: 'a1', provider: 'chatgpt', profileId: 'default' },
                { id: 'a2', provider: 'gemini', profileId: 'default' },
            ],
        };
        expect(api.getRouteRequiredProviders(route)).toEqual(['chatgpt']);
    });

    test('debate summary includes rounds', () => {
        const api = loadRouteBuilder();
        const summary = api.formatRouteSummary({
            kind: 'debate',
            rounds: 4,
            agents: [
                { id: 'a1', provider: 'chatgpt', profileId: 'default' },
                { id: 'a2', provider: 'gemini', profileId: 'default' },
            ],
        });
        expect(summary).toContain('Debate');
        expect(summary).toContain('4');
    });
});
