import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadRouteBinding() {
    const filePath = path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'sidepanel',
        'features',
        'routeBinding.js'
    );
    const source = fs.readFileSync(filePath, 'utf8');
    const context = {
        self: {},
        window: {},
        globalThis: {},
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'routeBinding.js' });
    return (
        context.self.MLCRouteBinding ||
        context.window.MLCRouteBinding ||
        context.globalThis.MLCRouteBinding
    );
}

describe('Route binding helper', () => {
    test('returns explicit target index for matching provider', () => {
        const api = loadRouteBinding();
        const index = api.pickRouteAgentIndexForNewTabBinding({
            provider: 'chatgpt',
            targetAgentId: 'a2',
            agents: [
                { id: 'a1', provider: 'chatgpt', profileId: 'default' },
                { id: 'a2', provider: 'chatgpt', profileId: null },
            ],
        });
        expect(index).toBe(1);
    });

    test('chooses latest unassigned slot before appending', () => {
        const api = loadRouteBinding();
        const index = api.pickRouteAgentIndexForNewTabBinding({
            provider: 'chatgpt',
            agents: [
                { id: 'a1', provider: 'chatgpt', profileId: 'default' },
                { id: 'a2', provider: 'chatgpt', profileId: null },
            ],
            defaultProfileId: 'profile_default',
            profilesById: {
                profile_default: {
                    profileId: 'profile_default',
                    provider: 'chatgpt',
                    tabId: 1,
                    status: 'ok',
                },
            },
            profileConnectionStatus: { profile_default: true },
        });
        expect(index).toBe(1);
    });

    test('treats unresolved default slot as bindable', () => {
        const api = loadRouteBinding();
        const index = api.pickRouteAgentIndexForNewTabBinding({
            provider: 'chatgpt',
            agents: [{ id: 'a1', provider: 'chatgpt', profileId: 'default' }],
            defaultProfileId: null,
            profilesById: {},
            profileConnectionStatus: {},
        });
        expect(index).toBe(0);
    });

    test('treats disconnected explicit profile as bindable', () => {
        const api = loadRouteBinding();
        const index = api.pickRouteAgentIndexForNewTabBinding({
            provider: 'chatgpt',
            agents: [{ id: 'a1', provider: 'chatgpt', profileId: 'profile_dead' }],
            defaultProfileId: 'profile_default',
            profilesById: {
                profile_default: {
                    profileId: 'profile_default',
                    provider: 'chatgpt',
                    tabId: 1,
                    status: 'ok',
                },
                profile_dead: {
                    profileId: 'profile_dead',
                    provider: 'chatgpt',
                    tabId: 2,
                    status: 'ok',
                },
            },
            profileConnectionStatus: {
                profile_default: true,
                profile_dead: false,
            },
        });
        expect(index).toBe(0);
    });

    test('returns -1 when no route slot needs repair', () => {
        const api = loadRouteBinding();
        const index = api.pickRouteAgentIndexForNewTabBinding({
            provider: 'chatgpt',
            agents: [{ id: 'a1', provider: 'chatgpt', profileId: 'default' }],
            defaultProfileId: 'profile_default',
            profilesById: {
                profile_default: {
                    profileId: 'profile_default',
                    provider: 'chatgpt',
                    tabId: 1,
                    status: 'ok',
                },
            },
            profileConnectionStatus: { profile_default: true },
        });
        expect(index).toBe(-1);
    });
});
