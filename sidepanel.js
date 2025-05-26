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
    
    console.log('📋 DOM elements found:', {
        promptInput: !!promptInput,
        sendButton: !!sendButton,
        charCount: !!charCount,
        useGemini: !!useGemini,
        useChatGPT: !!useChatGPT
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