(function chatgptAdapterModule(globalScope) {
    'use strict';

    const adapter = {
        id: 'chatgpt',
        label: 'ChatGPT',
        openUrl: 'https://chatgpt.com/',
        attachmentMode: 'auto',
        expectedHosts: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'platform.openai.com'],
        async sendPrompt(context, prompt, options = {}) {
            if (typeof context?.sendPrompt !== 'function') {
                throw new Error('ChatGPT adapter requires sendPrompt(context) implementation.');
            }
            return context.sendPrompt('chatgpt', prompt, options);
        },
    };

    const registry = globalScope.MLCProviderAdapters || {};
    registry.chatgpt = adapter;
    globalScope.MLCProviderAdapters = registry;
})(typeof self !== 'undefined' ? self : window);
