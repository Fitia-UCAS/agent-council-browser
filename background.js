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

// Follow-up template loaded from config/promp.json
let followUpTemplate =
    'I also asked {otherLLM} the same question. Here is their answer:\n{otherAnswer}\n\nPlease review both responses and enhance yours if necessary or confirm when they agree.';

async function loadFollowUpTemplate() {
    try {
        const resp = await fetch(chrome.runtime.getURL('config/promp.json'));
        const data = await resp.json();
        if (data && data.followUpTemplate) {
            followUpTemplate = data.followUpTemplate;
            console.log('[MLC Config] Loaded follow-up template from config');
        }
    } catch (err) {
        console.warn('[MLC Config] Failed to load template, using default:', err);
    }
}

loadFollowUpTemplate();

function buildFollowUpPrompt(otherLLM, answerText) {
    return followUpTemplate
        .replace('{otherLLM}', otherLLM)
        .replace('{otherAnswer}', answerText);
}

// FOLLOW-UP STATE FOR AUTO PROMPT V2
const defaultFollowUpState = {
    originalPrompt: null,
    originalSourceLLM: null, // 'chatgpt' | 'gemini'
    originalChatGPTTabId: null,
    originalGeminiTabId: null,
    geminiResponseContentForFollowUp: null,
    geminiResponseScraped: false,
    chatGPTResponseContentForFollowUp: null,
    chatGPTResponseScraped: false,
    promptTimestamp: 0, // Track when the prompt was sent
    promptId: null, // Unique ID for this prompt-response cycle
    waitingForResponse: false // Flag to track when we're waiting for a response
};
let activeFollowUpState = { ...defaultFollowUpState };

function resetFollowUpState() {
    activeFollowUpState = { ...defaultFollowUpState };
    console.log('[MLC FollowUp] Follow-up state reset.');
}

// Generate a unique ID for each prompt-response cycle
function generatePromptId() {
    return 'prompt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
            handleForwardPrompt(message, sender);
            sendResponse({ status: 'forward_received', type: message.type });
            break;
        case 'GEMINI_RESPONSE_CAPTURED':
            handleGeminiResponse(message);
            sendResponse({ status: 'gemini_response_received', type: message.type });
            break;
        case 'CHATGPT_RESPONSE_CAPTURED':
            handleChatGPTResponse(message);
            sendResponse({ status: 'chatgpt_response_received', type: message.type });
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

function handleForwardPrompt(message, sender) {
    const { from, prompt } = message;
    console.log('[MLC Background] Processing FORWARD_PROMPT:', { from, prompt: `"${prompt.substring(0,50)}..."` });
    if (!prompt) {
        console.warn('[MLC Background] Forward prompt is empty, aborting.');
        return;
    }

    let targetLLM = null;
    if (from === 'chatgpt') {
        targetLLM = 'gemini';
        // Initialise follow-up state – we only need to trigger when origin is ChatGPT
        resetFollowUpState();

        // Generate a unique prompt ID and store timestamp
        const promptId = generatePromptId();
        const timestamp = Date.now();

        // Set up the follow-up state with more tracking info
        activeFollowUpState.originalPrompt = prompt;
        activeFollowUpState.originalSourceLLM = 'chatgpt';
        activeFollowUpState.originalChatGPTTabId = sender?.tab?.id || null;
        activeFollowUpState.promptTimestamp = timestamp;
        activeFollowUpState.promptId = promptId;
        activeFollowUpState.waitingForResponse = true;

        console.log('[MLC FollowUp] Initialized follow-up tracking:', activeFollowUpState);

        // Send a message to the Gemini tab to notify it of the new prompt
        chrome.tabs.query({ url: "*://gemini.google.com/*" }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const geminiTab = tabs[0];
                try {
                    chrome.tabs.sendMessage(geminiTab.id, { 
                        type: 'NEW_PROMPT_SENT',
                        promptId,
                        timestamp,
                        prompt: prompt.substring(0, 100) // Send a snippet for debugging
                    });
                    console.log(`[MLC FollowUp] Notified Gemini tab ${geminiTab.id} of new prompt`);
                } catch (err) {
                    console.error('[MLC FollowUp] Error notifying Gemini tab:', err);
                }
            }
        });
    } else if (from === 'gemini') {
        targetLLM = 'chatgpt';

        resetFollowUpState();

        const promptId = generatePromptId();
        const timestamp = Date.now();

        activeFollowUpState.originalPrompt = prompt;
        activeFollowUpState.originalSourceLLM = 'gemini';
        activeFollowUpState.originalGeminiTabId = sender?.tab?.id || null;
        activeFollowUpState.promptTimestamp = timestamp;
        activeFollowUpState.promptId = promptId;
        activeFollowUpState.waitingForResponse = true;

        chrome.tabs.query({ url: ["*://chat.openai.com/*", "*://chatgpt.com/*"] }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const chatgptTab = tabs[0];
                try {
                    chrome.tabs.sendMessage(chatgptTab.id, {
                        type: 'NEW_PROMPT_SENT',
                        promptId,
                        timestamp,
                        prompt: prompt.substring(0, 100)
                    });
                    console.log(`[MLC FollowUp] Notified ChatGPT tab ${chatgptTab.id} of new prompt`);
                } catch (err) {
                    console.error('[MLC FollowUp] Error notifying ChatGPT tab:', err);
                }
            }
        });
    }

    if (targetLLM) {
        console.log(`[MLC Background] Forwarding from ${from} to ${targetLLM}.`);
        processLLM(targetLLM, prompt);
    } else {
        console.error('[MLC Background] Unknown "from" field for FORWARD_PROMPT:', from);
    }
}

function handleGeminiResponse(message) {
    console.log('[MLC FollowUp] Gemini response received:', {
        content: message.content ? message.content.substring(0, 50) + '...' : 'None',
        promptId: message.promptId,
        responseDelay: message.responseDelay,
        waitingState: activeFollowUpState.waitingForResponse,
        currentPromptId: activeFollowUpState.promptId
    });
    
    // TEMPORARILY DISABLE STRICT VALIDATION
    // Our validation may be too strict and blocking valid responses
    
    // Check if the response has content
    if (!message.content || message.content.trim().length === 0) {
        console.log('[MLC FollowUp] Received empty Gemini response, ignoring.');
        return;
    }
    
    console.log(`[MLC FollowUp] Valid Gemini response received, accepting for follow-up.`);
    activeFollowUpState.geminiResponseContentForFollowUp = message.content;
    activeFollowUpState.geminiResponseScraped = true;
    activeFollowUpState.waitingForResponse = false;
    
    console.log('[MLC FollowUp] Stored Gemini response, attempting trigger.');
    triggerFollowUpIfReady();
}

function handleChatGPTResponse(message) {
    console.log('[MLC FollowUp] ChatGPT response received:', {
        content: message.content ? message.content.substring(0, 50) + '...' : 'None',
        promptId: message.promptId,
        waitingState: activeFollowUpState.waitingForResponse,
        currentPromptId: activeFollowUpState.promptId
    });

    if (!message.content || message.content.trim().length === 0) {
        console.log('[MLC FollowUp] Received empty ChatGPT response, ignoring.');
        return;
    }

    activeFollowUpState.chatGPTResponseContentForFollowUp = message.content;
    activeFollowUpState.chatGPTResponseScraped = true;
    activeFollowUpState.waitingForResponse = false;

    console.log('[MLC FollowUp] Stored ChatGPT response, attempting trigger.');
    triggerFollowUpIfReady();
}

function triggerFollowUpIfReady() {
    if (
        activeFollowUpState.originalSourceLLM === 'chatgpt' &&
        activeFollowUpState.geminiResponseScraped &&
        activeFollowUpState.geminiResponseContentForFollowUp &&
        activeFollowUpState.originalChatGPTTabId
    ) {
        console.log('[MLC FollowUp] Conditions met, injecting follow-up prompt to ChatGPT.');
        const followUpPromptText = buildFollowUpPrompt('Gemini', activeFollowUpState.geminiResponseContentForFollowUp);
        injectFollowUpIntoChatGPT(activeFollowUpState.originalChatGPTTabId, followUpPromptText);
        resetFollowUpState();
    } else if (
        activeFollowUpState.originalSourceLLM === 'gemini' &&
        activeFollowUpState.chatGPTResponseScraped &&
        activeFollowUpState.chatGPTResponseContentForFollowUp &&
        activeFollowUpState.originalGeminiTabId
    ) {
        console.log('[MLC FollowUp] Conditions met, injecting follow-up prompt to Gemini.');
        const followUpPromptText = buildFollowUpPrompt('ChatGPT', activeFollowUpState.chatGPTResponseContentForFollowUp);
        injectFollowUpIntoGemini(activeFollowUpState.originalGeminiTabId, followUpPromptText);
        resetFollowUpState();
    } else {
        console.log('[MLC FollowUp] Not ready for follow-up yet.', activeFollowUpState);
    }
}

async function injectFollowUpIntoChatGPT(tabId, promptText) {
    try {
        console.log(`[MLC FollowUp] Injecting follow-up into ChatGPT tab ${tabId}.`);
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: simpleInteraction_InjectOnly,
            args: [promptText, 'chatgpt']
        });
        if (results && results[0] && results[0].result && results[0].result.success) {
            console.log('[MLC FollowUp] Follow-up prompt injected successfully.');
        } else {
            console.error('[MLC FollowUp] Failed to inject follow-up prompt.', results);
        }
    } catch (error) {
        console.error('[MLC FollowUp] Error during follow-up injection:', error);
    }
}

async function injectFollowUpIntoGemini(tabId, promptText) {
    try {
        console.log(`[MLC FollowUp] Injecting follow-up into Gemini tab ${tabId}.`);
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: simpleInteraction_InjectOnly,
            args: [promptText, 'gemini']
        });
        if (results && results[0] && results[0].result && results[0].result.success) {
            console.log('[MLC FollowUp] Follow-up prompt injected successfully into Gemini.');
        } else {
            console.error('[MLC FollowUp] Failed to inject follow-up prompt into Gemini.', results);
        }
    } catch (error) {
        console.error('[MLC FollowUp] Error during follow-up injection into Gemini:', error);
    }
}

// Inject-only variant: sets text but does NOT send.
function simpleInteraction_InjectOnly(prompt, llmType) {
    console.log(`[SimpleInteraction_InjectOnly INJECTED] (${llmType}) attempting to set prompt length ${prompt.length}.`);
    try {
        const inputSelectors = {
            chatgpt: [
                '#prompt-textarea',
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea'
            ],
            gemini: [
                'div.ql-editor[role="textbox"]',
                '.ql-editor.textarea',
                'div[contenteditable="true"]',
                'textarea[placeholder*="Enter a prompt"]',
                'textarea[placeholder*="Ask"]',
                'textarea'
            ]
        };
        const selectors = inputSelectors[llmType] || [];
        let inputEl = null;
        for (const sel of selectors) {
            inputEl = document.querySelector(sel);
            if (inputEl) break;
        }
        if (!inputEl) {
            console.error('[SimpleInteraction_InjectOnly INJECTED] No input element found.');
            return { success:false, error:'input_not_found' };
        }
        inputEl.focus();
        if (inputEl.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter ? setter.call(inputEl, prompt) : (inputEl.value = prompt);
            inputEl.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
        } else if (inputEl.isContentEditable || inputEl.contentEditable === 'true') {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, prompt);
            inputEl.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
        } else {
            inputEl.value = prompt;
            inputEl.dispatchEvent(new Event('input', { bubbles:true, composed:true }));
        }
        return { success:true };
    } catch(e) {
        console.error('[SimpleInteraction_InjectOnly INJECTED] Exception', e);
        return { success:false, error:e.message };
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
// ... (keep all other parts of background.js from the previous good version) ...
// ... (including onInstalled, sendMessageToPopup, onMessage, handleSendPrompt, handleForwardPrompt, processLLM, findLLMTab, injectAndExecute, checkConnectionStatus) ...

// THIS IS THE FUNCTION THAT GETS INJECTED AND EXECUTED IN THE TARGET PAGE
async function simpleInteraction(prompt, llmType) { // Added async here for the setTimeout
    console.log(`[SimpleInteraction INJECTED] Attempting on ${llmType} with prompt: "${prompt.substring(0, 50)}..."`);

    try {
        let inputElement = null;
        let sendButton = null;

        const inputSelectors = {
            chatgpt: [
                '#prompt-textarea',
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea[data-id="root"]',
                'textarea'
            ],
            gemini: [ // Gemini primarily uses a contenteditable div
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
            return { success: false, error: errMsg, details: { stage: 'find_input_selectors' } };
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
            return { success: false, error: errMsg, details: { stage: 'find_input_element' } };
        }
        console.log(`[SimpleInteraction INJECTED] Successfully found input for ${llmType}:`, inputElement);
        inputElement.focus(); // Focus the element first

        // --- Setting the prompt ---
        if (llmType === 'chatgpt' && inputElement.tagName === 'TEXTAREA') {
            console.log(`[SimpleInteraction INJECTED] Setting prompt for ChatGPT TEXTAREA`);
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            if (nativeInputValueSetter) {
                nativeInputValueSetter.call(inputElement, prompt);
            } else {
                inputElement.value = prompt;
            }
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            inputElement.dispatchEvent(new KeyboardEvent('keydown',  { key: ' ', keyCode: 32, bubbles: true, composed: true }));
            inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', keyCode: 32, bubbles: true, composed: true }));
            console.log(`[SimpleInteraction INJECTED] Dispatched events for ChatGPT TEXTAREA.`);

        } else if ((llmType === 'gemini' && (inputElement.isContentEditable || inputElement.contentEditable === 'true')) ||
                   (inputElement.isContentEditable || inputElement.contentEditable === 'true')) { // General contentEditable case
            console.log(`[SimpleInteraction INJECTED] Setting prompt for contentEditable element (${llmType})`);
            document.execCommand('selectAll', false, null);
            const insertSuccess = document.execCommand('insertText', false, prompt);
            console.log(`[SimpleInteraction INJECTED] Used document.execCommand('insertText'). Success: ${insertSuccess}.`);
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true })); // Ensure input event fires for contentEditable too
        } else { // Fallback for other input types (e.g. Gemini using a textarea which is rare)
            console.log(`[SimpleInteraction INJECTED] Setting prompt for standard input/textarea element (${llmType})`);
            inputElement.value = prompt;
            inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }

        // Verification Step
        await new Promise(resolve => setTimeout(resolve, 50));
        const currentText = (inputElement.isContentEditable || inputElement.contentEditable === 'true') ? inputElement.textContent : inputElement.value;
        console.log(`[SimpleInteraction INJECTED] Text in input field for ${llmType} after setting: "${currentText.substring(0,100)}..."`);
        if (!currentText.includes(prompt.substring(0, Math.min(prompt.length, 50)))) {
            console.warn(`[SimpleInteraction INJECTED] WARNING: Prompt may not have been set correctly for ${llmType}. Expected start: "${prompt.substring(0,50)}...", Got: "${currentText.substring(0,50)}..."`);
        }


        // --- Find and click send button ---
        const buttonSelectors = {
             chatgpt: [
                'button[data-testid="send-button"]',
                'button[data-testid="fruitjuice-send-button"]',
                'button[aria-label="Send message" i]',
                'form button[type="submit"]',
                'button[class*="bottom"] span[data-state="closed"]',
                'button:has(svg > path[d*="M7 11L12 6L17 11M12 18V7"])'
            ],
            gemini: [ // Gemini send button selectors
                'button[aria-label="Send message"]',      // Primary target for Gemini
                'button[data-testid="send-button"]',      // If available
                'button.send-button',                     // If class is used
                'button:has(svg[aria-label="Send message"])', // Button containing the send SVG
                'button.send-button-container button'     // A common pattern in Gemini
            ],
            generic: [
                'button[type="submit"]',
                'button[aria-label*="Send" i]',
                'button:has(svg)',
            ]
        };
        
        const currentButtonSelectors = buttonSelectors[llmType] ? 
                                       [...buttonSelectors[llmType], ...buttonSelectors.generic] : 
                                       buttonSelectors.generic;

        for (const selector of currentButtonSelectors) {
            const buttons = document.querySelectorAll(selector);
            for (const btn of buttons) {
                const style = window.getComputedStyle(btn);
                if (btn && !btn.disabled && btn.offsetParent !== null && 
                    style.display !== 'none' && style.visibility !== 'hidden' && 
                    btn.offsetHeight > 0 && btn.offsetWidth > 0) {
                    sendButton = btn;
                    console.log(`[SimpleInteraction INJECTED] Found send button for ${llmType} with: ${selector}`, sendButton);
                    break;
                }
            }
            if (sendButton) break;
        }
        
        if (!sendButton) {
            console.warn(`[SimpleInteraction INJECTED] No send button found for ${llmType} via selectors. Attempting Enter key on input.`);
            inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true }));
            console.log(`[SimpleInteraction INJECTED] Dispatched Enter keydown to input for ${llmType}.`);
            return { success: true, method: `enter_key_fallback_on_input_for_${llmType}`, details: { stage: 'send_enter_fallback' } };
        }
        
        console.log(`[SimpleInteraction INJECTED] Clicking send button for ${llmType}:`, sendButton);
        sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
        sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, cancelable: true }));
        sendButton.click();
        
        return { success: true, method: `button_click_for_${llmType}`, details: { stage: 'send_button_click' } };
        
    } catch (error) {
        const errMsg = `[SimpleInteraction INJECTED] Error during interaction with ${llmType}: ${error.message} (Stack: ${error.stack})`;
        console.error(errMsg, error);
        return { success: false, error: errMsg, details: { stage: 'main_catch_block', errorMessage: error.message } };
    }
}
// ... (rest of background.js like checkConnectionStatus) ...


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