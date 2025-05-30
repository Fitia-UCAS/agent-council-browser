/**
 * Multi-LLM Coder Extension - Background Service Worker
 * Handles communication with LLM websites and tab management
 */

// Extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('[MLC Background] Multi-LLM Coder extension installed/updated.');
});

// Safe message sending function
function sendMessageToPopup(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            if (chrome.runtime.lastError) {
                // console.log('[MLC Background] No popup to receive message:', message.type, chrome.runtime.lastError.message);
            }
        });
    } catch (error) {
        console.error('[MLC Background] Failed to send message to popup:', message.type, error);
    }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[MLC Background] Received message:', message);
    
    switch (message.type) {
        case 'SEND_PROMPT':
            handleSendPrompt(message);
            sendResponse({ status: 'received', type: message.type });
            break;
        case 'FORWARD_PROMPT':
            handleForwardPrompt(message);
            sendResponse({ status: 'forward_received', type: message.type });
            break;
        case 'CHECK_CONNECTION':
            checkConnectionStatus().then(status => {
                sendResponse({ 
                    type: 'CONNECTION_STATUS',
                    status: status 
                });
            });
            return true; // Keep message channel open for async response
        default:
            console.warn('[MLC Background] Unknown message type:', message.type);
            sendResponse({ status: 'unknown_message_type' });
            break;
    }
    
    return false; // Don't keep message channel open unless returning true for async
});

async function handleSendPrompt(message) {
    const { prompt, targets } = message;
    
    console.log('[MLC Background] Processing SEND_PROMPT:', { prompt: `"${prompt.substring(0,50)}..."`, targets });
    
    if (targets.gemini) {
        await processLLM('gemini', prompt);
    }
    
    if (targets.chatgpt) {
        await processLLM('chatgpt', prompt);
    }
}

function handleForwardPrompt(message) {
    const { from, prompt } = message;
    console.log('[MLC Background] Processing FORWARD_PROMPT:', { from, prompt: `"${prompt.substring(0,50)}..."` });
    if (!prompt) {
        console.warn('[MLC Background] Forward prompt is empty, aborting.');
        return;
    }

    let targetLLM = null;
    if (from === 'chatgpt') {
        targetLLM = 'gemini';
    } else if (from === 'gemini') {
        targetLLM = 'chatgpt';
    }

    if (targetLLM) {
        console.log(`[MLC Background] Forwarding from ${from} to ${targetLLM}.`);
        processLLM(targetLLM, prompt);
    } else {
        console.error('[MLC Background] Unknown "from" field for FORWARD_PROMPT:', from);
    }
}

async function processLLM(llmType, prompt) {
    try {
        console.log(`[MLC Background] processLLM for ${llmType} with prompt: "${prompt.substring(0, 50)}..."`);
        
        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Finding tab...' });
        const tab = await findLLMTab(llmType);
        
        if (!tab) {
            throw new Error(`${llmType} tab not found. Please open ${llmType} in a tab and ensure you're logged in.`);
        }
        console.log(`[MLC Background] Found ${llmType} tab: ID ${tab.id}, URL ${tab.url}`);
        
        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Injecting script...' });
        await injectAndExecute(tab.id, llmType, prompt);
        
    } catch (error) {
        console.error(`[MLC Background] Error processing ${llmType}:`, error.message, error.stack);
        sendMessageToPopup({ type: 'LLM_ERROR', llm: llmType, error: error.message });
    }
}

async function findLLMTab(llmType) {
    // ... (keep existing findLLMTab logic, it seems reasonable) ...
    // Add a log at the end of findLLMTab before returning:
    // console.log(`[MLC Background] findLLMTab for ${llmType} selected:`, selectedTab ? {id: selectedTab.id, url: selectedTab.url, title: selectedTab.title} : 'None');
    // return selectedTab;
    const urlPatterns = {
        gemini: ['*://gemini.google.com/*'],
        chatgpt: [
            '*://chat.openai.com/*', 
            '*://chatgpt.com/*',
            '*://openai.com/chatgpt*',
            '*://platform.openai.com/*'
        ]
    };
    
    const patterns = urlPatterns[llmType];
    if (!patterns) {
        throw new Error(`[MLC Background] Unknown LLM type for findLLMTab: ${llmType}`);
    }
    
    try {
        let allTabs = [];
        for (const pattern of patterns) {
            const tabs = await chrome.tabs.query({ url: pattern, status: 'complete' });
            allTabs = allTabs.concat(tabs);
        }
        
        if (allTabs.length === 0) {
            const allTabsQuery = await chrome.tabs.query({ status: 'complete' });
            const titleMatches = allTabsQuery.filter(tab => {
                const title = tab.title?.toLowerCase() || '';
                const url = tab.url?.toLowerCase() || '';
                const llmName = llmType.toLowerCase();
                return title.includes(llmName) || url.includes(llmName) || (llmName === 'chatgpt' && (title.includes('openai') || url.includes('openai')));
            });
            allTabs = titleMatches;
        }
        
        const selectedTab = allTabs.find(tab => tab.active && tab.windowId === chrome.windows.WINDOW_ID_CURRENT) || // Prefer active in current window
                            allTabs.find(tab => tab.active) || // Prefer any active
                            allTabs[0]; // Fallback to first found
        
        console.log(`[MLC Background] findLLMTab for ${llmType} selected:`, selectedTab ? {id: selectedTab.id, url: selectedTab.url, title: selectedTab.title} : 'None');
        return selectedTab;
        
    } catch (error) {
        console.error(`[MLC Background] Error in findLLMTab for ${llmType}:`, error);
        return null;
    }
}

async function injectAndExecute(tabId, llmType, prompt) {
    try {
        console.log(`[MLC Background] Injecting simpleInteraction into Tab ID ${tabId} for ${llmType}.`);
        
        sendMessageToPopup({ type: 'LLM_PROGRESS', llm: llmType, status: 'Sending prompt...' });
        
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: simpleInteraction, // This function is defined below
            args: [prompt, llmType]
        });
        
        console.log(`[MLC Background] Injection results for ${llmType} (Tab ID: ${tabId}):`, JSON.stringify(results, null, 2));
        
        if (results && results[0] && results[0].result) {
            const result = results[0].result;
            if (result.success) {
                console.log(`[MLC Background] simpleInteraction SUCCEEDED for ${llmType}: ${result.method}`);
                sendMessageToPopup({
                    type: 'LLM_RESPONSE',
                    llm: llmType,
                    content: `Prompt sent successfully to ${llmType} via ${result.method}.` // Response content is simple for now
                });
            } else {
                console.error(`[MLC Background] simpleInteraction FAILED for ${llmType}:`, result.error);
                throw new Error(result.error || `Unknown error in simpleInteraction for ${llmType}`);
            }
        } else {
            const noResultError = `No result or unexpected result structure from injection for ${llmType}.`;
            console.error(`[MLC Background] ${noResultError} Results:`, results);
            throw new Error(noResultError);
        }
        
    } catch (error) {
        console.error(`[MLC Background] Error injecting script for ${llmType} into Tab ID ${tabId}:`, error.message, error.stack);
        // Rethrow to be caught by processLLM
        throw new Error(`Failed to interact with ${llmType}: ${error.message}`);
    }
}

// This function is injected and executed in the context of the target LLM's page
function simpleInteraction(prompt, llmType) {
    console.log(`[SimpleInteraction INJECTED] Attempting on ${llmType} with prompt: "${prompt.substring(0, 50)}..."`);

    try {
        let inputElement = null;
        let sendButton = null;

        const inputSelectors = {
            chatgpt: [
                '#prompt-textarea', // Primary target
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea[data-id="root"]',
                'textarea' 
            ],
            gemini: [ // Gemini uses a contenteditable div
                'div.ql-editor[role="textbox"]',        // Specific Gemini input
                '.ql-editor.textarea',                  // Another common pattern
                'div[contenteditable="true"][aria-label*="prompt"]',
                'textarea[placeholder*="Enter a prompt"]', // Fallback if textarea is ever used
                'textarea[placeholder*="Ask"]',
                '[contenteditable="true"]' // General fallback
            ]
        };

        const currentInputSelectors = inputSelectors[llmType];
        if (!currentInputSelectors) {
            const errMsg = `[SimpleInteraction INJECTED] Unknown llmType for input selectors: ${llmType}`;
            console.error(errMsg);
            return { success: false, error: errMsg };
        }

        for (const selector of currentInputSelectors) {
            inputElement = document.querySelector(selector);
            if (inputElement) {
                console.log(`[SimpleInteraction INJECTED] Found input for ${llmType} with: ${selector}`, inputElement);
                break;
            }
        }

        if (!inputElement) {
            const errMsg = `[SimpleInteraction INJECTED] No input element found for ${llmType} after trying all selectors.`;
            console.error(errMsg);
            return { success: false, error: `No input element found for ${llmType}` };
        }
        console.log(`[SimpleInteraction INJECTED] Successfully found input for ${llmType}:`, inputElement);

        // Set the prompt
        if (inputElement.isContentEditable || inputElement.contentEditable === 'true') {
            console.log(`[SimpleInteraction INJECTED] Setting prompt for contentEditable element (${llmType})`);
            inputElement.focus(); // Focus first
            document.execCommand('selectAll', false, null); // Select all existing content
            document.execCommand('insertText', false, prompt); // Replace with new prompt
            // inputElement.textContent = prompt; // Simpler, but insertText might trigger more events
        } else if (inputElement.tagName === 'TEXTAREA') {
            console.log(`[SimpleInteraction INJECTED] Setting prompt for TEXTAREA (${llmType})`);
            inputElement.focus(); // Focus first
             // More robust way to set value for framework-controlled textarea
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
                 nativeInputValueSetter.call(inputElement, prompt);
            } else { // Fallback if descriptor not found (less likely)
                inputElement.value = prompt;
            }
        } else { // General input fields
            console.log(`[SimpleInteraction INJECTED] Setting prompt for standard input element (${llmType})`);
            inputElement.focus(); // Focus first
            inputElement.value = prompt;
        }

        // Trigger events to make the site recognize the change
        console.log(`[SimpleInteraction INJECTED] Dispatching input and change events for ${llmType}`);
        inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        // For some frameworks, a keydown event might be needed to update internal state for height adjustment, etc.
        inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }));
        inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, composed: true }));


        console.log(`[SimpleInteraction INJECTED] Prompt set for ${llmType}. Current value/textContent:`, inputElement.value || inputElement.textContent);

        // Find send button
        const buttonSelectors = {
             chatgpt: [
                'button[data-testid="send-button"]',
                'button[data-testid="fruitjuice-send-button"]',
                'button[aria-label*="Send message" i]', // Case insensitive aria-label
                'form button[type="submit"]',
                // More specific selector for the button with the paper plane icon
                'button[class*="bottom"] span[data-state]' // ChatGPT's typical send button structure if no testid
            ],
            gemini: [
                'button[aria-label="Send message"]',
                'button[data-testid="send-button"]',
                'button.send-button', // if class exists
                // Gemini often has a button with an SVG directly inside it
                'button:has(svg[aria-label="Send message"])'
            ],
            generic: [
                'button[type="submit"]',
                'button[aria-label*="Send" i]',
                'button:has(svg)',
                'button:last-of-type' // Risky
            ]
        };
        
        const currentButtonSelectors = buttonSelectors[llmType] ? 
                                       [...buttonSelectors[llmType], ...buttonSelectors.generic] : 
                                       buttonSelectors.generic;

        for (const selector of currentButtonSelectors) {
            const buttons = document.querySelectorAll(selector);
            for (const btn of buttons) {
                const style = window.getComputedStyle(btn);
                if (btn && !btn.disabled && btn.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden') {
                    sendButton = btn;
                    console.log(`[SimpleInteraction INJECTED] Found send button for ${llmType} with: ${selector}`, sendButton);
                    break;
                }
            }
            if (sendButton) break;
        }
        
        if (!sendButton) {
            console.warn(`[SimpleInteraction INJECTED] No send button found for ${llmType} via selectors. Attempting Enter key on input.`);
            // Simulate Enter key press on the input element
            inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
            // Some apps might need keyup as well
            // inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
            console.log(`[SimpleInteraction INJECTED] Dispatched Enter keydown to input for ${llmType}.`);
            return { success: true, method: `enter_key_fallback_on_input_for_${llmType}` };
        }
        
        console.log(`[SimpleInteraction INJECTED] Clicking send button for ${llmType}:`, sendButton);
        // Robust click
        sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
        sendButton.click();
        
        // The dev branch already had a post-click Enter key dispatch.
        // This can be useful if the click doesn't always register the submission.
        // However, it might also cause double sends if the click *and* Enter both work.
        // Let's make it a slightly delayed optional reinforcement.
        setTimeout(() => {
            console.log(`[SimpleInteraction INJECTED] (Reinforcement) Dispatching Enter to input for ${llmType} after button click.`);
            inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));
        }, 150);

        return { success: true, method: `button_click_for_${llmType}` };
        
    } catch (error) {
        const errMsg = `[SimpleInteraction INJECTED] Error during interaction with ${llmType}: ${error.message}`;
        console.error(errMsg, error.stack);
        return { success: false, error: errMsg };
    }
}


async function checkConnectionStatus() {
    // ... (keep existing checkConnectionStatus logic) ...
    // Add a log at the end:
    // console.log('[MLC Background] Final connection status:', status);
    // return status;
    const status = {
        gemini: false,
        chatgpt: false
    };
    
    try {
        const allTabs = await chrome.tabs.query({});
        
        const geminiTabs = allTabs.filter(tab => tab.url && tab.url.includes('gemini.google.com'));
        status.gemini = geminiTabs.length > 0;
        
        const chatgptKeywords = ['chat.openai.com', 'chatgpt.com'];
        const chatgptTabs = allTabs.filter(tab => tab.url && chatgptKeywords.some(keyword => tab.url.includes(keyword)));
        status.chatgpt = chatgptTabs.length > 0;

    } catch (error) {
        console.error('[MLC Background] Error checking connection status:', error);
    }
    
    console.log('[MLC Background] Final connection status:', status);
    return status;
}