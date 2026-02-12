(function claudeAdapterModule(globalScope) {
    'use strict';

    const adapter = {
        id: 'claude',
        label: 'Claude',
        openUrl: 'https://claude.ai/new',
        attachmentMode: 'auto',
        expectedHosts: ['claude.ai'],
        useDebuggerTransport: true,
        async sendPrompt(context, prompt, options = {}) {
            if (typeof context?.sendPrompt !== 'function') {
                throw new Error('Claude adapter requires sendPrompt(context) implementation.');
            }
            return context.sendPrompt('claude', prompt, options);
        },
    };

    const registry = globalScope.MLCProviderAdapters || {};
    registry.claude = adapter;
    globalScope.MLCProviderAdapters = registry;
})(typeof self !== 'undefined' ? self : window);
