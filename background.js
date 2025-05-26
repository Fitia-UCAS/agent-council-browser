/**
 * Multi-LLM Coder Extension - Background Service Worker
 * Handles communication with LLM websites and tab management
 */

// Extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('Multi-LLM Coder extension installed');
});

// Safe message sending function
async function sendMessageToPopup(message) {
    try {
        // Try to send message using the standard API
        chrome.runtime.sendMessage(message);
    } catch (error) {
        // If it fails, it means no popup is listening
        console.log('No popup to receive message:', message.type);
    }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);
    
    switch (message.type) {
        case 'SEND_PROMPT':
            handleSendPrompt(message);
            sendResponse({ status: 'received' });
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
            sendResponse({ status: 'unknown_message_type' });
            break;
    }
    
    return false; // Don't keep message channel open
});

async function handleSendPrompt(message) {
    const { prompt, targets } = message;
    
    console.log('Processing prompt:', prompt);
    console.log('Targets:', targets);
    
    // Process each target
    if (targets.gemini) {
        await processLLM('gemini', prompt);
    }
    
    if (targets.chatgpt) {
        await processLLM('chatgpt', prompt);
    }
}

async function processLLM(llmType, prompt) {
    try {
        console.log(`Processing ${llmType} with prompt:`, prompt);
        
        // Send progress update
        sendMessageToPopup({
            type: 'LLM_PROGRESS',
            llm: llmType,
            status: 'Finding tab...'
        });
        
        // Find the appropriate tab
        const tab = await findLLMTab(llmType);
        
        if (!tab) {
            throw new Error(`${llmType} tab not found. Please open ${llmType} in a tab and make sure you're logged in.`);
        }
        
        console.log(`Found ${llmType} tab:`, tab.id);
        
        // Send progress update
        sendMessageToPopup({
            type: 'LLM_PROGRESS',
            llm: llmType,
            status: 'Injecting script...'
        });
        
        // Inject and execute the interaction script
        await injectAndExecute(tab.id, llmType, prompt);
        
    } catch (error) {
        console.error(`Error processing ${llmType}:`, error);
        
        sendMessageToPopup({
            type: 'LLM_ERROR',
            llm: llmType,
            error: error.message
        });
    }
}

async function findLLMTab(llmType) {
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
        throw new Error(`Unknown LLM type: ${llmType}`);
    }
    
    try {
        let allTabs = [];
        
        // Check all patterns for this LLM type
        for (const pattern of patterns) {
            console.log(`Checking pattern: ${pattern}`);
            const tabs = await chrome.tabs.query({
                url: pattern,
                status: 'complete'
            });
            console.log(`Pattern ${pattern} found ${tabs.length} tabs`);
            allTabs = allTabs.concat(tabs);
        }
        
        console.log(`Found ${allTabs.length} ${llmType} tabs total`);
        
        if (allTabs.length === 0) {
            // Try to find any tab with the LLM name in the title
            const allTabsQuery = await chrome.tabs.query({});
            console.log(`🔍 Searching through ${allTabsQuery.length} total tabs for ${llmType}`);
            
            const titleMatches = allTabsQuery.filter(tab => {
                const title = tab.title?.toLowerCase() || '';
                const url = tab.url?.toLowerCase() || '';
                if (llmType === 'gemini') {
                    return title.includes('gemini') || url.includes('gemini');
                } else if (llmType === 'chatgpt') {
                    return title.includes('chatgpt') || title.includes('openai') || 
                           url.includes('chatgpt') || url.includes('openai');
                }
                return false;
            });
            console.log(`Found ${titleMatches.length} tabs by title/URL matching for ${llmType}:`);
            titleMatches.forEach(tab => {
                console.log(`  - ${tab.title} | ${tab.url}`);
            });
            allTabs = titleMatches;
        }
        
        // Return the first active tab, or just the first tab
        const selectedTab = allTabs.find(tab => tab.active) || allTabs[0];
        if (selectedTab) {
            console.log(`✅ Selected ${llmType} tab: ${selectedTab.title} | ${selectedTab.url}`);
        } else {
            console.log(`❌ No ${llmType} tab found`);
        }
        return selectedTab;
        
    } catch (error) {
        console.error(`Error finding ${llmType} tab:`, error);
        return null;
    }
}

async function injectAndExecute(tabId, llmType, prompt) {
    try {
        console.log(`Injecting simple interaction for ${llmType}`);
        
        // Send progress update
        sendMessageToPopup({
            type: 'LLM_PROGRESS',
            llm: llmType,
            status: 'Sending prompt...'
        });
        
        // Simple injection that just fills and sends
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: simpleInteraction,
            args: [prompt, llmType]
        });
        
        console.log(`Injection results for ${llmType}:`, results);
        
        if (results && results[0] && results[0].result) {
            const result = results[0].result;
            if (result.success) {
                sendMessageToPopup({
                    type: 'LLM_RESPONSE',
                    llm: llmType,
                    content: `Prompt sent successfully to ${llmType} using ${result.method}`
                });
            } else {
                throw new Error(result.error || 'Unknown error');
            }
        } else {
            throw new Error('No result returned from injection');
        }
        
    } catch (error) {
        console.error(`Error injecting script for ${llmType}:`, error);
        throw new Error(`Failed to interact with ${llmType}: ${error.message}`);
    }
}

// Simplified interaction function
function simpleInteraction(prompt, llmType) {
    console.log(`Simple interaction with ${llmType}:`, prompt);
    
    try {
        let inputElement = null;
        let sendButton = null;
        
        // Find input element with multiple strategies
        const inputSelectors = {
            chatgpt: [
                '#prompt-textarea',
                'textarea[placeholder*="Message"]',
                'textarea[data-id="root"]',
                'textarea',
                '[contenteditable="true"]'
            ],
            gemini: [
                'textarea[placeholder*="Enter a prompt"]',
                'textarea[placeholder*="Ask"]',
                'textarea',
                '[contenteditable="true"]'
            ]
        };
        
        const selectors = inputSelectors[llmType] || inputSelectors.chatgpt;
        
        for (const selector of selectors) {
            try {
                inputElement = document.querySelector(selector);
                if (inputElement) {
                    console.log(`Found input with: ${selector}`);
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!inputElement) {
            return { success: false, error: 'No input element found' };
        }
        
        // Set the prompt
        if (inputElement.contentEditable === 'true') {
            inputElement.innerHTML = prompt;
            inputElement.textContent = prompt;
        } else {
            inputElement.value = prompt;
        }
        
        // Trigger events
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        inputElement.dispatchEvent(new Event('change', { bubbles: true }));
        inputElement.focus();
        
        // Find send button
        const buttonSelectors = [
            'button[data-testid*="send"]',
            'button[aria-label*="Send"]',
            'button[type="submit"]',
            'button:has(svg)',
            'button:last-of-type'
        ];
        
        for (const selector of buttonSelectors) {
            try {
                const buttons = document.querySelectorAll(selector);
                for (const btn of buttons) {
                    if (btn && !btn.disabled && btn.offsetParent !== null) {
                        sendButton = btn;
                        console.log(`Found send button with: ${selector}`);
                        break;
                    }
                }
                if (sendButton) break;
            } catch (e) {
                continue;
            }
        }
        
        if (!sendButton) {
            // Try Enter key as fallback
            inputElement.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                bubbles: true
            }));
            return { success: true, method: 'enter_key' };
        }
        
        // Click send button
        sendButton.click();
        return { success: true, method: 'button_click' };
        
    } catch (error) {
        console.error('Error in simpleInteraction:', error);
        return { success: false, error: error.message };
    }
}

async function checkConnectionStatus() {
    const status = {
        gemini: false,
        chatgpt: false
    };
    
    try {
        // Debug: List all tabs to see what's actually open
        const allTabs = await chrome.tabs.query({});
        console.log('🔍 All open tabs:');
        allTabs.forEach(tab => {
            console.log(`  - ${tab.title} | ${tab.url}`);
        });
        
        // Check for Gemini tabs
        const geminiTabs = await chrome.tabs.query({
            url: '*://gemini.google.com/*',
            status: 'complete'
        });
        console.log('Gemini tabs found:', geminiTabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })));
        status.gemini = geminiTabs.length > 0;
        
        // Check for ChatGPT tabs
        const chatgptTabs = await chrome.tabs.query({
            url: '*://chat.openai.com/*',
            status: 'complete'
        });
        console.log('ChatGPT tabs found:', chatgptTabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })));
        status.chatgpt = chatgptTabs.length > 0;
        
        // Also check for alternative ChatGPT URLs
        const chatgptAltTabs = await chrome.tabs.query({
            url: '*://chatgpt.com/*',
            status: 'complete'
        });
        console.log('ChatGPT alternative tabs found:', chatgptAltTabs.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })));
        if (chatgptAltTabs.length > 0) {
            status.chatgpt = true;
        }
        
        // Check by title/content if URL patterns don't work
        const chatgptByTitle = allTabs.filter(tab => {
            const title = tab.title?.toLowerCase() || '';
            const url = tab.url?.toLowerCase() || '';
            return title.includes('chatgpt') || title.includes('openai') || 
                   url.includes('chatgpt') || url.includes('openai');
        });
        console.log('ChatGPT tabs found by title/URL:', chatgptByTitle.map(tab => ({ id: tab.id, url: tab.url, title: tab.title })));
        if (chatgptByTitle.length > 0) {
            status.chatgpt = true;
        }
        
    } catch (error) {
        console.error('Error checking connection status:', error);
    }
    
    console.log('Final connection status:', status);
    
    return status;
}

// Periodic connection check - removed as it's not needed
// The popup will request status when it opens 