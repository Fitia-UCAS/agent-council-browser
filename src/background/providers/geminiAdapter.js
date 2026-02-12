(function geminiAdapterModule(globalScope) {
    'use strict';

    const adapter = {
        id: 'gemini',
        label: 'Gemini',
        openUrl: 'https://gemini.google.com/',
        attachmentMode: 'manual',
        expectedHosts: ['gemini.google.com'],
        async sendPrompt(context, prompt, options = {}) {
            if (typeof context?.sendPrompt !== 'function') {
                throw new Error('Gemini adapter requires sendPrompt(context) implementation.');
            }
            return context.sendPrompt('gemini', prompt, options);
        },
    };

    const registry = globalScope.MLCProviderAdapters || {};
    registry.gemini = adapter;
    globalScope.MLCProviderAdapters = registry;
})(typeof self !== 'undefined' ? self : window);
