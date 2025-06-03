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

    if (isGemini) {
        /* ------------------------------------------------------------------
           Gemini response capture for Auto Follow-up
           ------------------------------------------------------------------ */
        function observeGeminiResponses() {
            console.log('[MLC GeminiCapture] Starting Gemini response capture...');
            
            // Simple approach: Target the most stable selector combinations
            // Based on recent Gemini UI structure
            const stopGeneratingSelector = 'button[aria-label*="Stop generating"], button[aria-label*="Stop respond"]';
            
            // Track response state
            let lastResponseText = '';
            let stableCounter = 0;
            let isCapturing = false;
            let captureComplete = false;
            let lastCaptureTime = 0;
            let lastMessageCount = 0; // Track message count to detect new responses
            let pendingPromptTimestamp = 0; // Track when the last prompt was sent
            let responseCaptureDelayMs = 2000; // Minimum delay after prompt before capturing
            let currentPromptId = null; // ID of the current prompt we're waiting for
            let lastIconState = null; // Track the last icon state to detect transitions
            let iconTransitionTimeout = null; // Timeout for icon state transitions

            // Listen for messages from background script about new prompts
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.type === 'NEW_PROMPT_SENT') {
                    console.log(`[MLC GeminiCapture] Received notification of new prompt sent: ${message.promptId}`);

                    // Store the prompt ID and timestamp
                    currentPromptId = message.promptId;
                    pendingPromptTimestamp = message.timestamp;

                    // Reset capture state
                    captureComplete = false;
                    isCapturing = false;
                    stableCounter = 0;
                    lastResponseText = '';

                    // Reset message count after a short delay to allow the prompt to appear in the UI
                    setTimeout(() => {
                        lastMessageCount = countMessages();
                        console.log(`[MLC GeminiCapture] Updated message count to ${lastMessageCount} after prompt notification`);
                    }, 500);

                    if (sendResponse) sendResponse({ received: true });
                }
                return true; // Keep the message channel open for async response
            });

            // Check message count to detect if a new response has been added
            function countMessages() {
                const allMessages = document.querySelectorAll('[data-message-id], .conversation-turn, .message-container');
                return allMessages.length;
            }

            // Initialize by counting current messages
            setTimeout(() => {
                lastMessageCount = countMessages();
                console.log(`[MLC GeminiCapture] Initial message count: ${lastMessageCount}`);
            }, 1000);

            // Listen for our own prompt being sent to Gemini
            if (findInput() && findSendButton()) {
                const input = findInput();
                const sendBtn = findSendButton();

                // Monitor send button clicks to detect when our prompt is sent
                if (sendBtn) {
                    sendBtn.addEventListener('click', () => {
                        pendingPromptTimestamp = Date.now();
                        console.log(`[MLC GeminiCapture] Prompt sent at ${pendingPromptTimestamp}, waiting for response...`);
                        // Reset capture state
                        isCapturing = false;
                        captureComplete = false;
                        stableCounter = 0;
                        lastResponseText = '';
                    }, true);
                }

                // Also monitor Enter key in the input field
                if (input) {
                    input.addEventListener('keydown', evt => {
                        if (evt.key === 'Enter' && !evt.shiftKey) {
                            pendingPromptTimestamp = Date.now();
                            console.log(`[MLC GeminiCapture] Prompt sent via Enter key at ${pendingPromptTimestamp}, waiting for response...`);
                            // Reset capture state
                            isCapturing = false;
                            captureComplete = false;
                            stableCounter = 0;
                            lastResponseText = '';
                        }
                    });
                }
            }

            // Function to check if we can capture now
            function canCapture() {
                // Don't capture too frequently
                const now = Date.now();

                // If we haven't seen a prompt sent recently, don't capture
                if (pendingPromptTimestamp === 0) {
                    console.log('[MLC GeminiCapture] No pending prompt detected yet');
                    return false;
                }

                // Don't capture until a minimum delay after the prompt was sent
                if (now - pendingPromptTimestamp < responseCaptureDelayMs) {
                    console.log(`[MLC GeminiCapture] Too soon after prompt (${now - pendingPromptTimestamp}ms), waiting...`);
                    return false;
                }

                // Check if the message count has increased since our prompt was sent
                const currentMessageCount = countMessages();
                if (currentMessageCount <= lastMessageCount) {
                    console.log(`[MLC GeminiCapture] No new messages detected (${currentMessageCount} ≤ ${lastMessageCount})`);
                    return false;
                }

                // Update our tracking of message count
                lastMessageCount = currentMessageCount;

                // Don't capture if we've captured too recently
                if (now - lastCaptureTime < 5000) {
                    console.log('[MLC GeminiCapture] Too soon after last capture');
                    return false;
                }

                console.log('[MLC GeminiCapture] Can capture now: prompt sent and new message detected');
                return true;
            }
            
            // Function to get current icon state
            function getCurrentIconState() {
                const micIcon = document.querySelector('mat-icon[fonticon="mic"]');
                const sendIcon = document.querySelector('mat-icon[fonticon="send"]:not(.hidden)');
                const stopIcon = document.querySelector('mat-icon[fonticon="stop"]');
                
                if (stopIcon) return 'stop';
                if (micIcon) return 'mic';
                if (sendIcon) return 'send';
                return 'unknown';
            }
            
            // Function to check if response is complete using font icon state with transition detection
            function isResponseComplete() {
                // NEW APPROACH: Check the font icon state to determine Gemini's status
                // mic = empty input / ready for new input (response complete)
                // send = text typed but not sent
                // stop = currently generating response
                
                const currentIconState = getCurrentIconState();
                
                console.log('[MLC GeminiCapture] Icon state transition:', {
                    previous: lastIconState,
                    current: currentIconState,
                    timestamp: Date.now()
                });
                
                // Detect transition from 'stop' to 'mic' - this indicates response completion
                if (lastIconState === 'stop' && currentIconState === 'mic') {
                    console.log('[MLC GeminiCapture] Detected stop->mic transition - response completion detected!');
                    
                    // Clear any existing timeout
                    if (iconTransitionTimeout) {
                        clearTimeout(iconTransitionTimeout);
                    }
                    
                    // Wait 500ms as suggested to ensure stability before capturing
                    iconTransitionTimeout = setTimeout(() => {
                        console.log('[MLC GeminiCapture] Icon transition stabilized after 500ms, response should be complete');
                        // Don't call captureAndSendResponse directly to avoid recursion
                        // Instead, capture the response directly here
                        if (!captureComplete) {
                            const responseText = getResponseText();
                            if (responseText) {
                                console.log('[MLC GeminiCapture] Capturing response after stop->mic transition');
                                chrome.runtime.sendMessage({
                                    type: 'GEMINI_RESPONSE_CAPTURED',
                                    content: responseText,
                                    promptId: currentPromptId,
                                    timestamp: Date.now(),
                                    responseDelay: pendingPromptTimestamp ? (Date.now() - pendingPromptTimestamp) : null
                                }, response => {
                                    if (chrome.runtime.lastError) {
                                        console.error('[MLC GeminiCapture] Error sending transition-based capture:', chrome.runtime.lastError);
                                    } else {
                                        console.log('[MLC GeminiCapture] Transition-based capture sent successfully:', response);
                                        captureComplete = true;
                                        currentPromptId = null;
                                        lastCaptureTime = Date.now();
                                    }
                                });
                            }
                        }
                    }, 500);
                    
                    lastIconState = currentIconState;
                    return false; // Don't capture immediately, wait for timeout
                }
                
                // Update last icon state for next comparison
                if (currentIconState !== lastIconState) {
                    console.log(`[MLC GeminiCapture] Icon state changed: ${lastIconState} -> ${currentIconState}`);
                    lastIconState = currentIconState;
                }
                
                // If stop icon is visible, Gemini is still generating
                if (currentIconState === 'stop') {
                    console.log('[MLC GeminiCapture] Still generating - stop icon visible');
                    return false;
                }
                
                // If mic icon is visible and we have a pending prompt, response is likely complete
                if (currentIconState === 'mic' && pendingPromptTimestamp > 0) {
                    console.log('[MLC GeminiCapture] Response complete - mic icon visible (ready state)');
                    return true;
                }
                
                // If only send icon is visible, user has typed but not sent yet
                if (currentIconState === 'send') {
                    console.log('[MLC GeminiCapture] User has typed but not sent - send icon visible');
                    return false;
                }
                
                // Fallback to original method if icons are not found or unclear
                const stopButton = document.querySelector(stopGeneratingSelector);
                if (stopButton) {
                    console.log('[MLC GeminiCapture] Still generating - fallback stop button found');
                    return false;
                }
                
                const inputField = document.querySelector('div.ql-editor[role="textbox"]');
                if (inputField && inputField.getAttribute('aria-disabled') === 'true') {
                    console.log('[MLC GeminiCapture] Still generating - fallback input field disabled');
                    return false;
                }
                
                // Only consider complete via fallback if we have a pending prompt
                if (pendingPromptTimestamp > 0) {
                    console.log('[MLC GeminiCapture] Response appears complete - fallback method');
                    return true;
                }
                
                console.log('[MLC GeminiCapture] No clear completion signal detected');
                return false;
            }
            
            // Function to extract response text using multiple strategies - ONLY the latest response
            function getResponseText() {
                console.log('[MLC GeminiCapture] Attempting to extract LATEST response text only...');

                // Strategy 1: Look for message elements with specific focus on the last/latest response
                const messages = document.querySelectorAll('[data-message-id], [data-message-author="gemini"], [data-testid="gemini-response"], div[role="region"][aria-label*="response"], .conversation-turn:not(.user)');
                if (messages.length > 0) {
                    console.log(`[MLC GeminiCapture] Found ${messages.length} message elements`);
                    // Get the last message which is the latest Gemini response
                    const lastMessage = messages[messages.length - 1];

                    // Check if this appears to be a Gemini response (not user message)
                    if (!lastMessage.classList.contains('user-message') &&
                        !lastMessage.hasAttribute('data-author-is-user')) {

                        // First, try to find markdown content within this message specifically
                        const markdownInMessage = lastMessage.querySelector('.markdown, .markdown-content, div[data-testid="markdown-content"]');
                        if (markdownInMessage) {
                            const markdownText = markdownInMessage.innerText || markdownInMessage.textContent;
                            if (markdownText && markdownText.trim()) {
                                console.log('[MLC GeminiCapture] Found latest message with markdown content');
                                return markdownText.trim();
                            }
                        }

                        // If no specific markdown container, use the whole message text
                        const text = lastMessage.innerText || lastMessage.textContent;
                        if (text && text.trim()) {
                            console.log('[MLC GeminiCapture] Found latest message text with strategy 1');
                            return text.trim();
                        }
                    }
                }

                // Strategy 2: Look for the last markdown content element (likely the latest response)
                const markdownElements = document.querySelectorAll('.markdown, .markdown-content, div[data-testid="markdown-content"]');
                if (markdownElements.length > 0) {
                    console.log(`[MLC GeminiCapture] Found ${markdownElements.length} markdown elements, focusing on last one`);

                    // Get only the last markdown element
                    const lastMarkdown = markdownElements[markdownElements.length - 1];

                    // Filter out user messages
                    const isUserMessage = lastMarkdown.closest('[data-author-is-user="true"], .user-message, .user-query');
                    if (!isUserMessage) {
                        const text = lastMarkdown.innerText || lastMarkdown.textContent;
                        if (text && text.trim()) {
                            console.log('[MLC GeminiCapture] Found latest message text with strategy 2');
                            return text.trim();
                        }
                    }
                }

                // Strategy 3: Look for conversation turns (message blocks) and get the last Gemini one
                const conversationTurns = document.querySelectorAll('.conversation-turn, .message-container, [data-message-container]');
                if (conversationTurns.length > 0) {
                    // Start from the end to find the last Gemini response
                    for (let i = conversationTurns.length - 1; i >= 0; i--) {
                        const turn = conversationTurns[i];

                        // Skip if it's a user message
                        if (turn.classList.contains('user-message') ||
                            turn.classList.contains('user-query') ||
                            turn.hasAttribute('data-author-is-user') ||
                            turn.querySelector('.user-message, .user-query')) {
                            continue;
                        }

                        // This is likely a Gemini response - get its text
                        const text = turn.innerText || turn.textContent;
                        if (text && text.trim()) {
                            console.log('[MLC GeminiCapture] Found latest message text with strategy 3');
                            return text.trim();
                        }
                    }
                }

                // Strategy 4: Find visual indicators of the latest response
                // Gemini often has a clear visual break between messages
                const responseIndicators = document.querySelectorAll('.response-block:last-child, .gemini-response:last-child, .model-response:last-child');
                if (responseIndicators.length > 0) {
                    const lastIndicator = responseIndicators[responseIndicators.length - 1];
                    const text = lastIndicator.innerText || lastIndicator.textContent;
                    if (text && text.trim()) {
                        console.log('[MLC GeminiCapture] Found latest message text with strategy 4');
                        return text.trim();
                    }
                }

                // Last resort - Look at the timestamp/date elements to identify the latest response
                const timeElements = document.querySelectorAll('time, [data-timestamp], .message-timestamp');
                if (timeElements.length > 0) {
                    let latestTime = 0;
                    let latestResponseElement = null;

                    for (let i = 0; i < timeElements.length; i++) {
                        const timeEl = timeElements[i];
                        // Try to get a timestamp from the element
                        const timestamp = timeEl.getAttribute('datetime') ||
                                          timeEl.getAttribute('data-timestamp') ||
                                          timeEl.textContent;

                        if (timestamp) {
                            const time = new Date(timestamp).getTime();
                            if (time > latestTime) {
                                latestTime = time;
                                // Get the parent message container
                                latestResponseElement = timeEl.closest('.message, .response, [data-message-id]');
                            }
                        }
                    }

                    if (latestResponseElement) {
                        // Verify it's not a user message
                        if (!latestResponseElement.classList.contains('user-message') &&
                            !latestResponseElement.hasAttribute('data-author-is-user')) {

                            const text = latestResponseElement.innerText || latestResponseElement.textContent;
                            if (text && text.trim()) {
                                console.log('[MLC GeminiCapture] Found latest message text with last resort timestamp strategy');
                                return text.trim();
                            }
                        }
                    }
                }

                console.log('[MLC GeminiCapture] No latest response text found');
                return '';
            }
            
            // Function to capture and send response
            function captureAndSendResponse() {
                // Debug logging to help understand the state
                console.log('[MLC GeminiCapture] captureAndSendResponse() called with state:', {
                    captureComplete,
                    pendingPromptTimestamp,
                    currentPromptId,
                    isCapturing,
                    stableCounter,
                    lastMessageCount,
                    lastResponseLength: lastResponseText ? lastResponseText.length : 0
                });

                // For debugging, send response regardless of canCapture() result
                // This helps us identify what's causing the issue
                const canCaptureResult = canCapture();
                if (captureComplete) {
                    console.log('[MLC GeminiCapture] Already completed capture for this prompt');
                    return;
                }

                // TEMPORARY FIX - Always allow capture for debugging
                // if (!canCaptureResult) return;

                // Check if response appears complete
                const isComplete = isResponseComplete();
                console.log('[MLC GeminiCapture] isResponseComplete() =', isComplete);

                if (!isComplete) {
                    console.log('[MLC GeminiCapture] Response not complete yet');
                    isCapturing = true;
                    return;
                }

                // Get the response text
                const responseText = getResponseText();
                console.log(`[MLC GeminiCapture] Got response text, length: ${responseText.length}`);

                // Empty response, nothing to send
                if (!responseText) {
                    console.log('[MLC GeminiCapture] Empty response text, not sending');
                    return;
                }

                // Check if response text is stable (hasn't changed in a few checks)
                if (responseText === lastResponseText) {
                    stableCounter++;
                    console.log(`[MLC GeminiCapture] Response text stable: ${stableCounter}/3`);
                } else {
                    stableCounter = 0;
                    lastResponseText = responseText;
                    console.log('[MLC GeminiCapture] Response text changed, resetting stability counter');
                }

                // If response is stable for 3 checks or more, consider it complete and send it
                // TEMPORARY CHANGE: Reduce from 3 to 1 for quicker testing
                if (stableCounter >= 1) {
                    console.log('[MLC GeminiCapture] Response appears stable, sending to background');

                    // Log the actual content we're sending (beginning)
                    console.log('[MLC GeminiCapture] Response content preview:', responseText.substring(0, 200));

                    chrome.runtime.sendMessage({
                        type: 'GEMINI_RESPONSE_CAPTURED',
                        content: responseText,
                        promptId: currentPromptId, // Include the prompt ID this response is for
                        timestamp: Date.now(),
                        responseDelay: pendingPromptTimestamp ? (Date.now() - pendingPromptTimestamp) : null
                    }, response => {
                        if (chrome.runtime.lastError) {
                            console.error('[MLC GeminiCapture] Error sending message:', chrome.runtime.lastError);
                        } else {
                            console.log('[MLC GeminiCapture] Message sent successfully:', response);
                            captureComplete = true;
                            // Reset the promptId as we've handled this prompt-response cycle
                            currentPromptId = null;
                        }
                    });
                    
                    // Reset for next capture
                    isCapturing = false;
                    lastCaptureTime = Date.now();
                    
                    // Stop checking for a while to avoid duplicate captures
                    setTimeout(() => {
                        captureComplete = false;
                    }, 10000);
                }
            }
            
            // Set up mutation observer to detect response changes
            const observer = new MutationObserver(() => {
                try {
                    // Only proceed if we're capturing or if response might be complete
                    if (isCapturing || isResponseComplete()) {
                        captureAndSendResponse();
                    }
                } catch (err) {
                    console.error('[MLC GeminiCapture] Observer error:', err);
                }
            });
            
            // Start observing the document
            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true
            });
            
            console.log('[MLC GeminiCapture] Response observer started');
            
            // Also check periodically in case mutation observer misses something
            const checkInterval = setInterval(() => {
                if (document.hidden) return; // Don't check if the tab is not visible
                
                try {
                    captureAndSendResponse();
                } catch (err) {
                    console.error('[MLC GeminiCapture] Interval check error:', err);
                }
            }, 2000);
            
            // Clean up when navigating away
            window.addEventListener('beforeunload', () => {
                clearInterval(checkInterval);
                observer.disconnect();
                console.log('[MLC GeminiCapture] Cleaned up observers');
            });
        }

        // Delay to let the page stabilize
        setTimeout(observeGeminiResponses, 3000);
    }

})();