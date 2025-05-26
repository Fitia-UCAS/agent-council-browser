(function() {
    const host = location.hostname;
    const isChatGPT = host.includes('openai.com') || host.includes('chatgpt.com');
    const isGemini = host.includes('gemini.google.com');
    if (!isChatGPT && !isGemini) return;

    let forwardEnabled = false;
    const forwardTo = isChatGPT ? 'gemini' : 'chatgpt';

    function findInput() {
        const selectors = isChatGPT ? [
            '#prompt-textarea',
            'textarea[placeholder*="Message"]',
            'textarea',
            '[contenteditable="true"]'
        ] : [
            'textarea[placeholder*="Enter a prompt"]',
            'textarea[placeholder*="Ask"]',
            'textarea',
            '[contenteditable="true"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function findSendButton() {
        const selectors = [
            'button[data-testid*="send"]',
            'button[aria-label*="Send"]',
            'button[type="submit"]',
            'button:has(svg)',
            'button:last-of-type'
        ];
        for (const sel of selectors) {
            const btns = document.querySelectorAll(sel);
            for (const btn of btns) {
                if (
                    btn &&
                    btn.id !== 'mlc-forward-toggle' &&
                    !btn.disabled &&
                    btn.offsetParent !== null
                ) {
                    return btn;
                }
            }
        }
        return null;
    }

    function attachListeners() {
        const input = findInput();
        const sendBtn = findSendButton();
        if (input && !input.dataset.mlcForwardKey) {
            input.addEventListener('keydown', evt => {
                if (!evt.isTrusted) return;
                if (evt.key === 'Enter' && !evt.shiftKey && forwardEnabled) {
                    const prompt = input.value || input.textContent || '';
                    chrome.runtime.sendMessage({
                        type: 'FORWARD_PROMPT',
                        from: isChatGPT ? 'chatgpt' : 'gemini',
                        prompt
                    });
                }
            });
            input.dataset.mlcForwardKey = 'true';
        }

        if (sendBtn && !sendBtn.dataset.mlcForwardClick) {
            sendBtn.addEventListener('click', () => {
                if (!forwardEnabled) return;
                const srcInput = findInput();
                const prompt = srcInput?.value || srcInput?.textContent || '';
                chrome.runtime.sendMessage({
                    type: 'FORWARD_PROMPT',
                    from: isChatGPT ? 'chatgpt' : 'gemini',
                    prompt
                });
            });
            sendBtn.dataset.mlcForwardClick = 'true';
        }
    }

    function addToggleButton() {
        if (document.getElementById('mlc-forward-toggle')) return;
        const input = findInput();
        if (!input || !input.parentElement) return;
        const btn = document.createElement('button');
        btn.id = 'mlc-forward-toggle';
        btn.type = 'button';
        btn.textContent = isChatGPT ? '⇄ Gemini' : '⇄ ChatGPT';
        btn.style.marginLeft = '4px';
        btn.style.cursor = 'pointer';
        btn.style.padding = '4px 6px';
        btn.style.fontSize = '12px';
        btn.style.border = '1px solid #666';
        btn.style.background = '#333';
        btn.style.color = '#fff';
        btn.style.borderRadius = '4px';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            forwardEnabled = !forwardEnabled;
            btn.style.background = forwardEnabled ? '#4caf50' : '#333';
        });
        input.parentElement.appendChild(btn);
    }

    const obs = new MutationObserver(() => {
        addToggleButton();
        attachListeners();
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Initial try
    addToggleButton();
    attachListeners();
})();
