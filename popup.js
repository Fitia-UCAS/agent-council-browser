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