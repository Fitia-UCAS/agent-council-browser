function normalizeProviderKey(provider) {
    return String(provider || '').trim().toLowerCase();
}

const PROVIDER_METADATA = {
    chatgpt: {
        label: 'ChatGPT',
        openUrl: 'https://chatgpt.com/',
        expectedHosts: ['chatgpt.com', 'chat.openai.com', 'openai.com', 'platform.openai.com'],
        urlPatterns: [
            '*://chat.openai.com/*',
            '*://chatgpt.com/*',
            '*://openai.com/chatgpt*',
            '*://platform.openai.com/*'
        ]
    },
    gemini: {
        label: 'Gemini',
        openUrl: 'https://gemini.google.com/',
        expectedHosts: ['gemini.google.com'],
        urlPatterns: ['*://gemini.google.com/*']
    },
    claude: {
        label: 'Claude',
        openUrl: 'https://claude.ai/new',
        expectedHosts: ['claude.ai'],
        urlPatterns: ['*://claude.ai/*', '*://*.claude.ai/*']
    },
    grok: {
        label: 'Grok',
        openUrl: 'https://grok.com/',
        expectedHosts: ['grok.com'],
        urlPatterns: ['*://grok.com/*', '*://*.grok.com/*']
    }
};

const PROVIDER_CAPABILITIES = {
    chatgpt: {
        attachments: {
            mode: 'auto'
        }
    },
    gemini: {
        // Gemini currently blocks reliable programmatic uploads from extension content scripts:
        // - No discoverable <input type="file"> in light DOM / open shadow roots
        // - Synthetic drag/drop events are ignored (event.isTrusted === false)
        // Fall back to sending text-only (no programmatic upload).
        attachments: {
            mode: 'manual'
        }
    },
    claude: {
        // Claude (claude.ai) exposes a real <input type="file"> in the composer.
        // We attempt programmatic upload via DataTransfer -> input.files + change/input events.
        attachments: {
            mode: 'auto'
        }
    },
    grok: {
        // Grok (grok.com) attachment automation is best-effort. If UI automation fails, we fall back to text-only.
        attachments: {
            mode: 'auto'
        }
    }
};

function getSupportedProviderKeys() {
    const capabilities = PROVIDER_CAPABILITIES && typeof PROVIDER_CAPABILITIES === 'object'
        ? Object.keys(PROVIDER_CAPABILITIES)
        : [];
    const normalized = capabilities.map(normalizeProviderKey).filter(Boolean);
    return [...new Set(normalized)];
}

function isSupportedProviderKey(provider) {
    const key = normalizeProviderKey(provider);
    if (!key) return false;
    return getSupportedProviderKeys().includes(key);
}
