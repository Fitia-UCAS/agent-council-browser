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
    
    // Multi-agent elements
    const multiAgentMode = document.getElementById('multi-agent-mode');
    const multiAgentControls = document.getElementById('multi-agent-controls');
    const iterationsInput = document.getElementById('iterations-input');
    const sessionStatus = document.getElementById('session-status');
    const sessionIteration = document.getElementById('session-iteration');
    const sessionMax = document.getElementById('session-max');
    const currentTurn = document.getElementById('current-turn');
    const stopSessionBtn = document.getElementById('stop-session-btn');
    
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
        
        // Multi-agent controls
        if (multiAgentMode) {
            multiAgentMode.addEventListener('change', handleMultiAgentModeToggle);
        }
        if (iterationsInput) {
            iterationsInput.addEventListener('change', updateSendButtonState);
        }
        if (stopSessionBtn) {
            stopSessionBtn.addEventListener('click', handleStopSession);
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
        const multiAgentEnabled = multiAgentMode?.checked;
        const maxIterations = parseInt(iterationsInput?.value) || 3;
        
        if (!prompt) {
            showMessage('Please enter a prompt', 'error');
            return;
        }
        
        if (!geminiSelected && !chatgptSelected) {
            showMessage('Please select at least one LLM', 'error');
            return;
        }
        
        if (multiAgentEnabled && (!geminiSelected || !chatgptSelected)) {
            showMessage('Multi-agent mode requires both ChatGPT and Gemini to be selected', 'error');
            return;
        }
        
        console.log('📤 Sending prompt:', prompt, { multiAgent: multiAgentEnabled, maxIterations });
        
        // Update UI
        sendButton.disabled = true;
        sendButton.textContent = multiAgentEnabled ? 'Starting Session...' : 'Sending...';
        
        if (multiAgentEnabled) {
            showMessage(`Starting multi-agent session with ${maxIterations} iterations...`, 'info');
            sessionMax.textContent = maxIterations;
            sessionIteration.textContent = '1';
            currentTurn.textContent = 'Starting...';
            sessionStatus.style.display = 'block';
        } else {
            showMessage('Sending prompt to selected LLMs...', 'info');
        }
        
        // Send to background script
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'SEND_PROMPT',
                prompt: prompt,
                targets: {
                    gemini: geminiSelected,
                    chatgpt: chatgptSelected
                },
                multiAgent: multiAgentEnabled ? {
                    enabled: true,
                    maxIterations: maxIterations
                } : { enabled: false }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error sending prompt:', chrome.runtime.lastError);
                    showMessage('Error sending prompt to background script', 'error');
                    resetSendButton();
                } else {
                    console.log('Prompt sent successfully:', response);
                    if (!multiAgentEnabled) {
                        resetSendButton();
                    }
                }
            });
        }
        
        // Update status
        if (!multiAgentEnabled) {
            if (geminiSelected) updateLLMStatus('gemini', 'Sending...', 'processing');
            if (chatgptSelected) updateLLMStatus('chatgpt', 'Sending...', 'processing');
        }
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
            case 'MULTI_AGENT_SESSION_STARTED':
                handleMultiAgentSessionStarted(message);
                sendResponse({ status: 'handled' });
                break;
            case 'MULTI_AGENT_TURN_COMPLETE':
                handleMultiAgentTurnComplete(message);
                sendResponse({ status: 'handled' });
                break;
            case 'MULTI_AGENT_SESSION_ENDED':
                handleMultiAgentSessionEnded(message);
                sendResponse({ status: 'handled' });
                break;
            case 'MULTI_AGENT_SESSION_ERROR':
                handleMultiAgentSessionError(message);
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
    
    // MULTI-AGENT MODE HANDLERS
    
    function handleMultiAgentModeToggle() {
        const enabled = multiAgentMode?.checked;
        if (multiAgentControls) {
            multiAgentControls.style.display = enabled ? 'block' : 'none';
        }
        
        if (enabled) {
            // Auto-select both LLMs when multi-agent is enabled
            if (useGemini) useGemini.checked = true;
            if (useChatGPT) useChatGPT.checked = true;
        }
        
        updateSendButtonState();
    }
    
    function handleStopSession() {
        if (chrome && chrome.runtime) {
            chrome.runtime.sendMessage({
                type: 'END_MULTI_AGENT_SESSION',
                reason: 'User requested stop'
            }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Error stopping session:', chrome.runtime.lastError);
                } else {
                    console.log('Session stop requested:', response);
                }
            });
        }
        resetMultiAgentUI();
    }
    
    function handleMultiAgentSessionStarted(message) {
        const { sessionId, maxIterations, currentIteration, currentTurnLLM } = message;
        console.log('🤖 Multi-agent session started:', message);
        
        if (sessionStatus) {
            sessionStatus.style.display = 'block';
        }
        if (sessionMax) {
            sessionMax.textContent = maxIterations;
        }
        if (sessionIteration) {
            sessionIteration.textContent = currentIteration;
        }
        if (currentTurn) {
            currentTurn.textContent = `${currentTurnLLM.toUpperCase()}'s turn`;
        }
        
        showMessage(`Multi-agent session started! Session ID: ${sessionId}`, 'success');
    }
    
    function handleMultiAgentTurnComplete(message) {
        const { sessionId, currentIteration, currentTurnLLM, conversationHistory } = message;
        console.log('🤖 Multi-agent turn complete:', message);
        
        if (sessionIteration) {
            sessionIteration.textContent = currentIteration;
        }
        if (currentTurn) {
            currentTurn.textContent = `${currentTurnLLM.toUpperCase()}'s turn`;
        }
        
        // Show the latest response in the response section
        if (conversationHistory && conversationHistory.length > 0) {
            const latestResponse = conversationHistory[conversationHistory.length - 1];
            showResponse(`${latestResponse.llm} (Iteration ${latestResponse.iteration})`, latestResponse.content);
        }
        
        showMessage(`Turn complete. Now ${currentTurnLLM}'s turn (Iteration ${currentIteration})`, 'info');
    }
    
    function handleMultiAgentSessionEnded(message) {
        const { summary } = message;
        console.log('🤖 Multi-agent session ended:', message);
        
        showMessage(`Multi-agent session completed! Total iterations: ${summary.totalIterations}`, 'success');
        
        // Show final conversation summary
        if (summary.conversationHistory && summary.conversationHistory.length > 0) {
            const finalExchange = summary.conversationHistory[summary.conversationHistory.length - 1];
            showResponse(`Final Response (${finalExchange.llm})`, finalExchange.content);
        }
        
        resetMultiAgentUI();
    }
    
    function handleMultiAgentSessionError(message) {
        const { error, sessionId } = message;
        console.error('🤖 Multi-agent session error:', message);
        
        showMessage(`Multi-agent session error: ${error}`, 'error');
        resetMultiAgentUI();
    }
    
    function resetMultiAgentUI() {
        if (sessionStatus) {
            sessionStatus.style.display = 'none';
        }
        if (currentTurn) {
            currentTurn.textContent = 'Ready';
        }
        if (sessionIteration) {
            sessionIteration.textContent = '0';
        }
        
        resetSendButton();
    }
});
