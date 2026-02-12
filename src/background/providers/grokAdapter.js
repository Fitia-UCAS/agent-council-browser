(function grokAdapterModule(globalScope) {
    'use strict';

    const adapter = {
        id: 'grok',
        label: 'Grok',
        openUrl: 'https://grok.com/',
        attachmentMode: 'auto',
        expectedHosts: ['grok.com'],
        async sendPrompt(context, prompt, options = {}) {
            if (typeof context?.sendPrompt !== 'function') {
                throw new Error('Grok adapter requires sendPrompt(context) implementation.');
            }
            return context.sendPrompt('grok', prompt, options);
        },
    };

    const registry = globalScope.MLCProviderAdapters || {};
    registry.grok = adapter;
    globalScope.MLCProviderAdapters = registry;
})(typeof self !== 'undefined' ? self : window);
