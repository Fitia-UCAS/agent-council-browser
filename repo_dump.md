# Repository dump of chromeEX


---

### `SIMPLE_TEST.md`

md
# Simplified Extension Test Guide

## What Changed ✅

### Simplified Approach
- Removed complex response monitoring
- Focus on just sending prompts successfully
- Better selector fallback system
- Uses Enter key if send button not found

### New Selector Strategy
**ChatGPT:**
1. `#prompt-textarea`
2. `textarea[placeholder*="Message"]`
3. `textarea[data-id="root"]`
4. `textarea`
5. `[contenteditable="true"]`

**Gemini:**
1. `textarea[placeholder*="Enter a prompt"]`
2. `textarea[placeholder*="Ask"]`
3. `textarea`
4. `[contenteditable="true"]`

**Send Button (both):**
1. `button[data-testid*="send"]`
2. `button[aria-label*="Send"]`
3. `button[type="submit"]`
4. `button:has(svg)`
5. `button:last-of-type`
6. **Fallback:** Enter key

## Testing Steps

1. **Reload Extension** in Chrome
2. **Open ChatGPT and Gemini tabs**
3. **Open Extension Popup**
4. **Send Test Prompt:** "Hello, this is a test"
5. **Check Results:**
   - Extension should show "Prompt sent successfully"
   - Check ChatGPT/Gemini tabs to see if message appeared

## Expected Behavior

- ✅ Extension finds input field
- ✅ Types the prompt
- ✅ Either clicks send button OR presses Enter
- ✅ Shows success message
- ✅ Prompt appears in LLM interface

## Debug Info

To see what's happening:
1. Open ChatGPT/Gemini tab
2. Press F12 → Console
3. Send prompt from extension
4. Check console for messages like:
   - `"Found input with: textarea"`
   - `"Found send button with: button[aria-label*="Send"]"`

## If Still Not Working

The console will show exactly which selector worked or failed, making it easy to identify what needs to be updated.



---

### `popup.js`

js
/**
 * Multi-LLM Coder Extension - Popup JavaScript
 * Full-featured popup interface
 */

console.log('🚀 Popup loading...');

document.addEventListener('DOMContentLoaded', function() {
    console.log('✅ Popup DOM loaded');
    
    // Get DOM elements
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const charCount = document.getElementById('char-count');
    const useGemini = document.getElementById('use-gemini');
    const useChatGPT = document.getElementById('use-chatgpt');
    const geminiStatus = document.getElementById('gemini-status');
    const chatgptStatus = document.getElementById('chatgpt-status');
    const responseContent = document.getElementById('response-content');
    
    // Initialize
    init();
    
    function init() {
        console.log('🔧 Initializing popup...');
        
        // Set up event listeners
        setupEventListeners();
        
        // Update UI state
        updateCharCount();
        updateSendButtonState();
        
        // Check connection status
        checkConnectionStatus();
        
        console.log('✅ Popup initialized');
    }
    
    function setupEventListeners() {
        // Prompt input
        if (promptInput) {
            promptInput.addEventListener('input', handlePromptInput);
            promptInput.addEventListener('keydown', handleKeyDown);
        }
        
        // Send button
        if (sendButton) {
            sendButton.addEventListener('click', handleSendClick);
        }
        
        // Checkboxes
        if (useGemini) {
            useGemini.addEventListener('change', updateSendButtonState);
        }
        if (useChatGPT) {
            useChatGPT.addEventListener('change', updateSendButtonState);
        }
        
        // Listen for messages from background
        if (chrome && chrome.runtime) {
            chrome.runtime.onMessage.addListener(handleBackgroundMessage);
        }
    }
    
    function handlePromptInput() {
        updateCharCount();
        updateSendButtonState();
    }
    
    function handleKeyDown(event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            handleSendClick();
        }
    }
    
    function handleSendClick() {
        const prompt = promptInput?.value?.trim();
        const geminiSelected = useGemini?.checked;
        const chatgptSelected = useChatGPT?.checked;
        
        if (!prompt) {
            showMessage('Please enter a prompt', 'error');
            return;
        }
        
        if (!geminiSelected && !chatgptSelected) {
            showMessage('Please select at least one LLM', 'error');
            return;
        }
        
        console.log('📤 Sending prompt:', prompt);
        
        // Update UI
        sendButton.disabled = true;
        sendButton.textContent = 'Sending...';
        showMessage('Sending prompt to selected LLMs...', 'info');
        
        // Send to background script
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: prompt,
                targets: {
                    gemini: geminiSelected,
                    chatgpt: chatgptSelected
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error sending prompt:', chrome.runtime.lastError);
                    showMessage('Error sending prompt to background script', 'error');
                    resetSendButton();
                } else {
                    console.log('Prompt sent successfully:', response);
                }
            });
        }
        
        // Update status
        if (geminiSelected) updateLLMStatus('gemini', 'Sending...', 'processing');
        if (chatgptSelected) updateLLMStatus('chatgpt', 'Sending...', 'processing');
    }
    
    function handleBackgroundMessage(message, sender, sendResponse) {
        console.log('📨 Received message:', message);
        
        switch (message.type) {
            case 'LLM_RESPONSE':
                handleLLMResponse(message);
                sendResponse({ status: 'handled' });
                break;
            case 'LLM_ERROR':
                handleLLMError(message);
                sendResponse({ status: 'handled' });
                break;
            case 'CONNECTION_STATUS':
                handleConnectionStatus(message);
                sendResponse({ status: 'handled' });
                break;
            case 'LLM_PROGRESS':
                handleLLMProgress(message);
                sendResponse({ status: 'handled' });
                break;
            default:
                sendResponse({ status: 'unknown_message' });
                break;
        }
        
        return false; // Don't keep message channel open
    }
    
    function handleLLMResponse(message) {
        const { llm, content } = message;
        console.log(`✅ ${llm} response received`);
        
        // Update status
        updateLLMStatus(llm, 'Complete', 'ready');
        
        // Show response
        showMessage(`${llm} response received!`, 'success');
        showResponse(llm, content);
        
        // Reset send button
        resetSendButton();
    }
    
    function handleLLMError(message) {
        const { llm, error } = message;
        console.log(`❌ ${llm} error:`, error);
        
        // Update status
        updateLLMStatus(llm, 'Error', 'error');
        
        // Show error
        showMessage(`${llm} error: ${error}`, 'error');
        
        // Reset send button
        resetSendButton();
    }
    
    function handleConnectionStatus(message) {
        const { gemini, chatgpt } = message.status;
        console.log('🔗 Connection status:', message.status);
        
        updateLLMStatus('gemini', gemini ? 'Ready' : 'Not Connected', gemini ? 'ready' : 'error');
        updateLLMStatus('chatgpt', chatgpt ? 'Ready' : 'Not Connected', chatgpt ? 'ready' : 'error');
        
        // Update checkboxes
        if (useGemini) useGemini.disabled = !gemini;
        if (useChatGPT) useChatGPT.disabled = !chatgpt;
        
        updateSendButtonState();
    }
    
    function handleLLMProgress(message) {
        const { llm, status } = message;
        updateLLMStatus(llm, status, 'processing');
    }
    
    function checkConnectionStatus() {
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error checking connection:', chrome.runtime.lastError);
                } else {
                    console.log('Connection check response:', response);
                    // Handle the response directly
                    if (response && response.type === 'CONNECTION_STATUS') {
                        handleConnectionStatus(response);
                    }
                }
            });
        }
    }
    
    function updateLLMStatus(llm, status, type) {
        const statusElement = document.getElementById(`${llm}-status`);
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = `status-${type}`;
        }
    }
    
    function updateCharCount() {
        if (promptInput && charCount) {
            const count = promptInput.value.length;
            charCount.textContent = count;
        }
    }
    
    function updateSendButtonState() {
        if (sendButton && promptInput && useGemini && useChatGPT) {
            const hasPrompt = promptInput.value.trim().length > 0;
            const hasTarget = (useGemini.checked && !useGemini.disabled) || 
                            (useChatGPT.checked && !useChatGPT.disabled);
            
            sendButton.disabled = !hasPrompt || !hasTarget;
        }
    }
    
    function resetSendButton() {
        if (sendButton) {
            sendButton.disabled = false;
            sendButton.textContent = 'Send Prompt';
            updateSendButtonState();
        }
    }
    
    function showMessage(message, type) {
        console.log(`💬 ${type.toUpperCase()}: ${message}`);
        // You could add a toast notification here if desired
    }
    
    function showResponse(llm, content) {
        if (responseContent) {
            // Clean up the content for display
            const cleanContent = content.replace(/<[^>]*>/g, '').substring(0, 500);
            responseContent.innerHTML = `
                <strong>${llm} Response:</strong><br>
                ${cleanContent}${cleanContent.length >= 500 ? '...' : ''}
            `;
            responseContent.className = 'response-content';
        }
    }
});



---

### `sidepanel.js`

js
/**
 * Multi-LLM Coder Extension - Side Panel JavaScript
 * Handles UI interactions and communication with background script
 */

console.log('🚀 sidepanel.js loading...');

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('✅ Multi-LLM Coder Extension DOM loaded');
    console.log('🔗 Chrome runtime available:', !!chrome?.runtime);
    
    // Get DOM references
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const charCount = document.getElementById('char-count');
    const useGemini = document.getElementById('use-gemini');
    const useChatGPT = document.getElementById('use-chatgpt');
    const sendToChatGPT = document.getElementById('send-to-chatgpt');
    const sendToGemini = document.getElementById('send-to-gemini');
    
    console.log('📋 DOM elements found:', {
        promptInput: !!promptInput,
        sendButton: !!sendButton,
        charCount: !!charCount,
        useGemini: !!useGemini,
        useChatGPT: !!useChatGPT,
        sendToChatGPT: !!sendToChatGPT,
        sendToGemini: !!sendToGemini
    });
    
    // Tab elements
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    
    // Status elements
    const geminiStatus = document.getElementById('gemini-status');
    const chatgptStatus = document.getElementById('chatgpt-status');
    
    // Initialize the extension
    init();
    
    function init() {
        console.log('Initializing Multi-LLM Coder...');
        
        // Set up event listeners
        setupEventListeners();
        
        // Update UI state
        updateSendButtonState();
        updateCharCount();
        
        // Check connection status
        checkConnectionStatus();
        
        console.log('Multi-LLM Coder initialized successfully');
    }
    
    function setupEventListeners() {
        // Prompt input events
        if (promptInput) {
            promptInput.addEventListener('input', handlePromptInput);
            promptInput.addEventListener('keydown', handleKeyDown);
        }
        
        // Send button
        if (sendButton) {
            sendButton.addEventListener('click', handleSendClick);
        }
        
        // LLM checkboxes
        if (useGemini) {
            useGemini.addEventListener('change', updateSendButtonState);
        }
        if (useChatGPT) {
            useChatGPT.addEventListener('change', updateSendButtonState);
        }

        // Forward buttons
        if (sendToChatGPT) {
            sendToChatGPT.addEventListener('click', handleSendToChatGPT);
        }
        if (sendToGemini) {
            sendToGemini.addEventListener('click', handleSendToGemini);
        }
        
        // Tab buttons
        tabButtons.forEach(button => {
            button.addEventListener('click', handleTabClick);
        });
        
        // Footer buttons
        const clearAllButton = document.getElementById('clear-all');
        if (clearAllButton) {
            clearAllButton.addEventListener('click', handleClearAll);
        }
        
        // Listen for messages from background script
        if (chrome && chrome.runtime) {
            console.log('🔗 Setting up message listener...');
            chrome.runtime.onMessage.addListener(handleBackgroundMessage);
            console.log('✅ Message listener registered');
            
            // Test the connection immediately
            console.log('🧪 Testing connection to background script...');
            chrome.runtime.sendMessage({ type: 'SIDE_PANEL_READY' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('❌ Connection test failed:', chrome.runtime.lastError);
                } else {
                    console.log('✅ Connection test successful:', response);
                }
            });
        } else {
            console.warn('⚠️ Chrome runtime not available');
        }
    }
    
    function handlePromptInput() {
        updateCharCount();
        updateSendButtonState();
    }
    
    function handleKeyDown(event) {
        // Handle Ctrl+Enter or Cmd+Enter
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            handleSendClick();
        }
    }
    
    function handleSendClick() {
        const prompt = promptInput?.value?.trim();
        const geminiSelected = useGemini?.checked;
        const chatgptSelected = useChatGPT?.checked;
        
        if (!prompt) {
            showToast('Please enter a prompt', 'warning');
            return;
        }
        
        if (!geminiSelected && !chatgptSelected) {
            showToast('Please select at least one LLM', 'warning');
            return;
        }
        
        console.log('Sending prompt:', prompt);
        console.log('Targets:', { gemini: geminiSelected, chatgpt: chatgptSelected });
        
        // Show loading state
        showLoading();
        
        // Send message to background script
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: prompt,
                targets: {
                    gemini: geminiSelected,
                    chatgpt: chatgptSelected
                }
            });
        } else {
            // Fallback for testing in browser
            console.log('Chrome runtime not available - showing mock response');
            setTimeout(() => {
                showMockResponse(prompt, geminiSelected, chatgptSelected);
                hideLoading();
            }, 2000);
        }
        
        // Update status
        if (geminiSelected) updateLLMStatus('gemini', 'Sending...');
        if (chatgptSelected) updateLLMStatus('chatgpt', 'Sending...');
    }

    function handleSendToChatGPT() {
        const content = document.getElementById('gemini-content')?.textContent?.trim();
        if (!content) {
            showToast('No Gemini response to send', 'warning');
            return;
        }

        showToast('Forwarding to ChatGPT...', 'info');
        showLoading();
        updateLLMStatus('chatgpt', 'Sending...');

        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: content,
                targets: { chatgpt: true }
            });
        }
    }

    function handleSendToGemini() {
        const content = document.getElementById('chatgpt-content')?.textContent?.trim();
        if (!content) {
            showToast('No ChatGPT response to send', 'warning');
            return;
        }

        showToast('Forwarding to Gemini...', 'info');
        showLoading();
        updateLLMStatus('gemini', 'Sending...');

        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: content,
                targets: { gemini: true }
            });
        }
    }
    
    function handleBackgroundMessage(message, sender, sendResponse) {
        console.log('Received message from background:', message);
        
        switch (message.type) {
            case 'LLM_RESPONSE':
                handleLLMResponse(message);
                break;
            case 'LLM_ERROR':
                handleLLMError(message);
                break;
            case 'CONNECTION_STATUS':
                handleConnectionStatus(message);
                break;
            case 'LLM_PROGRESS':
                handleLLMProgress(message);
                break;
        }
    }
    
    function handleLLMResponse(message) {
        const { llm, content } = message;
        
        // Update the appropriate output area
        const outputContent = document.getElementById(`${llm}-content`);
        if (outputContent) {
            outputContent.innerHTML = `
                <div class="response-content">
                    ${content}
                </div>
            `;
        }
        
        // Update comparison view
        const comparisonContent = document.getElementById(`comparison-${llm}`);
        if (comparisonContent) {
            comparisonContent.innerHTML = `
                <div class="response-content">
                    ${content}
                </div>
            `;
        }
        
        // Apply syntax highlighting
        if (typeof hljs !== 'undefined') {
            hljs.highlightAll();
        }
        
        // Update status
        updateLLMStatus(llm, 'Complete');
        
        // Check if all responses are complete
        checkAllResponsesComplete();
        
        showToast(`${llm} response received!`, 'success');
    }
    
    function handleLLMError(message) {
        const { llm, error } = message;
        
        // Update the appropriate output area
        const outputContent = document.getElementById(`${llm}-content`);
        if (outputContent) {
            outputContent.innerHTML = `
                <div class="error-state">
                    <span class="material-symbols-rounded">error</span>
                    <p>Error: ${error}</p>
                    <p>Make sure you have ${llm} open in a tab and are logged in.</p>
                </div>
            `;
        }
        
        // Update status
        updateLLMStatus(llm, 'Error');
        
        showToast(`${llm} error: ${error}`, 'error');
        
        // Check if all responses are complete
        checkAllResponsesComplete();
    }
    
    function handleConnectionStatus(message) {
        const { gemini, chatgpt } = message.status;
        
        updateLLMStatus('gemini', gemini ? 'Ready' : 'Not Connected');
        updateLLMStatus('chatgpt', chatgpt ? 'Ready' : 'Not Connected');
        
        // Update checkboxes based on availability
        if (useGemini) useGemini.disabled = !gemini;
        if (useChatGPT) useChatGPT.disabled = !chatgpt;
        
        updateSendButtonState();
    }
    
    function handleLLMProgress(message) {
        const { llm, status } = message;
        updateLLMStatus(llm, status);
    }
    
    function checkConnectionStatus() {
        // Ask background script to check connection status
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' });
        }
    }
    
    function updateLLMStatus(llm, status) {
        const statusElement = document.getElementById(`${llm}-status`);
        if (statusElement) {
            statusElement.textContent = status;
            
            // Update color based on status
            statusElement.className = 'llm-status';
            if (status === 'Ready' || status === 'Complete') {
                statusElement.classList.add('status-ready');
            } else if (status === 'Error' || status === 'Not Connected') {
                statusElement.classList.add('status-error');
            } else if (status === 'Sending...' || status === 'Processing...') {
                statusElement.classList.add('status-processing');
            }
        }
    }
    
    function checkAllResponsesComplete() {
        const geminiStatus = document.getElementById('gemini-status')?.textContent;
        const chatgptStatus = document.getElementById('chatgpt-status')?.textContent;
        
        const geminiSelected = useGemini?.checked;
        const chatgptSelected = useChatGPT?.checked;
        
        const geminiDone = !geminiSelected || geminiStatus === 'Complete' || geminiStatus === 'Error';
        const chatgptDone = !chatgptSelected || chatgptStatus === 'Complete' || chatgptStatus === 'Error';
        
        if (geminiDone && chatgptDone) {
            hideLoading();
            updateLastUpdated();
        }
    }
    
    function handleTabClick(event) {
        const targetId = event.currentTarget.dataset.target;
        
        // Remove active class from all tabs and contents
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        
        // Add active class to clicked tab and corresponding content
        event.currentTarget.classList.add('active');
        const targetContent = document.getElementById(targetId);
        if (targetContent) {
            targetContent.classList.add('active');
        }
    }
    
    function handleClearAll() {
        if (confirm('Clear all responses?')) {
            // Clear all output content
            const outputContents = document.querySelectorAll('.output-content');
            outputContents.forEach(content => {
                content.innerHTML = `
                    <div class="empty-state">
                        <span class="material-symbols-rounded">psychology</span>
                        <p>Response will appear here</p>
                    </div>
                `;
            });
            
            // Clear comparison content
            const comparisonContents = document.querySelectorAll('.comparison-content');
            comparisonContents.forEach(content => {
                content.innerHTML = `
                    <div class="empty-state">
                        <span class="material-symbols-rounded">psychology</span>
                        <p>Response will appear here</p>
                    </div>
                `;
            });
            
            showToast('All responses cleared', 'success');
        }
    }
    
    function showMockResponse(prompt, geminiSelected, chatgptSelected) {
        if (geminiSelected) {
            const geminiContent = document.getElementById('gemini-content');
            if (geminiContent) {
                geminiContent.innerHTML = `
                    <div class="response-content">
                        <h3>Mock Gemini Response</h3>
                        <p>This is a mock response to your prompt: "${prompt}"</p>
                        <pre><code class="language-javascript">// Example code response
function mockResponse() {
    console.log("This is a mock Gemini response");
    return "Hello from Gemini!";
}</code></pre>
                        <p>This demonstrates how responses will be displayed in the extension.</p>
                    </div>
                `;
            }
            
            // Update comparison
            const comparisonGemini = document.getElementById('comparison-gemini');
            if (comparisonGemini) {
                comparisonGemini.innerHTML = `
                    <div class="response-content">
                        <p>Mock Gemini response for comparison view.</p>
                    </div>
                `;
            }
            
            updateLLMStatus('gemini', 'Complete');
        }
        
        if (chatgptSelected) {
            const chatgptContent = document.getElementById('chatgpt-content');
            if (chatgptContent) {
                chatgptContent.innerHTML = `
                    <div class="response-content">
                        <h3>Mock ChatGPT Response</h3>
                        <p>This is a mock response to your prompt: "${prompt}"</p>
                        <pre><code class="language-python"># Example code response
def mock_response():
    print("This is a mock ChatGPT response")
    return "Hello from ChatGPT!"</code></pre>
                        <p>This shows how ChatGPT responses will appear.</p>
                    </div>
                `;
            }
            
            // Update comparison
            const comparisonChatGPT = document.getElementById('comparison-chatgpt');
            if (comparisonChatGPT) {
                comparisonChatGPT.innerHTML = `
                    <div class="response-content">
                        <p>Mock ChatGPT response for comparison view.</p>
                    </div>
                `;
            }
            
            updateLLMStatus('chatgpt', 'Complete');
        }
        
        // Apply syntax highlighting if available
        if (typeof hljs !== 'undefined') {
            hljs.highlightAll();
        }
        
        updateLastUpdated();
        showToast('Mock responses generated!', 'success');
    }
    
    function updateCharCount() {
        if (promptInput && charCount) {
            const count = promptInput.value.length;
            charCount.textContent = count;
            
            // Update color based on limit
            if (count > 3800) {
                charCount.style.color = 'var(--text-error)';
            } else if (count > 3500) {
                charCount.style.color = 'var(--text-warning)';
            } else {
                charCount.style.color = 'var(--text-muted)';
            }
        }
    }
    
    function updateSendButtonState() {
        if (sendButton && promptInput && useGemini && useChatGPT) {
            const hasPrompt = promptInput.value.trim().length > 0;
            const hasTarget = (useGemini.checked && !useGemini.disabled) || 
                            (useChatGPT.checked && !useChatGPT.disabled);
            
            sendButton.disabled = !hasPrompt || !hasTarget;
        }
    }
    
    function showLoading() {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.remove('hidden');
        }
    }
    
    function hideLoading() {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }
    }
    
    function showToast(message, type = 'info') {
        const toastContainer = document.getElementById('toast-container');
        if (!toastContainer) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        toastContainer.appendChild(toast);
        
        // Show toast
        setTimeout(() => toast.classList.add('show'), 100);
        
        // Hide and remove toast
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }
    
    function updateLastUpdated() {
        const lastUpdatedText = document.querySelector('#last-updated .status-text');
        if (lastUpdatedText) {
            const now = new Date();
            lastUpdatedText.textContent = now.toLocaleTimeString();
        }
    }
});



---

### `selectors.js`

js
/**
 * DOM Selectors for LLM Websites
 * Service Worker Compatible Version
 */

const LLM_SELECTORS = {
  gemini: {
    input: 'textarea[placeholder*="Enter a prompt"]',
    sendButton: 'button[aria-label*="Send"], button[data-testid="send-button"]',
    responseArea: '[data-testid="response-container"], .response-container, .chat-container',
    lastResponseBlock: '.response-block:last-child, .message:last-child, [data-testid="response"]:last-child',
    doneIndicator: '.generation-complete, [aria-label*="Stop"], button[data-testid="stop-button"][style*="display: none"]'
  },
  
  chatgpt: {
    input: '#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea[placeholder*="Message"], textarea[data-id="root"], textarea, [contenteditable="true"]',
    sendButton: 'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label="Send"], button[aria-label*="Send"], button[type="submit"]',
    responseArea: '[data-testid="conversation-turn"], .conversation-content, [role="main"]',
    lastResponseBlock: '[data-testid="conversation-turn"]:last-child .markdown, .message:last-child, .response:last-child',
    doneIndicator: 'button[aria-label*="Stop"]:not([disabled]), .stop-button:not([style*="display: none"])'
  }
};

function validateSelector(selector, context) {
  context = context || document;
  try {
    const element = context.querySelector(selector);
    return {
      valid: !!element,
      element: element,
      selector: selector
    };
  } catch (error) {
    return {
      valid: false,
      element: null,
      selector: selector,
      error: error.message
    };
  }
}



---

### `styles.css`

css
/**
 * Multi-LLM Coder Extension - Styles
 * Dark theme with modern design for Chrome side panel
 */

/* CSS Variables for theming */
:root {
  /* Dark theme colors */
  --bg-primary: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-tertiary: #3a3a3a;
  --bg-hover: #404040;
  --bg-active: #4a4a4a;
  
  /* Text colors */
  --text-primary: #e0e0e0;
  --text-secondary: #b0b0b0;
  --text-muted: #808080;
  --text-accent: #4CAF50;
  --text-error: #f44336;
  --text-warning: #ff9800;
  
  /* Border colors */
  --border-primary: #444444;
  --border-secondary: #555555;
  --border-accent: #4CAF50;
  
  /* Accent colors */
  --accent-primary: #4CAF50;
  --accent-secondary: #2196F3;
  --accent-warning: #ff9800;
  --accent-error: #f44336;
  
  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.3);
  
  /* Transitions */
  --transition-fast: 0.15s ease;
  --transition-normal: 0.3s ease;
  --transition-slow: 0.5s ease;
  
  /* Spacing */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  
  /* Typography */
  --font-family-mono: 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  --font-family-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  
  /* Sizes */
  --header-height: 80px;
  --footer-height: 60px;
  --tab-height: 48px;
}

/* Reset and base styles */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  font-family: var(--font-family-sans);
  background-color: var(--bg-primary);
  color: var(--text-primary);
  overflow: hidden;
}

/* Container */
.container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
}

/* Header */
.header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
  padding: var(--spacing-md);
  min-height: var(--header-height);
  display: flex;
  align-items: center;
}

.header-content {
  width: 100%;
}

.title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-accent);
  margin-bottom: var(--spacing-xs);
}

.subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

/* Main content */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Input section */
.input-section {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
  padding: var(--spacing-md);
}

.prompt-container {
  width: 100%;
}

.prompt-wrapper {
  position: relative;
  margin-bottom: var(--spacing-md);
}

.prompt-input {
  width: 100%;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--spacing-md);
  color: var(--text-primary);
  font-family: var(--font-family-mono);
  font-size: 0.875rem;
  line-height: 1.5;
  resize: vertical;
  min-height: 100px;
  transition: border-color var(--transition-fast);
}

.prompt-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
}

.prompt-input::placeholder {
  color: var(--text-muted);
}

.input-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--spacing-xs);
}

.char-counter {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-family: var(--font-family-mono);
}

/* Controls */
.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-md);
}

.llm-selection {
  display: flex;
  gap: var(--spacing-md);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  padding: var(--spacing-sm);
  border-radius: 6px;
  transition: background-color var(--transition-fast);
}

.checkbox-label:hover {
  background-color: var(--bg-hover);
}

.checkbox-label input[type="checkbox"] {
  display: none;
}

.checkmark {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-primary);
  border-radius: 4px;
  position: relative;
  transition: all var(--transition-fast);
}

.checkbox-label input[type="checkbox"]:checked + .checkmark {
  background-color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.checkbox-label input[type="checkbox"]:checked + .checkmark::after {
  content: '✓';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 12px;
  font-weight: bold;
}

.llm-name {
  font-weight: 500;
  color: var(--text-primary);
}

.llm-status {
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
}

/* Send button */
.send-button {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--accent-primary);
  color: white;
  border: none;
  border-radius: 8px;
  padding: var(--spacing-md) var(--spacing-lg);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.send-button:hover:not(:disabled) {
  background: #45a049;
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.send-button:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: not-allowed;
}

.send-button .material-symbols-rounded {
  font-size: 18px;
}

/* Output section */
.output-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Tab navigation */
.tab-navigation {
  display: flex;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
}

.tab-button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  background: none;
  border: none;
  padding: var(--spacing-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  border-bottom: 2px solid transparent;
  min-height: var(--tab-height);
}

.tab-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tab-button.active {
  color: var(--accent-primary);
  border-bottom-color: var(--accent-primary);
  background: var(--bg-primary);
}

.tab-icon {
  font-size: 16px;
}

.tab-label {
  font-weight: 500;
}

.tab-status {
  font-size: 0.75rem;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: var(--spacing-xs);
}

/* Tab content */
.tab-content-container {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.tab-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  visibility: hidden;
  transition: all var(--transition-fast);
}

.tab-content.active {
  opacity: 1;
  visibility: visible;
}

/* Output header */
.output-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
}

.output-title {
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-primary);
}

.output-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.action-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-secondary);
}

.action-button .material-symbols-rounded {
  font-size: 16px;
}

/* Output content */
.output-content {
  flex: 1;
  padding: var(--spacing-md);
  overflow-y: auto;
  background: var(--bg-primary);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-muted);
  text-align: center;
}

.empty-state .material-symbols-rounded {
  font-size: 48px;
  margin-bottom: var(--spacing-md);
  opacity: 0.5;
}

/* Comparison layout */
.comparison-container {
  display: flex;
  height: 100%;
  gap: 1px;
  background: var(--border-primary);
}

.comparison-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.comparison-header {
  padding: var(--spacing-md);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
  text-align: center;
}

.comparison-content {
  flex: 1;
  padding: var(--spacing-md);
  overflow-y: auto;
}

.comparison-divider {
  width: 1px;
  background: var(--border-primary);
}

/* Response content styling */
.response-content {
  line-height: 1.6;
}

.response-content h1,
.response-content h2,
.response-content h3,
.response-content h4,
.response-content h5,
.response-content h6 {
  color: var(--text-primary);
  margin: var(--spacing-md) 0 var(--spacing-sm) 0;
}

.response-content p {
  margin-bottom: var(--spacing-md);
  color: var(--text-primary);
}

.response-content ul,
.response-content ol {
  margin: var(--spacing-md) 0;
  padding-left: var(--spacing-lg);
}

.response-content li {
  margin-bottom: var(--spacing-xs);
  color: var(--text-primary);
}

.response-content blockquote {
  border-left: 4px solid var(--accent-primary);
  padding-left: var(--spacing-md);
  margin: var(--spacing-md) 0;
  color: var(--text-secondary);
  font-style: italic;
}

/* Code blocks */
.response-content pre {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--spacing-md);
  margin: var(--spacing-md) 0;
  overflow-x: auto;
  position: relative;
}

.response-content code {
  font-family: var(--font-family-mono);
  font-size: 0.875rem;
}

.response-content p code {
  background: var(--bg-tertiary);
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 0.875rem;
}

/* Code block with copy button */
.code-block {
  position: relative;
  margin: var(--spacing-md) 0;
}

.code-block .copy-code-button {
  position: absolute;
  top: var(--spacing-sm);
  right: var(--spacing-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  padding: var(--spacing-xs);
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: all var(--transition-fast);
}

.code-block:hover .copy-code-button {
  opacity: 1;
}

.copy-code-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* Footer */
.footer {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-primary);
  padding: var(--spacing-md);
  min-height: var(--footer-height);
}

.footer-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.status-bar {
  display: flex;
  gap: var(--spacing-md);
}

.status-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.status-item .material-symbols-rounded {
  font-size: 14px;
}

.footer-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.footer-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.footer-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.footer-button .material-symbols-rounded {
  font-size: 16px;
}

/* Loading overlay */
.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  transition: opacity var(--transition-normal);
}

.loading-overlay.hidden {
  opacity: 0;
  visibility: hidden;
}

.loading-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 12px;
  padding: var(--spacing-xl);
  text-align: center;
  max-width: 300px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--bg-tertiary);
  border-top: 3px solid var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto var(--spacing-md);
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.loading-text {
  color: var(--text-primary);
  margin-bottom: var(--spacing-md);
}

.cancel-button {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--accent-error);
  color: white;
  border: none;
  border-radius: 6px;
  padding: var(--spacing-sm) var(--spacing-md);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  margin: 0 auto;
}

.cancel-button:hover {
  background: #d32f2f;
}

/* Toast notifications */
.toast-container {
  position: fixed;
  top: var(--spacing-md);
  right: var(--spacing-md);
  z-index: 1001;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.toast {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--spacing-md);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
  transform: translateX(100%);
  transition: transform var(--transition-normal);
  max-width: 300px;
}

.toast.show {
  transform: translateX(0);
}

.toast.success {
  border-left: 4px solid var(--accent-primary);
}

.toast.error {
  border-left: 4px solid var(--accent-error);
}

.toast.warning {
  border-left: 4px solid var(--accent-warning);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--bg-secondary);
}

::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--bg-hover);
}

/* Responsive design */
@media (max-width: 400px) {
  .controls {
    flex-direction: column;
    align-items: stretch;
  }
  
  .llm-selection {
    justify-content: center;
  }
  
  .comparison-container {
    flex-direction: column;
  }
  
  .comparison-divider {
    width: 100%;
    height: 1px;
  }
  
  .tab-button .tab-label {
    display: none;
  }
}

/* Utility classes */
.hidden {
  display: none !important;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Animation classes */
.fade-in {
  animation: fadeIn var(--transition-normal) ease-in;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.slide-up {
  animation: slideUp var(--transition-normal) ease-out;
}

@keyframes slideUp {
  from { 
    opacity: 0;
    transform: translateY(20px);
  }
  to { 
    opacity: 1;
    transform: translateY(0);
  }
}

/* Status indicator styles */
.status-ready {
  color: var(--accent-primary) !important;
}

.status-error {
  color: var(--accent-error) !important;
}

.status-processing {
  color: var(--accent-warning) !important;
}

/* Error state styling */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl);
  color: var(--text-error);
  text-align: center;
}

.error-state .material-symbols-rounded {
  font-size: 48px;
  margin-bottom: var(--spacing-md);
  color: var(--accent-error);
}

.error-state p {
  margin-bottom: var(--spacing-sm);
  color: var(--text-secondary);
}



---

### `background.js`

js
/**
 * Multi-LLM Coder Extension - Background Service Worker
 * Handles communication with LLM websites and tab management
 */

// Extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('Multi-LLM Coder extension installed');
});

// Safe message sending function
function sendMessageToPopup(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            if (chrome.runtime.lastError) {
                console.log('No popup to receive message:', message.type);
            }
        });
    } catch (error) {
        console.log('Failed to send message:', message.type, error);
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
        case 'FORWARD_PROMPT':
            handleForwardPrompt(message);
            sendResponse({ status: 'forward_received' });
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

function handleForwardPrompt(message) {
    const { from, prompt } = message;
    if (!prompt) return;
    if (from === 'chatgpt') {
        processLLM('gemini', prompt);
    } else if (from === 'gemini') {
        processLLM('chatgpt', prompt);
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
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea[data-id="root"]',
                'textarea',
                '[contenteditable="true"]'
            ],
            gemini: [
                'textarea[placeholder*="Enter a prompt"]',
                'textarea[placeholder*="Ask"]',
                'textarea',
                'input[type="text"]',
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
            'button[aria-label="Send"]',
            'button[aria-label="Send message"]',
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
            const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
            const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
            inputElement.dispatchEvent(enterDown);
            inputElement.dispatchEvent(enterUp);
            return { success: true, method: 'enter_key' };
        }

        // Click send button using mouse events
        const mouseDown = new MouseEvent('mousedown', { bubbles: true });
        const mouseUp = new MouseEvent('mouseup', { bubbles: true });
        sendButton.dispatchEvent(mouseDown);
        sendButton.dispatchEvent(mouseUp);
        sendButton.click();

        // Also trigger Enter key as a fallback in case click is ignored
        const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        inputElement.dispatchEvent(enterDown);
        inputElement.dispatchEvent(enterUp);

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



---

### `popup.html`

html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Multi-LLM Coder</title>
    <link rel="stylesheet" href="styles.css">
    <style>
        body {
            width: 400px;
            height: 600px;
            margin: 0;
            padding: 0;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: var(--font-family-sans);
            overflow: hidden;
        }
        .popup-container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .popup-header {
            background: var(--bg-secondary);
            padding: var(--spacing-md);
            border-bottom: 1px solid var(--border-primary);
        }
        .popup-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: var(--accent-primary);
            margin: 0;
        }
        .popup-subtitle {
            font-size: 0.8rem;
            color: var(--text-secondary);
            margin: 4px 0 0 0;
        }
        .popup-content {
            flex: 1;
            padding: var(--spacing-md);
            overflow-y: auto;
        }
        .input-group {
            margin-bottom: var(--spacing-md);
        }
        .popup-textarea {
            width: 100%;
            min-height: 80px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-primary);
            border-radius: 6px;
            padding: var(--spacing-sm);
            color: var(--text-primary);
            font-family: var(--font-family-mono);
            font-size: 0.85rem;
            resize: vertical;
            box-sizing: border-box;
        }
        .popup-textarea:focus {
            outline: none;
            border-color: var(--accent-primary);
        }
        .char-counter {
            text-align: right;
            font-size: 0.7rem;
            color: var(--text-muted);
            margin-top: 4px;
        }
        .llm-options {
            display: flex;
            gap: var(--spacing-md);
            margin-bottom: var(--spacing-md);
        }
        .llm-option {
            display: flex;
            align-items: center;
            gap: var(--spacing-xs);
            font-size: 0.85rem;
        }
        .send-btn {
            width: 100%;
            background: var(--accent-primary);
            color: white;
            border: none;
            padding: var(--spacing-sm) var(--spacing-md);
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: var(--spacing-md);
        }
        .send-btn:hover:not(:disabled) {
            background: #45a049;
        }
        .send-btn:disabled {
            background: var(--bg-tertiary);
            color: var(--text-muted);
            cursor: not-allowed;
        }
        .status-section {
            background: var(--bg-secondary);
            padding: var(--spacing-sm);
            border-radius: 6px;
            margin-bottom: var(--spacing-md);
        }
        .status-title {
            font-size: 0.8rem;
            font-weight: 500;
            margin-bottom: var(--spacing-xs);
        }
        .status-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.75rem;
            margin-bottom: 4px;
        }
        .status-ready { color: var(--accent-primary); }
        .status-error { color: var(--accent-error); }
        .status-processing { color: var(--accent-warning); }
        .response-section {
            background: var(--bg-secondary);
            border-radius: 6px;
            padding: var(--spacing-sm);
            max-height: 200px;
            overflow-y: auto;
        }
        .response-title {
            font-size: 0.8rem;
            font-weight: 500;
            margin-bottom: var(--spacing-xs);
        }
        .response-content {
            font-size: 0.75rem;
            line-height: 1.4;
        }
        .empty-response {
            color: var(--text-muted);
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="popup-container">
        <div class="popup-header">
            <h1 class="popup-title">Multi-LLM Coder</h1>
            <p class="popup-subtitle">Send prompts to multiple AI models</p>
        </div>
        
        <div class="popup-content">
            <div class="input-group">
                <textarea 
                    id="prompt-input" 
                    class="popup-textarea" 
                    placeholder="Enter your prompt here..."
                    maxlength="4000"
                ></textarea>
                <div class="char-counter">
                    <span id="char-count">0</span>/4000
                </div>
            </div>
            
            <div class="llm-options">
                <label class="llm-option">
                    <input type="checkbox" id="use-gemini" checked>
                    <span>Gemini</span>
                </label>
                <label class="llm-option">
                    <input type="checkbox" id="use-chatgpt" checked>
                    <span>ChatGPT</span>
                </label>
            </div>
            
            <button id="send-button" class="send-btn" disabled>
                Send Prompt
            </button>
            
            <div class="status-section">
                <div class="status-title">Connection Status</div>
                <div class="status-item">
                    <span>Gemini:</span>
                    <span id="gemini-status" class="status-error">Checking...</span>
                </div>
                <div class="status-item">
                    <span>ChatGPT:</span>
                    <span id="chatgpt-status" class="status-error">Checking...</span>
                </div>
            </div>
            
            <div class="response-section">
                <div class="response-title">Last Response</div>
                <div id="response-content" class="response-content empty-response">
                    No responses yet. Send a prompt to get started!
                </div>
            </div>
        </div>
    </div>
    
    <script src="popup.js"></script>
</body>
</html>



---

### `dump_repo.py`

py
# dump_repo.py  (safe version: skips data files)
import os, pathlib, textwrap

ROOT = pathlib.Path(__file__).resolve().parent
OUT  = ROOT / "repo_dump.md"
MAX_KB = 200                        # still skip very large files

# File types we WANT to keep
CODE_EXTS = {
    ".py", ".ipynb", ".js", ".ts", ".tsx", ".jsx",
    ".java", ".go", ".rb", ".rs", ".cpp", ".c", ".h",
    ".md", ".toml", ".yaml", ".yml", ".jsonnet",
    ".html", ".css", ".scss", ".sh", ".bat", ".ps1",".lock",".env",'.toml', '.md'
}

# Or:  folders we want to ignore entirely
SKIP_DIRS = {"data", "datasets", "assets", ".git", "__pycache__", "bixbench/fhbixbench.egg-info",'bixbench/__pycache__','.github', "tests"}

SKIP_FILES = {                      # ALWAYS ignore these exact names
    ".gitignore",
    ".env",
    "uv.lock",
    "LICENSE",
    "pyproject.toml",
}
SKIP_EXTS  = {".toml"}              # ignore any file ending with these ext’s
# ---------------------------------------------------------------------------

def should_include(p: pathlib.Path) -> bool:
    if any(part in SKIP_DIRS for part in p.parts):
        return False
    if p.name in SKIP_FILES:
        return False
    if p.suffix.lower() in SKIP_EXTS:
        return False
    if p.suffix.lower() not in CODE_EXTS:
        return False
    if p.stat().st_size > MAX_KB * 1024:
        return False
    return True

def md_header(rel):
    lang = rel.suffix.lstrip(".") or "text"
    return f"\n\n---\n\n### `{rel}`\n\n{lang}"

with OUT.open("w", encoding="utf-8") as out:
    out.write(f"# Repository dump of {ROOT.name}\n")
    for p in ROOT.rglob("*"):
        if p.is_file() and should_include(p):
            rel = p.relative_to(ROOT)
            out.write(md_header(rel))
            out.write("\n" + p.read_text(errors="ignore") + "\n")

print(f"✅ Wrote {OUT}")


---

### `test-extension.md`

md
# Extension Testing Guide

## Latest Fixes Applied ✅

### Fixed Issues:
1. **Async Response Error** - ✅ Fixed message handling
2. **Connection Error** - ✅ Fixed messaging system  
3. **"Checking..." Status** - ✅ Fixed response handling
4. **Tab Detection** - ✅ Working for both Gemini and ChatGPT

## Testing Steps

### 1. Reload Extension
1. Go to `chrome://extensions/`
2. Find "Multi-LLM Coder"
3. Click the reload button (circular arrow icon)

### 2. Open Required Tabs
1. Open ChatGPT: https://chatgpt.com or https://chat.openai.com
2. Open Gemini: https://gemini.google.com
3. Make sure you're logged into both

### 3. Test Extension
1. Click the extension icon in Chrome toolbar
2. **Status should now show "Ready" for both LLMs** (not "Checking...")
3. Enter a test prompt: "Hello, please respond with just 'Hi there!'"
4. Select both Gemini and ChatGPT
5. Click "Send Prompt"

### 4. Expected Results
- ✅ No console errors
- ✅ Status shows "Ready" for detected LLMs
- ✅ Status shows "Not Connected" for missing LLMs
- ✅ Can select and send prompts
- ✅ Progress updates show during sending

### 5. Debug Console (if needed)
1. Right-click extension popup → "Inspect"
2. Check Console for any remaining errors
3. Background script logs show tab detection working

## What's Fixed
- Connection status updates immediately
- No more "Could not establish connection" errors
- No more async response errors
- Proper tab detection for both LLM services
- Clean messaging between popup and background script



---

### `README.md`

md
# Multi-LLM Coder Chrome Extension

A powerful Chrome extension that allows developers to send prompts simultaneously to multiple LLM providers (Gemini and ChatGPT) and compare responses side-by-side in a convenient Chrome side panel.

## ✨ Features

- **Multi-LLM Support**: Send prompts to Gemini and ChatGPT simultaneously
- **Side Panel Interface**: Persistent, accessible UI that doesn't interfere with your workflow
- **Response Comparison**: View responses side-by-side to compare different LLM outputs
- **Dark Theme**: Professional dark theme optimized for developers
- **Real-time Status**: Live connection status and progress indicators
- **Syntax Highlighting**: Code blocks are automatically highlighted
- **Keyboard Shortcuts**: Ctrl/Cmd+Enter to send prompts quickly

## 🚀 Installation

### Method 1: Load Unpacked Extension (Recommended for Development)

1. **Download or Clone** this repository to your local machine
2. **Open Chrome** and navigate to `chrome://extensions/`
3. **Enable Developer Mode** by toggling the switch in the top-right corner
4. **Click "Load unpacked"** and select the folder containing the extension files
5. **Pin the extension** by clicking the puzzle piece icon and pinning "Multi-LLM Coder"
6. **Open the side panel** from Chrome's toolbar and select "Multi-LLM Coder" to launch the extension

### Method 2: Manual Installation

1. Download all files from this repository
2. Ensure you have these files in a folder:
   - `manifest.json`
   - `sidepanel.html`
   - `sidepanel.js`
   - `background.js`
   - `selectors.js`
   - `styles.css`
3. Follow steps 2-6 from Method 1

## 📖 Usage

### Initial Setup

1. **Open LLM Websites**: 
   - Open [Gemini](https://gemini.google.com) in one tab
   - Open [ChatGPT](https://chat.openai.com) in another tab
   - Make sure you're logged into both services

2. **Open the Extension**:
   - Click the Multi-LLM Coder icon in your Chrome toolbar
   - Or use the keyboard shortcut (if configured)

### Sending Prompts

1. **Enter Your Prompt**: Type your question or request in the text area
2. **Select LLMs**: Check the boxes for Gemini and/or ChatGPT
3. **Send**: Click the "Send to LLMs" button or press Ctrl/Cmd+Enter
4. **View Responses**: Switch between tabs to see individual responses or use the Compare tab

### Interface Overview

- **Input Area**: Large text area with character counter
- **LLM Selection**: Checkboxes to choose which LLMs to query
- **Tabs**: 
  - **Gemini**: View Gemini's response
  - **ChatGPT**: View ChatGPT's response  
  - **Compare**: Side-by-side comparison view
- **Status Bar**: Shows connection status and last update time

## 🔧 How It Works

The extension uses Chrome's scripting API to interact with LLM websites:

1. **Tab Detection**: Finds open tabs with Gemini/ChatGPT
2. **Script Injection**: Injects JavaScript into the LLM websites
3. **DOM Interaction**: Fills input fields and clicks send buttons
4. **Response Monitoring**: Uses MutationObserver to detect when responses are complete
5. **Content Extraction**: Extracts response content and displays it in the side panel

## ⚠️ Important Notes

### Selector Updates
The extension relies on DOM selectors to interact with LLM websites. These may need updates when the websites change their interface. If the extension stops working:

1. Check the browser console for errors
2. Update selectors in `selectors.js` if needed
3. The selectors are the most volatile part of the extension

### Limitations
- Requires active tabs with Gemini and ChatGPT open
- Depends on website DOM structure (may break with UI updates)
- No offline functionality
- Responses are limited by the LLM websites' rate limits

## 🛠️ Development

### File Structure
```
chromeEX/
├── manifest.json          # Extension configuration
├── sidepanel.html         # Side panel UI
├── sidepanel.js          # UI logic and Chrome API communication
├── background.js         # Service worker for tab management
├── selectors.js          # DOM selectors for LLM websites
├── styles.css            # Dark theme styling
└── README.md            # This file
```

### Testing
- Use `python3 -m http.server 8000` to preview the UI at `http://localhost:8000/sidepanel.html`
- Check Chrome DevTools console for debugging information
- Test with both LLM websites open and logged in

### Updating Selectors
When LLM websites update their UI, update the selectors in `selectors.js`:

```javascript
const LLM_SELECTORS = {
    gemini: {
        input: 'textarea[placeholder*="Enter a prompt"]',
        sendButton: 'button[aria-label*="Send"]',
        // ... other selectors
    },
    chatgpt: {
        input: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        // ... other selectors
    }
};
```

## 🐛 Troubleshooting

### Extension Not Working
1. Check that you have Gemini/ChatGPT tabs open and loaded
2. Ensure you're logged into both services
3. Check the Chrome DevTools console for errors
4. Try refreshing the LLM website tabs

### No Responses Received
1. Verify the LLM websites are responsive
2. Check if selectors need updating
3. Look for errors in the background script console
4. Ensure the websites haven't changed their DOM structure

### Connection Status Shows "Not Connected"
1. Make sure the LLM websites are fully loaded
2. Check that the URLs match the host permissions in manifest.json
3. Try refreshing the extension

## 📝 License

This project is open source and available under the MIT License.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Common Contribution Areas
- Updating selectors when LLM websites change
- Adding support for new LLM providers
- Improving error handling and user feedback
- Enhancing the UI/UX

## 📞 Support

If you encounter issues:
1. Check this README for troubleshooting steps
2. Look at the browser console for error messages
3. Create an issue on the project repository
4. Include browser version, extension version, and error details

## 📦 Dependencies & Installation

### System Requirements
- **Google Chrome** (version 88 or higher)
- **Developer Mode** enabled in Chrome Extensions
- **Internet Connection** (for LLM website access)

### No Traditional Dependencies Required
This Chrome extension is built with vanilla JavaScript and doesn't require Node.js, npm, or any build tools. All dependencies are either:
- Built into Chrome (Extension APIs)
- Loaded from CDN (highlight.js)
- Native Web APIs

### Quick Setup Script
For a streamlined setup process, you can use this script:

```bash
#!/bin/bash
# Multi-LLM Coder Extension Setup Script

echo "🚀 Setting up Multi-LLM Coder Chrome Extension..."

# Check if Chrome is installed
if ! command -v google-chrome &> /dev/null && ! command -v chrome &> /dev/null; then
    echo "❌ Google Chrome not found. Please install Chrome first."
    echo "   Download from: https://www.google.com/chrome/"
    exit 1
fi

echo "✅ Chrome detected"

# Clone or download the repository
if [ ! -d "chromeEX" ]; then
    echo "📥 Downloading extension files..."
    # If using git:
    # git clone <repository-url> chromeEX
    # Or download and extract manually
    echo "   Please ensure all extension files are in the current directory"
fi

# Verify required files
required_files=("manifest.json" "sidepanel.html" "sidepanel.js" "background.js" "selectors.js" "styles.css")
missing_files=()

for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        missing_files+=("$file")
    fi
done

if [ ${#missing_files[@]} -ne 0 ]; then
    echo "❌ Missing required files:"
    printf '   - %s\n' "${missing_files[@]}"
    exit 1
fi

echo "✅ All required files present"

# Run tests (optional)
if [ -f "tests/test-runner.html" ]; then
    echo "🧪 Test files available"
    echo "   Open tests/test-runner.html in Chrome to run validation tests"
fi

echo ""
echo "🎉 Setup complete! Next steps:"
echo "   1. Open Chrome and go to chrome://extensions/"
echo "   2. Enable 'Developer mode' (toggle in top-right)"
echo "   3. Click 'Load unpacked' and select this directory"
echo "   4. Open Gemini (gemini.google.com) and ChatGPT (chat.openai.com)"
echo "   5. Click the extension icon to start using Multi-LLM Coder"
echo ""
echo "📚 For detailed instructions, see the Installation section in README.md"
```

### Manual Verification
To verify your setup, check that you have these files:

```bash
# Verify all required files are present
ls -la manifest.json sidepanel.html sidepanel.js background.js selectors.js styles.css

# Optional: Run a simple HTTP server to preview the UI
python3 -m http.server 8000
# Then visit: http://localhost:8000/sidepanel.html
```

### Development Dependencies (Optional)
If you want to contribute to the project or run tests:

```bash
# For running a local HTTP server (testing UI)
python3 -m http.server 8000

# For code formatting (if you have prettier installed globally)
npx prettier --write "*.js" "*.html" "*.css"

# For linting (if you have eslint installed globally)  
npx eslint *.js
```

### External Dependencies
The extension automatically loads these external resources:
- **highlight.js** (v11.9.0) - For syntax highlighting in code blocks
- **Material Icons** - For UI icons
- **Chrome Extension APIs** - Built into Chrome browser

### Troubleshooting Dependencies
If the extension doesn't work properly:

1. **Check Chrome Version**: Ensure you're using Chrome 88+
2. **Verify Files**: Run the verification script above
3. **Test Network**: Ensure you can access gemini.google.com and chat.openai.com
4. **Check Console**: Open Chrome DevTools and look for any error messages

### No Build Process Required
Unlike many modern web projects, this extension:
- ✅ Requires no compilation or build step
- ✅ Uses no package managers (npm, yarn, etc.)
- ✅ Has no node_modules directory
- ✅ Works directly with Chrome's built-in APIs
- ✅ Loads external libraries via CDN

This makes it easy to modify, debug, and deploy without complex tooling.



---

### `metadata.md`

md
# Multi-LLM Coder Extension - Metadata

## Development Progress

### Session 1 - Initial Setup, Tasks 1-4
- **Date**: 2024-12-19
- **Status**: Task 4 Complete - Moving to Task 5
- **Completed**: 
  - Project directory structure
  - Initial plan.md and metadata.md
  - manifest.json with Manifest V3 structure
  - Test infrastructure (test-runner.html, test-manifest.js)
  - All required permissions and configurations
  - selectors.js with DOM selectors for Gemini and ChatGPT
  - Comprehensive test suite for selectors validation
  - Helper functions for selector testing and validation
  - Complete sidepanel.html with modern UI structure
  - Comprehensive styles.css with dark theme and responsive design
- **Next**: Task 5 - sidepanel.js

## Technical Notes

### Architecture Decisions
- Using Chrome Extension Manifest V3
- Side panel approach for persistent UI
- No backend required for MVP
- Client-side only implementation
- Dark theme with modern design principles
- Responsive layout for various screen sizes

### Key Dependencies
- highlight.js for syntax highlighting
- Chrome APIs: sidePanel, scripting, storage, tabs
- MutationObserver for response detection
- Material Icons for UI elements

### Known Issues & Risks
1. **DOM Selectors**: Most fragile part - will need constant updates
2. **Response Detection**: MutationObserver logic needs careful implementation
3. **Cross-tab Communication**: Reliability concerns
4. **Website Changes**: External dependencies on Gemini/ChatGPT UI

### Testing Approach
- Test-driven development
- Unit tests for each module
- Integration tests for message passing
- Manual testing with live LLM websites

## File Status

| File | Status | Last Updated | Notes |
|------|--------|--------------|-------|
| plan.md | ✅ Complete | 2024-12-19 | Updated with Task 4 completion |
| metadata.md | ✅ Complete | 2024-12-19 | This file |
| manifest.json | ✅ Complete | 2024-12-19 | Manifest V3 with all permissions |
| tests/test-runner.html | ✅ Complete | 2024-12-19 | Test infrastructure with selectors tests |
| tests/test-manifest.js | ✅ Complete | 2024-12-19 | Manifest validation tests |
| tests/test-selectors.js | ✅ Complete | 2024-12-19 | Standalone selectors tests |
| selectors.js | ✅ Complete | 2024-12-19 | DOM selectors with helper functions |
| sidepanel.html | ✅ Complete | 2024-12-19 | Complete UI structure with modern design |
| styles.css | ✅ Complete | 2024-12-19 | Comprehensive dark theme styling |
| sidepanel.js | ⏳ In Progress | - | Next task |
| background.js | 📋 Planned | - | Service worker |

## Development Environment
- **OS**: macOS 24.4.0
- **Shell**: /bin/zsh
- **Project Path**: /Users/amt42/projects/chromeEX
- **Chrome Extension**: Manifest V3
- **Test Server**: Python HTTP server on port 8000

## Performance Targets
- Side panel load time: < 500ms
- Response processing: < 2s
- Memory usage: < 50MB
- CPU impact: Minimal when idle

## Task 4 Completion Notes
- Successfully created comprehensive styles.css with modern dark theme
- Implemented responsive design for various screen sizes
- Added CSS variables for easy theming and maintenance
- Styled all UI components including tabs, buttons, and form elements
- Added loading states, animations, and toast notifications
- Implemented proper scrollbar styling and accessibility features
- Created utility classes for common styling patterns

## UI/UX Design Features
- **Dark Theme**: Professional dark color scheme optimized for developers
- **Responsive Layout**: Adapts to different side panel sizes
- **Modern Components**: Custom checkboxes, buttons, and form elements
- **Tab Interface**: Clean tabbed navigation for different views
- **Code Highlighting**: Styled code blocks with copy functionality
- **Loading States**: Spinner and overlay for async operations
- **Toast Notifications**: User feedback system
- **Accessibility**: Proper focus states and screen reader support

## CSS Architecture
- **CSS Variables**: Centralized theming system
- **Component-based**: Modular styling approach
- **Responsive**: Mobile-first design principles
- **Performance**: Optimized animations and transitions
- **Maintainable**: Well-organized and documented code



---

### `SELECTOR_DEBUG.md`

md
# Selector Debug Guide

## What We Fixed

### Enhanced Selector Detection
- Added fallback selectors for both ChatGPT and Gemini
- Better error reporting showing what elements are available
- Debug logging to see exactly what's found

### ChatGPT Fallback Selectors
**Input:**
- `textarea[placeholder*="Message"]`
- `textarea[data-id="root"]`
- `textarea`
- `#prompt-textarea`
- `[contenteditable="true"]`

**Send Button:**
- `button[aria-label*="Send"]`
- `button[data-testid*="send"]`
- `button:has(svg)`
- `button[type="submit"]`
- `button:last-of-type`

### Gemini Fallback Selectors
**Input:**
- `textarea[placeholder*="Enter a prompt"]`
- `textarea[placeholder*="Ask"]`
- `textarea`
- `[contenteditable="true"]`
- `input[type="text"]`

**Send Button:**
- `button[aria-label*="Send"]`
- `button[data-testid*="send"]`
- `button:has(svg)`
- `button[type="submit"]`
- `button:last-of-type`

## Testing Steps

1. **Reload Extension**
2. **Open Browser Console** (F12 → Console)
3. **Send a Test Prompt**
4. **Check Console Output** for:
   - Number of textareas/inputs found
   - Which fallback selector worked
   - List of all available buttons (if send button fails)

## Expected Results

- Should find input elements even if primary selectors fail
- Should find send buttons using fallback selectors
- Better error messages showing what was actually found
- Messages should send to both LLMs successfully

## If Still Failing

The console will now show:
- All available textareas and inputs
- All available buttons with their HTML
- Which selectors were tried and which worked

This will help us update the selectors to match the current website structure.



---

### `plan.md`

md
# Multi-LLM Coder Extension - Development Plan

## Project Overview
A Chrome extension that allows developers to send prompts to multiple LLM providers (Gemini and ChatGPT) simultaneously and view responses side-by-side in a Chrome side panel.

## Current Status: Task 4 Complete - Moving to Task 5

## Project Structure
```
chromeEX/
├── manifest.json          # Chrome extension manifest (Manifest V3) ✅
├── background.js          # Service worker - orchestrates communication
├── sidepanel.html        # Side panel UI ✅
├── sidepanel.js          # Side panel logic
├── styles.css            # Styling for the extension ✅
├── selectors.js          # DOM selectors for LLM websites ✅
├── plan.md               # This file - development plan ✅
├── metadata.md           # Progress tracking and metadata ✅
└── tests/                # Test files ✅
    ├── test-manifest.js  # ✅
    ├── test-runner.html  # ✅
    ├── test-selectors.js # ✅
    └── test-background.js
```

## Task Breakdown

### ✅ Task 0: Project Setup
- [x] Create project directory
- [x] Create plan.md
- [x] Create metadata.md
- [x] Set up basic test structure

### ✅ Task 1: Create manifest.json
- [x] Create manifest.json with Manifest V3 structure
- [x] Define permissions: sidePanel, scripting, storage, tabs
- [x] Define host_permissions for Gemini and ChatGPT
- [x] Configure background service worker
- [x] Configure side panel
- [x] Add action for opening side panel
- [x] Write tests for manifest validation

### ✅ Task 2: Create selectors.js
- [x] Create selectors.js file
- [x] Define LLM_SELECTORS object structure
- [x] Add placeholder selectors for Gemini
- [x] Add placeholder selectors for ChatGPT
- [x] Document selector update process
- [x] Write tests for selector structure

### ✅ Task 3: Build sidepanel.html
- [x] Create HTML structure
- [x] Add input area with textarea
- [x] Add LLM selection checkboxes
- [x] Add send button
- [x] Create tabbed output area
- [x] Link CSS and JS files
- [x] Add highlight.js for syntax highlighting

### ✅ Task 4: Style with styles.css
- [x] Implement dark theme
- [x] Style input components
- [x] Style tabbed interface
- [x] Style code blocks
- [x] Add copy button styles
- [x] Make responsive layout

### ⏳ Task 5: Implement sidepanel.js
- [ ] Set up DOM references
- [ ] Implement tab switching
- [ ] Handle send button clicks
- [ ] Handle keyboard shortcuts (Ctrl/Cmd+Enter)
- [ ] Message passing to background.js
- [ ] Handle response display
- [ ] Implement code highlighting
- [ ] Add copy functionality
- [ ] Add "Send to..." functionality
- [ ] Write tests for UI logic

### 📋 Task 6: Implement background.js
- [ ] Set up service worker
- [ ] Handle extension installation
- [ ] Configure side panel behavior
- [ ] Implement message listeners
- [ ] Implement tab finding logic
- [ ] Implement script injection
- [ ] Handle response routing
- [ ] Error handling
- [ ] Write tests for background logic

### 📋 Task 7: Testing & Refinement
- [ ] Manual selector discovery
- [ ] Integration testing
- [ ] Error case testing
- [ ] Performance testing
- [ ] Documentation updates

## Testing Strategy
- Unit tests for each module
- Integration tests for message passing
- Manual testing with actual LLM websites
- Error scenario testing

## Known Challenges
1. DOM selectors will need frequent updates
2. MutationObserver logic for detecting response completion
3. Handling dynamic content on LLM websites
4. Cross-tab communication reliability

## Next Steps
1. ✅ Create metadata.md
2. ✅ Set up test structure
3. ✅ Begin Task 1: manifest.json 
4. ✅ Task 2: selectors.js
5. ✅ Task 3: sidepanel.html
6. ✅ Task 4: styles.css
7. ⏳ Task 5: sidepanel.js



---

### `sidepanel.html`

html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Multi-LLM Coder</title>
    
    <!-- Highlight.js for syntax highlighting -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    
    <!-- Material Icons for UI elements -->
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0" />
    
    <!-- Main styles -->
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <!-- Header -->
        <header class="header">
            <div class="header-content">
                <h1 class="title">Multi-LLM Coder</h1>
                <p class="subtitle">Compare responses from multiple AI models</p>
            </div>
        </header>

        <!-- Main Content Area -->
        <main class="main-content">
            <!-- Input Section -->
            <section class="input-section">
                <div class="prompt-container">
                    <div class="prompt-wrapper">
                        <textarea 
                            id="prompt-input" 
                            class="prompt-input" 
                            placeholder="Enter your prompt here... (Ctrl+Enter to send)"
                            rows="4"
                            maxlength="4000"
                        ></textarea>
                        <div class="input-footer">
                            <div class="char-counter">
                                <span id="char-count">0</span>/4000
                            </div>
                        </div>
                    </div>
                    
                    <!-- Controls -->
                    <div class="controls">
                        <div class="llm-selection">
                            <label class="checkbox-label">
                                <input type="checkbox" id="use-gemini" checked>
                                <span class="checkmark"></span>
                                <span class="llm-name">Gemini</span>
                                <span class="llm-status" id="gemini-status">Ready</span>
                            </label>
                            
                            <label class="checkbox-label">
                                <input type="checkbox" id="use-chatgpt" checked>
                                <span class="checkmark"></span>
                                <span class="llm-name">ChatGPT</span>
                                <span class="llm-status" id="chatgpt-status">Ready</span>
                            </label>
                        </div>
                        
                        <button id="send-button" class="send-button" disabled>
                            <span class="material-symbols-rounded">send</span>
                            <span class="button-text">Send Prompt</span>
                        </button>
                    </div>
                </div>
            </section>

            <!-- Output Section -->
            <section class="output-section">
                <!-- Tab Navigation -->
                <div class="tab-navigation">
                    <button class="tab-button active" data-target="gemini-output" id="gemini-tab">
                        <span class="tab-icon">🤖</span>
                        <span class="tab-label">Gemini</span>
                        <span class="tab-status" id="gemini-tab-status"></span>
                    </button>
                    
                    <button class="tab-button" data-target="chatgpt-output" id="chatgpt-tab">
                        <span class="tab-icon">💬</span>
                        <span class="tab-label">ChatGPT</span>
                        <span class="tab-status" id="chatgpt-tab-status"></span>
                    </button>
                    
                    <button class="tab-button" data-target="comparison-output" id="comparison-tab">
                        <span class="tab-icon">⚖️</span>
                        <span class="tab-label">Compare</span>
                        <span class="tab-status" id="comparison-tab-status"></span>
                    </button>
                </div>

                <!-- Tab Content -->
                <div class="tab-content-container">
                    <!-- Gemini Output -->
                    <div id="gemini-output" class="tab-content active">
                        <div class="output-header">
                            <h3 class="output-title">Gemini Response</h3>
                            <div class="output-actions">
                                <button class="action-button" id="copy-gemini" title="Copy Response">
                                    <span class="material-symbols-rounded">content_copy</span>
                                </button>
                                <button class="action-button" id="send-to-chatgpt" title="Send to ChatGPT">
                                    <span class="material-symbols-rounded">arrow_forward</span>
                                </button>
                                <button class="action-button" id="retry-gemini" title="Retry">
                                    <span class="material-symbols-rounded">refresh</span>
                                </button>
                            </div>
                        </div>
                        <div class="output-content" id="gemini-content">
                            <div class="empty-state">
                                <span class="material-symbols-rounded">psychology</span>
                                <p>Gemini response will appear here</p>
                            </div>
                        </div>
                    </div>

                    <!-- ChatGPT Output -->
                    <div id="chatgpt-output" class="tab-content">
                        <div class="output-header">
                            <h3 class="output-title">ChatGPT Response</h3>
                            <div class="output-actions">
                                <button class="action-button" id="copy-chatgpt" title="Copy Response">
                                    <span class="material-symbols-rounded">content_copy</span>
                                </button>
                                <button class="action-button" id="send-to-gemini" title="Send to Gemini">
                                    <span class="material-symbols-rounded">arrow_forward</span>
                                </button>
                                <button class="action-button" id="retry-chatgpt" title="Retry">
                                    <span class="material-symbols-rounded">refresh</span>
                                </button>
                            </div>
                        </div>
                        <div class="output-content" id="chatgpt-content">
                            <div class="empty-state">
                                <span class="material-symbols-rounded">chat</span>
                                <p>ChatGPT response will appear here</p>
                            </div>
                        </div>
                    </div>

                    <!-- Comparison Output -->
                    <div id="comparison-output" class="tab-content">
                        <div class="output-header">
                            <h3 class="output-title">Side-by-Side Comparison</h3>
                            <div class="output-actions">
                                <button class="action-button" id="copy-comparison" title="Copy Comparison">
                                    <span class="material-symbols-rounded">content_copy</span>
                                </button>
                                <button class="action-button" id="export-comparison" title="Export as Markdown">
                                    <span class="material-symbols-rounded">download</span>
                                </button>
                            </div>
                        </div>
                        <div class="comparison-container">
                            <div class="comparison-column">
                                <h4 class="comparison-header">Gemini</h4>
                                <div class="comparison-content" id="comparison-gemini">
                                    <div class="empty-state">
                                        <span class="material-symbols-rounded">psychology</span>
                                        <p>Gemini response</p>
                                    </div>
                                </div>
                            </div>
                            <div class="comparison-divider"></div>
                            <div class="comparison-column">
                                <h4 class="comparison-header">ChatGPT</h4>
                                <div class="comparison-content" id="comparison-chatgpt">
                                    <div class="empty-state">
                                        <span class="material-symbols-rounded">chat</span>
                                        <p>ChatGPT response</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </main>

        <!-- Footer -->
        <footer class="footer">
            <div class="footer-content">
                <div class="status-bar">
                    <span class="status-item" id="connection-status">
                        <span class="material-symbols-rounded">wifi</span>
                        <span class="status-text">Ready</span>
                    </span>
                    <span class="status-item" id="last-updated">
                        <span class="material-symbols-rounded">schedule</span>
                        <span class="status-text">Never</span>
                    </span>
                </div>
                <div class="footer-actions">
                    <button class="footer-button" id="clear-all" title="Clear All Responses">
                        <span class="material-symbols-rounded">clear_all</span>
                    </button>
                    <button class="footer-button" id="settings" title="Settings">
                        <span class="material-symbols-rounded">settings</span>
                    </button>
                    <button class="footer-button" id="help" title="Help">
                        <span class="material-symbols-rounded">help</span>
                    </button>
                </div>
            </div>
        </footer>
    </div>

    <!-- Loading Overlay -->
    <div id="loading-overlay" class="loading-overlay hidden">
        <div class="loading-content">
            <div class="loading-spinner"></div>
            <p class="loading-text">Processing your request...</p>
            <button class="cancel-button" id="cancel-request">
                <span class="material-symbols-rounded">close</span>
                Cancel
            </button>
        </div>
    </div>

    <!-- Toast Notifications -->
    <div id="toast-container" class="toast-container"></div>

    <!-- Main JavaScript -->
    <script src="sidepanel.js"></script>
</body>
</html>



---

### `contentScript.js`

js
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
            sendBtn.addEventListener('click', (evt) => {
                if (!forwardEnabled) return;
                if (evt.target.id === 'mlc-forward-toggle') return;
                const srcInput = findInput();
                const prompt = srcInput?.value || srcInput?.textContent || '';
                chrome.runtime.sendMessage({
                    type: 'FORWARD_PROMPT',
                    from: isChatGPT ? 'chatgpt' : 'gemini',
                    prompt
                });
            }, true);
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



---

### `FIXES_APPLIED.md`

md
# Fixes Applied to Multi-LLM Coder Extension

## Issues Fixed

### 1. Async Response Error
**Error**: "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"

**Fix**: Updated `handleBackgroundMessage` in popup.js to:
- Send proper responses with `sendResponse({ status: 'handled' })`
- Return `false` to not keep message channel open
- Added default case for unknown messages

### 2. Connection Error
**Error**: "Could not establish connection. Receiving end does not exist"

**Fix**: Created safe messaging system:
- Added `sendMessageToPopup()` function that checks if popup is open
- Handles cases where no receiver exists gracefully
- Uses `chrome.extension.getViews()` to check for active popups

### 3. Content Script Injection
**Issue**: Injected scripts were trying to use `chrome.runtime.sendMessage` which isn't available in web page context

**Fix**: Complete rewrite of injection system:
- Created `injectMonitoringFunctions()` to inject helper functions
- Rewritten `interactWithLLMAndWait()` to return promises
- Removed all `chrome.runtime.sendMessage` calls from injected code
- Now uses a promise-based approach that returns results to background script

### 4. Tab Detection Enhancement
**Enhancement**: Added comprehensive debugging and fallback detection

**Features**:
- Lists all open tabs for debugging
- Checks multiple URL patterns for ChatGPT
- Falls back to title/URL content matching
- Detailed logging of detection process

## Testing Checklist

✅ Extension loads without errors
✅ No async response errors in console
✅ ChatGPT tabs detected (both chatgpt.com and chat.openai.com)
✅ Gemini tabs detected
✅ Connection status updates properly
✅ No "connection does not exist" errors
✅ Can send prompts to LLMs (pending selector accuracy)

## Next Steps

1. Test actual prompt sending to verify selectors work
2. Update selectors if websites have changed
3. Add error recovery for selector failures
4. Consider adding retry logic for transient failures



---

### `repo_dump.md`

md
# Repository dump of chromeEX


---

### `SIMPLE_TEST.md`

md
# Simplified Extension Test Guide

## What Changed ✅

### Simplified Approach
- Removed complex response monitoring
- Focus on just sending prompts successfully
- Better selector fallback system
- Uses Enter key if send button not found

### New Selector Strategy
**ChatGPT:**
1. `#prompt-textarea`
2. `textarea[placeholder*="Message"]`
3. `textarea[data-id="root"]`
4. `textarea`
5. `[contenteditable="true"]`

**Gemini:**
1. `textarea[placeholder*="Enter a prompt"]`
2. `textarea[placeholder*="Ask"]`
3. `textarea`
4. `[contenteditable="true"]`

**Send Button (both):**
1. `button[data-testid*="send"]`
2. `button[aria-label*="Send"]`
3. `button[type="submit"]`
4. `button:has(svg)`
5. `button:last-of-type`
6. **Fallback:** Enter key

## Testing Steps

1. **Reload Extension** in Chrome
2. **Open ChatGPT and Gemini tabs**
3. **Open Extension Popup**
4. **Send Test Prompt:** "Hello, this is a test"
5. **Check Results:**
   - Extension should show "Prompt sent successfully"
   - Check ChatGPT/Gemini tabs to see if message appeared

## Expected Behavior

- ✅ Extension finds input field
- ✅ Types the prompt
- ✅ Either clicks send button OR presses Enter
- ✅ Shows success message
- ✅ Prompt appears in LLM interface

## Debug Info

To see what's happening:
1. Open ChatGPT/Gemini tab
2. Press F12 → Console
3. Send prompt from extension
4. Check console for messages like:
   - `"Found input with: textarea"`
   - `"Found send button with: button[aria-label*="Send"]"`

## If Still Not Working

The console will show exactly which selector worked or failed, making it easy to identify what needs to be updated.



---

### `popup.js`

js
/**
 * Multi-LLM Coder Extension - Popup JavaScript
 * Full-featured popup interface
 */

console.log('🚀 Popup loading...');

document.addEventListener('DOMContentLoaded', function() {
    console.log('✅ Popup DOM loaded');
    
    // Get DOM elements
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const charCount = document.getElementById('char-count');
    const useGemini = document.getElementById('use-gemini');
    const useChatGPT = document.getElementById('use-chatgpt');
    const geminiStatus = document.getElementById('gemini-status');
    const chatgptStatus = document.getElementById('chatgpt-status');
    const responseContent = document.getElementById('response-content');
    
    // Initialize
    init();
    
    function init() {
        console.log('🔧 Initializing popup...');
        
        // Set up event listeners
        setupEventListeners();
        
        // Update UI state
        updateCharCount();
        updateSendButtonState();
        
        // Check connection status
        checkConnectionStatus();
        
        console.log('✅ Popup initialized');
    }
    
    function setupEventListeners() {
        // Prompt input
        if (promptInput) {
            promptInput.addEventListener('input', handlePromptInput);
            promptInput.addEventListener('keydown', handleKeyDown);
        }
        
        // Send button
        if (sendButton) {
            sendButton.addEventListener('click', handleSendClick);
        }
        
        // Checkboxes
        if (useGemini) {
            useGemini.addEventListener('change', updateSendButtonState);
        }
        if (useChatGPT) {
            useChatGPT.addEventListener('change', updateSendButtonState);
        }
        
        // Listen for messages from background
        if (chrome && chrome.runtime) {
            chrome.runtime.onMessage.addListener(handleBackgroundMessage);
        }
    }
    
    function handlePromptInput() {
        updateCharCount();
        updateSendButtonState();
    }
    
    function handleKeyDown(event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            handleSendClick();
        }
    }
    
    function handleSendClick() {
        const prompt = promptInput?.value?.trim();
        const geminiSelected = useGemini?.checked;
        const chatgptSelected = useChatGPT?.checked;
        
        if (!prompt) {
            showMessage('Please enter a prompt', 'error');
            return;
        }
        
        if (!geminiSelected && !chatgptSelected) {
            showMessage('Please select at least one LLM', 'error');
            return;
        }
        
        console.log('📤 Sending prompt:', prompt);
        
        // Update UI
        sendButton.disabled = true;
        sendButton.textContent = 'Sending...';
        showMessage('Sending prompt to selected LLMs...', 'info');
        
        // Send to background script
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: prompt,
                targets: {
                    gemini: geminiSelected,
                    chatgpt: chatgptSelected
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error sending prompt:', chrome.runtime.lastError);
                    showMessage('Error sending prompt to background script', 'error');
                    resetSendButton();
                } else {
                    console.log('Prompt sent successfully:', response);
                }
            });
        }
        
        // Update status
        if (geminiSelected) updateLLMStatus('gemini', 'Sending...', 'processing');
        if (chatgptSelected) updateLLMStatus('chatgpt', 'Sending...', 'processing');
    }
    
    function handleBackgroundMessage(message, sender, sendResponse) {
        console.log('📨 Received message:', message);
        
        switch (message.type) {
            case 'LLM_RESPONSE':
                handleLLMResponse(message);
                sendResponse({ status: 'handled' });
                break;
            case 'LLM_ERROR':
                handleLLMError(message);
                sendResponse({ status: 'handled' });
                break;
            case 'CONNECTION_STATUS':
                handleConnectionStatus(message);
                sendResponse({ status: 'handled' });
                break;
            case 'LLM_PROGRESS':
                handleLLMProgress(message);
                sendResponse({ status: 'handled' });
                break;
            default:
                sendResponse({ status: 'unknown_message' });
                break;
        }
        
        return false; // Don't keep message channel open
    }
    
    function handleLLMResponse(message) {
        const { llm, content } = message;
        console.log(`✅ ${llm} response received`);
        
        // Update status
        updateLLMStatus(llm, 'Complete', 'ready');
        
        // Show response
        showMessage(`${llm} response received!`, 'success');
        showResponse(llm, content);
        
        // Reset send button
        resetSendButton();
    }
    
    function handleLLMError(message) {
        const { llm, error } = message;
        console.log(`❌ ${llm} error:`, error);
        
        // Update status
        updateLLMStatus(llm, 'Error', 'error');
        
        // Show error
        showMessage(`${llm} error: ${error}`, 'error');
        
        // Reset send button
        resetSendButton();
    }
    
    function handleConnectionStatus(message) {
        const { gemini, chatgpt } = message.status;
        console.log('🔗 Connection status:', message.status);
        
        updateLLMStatus('gemini', gemini ? 'Ready' : 'Not Connected', gemini ? 'ready' : 'error');
        updateLLMStatus('chatgpt', chatgpt ? 'Ready' : 'Not Connected', chatgpt ? 'ready' : 'error');
        
        // Update checkboxes
        if (useGemini) useGemini.disabled = !gemini;
        if (useChatGPT) useChatGPT.disabled = !chatgpt;
        
        updateSendButtonState();
    }
    
    function handleLLMProgress(message) {
        const { llm, status } = message;
        updateLLMStatus(llm, status, 'processing');
    }
    
    function checkConnectionStatus() {
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error checking connection:', chrome.runtime.lastError);
                } else {
                    console.log('Connection check response:', response);
                    // Handle the response directly
                    if (response && response.type === 'CONNECTION_STATUS') {
                        handleConnectionStatus(response);
                    }
                }
            });
        }
    }
    
    function updateLLMStatus(llm, status, type) {
        const statusElement = document.getElementById(`${llm}-status`);
        if (statusElement) {
            statusElement.textContent = status;
            statusElement.className = `status-${type}`;
        }
    }
    
    function updateCharCount() {
        if (promptInput && charCount) {
            const count = promptInput.value.length;
            charCount.textContent = count;
        }
    }
    
    function updateSendButtonState() {
        if (sendButton && promptInput && useGemini && useChatGPT) {
            const hasPrompt = promptInput.value.trim().length > 0;
            const hasTarget = (useGemini.checked && !useGemini.disabled) || 
                            (useChatGPT.checked && !useChatGPT.disabled);
            
            sendButton.disabled = !hasPrompt || !hasTarget;
        }
    }
    
    function resetSendButton() {
        if (sendButton) {
            sendButton.disabled = false;
            sendButton.textContent = 'Send Prompt';
            updateSendButtonState();
        }
    }
    
    function showMessage(message, type) {
        console.log(`💬 ${type.toUpperCase()}: ${message}`);
        // You could add a toast notification here if desired
    }
    
    function showResponse(llm, content) {
        if (responseContent) {
            // Clean up the content for display
            const cleanContent = content.replace(/<[^>]*>/g, '').substring(0, 500);
            responseContent.innerHTML = `
                <strong>${llm} Response:</strong><br>
                ${cleanContent}${cleanContent.length >= 500 ? '...' : ''}
            `;
            responseContent.className = 'response-content';
        }
    }
});



---

### `sidepanel.js`

js
/**
 * Multi-LLM Coder Extension - Side Panel JavaScript
 * Handles UI interactions and communication with background script
 */

console.log('🚀 sidepanel.js loading...');

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('✅ Multi-LLM Coder Extension DOM loaded');
    console.log('🔗 Chrome runtime available:', !!chrome?.runtime);
    
    // Get DOM references
    const promptInput = document.getElementById('prompt-input');
    const sendButton = document.getElementById('send-button');
    const charCount = document.getElementById('char-count');
    const useGemini = document.getElementById('use-gemini');
    const useChatGPT = document.getElementById('use-chatgpt');
    const sendToChatGPT = document.getElementById('send-to-chatgpt');
    const sendToGemini = document.getElementById('send-to-gemini');
    
    console.log('📋 DOM elements found:', {
        promptInput: !!promptInput,
        sendButton: !!sendButton,
        charCount: !!charCount,
        useGemini: !!useGemini,
        useChatGPT: !!useChatGPT,
        sendToChatGPT: !!sendToChatGPT,
        sendToGemini: !!sendToGemini
    });
    
    // Tab elements
    const tabButtons = document.querySelectorAll('.tab-button');
    const tabContents = document.querySelectorAll('.tab-content');
    
    // Status elements
    const geminiStatus = document.getElementById('gemini-status');
    const chatgptStatus = document.getElementById('chatgpt-status');
    
    // Initialize the extension
    init();
    
    function init() {
        console.log('Initializing Multi-LLM Coder...');
        
        // Set up event listeners
        setupEventListeners();
        
        // Update UI state
        updateSendButtonState();
        updateCharCount();
        
        // Check connection status
        checkConnectionStatus();
        
        console.log('Multi-LLM Coder initialized successfully');
    }
    
    function setupEventListeners() {
        // Prompt input events
        if (promptInput) {
            promptInput.addEventListener('input', handlePromptInput);
            promptInput.addEventListener('keydown', handleKeyDown);
        }
        
        // Send button
        if (sendButton) {
            sendButton.addEventListener('click', handleSendClick);
        }
        
        // LLM checkboxes
        if (useGemini) {
            useGemini.addEventListener('change', updateSendButtonState);
        }
        if (useChatGPT) {
            useChatGPT.addEventListener('change', updateSendButtonState);
        }

        // Forward buttons
        if (sendToChatGPT) {
            sendToChatGPT.addEventListener('click', handleSendToChatGPT);
        }
        if (sendToGemini) {
            sendToGemini.addEventListener('click', handleSendToGemini);
        }
        
        // Tab buttons
        tabButtons.forEach(button => {
            button.addEventListener('click', handleTabClick);
        });
        
        // Footer buttons
        const clearAllButton = document.getElementById('clear-all');
        if (clearAllButton) {
            clearAllButton.addEventListener('click', handleClearAll);
        }
        
        // Listen for messages from background script
        if (chrome && chrome.runtime) {
            console.log('🔗 Setting up message listener...');
            chrome.runtime.onMessage.addListener(handleBackgroundMessage);
            console.log('✅ Message listener registered');
            
            // Test the connection immediately
            console.log('🧪 Testing connection to background script...');
            chrome.runtime.sendMessage({ type: 'SIDE_PANEL_READY' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('❌ Connection test failed:', chrome.runtime.lastError);
                } else {
                    console.log('✅ Connection test successful:', response);
                }
            });
        } else {
            console.warn('⚠️ Chrome runtime not available');
        }
    }
    
    function handlePromptInput() {
        updateCharCount();
        updateSendButtonState();
    }
    
    function handleKeyDown(event) {
        // Handle Ctrl+Enter or Cmd+Enter
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            handleSendClick();
        }
    }
    
    function handleSendClick() {
        const prompt = promptInput?.value?.trim();
        const geminiSelected = useGemini?.checked;
        const chatgptSelected = useChatGPT?.checked;
        
        if (!prompt) {
            showToast('Please enter a prompt', 'warning');
            return;
        }
        
        if (!geminiSelected && !chatgptSelected) {
            showToast('Please select at least one LLM', 'warning');
            return;
        }
        
        console.log('Sending prompt:', prompt);
        console.log('Targets:', { gemini: geminiSelected, chatgpt: chatgptSelected });
        
        // Show loading state
        showLoading();
        
        // Send message to background script
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: prompt,
                targets: {
                    gemini: geminiSelected,
                    chatgpt: chatgptSelected
                }
            });
        } else {
            // Fallback for testing in browser
            console.log('Chrome runtime not available - showing mock response');
            setTimeout(() => {
                showMockResponse(prompt, geminiSelected, chatgptSelected);
                hideLoading();
            }, 2000);
        }
        
        // Update status
        if (geminiSelected) updateLLMStatus('gemini', 'Sending...');
        if (chatgptSelected) updateLLMStatus('chatgpt', 'Sending...');
    }

    function handleSendToChatGPT() {
        const content = document.getElementById('gemini-content')?.textContent?.trim();
        if (!content) {
            showToast('No Gemini response to send', 'warning');
            return;
        }

        showToast('Forwarding to ChatGPT...', 'info');
        showLoading();
        updateLLMStatus('chatgpt', 'Sending...');

        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: content,
                targets: { chatgpt: true }
            });
        }
    }

    function handleSendToGemini() {
        const content = document.getElementById('chatgpt-content')?.textContent?.trim();
        if (!content) {
            showToast('No ChatGPT response to send', 'warning');
            return;
        }

        showToast('Forwarding to Gemini...', 'info');
        showLoading();
        updateLLMStatus('gemini', 'Sending...');

        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: content,
                targets: { gemini: true }
            });
        }
    }
    
    function handleBackgroundMessage(message, sender, sendResponse) {
        console.log('Received message from background:', message);
        
        switch (message.type) {
            case 'LLM_RESPONSE':
                handleLLMResponse(message);
                break;
            case 'LLM_ERROR':
                handleLLMError(message);
                break;
            case 'CONNECTION_STATUS':
                handleConnectionStatus(message);
                break;
            case 'LLM_PROGRESS':
                handleLLMProgress(message);
                break;
        }
    }
    
    function handleLLMResponse(message) {
        const { llm, content } = message;
        
        // Update the appropriate output area
        const outputContent = document.getElementById(`${llm}-content`);
        if (outputContent) {
            outputContent.innerHTML = `
                <div class="response-content">
                    ${content}
                </div>
            `;
        }
        
        // Update comparison view
        const comparisonContent = document.getElementById(`comparison-${llm}`);
        if (comparisonContent) {
            comparisonContent.innerHTML = `
                <div class="response-content">
                    ${content}
                </div>
            `;
        }
        
        // Apply syntax highlighting
        if (typeof hljs !== 'undefined') {
            hljs.highlightAll();
        }
        
        // Update status
        updateLLMStatus(llm, 'Complete');
        
        // Check if all responses are complete
        checkAllResponsesComplete();
        
        showToast(`${llm} response received!`, 'success');
    }
    
    function handleLLMError(message) {
        const { llm, error } = message;
        
        // Update the appropriate output area
        const outputContent = document.getElementById(`${llm}-content`);
        if (outputContent) {
            outputContent.innerHTML = `
                <div class="error-state">
                    <span class="material-symbols-rounded">error</span>
                    <p>Error: ${error}</p>
                    <p>Make sure you have ${llm} open in a tab and are logged in.</p>
                </div>
            `;
        }
        
        // Update status
        updateLLMStatus(llm, 'Error');
        
        showToast(`${llm} error: ${error}`, 'error');
        
        // Check if all responses are complete
        checkAllResponsesComplete();
    }
    
    function handleConnectionStatus(message) {
        const { gemini, chatgpt } = message.status;
        
        updateLLMStatus('gemini', gemini ? 'Ready' : 'Not Connected');
        updateLLMStatus('chatgpt', chatgpt ? 'Ready' : 'Not Connected');
        
        // Update checkboxes based on availability
        if (useGemini) useGemini.disabled = !gemini;
        if (useChatGPT) useChatGPT.disabled = !chatgpt;
        
        updateSendButtonState();
    }
    
    function handleLLMProgress(message) {
        const { llm, status } = message;
        updateLLMStatus(llm, status);
    }
    
    function checkConnectionStatus() {
        // Ask background script to check connection status
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION' });
        }
    }
    
    function updateLLMStatus(llm, status) {
        const statusElement = document.getElementById(`${llm}-status`);
        if (statusElement) {
            statusElement.textContent = status;
            
            // Update color based on status
            statusElement.className = 'llm-status';
            if (status === 'Ready' || status === 'Complete') {
                statusElement.classList.add('status-ready');
            } else if (status === 'Error' || status === 'Not Connected') {
                statusElement.classList.add('status-error');
            } else if (status === 'Sending...' || status === 'Processing...') {
                statusElement.classList.add('status-processing');
            }
        }
    }
    
    function checkAllResponsesComplete() {
        const geminiStatus = document.getElementById('gemini-status')?.textContent;
        const chatgptStatus = document.getElementById('chatgpt-status')?.textContent;
        
        const geminiSelected = useGemini?.checked;
        const chatgptSelected = useChatGPT?.checked;
        
        const geminiDone = !geminiSelected || geminiStatus === 'Complete' || geminiStatus === 'Error';
        const chatgptDone = !chatgptSelected || chatgptStatus === 'Complete' || chatgptStatus === 'Error';
        
        if (geminiDone && chatgptDone) {
            hideLoading();
            updateLastUpdated();
        }
    }
    
    function handleTabClick(event) {
        const targetId = event.currentTarget.dataset.target;
        
        // Remove active class from all tabs and contents
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabContents.forEach(content => content.classList.remove('active'));
        
        // Add active class to clicked tab and corresponding content
        event.currentTarget.classList.add('active');
        const targetContent = document.getElementById(targetId);
        if (targetContent) {
            targetContent.classList.add('active');
        }
    }
    
    function handleClearAll() {
        if (confirm('Clear all responses?')) {
            // Clear all output content
            const outputContents = document.querySelectorAll('.output-content');
            outputContents.forEach(content => {
                content.innerHTML = `
                    <div class="empty-state">
                        <span class="material-symbols-rounded">psychology</span>
                        <p>Response will appear here</p>
                    </div>
                `;
            });
            
            // Clear comparison content
            const comparisonContents = document.querySelectorAll('.comparison-content');
            comparisonContents.forEach(content => {
                content.innerHTML = `
                    <div class="empty-state">
                        <span class="material-symbols-rounded">psychology</span>
                        <p>Response will appear here</p>
                    </div>
                `;
            });
            
            showToast('All responses cleared', 'success');
        }
    }
    
    function showMockResponse(prompt, geminiSelected, chatgptSelected) {
        if (geminiSelected) {
            const geminiContent = document.getElementById('gemini-content');
            if (geminiContent) {
                geminiContent.innerHTML = `
                    <div class="response-content">
                        <h3>Mock Gemini Response</h3>
                        <p>This is a mock response to your prompt: "${prompt}"</p>
                        <pre><code class="language-javascript">// Example code response
function mockResponse() {
    console.log("This is a mock Gemini response");
    return "Hello from Gemini!";
}</code></pre>
                        <p>This demonstrates how responses will be displayed in the extension.</p>
                    </div>
                `;
            }
            
            // Update comparison
            const comparisonGemini = document.getElementById('comparison-gemini');
            if (comparisonGemini) {
                comparisonGemini.innerHTML = `
                    <div class="response-content">
                        <p>Mock Gemini response for comparison view.</p>
                    </div>
                `;
            }
            
            updateLLMStatus('gemini', 'Complete');
        }
        
        if (chatgptSelected) {
            const chatgptContent = document.getElementById('chatgpt-content');
            if (chatgptContent) {
                chatgptContent.innerHTML = `
                    <div class="response-content">
                        <h3>Mock ChatGPT Response</h3>
                        <p>This is a mock response to your prompt: "${prompt}"</p>
                        <pre><code class="language-python"># Example code response
def mock_response():
    print("This is a mock ChatGPT response")
    return "Hello from ChatGPT!"</code></pre>
                        <p>This shows how ChatGPT responses will appear.</p>
                    </div>
                `;
            }
            
            // Update comparison
            const comparisonChatGPT = document.getElementById('comparison-chatgpt');
            if (comparisonChatGPT) {
                comparisonChatGPT.innerHTML = `
                    <div class="response-content">
                        <p>Mock ChatGPT response for comparison view.</p>
                    </div>
                `;
            }
            
            updateLLMStatus('chatgpt', 'Complete');
        }
        
        // Apply syntax highlighting if available
        if (typeof hljs !== 'undefined') {
            hljs.highlightAll();
        }
        
        updateLastUpdated();
        showToast('Mock responses generated!', 'success');
    }
    
    function updateCharCount() {
        if (promptInput && charCount) {
            const count = promptInput.value.length;
            charCount.textContent = count;
            
            // Update color based on limit
            if (count > 3800) {
                charCount.style.color = 'var(--text-error)';
            } else if (count > 3500) {
                charCount.style.color = 'var(--text-warning)';
            } else {
                charCount.style.color = 'var(--text-muted)';
            }
        }
    }
    
    function updateSendButtonState() {
        if (sendButton && promptInput && useGemini && useChatGPT) {
            const hasPrompt = promptInput.value.trim().length > 0;
            const hasTarget = (useGemini.checked && !useGemini.disabled) || 
                            (useChatGPT.checked && !useChatGPT.disabled);
            
            sendButton.disabled = !hasPrompt || !hasTarget;
        }
    }
    
    function showLoading() {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.remove('hidden');
        }
    }
    
    function hideLoading() {
        const loadingOverlay = document.getElementById('loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
        }
    }
    
    function showToast(message, type = 'info') {
        const toastContainer = document.getElementById('toast-container');
        if (!toastContainer) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        
        toastContainer.appendChild(toast);
        
        // Show toast
        setTimeout(() => toast.classList.add('show'), 100);
        
        // Hide and remove toast
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }
    
    function updateLastUpdated() {
        const lastUpdatedText = document.querySelector('#last-updated .status-text');
        if (lastUpdatedText) {
            const now = new Date();
            lastUpdatedText.textContent = now.toLocaleTimeString();
        }
    }
});



---

### `selectors.js`

js
/**
 * DOM Selectors for LLM Websites
 * Service Worker Compatible Version
 */

const LLM_SELECTORS = {
  gemini: {
    input: 'textarea[placeholder*="Enter a prompt"]',
    sendButton: 'button[aria-label*="Send"], button[data-testid="send-button"]',
    responseArea: '[data-testid="response-container"], .response-container, .chat-container',
    lastResponseBlock: '.response-block:last-child, .message:last-child, [data-testid="response"]:last-child',
    doneIndicator: '.generation-complete, [aria-label*="Stop"], button[data-testid="stop-button"][style*="display: none"]'
  },
  
  chatgpt: {
    input: '#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea[placeholder*="Message"], textarea[data-id="root"], textarea, [contenteditable="true"]',
    sendButton: 'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label="Send"], button[aria-label*="Send"], button[type="submit"]',
    responseArea: '[data-testid="conversation-turn"], .conversation-content, [role="main"]',
    lastResponseBlock: '[data-testid="conversation-turn"]:last-child .markdown, .message:last-child, .response:last-child',
    doneIndicator: 'button[aria-label*="Stop"]:not([disabled]), .stop-button:not([style*="display: none"])'
  }
};

function validateSelector(selector, context) {
  context = context || document;
  try {
    const element = context.querySelector(selector);
    return {
      valid: !!element,
      element: element,
      selector: selector
    };
  } catch (error) {
    return {
      valid: false,
      element: null,
      selector: selector,
      error: error.message
    };
  }
}



---

### `styles.css`

css
/**
 * Multi-LLM Coder Extension - Styles
 * Dark theme with modern design for Chrome side panel
 */

/* CSS Variables for theming */
:root {
  /* Dark theme colors */
  --bg-primary: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-tertiary: #3a3a3a;
  --bg-hover: #404040;
  --bg-active: #4a4a4a;
  
  /* Text colors */
  --text-primary: #e0e0e0;
  --text-secondary: #b0b0b0;
  --text-muted: #808080;
  --text-accent: #4CAF50;
  --text-error: #f44336;
  --text-warning: #ff9800;
  
  /* Border colors */
  --border-primary: #444444;
  --border-secondary: #555555;
  --border-accent: #4CAF50;
  
  /* Accent colors */
  --accent-primary: #4CAF50;
  --accent-secondary: #2196F3;
  --accent-warning: #ff9800;
  --accent-error: #f44336;
  
  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 6px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 10px 15px rgba(0, 0, 0, 0.3);
  
  /* Transitions */
  --transition-fast: 0.15s ease;
  --transition-normal: 0.3s ease;
  --transition-slow: 0.5s ease;
  
  /* Spacing */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  
  /* Typography */
  --font-family-mono: 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  --font-family-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  
  /* Sizes */
  --header-height: 80px;
  --footer-height: 60px;
  --tab-height: 48px;
}

/* Reset and base styles */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  font-family: var(--font-family-sans);
  background-color: var(--bg-primary);
  color: var(--text-primary);
  overflow: hidden;
}

/* Container */
.container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
}

/* Header */
.header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
  padding: var(--spacing-md);
  min-height: var(--header-height);
  display: flex;
  align-items: center;
}

.header-content {
  width: 100%;
}

.title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-accent);
  margin-bottom: var(--spacing-xs);
}

.subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

/* Main content */
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Input section */
.input-section {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
  padding: var(--spacing-md);
}

.prompt-container {
  width: 100%;
}

.prompt-wrapper {
  position: relative;
  margin-bottom: var(--spacing-md);
}

.prompt-input {
  width: 100%;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--spacing-md);
  color: var(--text-primary);
  font-family: var(--font-family-mono);
  font-size: 0.875rem;
  line-height: 1.5;
  resize: vertical;
  min-height: 100px;
  transition: border-color var(--transition-fast);
}

.prompt-input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
}

.prompt-input::placeholder {
  color: var(--text-muted);
}

.input-footer {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--spacing-xs);
}

.char-counter {
  font-size: 0.75rem;
  color: var(--text-muted);
  font-family: var(--font-family-mono);
}

/* Controls */
.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-md);
}

.llm-selection {
  display: flex;
  gap: var(--spacing-md);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  padding: var(--spacing-sm);
  border-radius: 6px;
  transition: background-color var(--transition-fast);
}

.checkbox-label:hover {
  background-color: var(--bg-hover);
}

.checkbox-label input[type="checkbox"] {
  display: none;
}

.checkmark {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-primary);
  border-radius: 4px;
  position: relative;
  transition: all var(--transition-fast);
}

.checkbox-label input[type="checkbox"]:checked + .checkmark {
  background-color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.checkbox-label input[type="checkbox"]:checked + .checkmark::after {
  content: '✓';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 12px;
  font-weight: bold;
}

.llm-name {
  font-weight: 500;
  color: var(--text-primary);
}

.llm-status {
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
}

/* Send button */
.send-button {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--accent-primary);
  color: white;
  border: none;
  border-radius: 8px;
  padding: var(--spacing-md) var(--spacing-lg);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.send-button:hover:not(:disabled) {
  background: #45a049;
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.send-button:disabled {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: not-allowed;
}

.send-button .material-symbols-rounded {
  font-size: 18px;
}

/* Output section */
.output-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Tab navigation */
.tab-navigation {
  display: flex;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
}

.tab-button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  background: none;
  border: none;
  padding: var(--spacing-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  border-bottom: 2px solid transparent;
  min-height: var(--tab-height);
}

.tab-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tab-button.active {
  color: var(--accent-primary);
  border-bottom-color: var(--accent-primary);
  background: var(--bg-primary);
}

.tab-icon {
  font-size: 16px;
}

.tab-label {
  font-weight: 500;
}

.tab-status {
  font-size: 0.75rem;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: var(--spacing-xs);
}

/* Tab content */
.tab-content-container {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.tab-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  visibility: hidden;
  transition: all var(--transition-fast);
}

.tab-content.active {
  opacity: 1;
  visibility: visible;
}

/* Output header */
.output-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
}

.output-title {
  font-size: 1rem;
  font-weight: 500;
  color: var(--text-primary);
}

.output-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.action-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.action-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-secondary);
}

.action-button .material-symbols-rounded {
  font-size: 16px;
}

/* Output content */
.output-content {
  flex: 1;
  padding: var(--spacing-md);
  overflow-y: auto;
  background: var(--bg-primary);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-muted);
  text-align: center;
}

.empty-state .material-symbols-rounded {
  font-size: 48px;
  margin-bottom: var(--spacing-md);
  opacity: 0.5;
}

/* Comparison layout */
.comparison-container {
  display: flex;
  height: 100%;
  gap: 1px;
  background: var(--border-primary);
}

.comparison-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.comparison-header {
  padding: var(--spacing-md);
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-primary);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-primary);
  text-align: center;
}

.comparison-content {
  flex: 1;
  padding: var(--spacing-md);
  overflow-y: auto;
}

.comparison-divider {
  width: 1px;
  background: var(--border-primary);
}

/* Response content styling */
.response-content {
  line-height: 1.6;
}

.response-content h1,
.response-content h2,
.response-content h3,
.response-content h4,
.response-content h5,
.response-content h6 {
  color: var(--text-primary);
  margin: var(--spacing-md) 0 var(--spacing-sm) 0;
}

.response-content p {
  margin-bottom: var(--spacing-md);
  color: var(--text-primary);
}

.response-content ul,
.response-content ol {
  margin: var(--spacing-md) 0;
  padding-left: var(--spacing-lg);
}

.response-content li {
  margin-bottom: var(--spacing-xs);
  color: var(--text-primary);
}

.response-content blockquote {
  border-left: 4px solid var(--accent-primary);
  padding-left: var(--spacing-md);
  margin: var(--spacing-md) 0;
  color: var(--text-secondary);
  font-style: italic;
}

/* Code blocks */
.response-content pre {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--spacing-md);
  margin: var(--spacing-md) 0;
  overflow-x: auto;
  position: relative;
}

.response-content code {
  font-family: var(--font-family-mono);
  font-size: 0.875rem;
}

.response-content p code {
  background: var(--bg-tertiary);
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 0.875rem;
}

/* Code block with copy button */
.code-block {
  position: relative;
  margin: var(--spacing-md) 0;
}

.code-block .copy-code-button {
  position: absolute;
  top: var(--spacing-sm);
  right: var(--spacing-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 4px;
  padding: var(--spacing-xs);
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: all var(--transition-fast);
}

.code-block:hover .copy-code-button {
  opacity: 1;
}

.copy-code-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* Footer */
.footer {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-primary);
  padding: var(--spacing-md);
  min-height: var(--footer-height);
}

.footer-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.status-bar {
  display: flex;
  gap: var(--spacing-md);
}

.status-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.status-item .material-symbols-rounded {
  font-size: 14px;
}

.footer-actions {
  display: flex;
  gap: var(--spacing-sm);
}

.footer-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.footer-button:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.footer-button .material-symbols-rounded {
  font-size: 16px;
}

/* Loading overlay */
.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  transition: opacity var(--transition-normal);
}

.loading-overlay.hidden {
  opacity: 0;
  visibility: hidden;
}

.loading-content {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 12px;
  padding: var(--spacing-xl);
  text-align: center;
  max-width: 300px;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--bg-tertiary);
  border-top: 3px solid var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto var(--spacing-md);
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.loading-text {
  color: var(--text-primary);
  margin-bottom: var(--spacing-md);
}

.cancel-button {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--accent-error);
  color: white;
  border: none;
  border-radius: 6px;
  padding: var(--spacing-sm) var(--spacing-md);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  margin: 0 auto;
}

.cancel-button:hover {
  background: #d32f2f;
}

/* Toast notifications */
.toast-container {
  position: fixed;
  top: var(--spacing-md);
  right: var(--spacing-md);
  z-index: 1001;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.toast {
  background: var(--bg-secondary);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: var(--spacing-md);
  color: var(--text-primary);
  box-shadow: var(--shadow-lg);
  transform: translateX(100%);
  transition: transform var(--transition-normal);
  max-width: 300px;
}

.toast.show {
  transform: translateX(0);
}

.toast.success {
  border-left: 4px solid var(--accent-primary);
}

.toast.error {
  border-left: 4px solid var(--accent-error);
}

.toast.warning {
  border-left: 4px solid var(--accent-warning);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: var(--bg-secondary);
}

::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--bg-hover);
}

/* Responsive design */
@media (max-width: 400px) {
  .controls {
    flex-direction: column;
    align-items: stretch;
  }
  
  .llm-selection {
    justify-content: center;
  }
  
  .comparison-container {
    flex-direction: column;
  }
  
  .comparison-divider {
    width: 100%;
    height: 1px;
  }
  
  .tab-button .tab-label {
    display: none;
  }
}

/* Utility classes */
.hidden {
  display: none !important;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Animation classes */
.fade-in {
  animation: fadeIn var(--transition-normal) ease-in;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.slide-up {
  animation: slideUp var(--transition-normal) ease-out;
}

@keyframes slideUp {
  from { 
    opacity: 0;
    transform: translateY(20px);
  }
  to { 
    opacity: 1;
    transform: translateY(0);
  }
}

/* Status indicator styles */
.status-ready {
  color: var(--accent-primary) !important;
}

.status-error {
  color: var(--accent-error) !important;
}

.status-processing {
  color: var(--accent-warning) !important;
}

/* Error state styling */
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl);
  color: var(--text-error);
  text-align: center;
}

.error-state .material-symbols-rounded {
  font-size: 48px;
  margin-bottom: var(--spacing-md);
  color: var(--accent-error);
}

.error-state p {
  margin-bottom: var(--spacing-sm);
  color: var(--text-secondary);
}



---

### `background.js`

js
/**
 * Multi-LLM Coder Extension - Background Service Worker
 * Handles communication with LLM websites and tab management
 */

// Extension installation
chrome.runtime.onInstalled.addListener(() => {
    console.log('Multi-LLM Coder extension installed');
});

// Safe message sending function
function sendMessageToPopup(message) {
    try {
        chrome.runtime.sendMessage(message, () => {
            if (chrome.runtime.lastError) {
                console.log('No popup to receive message:', message.type);
            }
        });
    } catch (error) {
        console.log('Failed to send message:', message.type, error);
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
        case 'FORWARD_PROMPT':
            handleForwardPrompt(message);
            sendResponse({ status: 'forward_received' });
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

function handleForwardPrompt(message) {
    const { from, prompt } = message;
    if (!prompt) return;
    if (from === 'chatgpt') {
        processLLM('gemini', prompt);
    } else if (from === 'gemini') {
        processLLM('chatgpt', prompt);
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
                'textarea[data-testid="prompt-textarea"]',
                'textarea[placeholder*="Message"]',
                'textarea[data-id="root"]',
                'textarea',
                '[contenteditable="true"]'
            ],
            gemini: [
                'textarea[placeholder*="Enter a prompt"]',
                'textarea[placeholder*="Ask"]',
                'textarea',
                'input[type="text"]',
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
            'button[aria-label="Send"]',
            'button[aria-label="Send message"]',
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
            const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
            const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
            inputElement.dispatchEvent(enterDown);
            inputElement.dispatchEvent(enterUp);
            return { success: true, method: 'enter_key' };
        }

        // Click send button using mouse events
        const mouseDown = new MouseEvent('mousedown', { bubbles: true });
        const mouseUp = new MouseEvent('mouseup', { bubbles: true });
        sendButton.dispatchEvent(mouseDown);
        sendButton.dispatchEvent(mouseUp);
        sendButton.click();

        // Also trigger Enter key as a fallback in case click is ignored
        const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        inputElement.dispatchEvent(enterDown);
        inputElement.dispatchEvent(enterUp);

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



---

### `popup.html`

html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Multi-LLM Coder</title>
    <link rel="stylesheet" href="styles.css">
    <style>
        body {
            width: 400px;
            height: 600px;
            margin: 0;
            padding: 0;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: var(--font-family-sans);
            overflow: hidden;
        }
        .popup-container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        .popup-header {
            background: var(--bg-secondary);
            padding: var(--spacing-md);
            border-bottom: 1px solid var(--border-primary);
        }
        .popup-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: var(--accent-primary);
            margin: 0;
        }
        .popup-subtitle {
            font-size: 0.8rem;
            color: var(--text-secondary);
            margin: 4px 0 0 0;
        }
        .popup-content {
            flex: 1;
            padding: var(--spacing-md);
            overflow-y: auto;
        }
        .input-group {
            margin-bottom: var(--spacing-md);
        }
        .popup-textarea {
            width: 100%;
            min-height: 80px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-primary);
            border-radius: 6px;
            padding: var(--spacing-sm);
            color: var(--text-primary);
            font-family: var(--font-family-mono);
            font-size: 0.85rem;
            resize: vertical;
            box-sizing: border-box;
        }
        .popup-textarea:focus {
            outline: none;
            border-color: var(--accent-primary);
        }
        .char-counter {
            text-align: right;
            font-size: 0.7rem;
            color: var(--text-muted);
            margin-top: 4px;
        }
        .llm-options {
            display: flex;
            gap: var(--spacing-md);
            margin-bottom: var(--spacing-md);
        }
        .llm-option {
            display: flex;
            align-items: center;
            gap: var(--spacing-xs);
            font-size: 0.85rem;
        }
        .send-btn {
            width: 100%;
            background: var(--accent-primary);
            color: white;
            border: none;
            padding: var(--spacing-sm) var(--spacing-md);
            border-radius: 6px;
            font-weight: 500;
            cursor: pointer;
            margin-bottom: var(--spacing-md);
        }
        .send-btn:hover:not(:disabled) {
            background: #45a049;
        }
        .send-btn:disabled {
            background: var(--bg-tertiary);
            color: var(--text-muted);
            cursor: not-allowed;
        }
        .status-section {
            background: var(--bg-secondary);
            padding: var(--spacing-sm);
            border-radius: 6px;
            margin-bottom: var(--spacing-md);
        }
        .status-title {
            font-size: 0.8rem;
            font-weight: 500;
            margin-bottom: var(--spacing-xs);
        }
        .status-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.75rem;
            margin-bottom: 4px;
        }
        .status-ready { color: var(--accent-primary); }
        .status-error { color: var(--accent-error); }
        .status-processing { color: var(--accent-warning); }
        .response-section {
            background: var(--bg-secondary);
            border-radius: 6px;
            padding: var(--spacing-sm);
            max-height: 200px;
            overflow-y: auto;
        }
        .response-title {
            font-size: 0.8rem;
            font-weight: 500;
            margin-bottom: var(--spacing-xs);
        }
        .response-content {
            font-size: 0.75rem;
            line-height: 1.4;
        }
        .empty-response {
            color: var(--text-muted);
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="popup-container">
        <div class="popup-header">
            <h1 class="popup-title">Multi-LLM Coder</h1>
            <p class="popup-subtitle">Send prompts to multiple AI models</p>
        </div>
        
        <div class="popup-content">
            <div class="input-group">
                <textarea 
                    id="prompt-input" 
                    class="popup-textarea" 
                    placeholder="Enter your prompt here..."
                    maxlength="4000"
                ></textarea>
                <div class="char-counter">
                    <span id="char-count">0</span>/4000
                </div>
            </div>
            
            <div class="llm-options">
                <label class="llm-option">
                    <input type="checkbox" id="use-gemini" checked>
                    <span>Gemini</span>
                </label>
                <label class="llm-option">
                    <input type="checkbox" id="use-chatgpt" checked>
                    <span>ChatGPT</span>
                </label>
            </div>
            
            <button id="send-button" class="send-btn" disabled>
                Send Prompt
            </button>
            
            <div class="status-section">
                <div class="status-title">Connection Status</div>
                <div class="status-item">
                    <span>Gemini:</span>
                    <span id="gemini-status" class="status-error">Checking...</span>
                </div>
                <div class="status-item">
                    <span>ChatGPT:</span>
                    <span id="chatgpt-status" class="status-error">Checking...</span>
                </div>
            </div>
            
            <div class="response-section">
                <div class="response-title">Last Response</div>
                <div id="response-content" class="response-content empty-response">
                    No responses yet. Send a prompt to get started!
                </div>
            </div>
        </div>
    </div>
    
    <script src="popup.js"></script>
</body>
</html>



---

### `dump_repo.py`

py
# dump_repo.py  (safe version: skips data files)
import os, pathlib, textwrap

ROOT = pathlib.Path(__file__).resolve().parent
OUT  = ROOT / "repo_dump.md"
MAX_KB = 200                        # still skip very large files

# File types we WANT to keep
CODE_EXTS = {
    ".py", ".ipynb", ".js", ".ts", ".tsx", ".jsx",
    ".java", ".go", ".rb", ".rs", ".cpp", ".c", ".h",
    ".md", ".toml", ".yaml", ".yml", ".jsonnet",
    ".html", ".css", ".scss", ".sh", ".bat", ".ps1",".lock",".env",'.toml', '.md'
}

# Or:  folders we want to ignore entirely
SKIP_DIRS = {"data", "datasets", "assets", ".git", "__pycache__", "bixbench/fhbixbench.egg-info",'bixbench/__pycache__','.github', "tests"}

SKIP_FILES = {                      # ALWAYS ignore these exact names
    ".gitignore",
    ".env",
    "uv.lock",
    "LICENSE",
    "pyproject.toml",
}
SKIP_EXTS  = {".toml"}              # ignore any file ending with these ext’s
# ---------------------------------------------------------------------------

def should_include(p: pathlib.Path) -> bool:
    if any(part in SKIP_DIRS for part in p.parts):
        return False
    if p.name in SKIP_FILES:
        return False
    if p.suffix.lower() in SKIP_EXTS:
        return False
    if p.suffix.lower() not in CODE_EXTS:
        return False
    if p.stat().st_size > MAX_KB * 1024:
        return False
    return True

def md_header(rel):
    lang = rel.suffix.lstrip(".") or "text"
    return f"\n\n---\n\n### `{rel}`\n\n{lang}"

with OUT.open("w", encoding="utf-8") as out:
    out.write(f"# Repository dump of {ROOT.name}\n")
    for p in ROOT.rglob("*"):
        if p.is_file() and should_include(p):
            rel = p.relative_to(ROOT)
            out.write(md_header(rel))
            out.write("\n" + p.read_text(errors="ignore") + "\n")

print(f"✅ Wrote {OUT}")


---

### `test-extension.md`

md
# Extension Testing Guide

## Latest Fixes Applied ✅

### Fixed Issues:
1. **Async Response Error** - ✅ Fixed message handling
2. **Connection Error** - ✅ Fixed messaging system  
3. **"Checking..." Status** - ✅ Fixed response handling
4. **Tab Detection** - ✅ Working for both Gemini and ChatGPT

## Testing Steps

### 1. Reload Extension
1. Go to `chrome://extensions/`
2. Find "Multi-LLM Coder"
3. Click the reload button (circular arrow icon)

### 2. Open Required Tabs
1. Open ChatGPT: https://chatgpt.com or https://chat.openai.com
2. Open Gemini: https://gemini.google.com
3. Make sure you're logged into both

### 3. Test Extension
1. Click the extension icon in Chrome toolbar
2. **Status should now show "Ready" for both LLMs** (not "Checking...")
3. Enter a test prompt: "Hello, please respond with just 'Hi there!'"
4. Select both Gemini and ChatGPT
5. Click "Send Prompt"

### 4. Expected Results
- ✅ No console errors
- ✅ Status shows "Ready" for detected LLMs
- ✅ Status shows "Not Connected" for missing LLMs
- ✅ Can select and send prompts
- ✅ Progress updates show during sending

### 5. Debug Console (if needed)
1. Right-click extension popup → "Inspect"
2. Check Console for any remaining errors
3. Background script logs show tab detection working

## What's Fixed
- Connection status updates immediately
- No more "Could not establish connection" errors
- No more async response errors
- Proper tab detection for both LLM services
- Clean messaging between popup and background script



---

### `README.md`

md
# Multi-LLM Coder Chrome Extension

A powerful Chrome extension that allows developers to send prompts simultaneously to multiple LLM providers (Gemini and ChatGPT) and compare responses side-by-side in a convenient Chrome side panel.

## ✨ Features

- **Multi-LLM Support**: Send prompts to Gemini and ChatGPT simultaneously
- **Side Panel Interface**: Persistent, accessible UI that doesn't interfere with your workflow
- **Response Comparison**: View responses side-by-side to compare different LLM outputs
- **Dark Theme**: Professional dark theme optimized for developers
- **Real-time Status**: Live connection status and progress indicators
- **Syntax Highlighting**: Code blocks are automatically highlighted
- **Keyboard Shortcuts**: Ctrl/Cmd+Enter to send prompts quickly

## 🚀 Installation

### Method 1: Load Unpacked Extension (Recommended for Development)

1. **Download or Clone** this repository to your local machine
2. **Open Chrome** and navigate to `chrome://extensions/`
3. **Enable Developer Mode** by toggling the switch in the top-right corner
4. **Click "Load unpacked"** and select the folder containing the extension files
5. **Pin the extension** by clicking the puzzle piece icon and pinning "Multi-LLM Coder"
6. **Open the side panel** from Chrome's toolbar and select "Multi-LLM Coder" to launch the extension

### Method 2: Manual Installation

1. Download all files from this repository
2. Ensure you have these files in a folder:
   - `manifest.json`
   - `sidepanel.html`
   - `sidepanel.js`
   - `background.js`
   - `selectors.js`
   - `styles.css`
3. Follow steps 2-6 from Method 1

## 📖 Usage

### Initial Setup

1. **Open LLM Websites**: 
   - Open [Gemini](https://gemini.google.com) in one tab
   - Open [ChatGPT](https://chat.openai.com) in another tab
   - Make sure you're logged into both services

2. **Open the Extension**:
   - Click the Multi-LLM Coder icon in your Chrome toolbar
   - Or use the keyboard shortcut (if configured)

### Sending Prompts

1. **Enter Your Prompt**: Type your question or request in the text area
2. **Select LLMs**: Check the boxes for Gemini and/or ChatGPT
3. **Send**: Click the "Send to LLMs" button or press Ctrl/Cmd+Enter
4. **View Responses**: Switch between tabs to see individual responses or use the Compare tab

### Interface Overview

- **Input Area**: Large text area with character counter
- **LLM Selection**: Checkboxes to choose which LLMs to query
- **Tabs**: 
  - **Gemini**: View Gemini's response
  - **ChatGPT**: View ChatGPT's response  
  - **Compare**: Side-by-side comparison view
- **Status Bar**: Shows connection status and last update time

## 🔧 How It Works

The extension uses Chrome's scripting API to interact with LLM websites:

1. **Tab Detection**: Finds open tabs with Gemini/ChatGPT
2. **Script Injection**: Injects JavaScript into the LLM websites
3. **DOM Interaction**: Fills input fields and clicks send buttons
4. **Response Monitoring**: Uses MutationObserver to detect when responses are complete
5. **Content Extraction**: Extracts response content and displays it in the side panel

## ⚠️ Important Notes

### Selector Updates
The extension relies on DOM selectors to interact with LLM websites. These may need updates when the websites change their interface. If the extension stops working:

1. Check the browser console for errors
2. Update selectors in `selectors.js` if needed
3. The selectors are the most volatile part of the extension

### Limitations
- Requires active tabs with Gemini and ChatGPT open
- Depends on website DOM structure (may break with UI updates)
- No offline functionality
- Responses are limited by the LLM websites' rate limits

## 🛠️ Development

### File Structure
```
chromeEX/
├── manifest.json          # Extension configuration
├── sidepanel.html         # Side panel UI
├── sidepanel.js          # UI logic and Chrome API communication
├── background.js         # Service worker for tab management
├── selectors.js          # DOM selectors for LLM websites
├── styles.css            # Dark theme styling
└── README.md            # This file
```

### Testing
- Use `python3 -m http.server 8000` to preview the UI at `http://localhost:8000/sidepanel.html`
- Check Chrome DevTools console for debugging information
- Test with both LLM websites open and logged in

### Updating Selectors
When LLM websites update their UI, update the selectors in `selectors.js`:

```javascript
const LLM_SELECTORS = {
    gemini: {
        input: 'textarea[placeholder*="Enter a prompt"]',
        sendButton: 'button[aria-label*="Send"]',
        // ... other selectors
    },
    chatgpt: {
        input: '#prompt-textarea',
        sendButton: 'button[data-testid="send-button"]',
        // ... other selectors
    }
};
```

## 🐛 Troubleshooting

### Extension Not Working
1. Check that you have Gemini/ChatGPT tabs open and loaded
2. Ensure you're logged into both services
3. Check the Chrome DevTools console for errors
4. Try refreshing the LLM website tabs

### No Responses Received
1. Verify the LLM websites are responsive
2. Check if selectors need updating
3. Look for errors in the background script console
4. Ensure the websites haven't changed their DOM structure

### Connection Status Shows "Not Connected"
1. Make sure the LLM websites are fully loaded
2. Check that the URLs match the host permissions in manifest.json
3. Try refreshing the extension

## 📝 License

This project is open source and available under the MIT License.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Common Contribution Areas
- Updating selectors when LLM websites change
- Adding support for new LLM providers
- Improving error handling and user feedback
- Enhancing the UI/UX

## 📞 Support

If you encounter issues:
1. Check this README for troubleshooting steps
2. Look at the browser console for error messages
3. Create an issue on the project repository
4. Include browser version, extension version, and error details

## 📦 Dependencies & Installation

### System Requirements
- **Google Chrome** (version 88 or higher)
- **Developer Mode** enabled in Chrome Extensions
- **Internet Connection** (for LLM website access)

### No Traditional Dependencies Required
This Chrome extension is built with vanilla JavaScript and doesn't require Node.js, npm, or any build tools. All dependencies are either:
- Built into Chrome (Extension APIs)
- Loaded from CDN (highlight.js)
- Native Web APIs

### Quick Setup Script
For a streamlined setup process, you can use this script:

```bash
#!/bin/bash
# Multi-LLM Coder Extension Setup Script

echo "🚀 Setting up Multi-LLM Coder Chrome Extension..."

# Check if Chrome is installed
if ! command -v google-chrome &> /dev/null && ! command -v chrome &> /dev/null; then
    echo "❌ Google Chrome not found. Please install Chrome first."
    echo "   Download from: https://www.google.com/chrome/"
    exit 1
fi

echo "✅ Chrome detected"

# Clone or download the repository
if [ ! -d "chromeEX" ]; then
    echo "📥 Downloading extension files..."
    # If using git:
    # git clone <repository-url> chromeEX
    # Or download and extract manually
    echo "   Please ensure all extension files are in the current directory"
fi

# Verify required files
required_files=("manifest.json" "sidepanel.html" "sidepanel.js" "background.js" "selectors.js" "styles.css")
missing_files=()

for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        missing_files+=("$file")
    fi
done

if [ ${#missing_files[@]} -ne 0 ]; then
    echo "❌ Missing required files:"
    printf '   - %s\n' "${missing_files[@]}"
    exit 1
fi

echo "✅ All required files present"

# Run tests (optional)
if [ -f "tests/test-runner.html" ]; then
    echo "🧪 Test files available"
    echo "   Open tests/test-runner.html in Chrome to run validation tests"
fi

echo ""
echo "🎉 Setup complete! Next steps:"
echo "   1. Open Chrome and go to chrome://extensions/"
echo "   2. Enable 'Developer mode' (toggle in top-right)"
echo "   3. Click 'Load unpacked' and select this directory"
echo "   4. Open Gemini (gemini.google.com) and ChatGPT (chat.openai.com)"
echo "   5. Click the extension icon to start using Multi-LLM Coder"
echo ""
echo "📚 For detailed instructions, see the Installation section in README.md"
```

### Manual Verification
To verify your setup, check that you have these files:

```bash
# Verify all required files are present
ls -la manifest.json sidepanel.html sidepanel.js background.js selectors.js styles.css

# Optional: Run a simple HTTP server to preview the UI
python3 -m http.server 8000
# Then visit: http://localhost:8000/sidepanel.html
```

### Development Dependencies (Optional)
If you want to contribute to the project or run tests:

```bash
# For running a local HTTP server (testing UI)
python3 -m http.server 8000

# For code formatting (if you have prettier installed globally)
npx prettier --write "*.js" "*.html" "*.css"

# For linting (if you have eslint installed globally)  
npx eslint *.js
```

### External Dependencies
The extension automatically loads these external resources:
- **highlight.js** (v11.9.0) - For syntax highlighting in code blocks
- **Material Icons** - For UI icons
- **Chrome Extension APIs** - Built into Chrome browser

### Troubleshooting Dependencies
If the extension doesn't work properly:

1. **Check Chrome Version**: Ensure you're using Chrome 88+
2. **Verify Files**: Run the verification script above
3. **Test Network**: Ensure you can access gemini.google.com and chat.openai.com
4. **Check Console**: Open Chrome DevTools and look for any error messages

### No Build Process Required
Unlike many modern web projects, this extension:
- ✅ Requires no compilation or build step
- ✅ Uses no package managers (npm, yarn, etc.)
- ✅ Has no node_modules directory
- ✅ Works directly with Chrome's built-in APIs
- ✅ Loads external libraries via CDN

This makes it easy to modify, debug, and deploy without complex tooling.



---

### `metadata.md`

md
# Multi-LLM Coder Extension - Metadata

## Development Progress

### Session 1 - Initial Setup, Tasks 1-4
- **Date**: 2024-12-19
- **Status**: Task 4 Complete - Moving to Task 5
- **Completed**: 
  - Project directory structure
  - Initial plan.md and metadata.md
  - manifest.json with Manifest V3 structure
  - Test infrastructure (test-runner.html, test-manifest.js)
  - All required permissions and configurations
  - selectors.js with DOM selectors for Gemini and ChatGPT
  - Comprehensive test suite for selectors validation
  - Helper functions for selector testing and validation
  - Complete sidepanel.html with modern UI structure
  - Comprehensive styles.css with dark theme and responsive design
- **Next**: Task 5 - sidepanel.js

## Technical Notes

### Architecture Decisions
- Using Chrome Extension Manifest V3
- Side panel approach for persistent UI
- No backend required for MVP
- Client-side only implementation
- Dark theme with modern design principles
- Responsive layout for various screen sizes

### Key Dependencies
- highlight.js for syntax highlighting
- Chrome APIs: sidePanel, scripting, storage, tabs
- MutationObserver for response detection
- Material Icons for UI elements

### Known Issues & Risks
1. **DOM Selectors**: Most fragile part - will need constant updates
2. **Response Detection**: MutationObserver logic needs careful implementation
3. **Cross-tab Communication**: Reliability concerns
4. **Website Changes**: External dependencies on Gemini/ChatGPT UI

### Testing Approach
- Test-driven development
- Unit tests for each module
- Integration tests for message passing
- Manual testing with live LLM websites

## File Status

| File | Status | Last Updated | Notes |
|------|--------|--------------|-------|
| plan.md | ✅ Complete | 2024-12-19 | Updated with Task 4 completion |
| metadata.md | ✅ Complete | 2024-12-19 | This file |
| manifest.json | ✅ Complete | 2024-12-19 | Manifest V3 with all permissions |
| tests/test-runner.html | ✅ Complete | 2024-12-19 | Test infrastructure with selectors tests |
| tests/test-manifest.js | ✅ Complete | 2024-12-19 | Manifest validation tests |
| tests/test-selectors.js | ✅ Complete | 2024-12-19 | Standalone selectors tests |
| selectors.js | ✅ Complete | 2024-12-19 | DOM selectors with helper functions |
| sidepanel.html | ✅ Complete | 2024-12-19 | Complete UI structure with modern design |
| styles.css | ✅ Complete | 2024-12-19 | Comprehensive dark theme styling |
| sidepanel.js | ⏳ In Progress | - | Next task |
| background.js | 📋 Planned | - | Service worker |

## Development Environment
- **OS**: macOS 24.4.0
- **Shell**: /bin/zsh
- **Project Path**: /Users/amt42/projects/chromeEX
- **Chrome Extension**: Manifest V3
- **Test Server**: Python HTTP server on port 8000

## Performance Targets
- Side panel load time: < 500ms
- Response processing: < 2s
- Memory usage: < 50MB
- CPU impact: Minimal when idle

## Task 4 Completion Notes
- Successfully created comprehensive styles.css with modern dark theme
- Implemented responsive design for various screen sizes
- Added CSS variables for easy theming and maintenance
- Styled all UI components including tabs, buttons, and form elements
- Added loading states, animations, and toast notifications
- Implemented proper scrollbar styling and accessibility features
- Created utility classes for common styling patterns

## UI/UX Design Features
- **Dark Theme**: Professional dark color scheme optimized for developers
- **Responsive Layout**: Adapts to different side panel sizes
- **Modern Components**: Custom checkboxes, buttons, and form elements
- **Tab Interface**: Clean tabbed navigation for different views
- **Code Highlighting**: Styled code blocks with copy functionality
- **Loading States**: Spinner and overlay for async operations
- **Toast Notifications**: User feedback system
- **Accessibility**: Proper focus states and screen reader support

## CSS Architecture
- **CSS Variables**: Centralized theming system
- **Component-based**: Modular styling approach
- **Responsive**: Mobile-first design principles
- **Performance**: Optimized animations and transitions
- **Maintainable**: Well-organized and documented code



---

### `SELECTOR_DEBUG.md`

md
# Selector Debug Guide

## What We Fixed

### Enhanced Selector Detection
- Added fallback selectors for both ChatGPT and Gemini
- Better error reporting showing what elements are available
- Debug logging to see exactly what's found

### ChatGPT Fallback Selectors
**Input:**
- `textarea[placeholder*="Message"]`
- `textarea[data-id="root"]`
- `textarea`
- `#prompt-textarea`
- `[contenteditable="true"]`

**Send Button:**
- `button[aria-label*="Send"]`
- `button[data-testid*="send"]`
- `button:has(svg)`
- `button[type="submit"]`
- `button:last-of-type`

### Gemini Fallback Selectors
**Input:**
- `textarea[placeholder*="Enter a prompt"]`
- `textarea[placeholder*="Ask"]`
- `textarea`
- `[contenteditable="true"]`
- `input[type="text"]`

**Send Button:**
- `button[aria-label*="Send"]`
- `button[data-testid*="send"]`
- `button:has(svg)`
- `button[type="submit"]`
- `button:last-of-type`

## Testing Steps

1. **Reload Extension**
2. **Open Browser Console** (F12 → Console)
3. **Send a Test Prompt**
4. **Check Console Output** for:
   - Number of textareas/inputs found
   - Which fallback selector worked
   - List of all available buttons (if send button fails)

## Expected Results

- Should find input elements even if primary selectors fail
- Should find send buttons using fallback selectors
- Better error messages showing what was actually found
- Messages should send to both LLMs successfully

## If Still Failing

The console will now show:
- All available textareas and inputs
- All available buttons with their HTML
- Which selectors were tried and which worked

This will help us update the selectors to match the current website structure.



---

### `plan.md`

md
# Multi-LLM Coder Extension - Development Plan

## Project Overview
A Chrome extension that allows developers to send prompts to multiple LLM providers (Gemini and ChatGPT) simultaneously and view responses side-by-side in a Chrome side panel.

## Current Status: Task 4 Complete - Moving to Task 5

## Project Structure
```
chromeEX/
├── manifest.json          # Chrome extension manifest (Manifest V3) ✅
├── background.js          # Service worker - orchestrates communication
├── sidepanel.html        # Side panel UI ✅
├── sidepanel.js          # Side panel logic
├── styles.css            # Styling for the extension ✅
├── selectors.js          # DOM selectors for LLM websites ✅
├── plan.md               # This file - development plan ✅
├── metadata.md           # Progress tracking and metadata ✅
└── tests/                # Test files ✅
    ├── test-manifest.js  # ✅
    ├── test-runner.html  # ✅
    ├── test-selectors.js # ✅
    └── test-background.js
```

## Task Breakdown

### ✅ Task 0: Project Setup
- [x] Create project directory
- [x] Create plan.md
- [x] Create metadata.md
- [x] Set up basic test structure

### ✅ Task 1: Create manifest.json
- [x] Create manifest.json with Manifest V3 structure
- [x] Define permissions: sidePanel, scripting, storage, tabs
- [x] Define host_permissions for Gemini and ChatGPT
- [x] Configure background service worker
- [x] Configure side panel
- [x] Add action for opening side panel
- [x] Write tests for manifest validation

### ✅ Task 2: Create selectors.js
- [x] Create selectors.js file
- [x] Define LLM_SELECTORS object structure
- [x] Add placeholder selectors for Gemini
- [x] Add placeholder selectors for ChatGPT
- [x] Document selector update process
- [x] Write tests for selector structure

### ✅ Task 3: Build sidepanel.html
- [x] Create HTML structure
- [x] Add input area with textarea
- [x] Add LLM selection checkboxes
- [x] Add send button
- [x] Create tabbed output area
- [x] Link CSS and JS files
- [x] Add highlight.js for syntax highlighting

### ✅ Task 4: Style with styles.css
- [x] Implement dark theme
- [x] Style input components
- [x] Style tabbed interface
- [x] Style code blocks
- [x] Add copy button styles
- [x] Make responsive layout

### ⏳ Task 5: Implement sidepanel.js
- [ ] Set up DOM references
- [ ] Implement tab switching
- [ ] Handle send button clicks
- [ ] Handle keyboard shortcuts (Ctrl/Cmd+Enter)
- [ ] Message passing to background.js
- [ ] Handle response display
- [ ] Implement code highlighting
- [ ] Add copy functionality
- [ ] Add "Send to..." functionality
- [ ] Write tests for UI logic

### 📋 Task 6: Implement background.js
- [ ] Set up service worker
- [ ] Handle extension installation
- [ ] Configure side panel behavior
- [ ] Implement message listeners
- [ ] Implement tab finding logic
- [ ] Implement script injection
- [ ] Handle response routing
- [ ] Error handling
- [ ] Write tests for background logic

### 📋 Task 7: Testing & Refinement
- [ ] Manual selector discovery
- [ ] Integration testing
- [ ] Error case testing
- [ ] Performance testing
- [ ] Documentation updates

## Testing Strategy
- Unit tests for each module
- Integration tests for message passing
- Manual testing with actual LLM websites
- Error scenario testing

## Known Challenges
1. DOM selectors will need frequent updates
2. MutationObserver logic for detecting response completion
3. Handling dynamic content on LLM websites
4. Cross-tab communication reliability

## Next Steps
1. ✅ Create metadata.md
2. ✅ Set up test structure
3. ✅ Begin Task 1: manifest.json 
4. ✅ Task 2: selectors.js
5. ✅ Task 3: sidepanel.html
6. ✅ Task 4: styles.css
7. ⏳ Task 5: sidepanel.js



---

### `sidepanel.html`

html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Multi-LLM Coder</title>
    
    <!-- Highlight.js for syntax highlighting -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
    
    <!-- Material Icons for UI elements -->
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0" />
    
    <!-- Main styles -->
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="container">
        <!-- Header -->
        <header class="header">
            <div class="header-content">
                <h1 class="title">Multi-LLM Coder</h1>
                <p class="subtitle">Compare responses from multiple AI models</p>
            </div>
        </header>

        <!-- Main Content Area -->
        <main class="main-content">
            <!-- Input Section -->
            <section class="input-section">
                <div class="prompt-container">
                    <div class="prompt-wrapper">
                        <textarea 
                            id="prompt-input" 
                            class="prompt-input" 
                            placeholder="Enter your prompt here... (Ctrl+Enter to send)"
                            rows="4"
                            maxlength="4000"
                        ></textarea>
                        <div class="input-footer">
                            <div class="char-counter">
                                <span id="char-count">0</span>/4000
                            </div>
                        </div>
                    </div>
                    
                    <!-- Controls -->
                    <div class="controls">
                        <div class="llm-selection">
                            <label class="checkbox-label">
                                <input type="checkbox" id="use-gemini" checked>
                                <span class="checkmark"></span>
                                <span class="llm-name">Gemini</span>
                                <span class="llm-status" id="gemini-status">Ready</span>
                            </label>
                            
                            <label class="checkbox-label">
                                <input type="checkbox" id="use-chatgpt" checked>
                                <span class="checkmark"></span>
                                <span class="llm-name">ChatGPT</span>
                                <span class="llm-status" id="chatgpt-status">Ready</span>
                            </label>
                        </div>
                        
                        <button id="send-button" class="send-button" disabled>
                            <span class="material-symbols-rounded">send</span>
                            <span class="button-text">Send Prompt</span>
                        </button>
                    </div>
                </div>
            </section>

            <!-- Output Section -->
            <section class="output-section">
                <!-- Tab Navigation -->
                <div class="tab-navigation">
                    <button class="tab-button active" data-target="gemini-output" id="gemini-tab">
                        <span class="tab-icon">🤖</span>
                        <span class="tab-label">Gemini</span>
                        <span class="tab-status" id="gemini-tab-status"></span>
                    </button>
                    
                    <button class="tab-button" data-target="chatgpt-output" id="chatgpt-tab">
                        <span class="tab-icon">💬</span>
                        <span class="tab-label">ChatGPT</span>
                        <span class="tab-status" id="chatgpt-tab-status"></span>
                    </button>
                    
                    <button class="tab-button" data-target="comparison-output" id="comparison-tab">
                        <span class="tab-icon">⚖️</span>
                        <span class="tab-label">Compare</span>
                        <span class="tab-status" id="comparison-tab-status"></span>
                    </button>
                </div>

                <!-- Tab Content -->
                <div class="tab-content-container">
                    <!-- Gemini Output -->
                    <div id="gemini-output" class="tab-content active">
                        <div class="output-header">
                            <h3 class="output-title">Gemini Response</h3>
                            <div class="output-actions">
                                <button class="action-button" id="copy-gemini" title="Copy Response">
                                    <span class="material-symbols-rounded">content_copy</span>
                                </button>
                                <button class="action-button" id="send-to-chatgpt" title="Send to ChatGPT">
                                    <span class="material-symbols-rounded">arrow_forward</span>
                                </button>
                                <button class="action-button" id="retry-gemini" title="Retry">
                                    <span class="material-symbols-rounded">refresh</span>
                                </button>
                            </div>
                        </div>
                        <div class="output-content" id="gemini-content">
                            <div class="empty-state">
                                <span class="material-symbols-rounded">psychology</span>
                                <p>Gemini response will appear here</p>
                            </div>
                        </div>
                    </div>

                    <!-- ChatGPT Output -->
                    <div id="chatgpt-output" class="tab-content">
                        <div class="output-header">
                            <h3 class="output-title">ChatGPT Response</h3>
                            <div class="output-actions">
                                <button class="action-button" id="copy-chatgpt" title="Copy Response">
                                    <span class="material-symbols-rounded">content_copy</span>
                                </button>
                                <button class="action-button" id="send-to-gemini" title="Send to Gemini">
                                    <span class="material-symbols-rounded">arrow_forward</span>
                                </button>
                                <button class="action-button" id="retry-chatgpt" title="Retry">
                                    <span class="material-symbols-rounded">refresh</span>
                                </button>
                            </div>
                        </div>
                        <div class="output-content" id="chatgpt-content">
                            <div class="empty-state">
                                <span class="material-symbols-rounded">chat</span>
                                <p>ChatGPT response will appear here</p>
                            </div>
                        </div>
                    </div>

                    <!-- Comparison Output -->
                    <div id="comparison-output" class="tab-content">
                        <div class="output-header">
                            <h3 class="output-title">Side-by-Side Comparison</h3>
                            <div class="output-actions">
                                <button class="action-button" id="copy-comparison" title="Copy Comparison">
                                    <span class="material-symbols-rounded">content_copy</span>
                                </button>
                                <button class="action-button" id="export-comparison" title="Export as Markdown">
                                    <span class="material-symbols-rounded">download</span>
                                </button>
                            </div>
                        </div>
                        <div class="comparison-container">
                            <div class="comparison-column">
                                <h4 class="comparison-header">Gemini</h4>
                                <div class="comparison-content" id="comparison-gemini">
                                    <div class="empty-state">
                                        <span class="material-symbols-rounded">psychology</span>
                                        <p>Gemini response</p>
                                    </div>
                                </div>
                            </div>
                            <div class="comparison-divider"></div>
                            <div class="comparison-column">
                                <h4 class="comparison-header">ChatGPT</h4>
                                <div class="comparison-content" id="comparison-chatgpt">
                                    <div class="empty-state">
                                        <span class="material-symbols-rounded">chat</span>
                                        <p>ChatGPT response</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </main>

        <!-- Footer -->
        <footer class="footer">
            <div class="footer-content">
                <div class="status-bar">
                    <span class="status-item" id="connection-status">
                        <span class="material-symbols-rounded">wifi</span>
                        <span class="status-text">Ready</span>
                    </span>
                    <span class="status-item" id="last-updated">
                        <span class="material-symbols-rounded">schedule</span>
                        <span class="status-text">Never</span>
                    </span>
                </div>
                <div class="footer-actions">
                    <button class="footer-button" id="clear-all" title="Clear All Responses">
                        <span class="material-symbols-rounded">clear_all</span>
                    </button>
                    <button class="footer-button" id="settings" title="Settings">
                        <span class="material-symbols-rounded">settings</span>
                    </button>
                    <button class="footer-button" id="help" title="Help">
                        <span class="material-symbols-rounded">help</span>
                    </button>
                </div>
            </div>
        </footer>
    </div>

    <!-- Loading Overlay -->
    <div id="loading-overlay" class="loading-overlay hidden">
        <div class="loading-content">
            <div class="loading-spinner"></div>
            <p class="loading-text">Processing your request...</p>
            <button class="cancel-button" id="cancel-request">
                <span class="material-symbols-rounded">close</span>
                Cancel
            </button>
        </div>
    </div>

    <!-- Toast Notifications -->
    <div id="toast-container" class="toast-container"></div>

    <!-- Main JavaScript -->
    <script src="sidepanel.js"></script>
</body>
</html>


