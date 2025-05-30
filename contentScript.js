(function() {
    const host = location.hostname;
    const isChatGPT = host.includes('openai.com') || host.includes('chatgpt.com');
    const isGemini = host.includes('gemini.google.com');
    if (!isChatGPT && !isGemini) return;

    let forwardEnabled = false;
    const forwardTo = isChatGPT ? 'gemini' : 'chatgpt';
    const currentLLM = isChatGPT ? 'chatgpt' : 'gemini';

    console.log(`[MLC ContentScript] Initializing for ${currentLLM}. Forwarding to ${forwardTo}.`);

    function findInput() {
        const selectors = isChatGPT ? [
            '#prompt-textarea',
            'textarea[data-testid="prompt-textarea"]',
            'textarea[placeholder*="Message"]',
            'textarea',
            '[contenteditable="true"]'
        ] : [ 
            'div.ql-editor[role="textbox"]', 
            '.ql-editor.textarea',
            'div[contenteditable="true"][aria-label*="prompt"]', 
            'textarea[placeholder*="Enter a prompt"]',
            'textarea[placeholder*="Ask"]',
            'textarea',
            '[contenteditable="true"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                // console.log(`[MLC ContentScript - ${currentLLM}] Found input with selector:`, sel, el);
                return el;
            }
        }
        console.error(`[MLC ContentScript - ${currentLLM}] Input element NOT found.`);
        return null;
    }

    function findSendButton() {
        const selectors = isChatGPT ? [
            'button[data-testid="send-button"]',
            'button[data-testid="fruitjuice-send-button"]',
            'button[aria-label="Send message"]', // More specific
            'form button[type="submit"]'
        ] : [ 
            'button[aria-label="Send message"]', 
            'button[data-testid="send-button"]', 
            'button.send-button' 
        ];
        
        const genericSelectors = [
            'button[aria-label*="Send"]', // General send
            'button[type="submit"]',
            'button:has(svg[class*="send"])', // Button with a send-like SVG
            'button:has(span[class*="send"])', // Button with a send-like SPAN
            // 'button:last-of-type' // Too risky, remove for now
        ];

        const allSelectors = [...selectors, ...genericSelectors];

        for (const sel of allSelectors) {
            const btns = document.querySelectorAll(sel);
            for (const btn of btns) {
                const style = window.getComputedStyle(btn);
                if (
                    btn &&
                    btn.id !== 'mlc-forward-toggle' && 
                    !btn.disabled &&
                    btn.offsetParent !== null &&      
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (btn.offsetHeight > 0 && btn.offsetWidth > 0) // Check if actually visible
                ) {
                    // console.log(`[MLC ContentScript - ${currentLLM}] Found send button with selector:`, sel, btn);
                    return btn;
                }
            }
        }
        console.warn(`[MLC ContentScript - ${currentLLM}] Send button NOT found (might rely on Enter key).`);
        return null;
    }

    function getPromptText(inputElement) {
        if (!inputElement) return '';
        if (inputElement.isContentEditable || inputElement.contentEditable === 'true') {
            return inputElement.innerText || inputElement.textContent || '';
        }
        return inputElement.value || '';
    }

    function attachListeners() {
        const input = findInput();
        const sendBtn = findSendButton();

        if (input && !input.dataset.mlcForwardKey) {
            input.addEventListener('keydown', evt => {
                if (!evt.isTrusted) return; 
                if (evt.key === 'Enter' && !evt.shiftKey && !evt.metaKey && !evt.ctrlKey) {
                    if (forwardEnabled) {
                        const currentInput = findInput(); 
                        const prompt = getPromptText(currentInput).trim();
                        console.log(`[MLC ContentScript - ${currentLLM}] Enter detected, forwardEnabled. Prompt: "${prompt.substring(0,50)}..."`);
                        if (prompt) {
                            chrome.runtime.sendMessage({
                                type: 'FORWARD_PROMPT',
                                from: currentLLM,
                                prompt
                            });
                        }
                    }
                }
            });
            input.dataset.mlcForwardKey = 'true';
            // console.log(`[MLC ContentScript - ${currentLLM}] Keydown listener attached to input.`);
        }

        if (sendBtn && !sendBtn.dataset.mlcForwardClick) {
            sendBtn.addEventListener('click', (evt) => {
                if (!sendBtn.contains(evt.target) && evt.target !== sendBtn) return;
                if (!forwardEnabled) return;
                if (evt.target.id === 'mlc-forward-toggle') return;

                const srcInput = findInput(); 
                const prompt = getPromptText(srcInput).trim();
                console.log(`[MLC ContentScript - ${currentLLM}] Send button clicked, forwardEnabled. Prompt: "${prompt.substring(0,50)}..."`);
                if (prompt) {
                    chrome.runtime.sendMessage({
                        type: 'FORWARD_PROMPT',
                        from: currentLLM,
                        prompt
                    });
                }
            }, true); 
            sendBtn.dataset.mlcForwardClick = 'true';
            // console.log(`[MLC ContentScript - ${currentLLM}] Click listener attached to send button.`);
        }
    }

    function addToggleButton() {
        const existingButton = document.getElementById('mlc-forward-toggle');
        if (existingButton && existingButton.dataset.mlcManaged === 'true') {
            // If new button exists, just update its style based on forwardEnabled
            existingButton.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
            existingButton.style.borderColor = forwardEnabled ? '#4CAF50' : '#555';
            return;
        } else if (existingButton) {
            // If an old button (not marked as mlcManaged) exists, remove it
            console.log(`[MLC ContentScript - ${currentLLM}] Removing old (unmanaged) toggle button.`);
            existingButton.remove();
        }

        let parentElement = null;
        const inputEl = findInput();
        const sendBtnEl = findSendButton();

        if (isChatGPT) {
            // ChatGPT: Try to place it near the send button or within its container.
            // The send button is usually inside a div, which is a sibling of the textarea's parent div, or part of a larger form structure.
            if (sendBtnEl) {
                parentElement = sendBtnEl.parentElement; // Direct parent of send button
                // If send button's parent is a flex container, good.
                // Or find a more specific container for buttons.
                const buttonContainer = sendBtnEl.closest('div[class*="stretch"] > div[class*="flex"], div[class*="absolute"] > div[class*="flex"]'); // Common pattern for button groups in CPT
                if (buttonContainer) {
                    parentElement = buttonContainer;
                } else if (parentElement && parentElement.tagName === 'FORM') { 
                    // If parent is form, try to find a div inside it that holds buttons
                    const formButtonDiv = parentElement.querySelector('div > button[data-testid*="send"]')?.parentElement;
                    if (formButtonDiv) parentElement = formButtonDiv;
                }
            }
            if (!parentElement && inputEl) { // Fallback to input area if send button area not ideal
                 parentElement = inputEl.parentElement; // Parent of textarea
                 if (parentElement && parentElement.parentElement && parentElement.parentElement.querySelector('button[data-testid*="send"]')) {
                    // If the grandparent of textarea also contains the send button, this might be a better container
                    parentElement = parentElement.parentElement;
                 }
            }
        } else { // Gemini
            let geminiInputContainer = inputEl?.closest('.input-area-container, .composer-collapsed-view, .input-container, .input-area, .input-row');
            if (geminiInputContainer) {
                // Gemini often has a specific div for actions/buttons within the input area
                parentElement = geminiInputContainer.querySelector('div[class*="actions"], div[style*="display: flex"], .button-row') || geminiInputContainer;
            } else if (inputEl) {
                parentElement = inputEl.parentElement;
            }
        }
        
        if (!parentElement) {
            parentElement = document.querySelector('form') || inputEl?.closest('form');
            if (!parentElement) {
                parentElement = document.body; // Absolute last resort
                console.warn(`[MLC ContentScript - ${currentLLM}] Could not find specific parent for toggle button, using fallback: ${parentElement.tagName}`);
            }
        }

        const btn = document.createElement('button');
        btn.id = 'mlc-forward-toggle';
        btn.dataset.mlcManaged = 'true'; // Mark as new, managed button
        btn.type = 'button';
        btn.textContent = isChatGPT ? `⇄ Gemini` : `⇄ ChatGPT`;
        
        // Consistent styling
        btn.style.marginLeft = '8px';
        btn.style.marginRight = '8px';
        btn.style.padding = '6px 10px';
        btn.style.fontSize = '12px';
        btn.style.border = '1px solid #555';
        btn.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
        btn.style.borderColor = forwardEnabled ? '#4CAF50' : '#555';
        btn.style.color = '#e0e0e0';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.zIndex = '10000'; 
        btn.style.whiteSpace = 'nowrap'; // Prevent text wrapping

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            forwardEnabled = !forwardEnabled;
            btn.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
            btn.style.borderColor = forwardEnabled ? '#4CAF50' : '#555';
            console.log(`[MLC ContentScript - ${currentLLM}] Forwarding to ${forwardTo} ${forwardEnabled ? 'ENABLED' : 'DISABLED'}.`);
        });

        // Insertion logic: Try to insert before the native send button if possible and sensible
        if (sendBtnEl && parentElement && parentElement.contains(sendBtnEl) && parentElement !== sendBtnEl) {
            // If the parentElement contains the send button, insert our button before the send button
            parentElement.insertBefore(btn, sendBtnEl);
        } else if (parentElement) {
            // Otherwise, append to the determined parent element
            parentElement.appendChild(btn);
        } else {
            console.error(`[MLC ContentScript - ${currentLLM}] Final parentElement is null, cannot add button.`);
            return; // Exit if no parent to append to
        }
        
        console.log(`[MLC ContentScript - ${currentLLM}] Toggle button added/updated. Parent:`, parentElement);
    }

    const observer = new MutationObserver((mutationsList, observer) => {
        let relevantChange = false;
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
                if (changedNodes.some(node => node.nodeType === Node.ELEMENT_NODE && (
                    (currentLLM === 'chatgpt' && (node.id === 'prompt-textarea' || node.querySelector('#prompt-textarea') || node.matches('button[data-testid*="send"]'))) ||
                    (currentLLM === 'gemini' && (node.matches?.('div.ql-editor[role="textbox"]') || node.querySelector('div.ql-editor[role="textbox"]') || node.matches('button[aria-label="Send message"]'))) ||
                    node.matches('textarea, button, form, div[contenteditable="true"]') || // General catch-all
                    (node.querySelector && node.querySelector('textarea, button, form, div[contenteditable="true"]'))
                ))) {
                    relevantChange = true;
                    break;
                }
            }
            if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE && 
                (mutation.target.id === 'prompt-textarea' || mutation.target.matches?.('button') || mutation.target.matches?.('div.ql-editor'))) {
                relevantChange = true;
            }
        }

        if (relevantChange) {
            // console.log(`[MLC ContentScript - ${currentLLM}] DOM changed, re-evaluating elements.`);
            addToggleButton(); 
            attachListeners(); 
        }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    setTimeout(() => {
        // console.log(`[MLC ContentScript - ${currentLLM}] Delayed initial setup.`);
        addToggleButton();
        attachListeners();
    }, 2500); // Slightly increased delay

})();