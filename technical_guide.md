# Technical Guide: Multi-Agent LLM Extension

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture Components](#architecture-components)
3. [Message Flow Diagrams](#message-flow-diagrams)
4. [Response Capture Mechanisms](#response-capture-mechanisms)
5. [Multi-Agent Session Management](#multi-agent-session-management)
6. [Integration Guide for New LLM Providers](#integration-guide-for-new-llm-providers)
7. [Troubleshooting and Best Practices](#troubleshooting-and-best-practices)

---

## System Overview

The Multi-Agent LLM Extension creates structured conversations between different AI models (ChatGPT and Gemini) by orchestrating message passing, response capture, and conversation state management across browser tabs.

### Key Innovation
The system works by:
1. **Intercepting user inputs** on LLM websites
2. **Capturing AI responses** through DOM observation
3. **Managing conversation state** in the background service worker
4. **Formatting contextual prompts** that include conversation history
5. **Automatically continuing conversations** between different LLM providers

---

## Architecture Components

### 1. Background Service Worker (`background.js`)
**Role**: Central orchestrator and state manager

**Key Responsibilities**:
- Session state management
- Message routing between components
- Tab management and LLM discovery
- Conversation flow control
- Prompt formatting with context

**Critical Data Structures**:
```javascript
const activeMultiAgentState = {
    isActive: false,
    maxIterations: 3,
    currentIteration: 0,
    currentTurnLLM: 'chatgpt',
    originalPrompt: '',
    conversationHistory: [], // {llm, content, iteration, timestamp}
    sessionId: 'session_timestamp_random',
    waitingForResponse: false
};
```

### 2. Content Scripts (`contentScript.js`)
**Role**: Interface with LLM websites and capture responses

**Injected into**: 
- `chat.openai.com` and `chatgpt.com` (ChatGPT)
- `gemini.google.com` (Gemini)

**Key Responsibilities**:
- DOM manipulation (input injection, button clicking)
- Response detection and capture
- User interaction monitoring
- Message passing to background script

### 3. Popup Interface (`popup.html` + `popup.js`)
**Role**: User interface and session control

**Key Features**:
- Multi-agent mode toggle
- Iteration count setting
- Real-time session status
- Progress tracking
- Session control (start/stop)

---

## Message Flow Diagrams

### Simple Forwarding Flow
```
User Types in ChatGPT → Content Script Detects → Background Script → 
→ Finds Gemini Tab → Injects Prompt → Gemini Responds → 
→ Content Script Captures → Background Script → Follow-up to ChatGPT
```

### Multi-Agent Session Flow
```
User Enables Multi-Agent Mode → Popup → Background Script →
→ Initialize Session State → Format Context Prompt →
→ Send to First LLM → Content Script Injects →
→ LLM Responds → Content Script Captures →
→ Background Script Processes → Format Next Turn →
→ Send to Next LLM → Repeat Until Max Iterations →
→ Session Complete
```

### Detailed Multi-Agent Message Sequence

1. **Session Initialization**
```javascript
// popup.js → background.js
{
    type: 'SEND_PROMPT',
    prompt: 'Original user question',
    multiAgent: { enabled: true, maxIterations: 3 },
    targets: { chatgpt: true, gemini: true }
}
```

2. **Background Processing**
```javascript
// background.js creates session and formats first prompt
{
    sessionId: 'session_12345',
    formattedPrompt: `You're in a multi-agent system... Original Question: ${prompt}`
}
```

3. **Content Script Notification**
```javascript
// background.js → contentScript.js
{
    type: 'NEW_MULTI_AGENT_PROMPT_SENT',
    sessionId: 'session_12345',
    timestamp: Date.now(),
    llmType: 'chatgpt',
    iteration: 1
}
```

4. **Response Capture**
```javascript
// contentScript.js → background.js
{
    type: 'MULTI_AGENT_RESPONSE_CAPTURED',
    content: 'LLM response text',
    sessionId: 'session_12345',
    sourceLLM: 'chatgpt',
    timestamp: Date.now()
}
```

---

## Response Capture Mechanisms

### Why Response Capture is Critical
The extension's power comes from accurately detecting when AI models finish responding and capturing their full response text. This is challenging because:
- Responses stream in real-time
- UI elements change dynamically
- Different providers have different DOM structures
- No official APIs for response detection

### ChatGPT Response Capture

**Challenge**: ChatGPT streams responses and has dynamic UI elements.

**Solution**: Multi-layered detection approach

```javascript
// Detection Method 1: Stop Button Monitoring
function isChatGPTGenerating() {
    const stopButton = document.querySelector('button[data-testid="stop-button"]');
    return stopButton && stopButton.offsetParent !== null;
}

// Detection Method 2: Response Text Extraction
function getChatGPTResponseText() {
    const messageContainers = document.querySelectorAll('div[data-testid^="conversation-turn-"]');
    for (let i = messageContainers.length - 1; i >= 0; i--) {
        const turn = messageContainers[i];
        const authorRole = turn.querySelector('[data-message-author-role]');
        if (authorRole?.getAttribute('data-message-author-role') === 'assistant') {
            const responseContent = turn.querySelector('.markdown, .prose');
            if (responseContent) {
                return responseContent.innerText?.trim();
            }
        }
    }
    return '';
}

// Stability Check: Wait for text to stop changing
if (responseText === lastResponseText) {
    stableCounter++;
} else {
    stableCounter = 0;
    lastResponseText = responseText;
}
if (stableCounter >= 3) { /* Response is stable, capture it */ }
```

**Key ChatGPT Selectors**:
- Input: `#prompt-textarea`, `textarea[data-testid="prompt-textarea"]`
- Send Button: `button[data-testid="send-button"]`
- Stop Button: `button[data-testid="stop-button"]`
- Response: `div[data-testid^="conversation-turn-"] .markdown`

### Gemini Response Capture

**Challenge**: Gemini uses contenteditable divs and different UI patterns.

**Solution**: Icon state monitoring + DOM observation

```javascript
// Detection Method: Icon State Transitions
function getCurrentIconState() {
    const micIcon = document.querySelector('mat-icon[fonticon="mic"]');
    const sendIcon = document.querySelector('mat-icon[fonticon="send"]');
    const stopIcon = document.querySelector('mat-icon[fonticon="stop"]');
    
    if (stopIcon) return 'stop';     // Currently generating
    if (micIcon) return 'mic';       // Ready for input (complete)
    if (sendIcon) return 'send';     // Text typed, not sent
    return 'unknown';
}

// Smart Transition Detection
if (lastIconState === 'stop' && currentIconState === 'mic') {
    // Response just completed! Capture after 500ms for stability
    setTimeout(() => captureResponse(), 500);
}
```

**Key Gemini Selectors**:
- Input: `div.ql-editor[role="textbox"]`
- Send Button: `button[aria-label="Send message"]`
- Response: Last element in conversation that's not user-authored

### Response Capture Architecture

```javascript
// Both LLMs use this pattern:
1. Monitor for prompt injection notification
2. Reset capture state
3. Watch for completion signals
4. Extract response text when stable
5. Send to background script with session context
```

---

## Multi-Agent Session Management

### Session Lifecycle

**1. Initialization**
```javascript
function handleStartMultiAgentSession(message, sender) {
    resetMultiAgentState();
    activeMultiAgentState.isActive = true;
    activeMultiAgentState.sessionId = generateSessionId();
    activeMultiAgentState.originalPrompt = prompt;
    // ... format and send first prompt
}
```

**2. Turn Processing**
```javascript
function handleMultiAgentResponse(message) {
    // Add response to conversation history
    activeMultiAgentState.conversationHistory.push({
        llm: sourceLLM,
        content: content,
        iteration: currentIteration,
        timestamp: Date.now()
    });
    
    // Determine next turn
    const nextLLM = sourceLLM === 'chatgpt' ? 'gemini' : 'chatgpt';
    
    // Check if session should continue
    if (currentIteration >= maxIterations) {
        endMultiAgentSession();
        return;
    }
    
    // Format and send next turn
    const formattedPrompt = formatMultiAgentPrompt(nextLLM, nextIteration, history);
    sendMultiAgentTurn(nextLLM, formattedPrompt, sessionId);
}
```

**3. Context Formatting**
```javascript
function formatMultiAgentPrompt(targetLLM, iteration, originalPrompt, history) {
    let prompt = `You're in a multi-agent system where ChatGPT and Gemini will collaborate for ${maxIterations} iterations.\n\n`;
    prompt += `Current Status: Iteration ${iteration}/${maxIterations}, ${targetLLM}'s turn\n\n`;
    prompt += `Original User Question: ${originalPrompt}\n\n`;
    
    if (history.length > 0) {
        prompt += `Previous Exchanges:\n`;
        history.forEach(entry => {
            prompt += `${entry.llm.toUpperCase()}: ${entry.content}\n\n`;
        });
    }
    
    prompt += `Now respond as ${targetLLM.toUpperCase()}. Be constructive, collaborative, and critical.`;
    return prompt;
}
```

### Session State Synchronization

**Challenge**: Keep UI and background state synchronized across different tabs and components.

**Solution**: Event-driven updates with message passing

```javascript
// Background sends progress updates
sendMessageToPopup({
    type: 'MULTI_AGENT_TURN_COMPLETE',
    sessionId: sessionId,
    currentIteration: iteration,
    currentTurnLLM: nextLLM,
    conversationHistory: history
});

// Popup updates UI
function handleMultiAgentTurnComplete(message) {
    sessionIteration.textContent = message.currentIteration;
    currentTurn.textContent = `${message.currentTurnLLM.toUpperCase()}'s turn`;
    // Show latest response...
}
```

---

## Integration Guide for New LLM Providers

### Step 1: Add Provider to Architecture

**1.1 Update manifest.json**
```javascript
"host_permissions": [
    "https://your-llm-provider.com/*"
],
"content_scripts": [
    {
        "matches": ["https://your-llm-provider.com/*"],
        "js": ["contentScript.js"]
    }
]
```

**1.2 Add Provider Detection**
```javascript
// In contentScript.js
const isYourLLM = location.hostname.includes('your-llm-provider.com');
if (!isChatGPT && !isGemini && !isYourLLM) return;

const currentLLM = isChatGPT ? 'chatgpt' : 
                   isGemini ? 'gemini' : 
                   isYourLLM ? 'yourllm' : 'unknown';
```

### Step 2: Implement DOM Selectors

**2.1 Identify UI Elements**
You need to find selectors for:
- Input field (textarea or contenteditable)
- Send button
- Stop/generating indicator
- Response containers

**2.2 Add to Selector Maps**
```javascript
// Input selectors
const inputSelectors = {
    chatgpt: ['#prompt-textarea', ...],
    gemini: ['div.ql-editor[role="textbox"]', ...],
    yourllm: ['your-input-selector', 'fallback-selector']
};

// Button selectors
const buttonSelectors = {
    chatgpt: ['button[data-testid="send-button"]', ...],
    gemini: ['button[aria-label="Send message"]', ...],
    yourllm: ['your-send-button-selector']
};
```

### Step 3: Implement Response Capture

**3.1 Understand Your Provider's Patterns**
- How does it indicate response is generating?
- How does it signal completion?
- What's the DOM structure of responses?
- Does it stream or load at once?

**3.2 Create Provider-Specific Capture Logic**
```javascript
if (isYourLLM) {
    function observeYourLLMResponses() {
        // Provider-specific capture logic
        let lastResponseText = '';
        let stableCounter = 0;
        let currentPromptId = null;
        
        // Listen for prompt notifications
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'NEW_PROMPT_SENT' || message.type === 'NEW_MULTI_AGENT_PROMPT_SENT') {
                currentPromptId = message.promptId || message.sessionId;
                // Reset capture state...
            }
        });
        
        // Implement completion detection
        function isResponseComplete() {
            // Your provider-specific logic
            const loadingIndicator = document.querySelector('your-loading-selector');
            return !loadingIndicator; // or whatever indicates completion
        }
        
        // Extract response text
        function getResponseText() {
            const responses = document.querySelectorAll('your-response-selector');
            if (responses.length > 0) {
                const lastResponse = responses[responses.length - 1];
                return lastResponse.innerText?.trim();
            }
            return '';
        }
        
        // Capture and send logic
        function captureAndSend() {
            if (!isResponseComplete()) return;
            const text = getResponseText();
            if (!text || text === lastResponseText) return;
            
            lastResponseText = text;
            stableCounter++;
            
            if (stableCounter >= 2) { // Adjust stability threshold
                const isMultiAgent = currentPromptId?.startsWith('session_');
                chrome.runtime.sendMessage({
                    type: isMultiAgent ? 'MULTI_AGENT_RESPONSE_CAPTURED' : 'YOURLLM_RESPONSE_CAPTURED',
                    content: text,
                    promptId: currentPromptId,
                    sessionId: isMultiAgent ? currentPromptId : null,
                    sourceLLM: 'yourllm',
                    timestamp: Date.now()
                });
            }
        }
        
        // Set up observers
        const observer = new MutationObserver(captureAndSend);
        observer.observe(document.body, { childList: true, subtree: true });
        setInterval(captureAndSend, 3000);
    }
    
    setTimeout(observeYourLLMResponses, 3000);
}
```

### Step 4: Update Background Script

**4.1 Add Provider to Tab Finding**
```javascript
async function findLLMTab(llmType) {
    const urlPatterns = {
        gemini: ['*://gemini.google.com/*'],
        chatgpt: ['*://chat.openai.com/*', '*://chatgpt.com/*'],
        yourllm: ['*://your-llm-provider.com/*']
    };
    // ... rest of function
}
```

**4.2 Add Response Handler**
```javascript
// In onMessage listener
case 'YOURLLM_RESPONSE_CAPTURED':
    handleYourLLMResponse(message);
    sendResponse({ status: 'yourllm_response_received', type: message.type });
    break;

function handleYourLLMResponse(message) {
    // Similar to handleGeminiResponse/handleChatGPTResponse
    // Update follow-up state or multi-agent state as needed
}
```

### Step 5: Update UI Components

**5.1 Add Provider to Popup**
```html
<label class="llm-option">
    <input type="checkbox" id="use-yourllm">
    <span>YourLLM</span>
</label>
```

**5.2 Update JavaScript**
```javascript
const useYourLLM = document.getElementById('use-yourllm');
// Add event listeners and update logic...
```

### Step 6: Testing Checklist

**6.1 Basic Functionality**
- [ ] Extension loads on provider's website
- [ ] Can find input field and send button
- [ ] Can inject text and trigger send
- [ ] Can detect response completion
- [ ] Can extract response text accurately

**6.2 Integration Testing**
- [ ] Simple forwarding works (Provider → Others)
- [ ] Simple forwarding works (Others → Provider)
- [ ] Multi-agent sessions include provider
- [ ] Response capture works in multi-agent mode
- [ ] UI updates correctly with provider responses

**6.3 Edge Cases**
- [ ] Very long responses
- [ ] Rapid-fire interactions
- [ ] Network interruptions
- [ ] Tab switching during responses
- [ ] Provider UI updates/changes

---

## Troubleshooting and Best Practices

### Common Issues and Solutions

**1. Response Capture Fails**
- **Symptoms**: Extension doesn't detect responses or captures partial text
- **Causes**: DOM structure changed, selectors outdated, timing issues
- **Solutions**: 
  - Update selectors by inspecting current DOM
  - Adjust stability thresholds
  - Add more fallback selectors
  - Increase observation delays

**2. Prompt Injection Fails**
- **Symptoms**: Text doesn't appear in input field or send doesn't trigger
- **Causes**: Input method incompatibility, missing events, security restrictions
- **Solutions**:
  - Use native property setters
  - Dispatch proper input events
  - Try different injection methods (execCommand, setValue, etc.)

**3. Multi-Agent Sessions Get Stuck**
- **Symptoms**: Session doesn't progress between turns
- **Causes**: Response not captured, session state corruption, tab issues
- **Solutions**:
  - Add session timeout mechanisms
  - Implement session recovery
  - Add manual session reset options

### Best Practices

**1. Robust Selector Strategy**
```javascript
// Always provide multiple selector fallbacks
const selectors = [
    'primary-selector',           // Most specific
    'secondary-selector',         // Backup
    'generic-selector',          // Last resort
    '[aria-label*="keyword"]'    // Semantic fallback
];
```

**2. Defensive Response Capture**
```javascript
// Always validate captured content
function validateResponse(text) {
    return text && 
           text.length > 10 && 
           !text.includes('error') && 
           text !== lastCapturedText;
}
```

**3. State Management**
```javascript
// Always provide cleanup mechanisms
function resetState() {
    // Clear all timeouts
    // Reset all flags
    // Clean up observers
    // Notify other components
}
```

**4. Error Handling**
```javascript
// Wrap all critical operations
try {
    const result = riskyOperation();
    handleSuccess(result);
} catch (error) {
    console.error('[Provider] Operation failed:', error);
    notifyUser('Something went wrong, please try again');
    resetToSafeState();
}
```

### Performance Considerations

**1. Observer Efficiency**
- Use specific target elements for MutationObserver
- Debounce frequent operations
- Disconnect observers when not needed

**2. Memory Management**
- Clear large response texts after processing
- Limit conversation history size
- Clean up event listeners properly

**3. Network Efficiency**
- Batch message sending when possible
- Avoid frequent status updates
- Implement exponential backoff for retries

---

## Conclusion

The Multi-Agent LLM Extension's success comes from:

1. **Robust Response Detection**: Multiple fallback methods for different providers
2. **Centralized State Management**: Clean separation between UI, orchestration, and capture
3. **Event-Driven Architecture**: Loose coupling through message passing
4. **Provider Abstraction**: Modular design that makes adding new LLMs straightforward

The key insight is that each LLM provider requires provider-specific DOM interaction and response capture, but the orchestration logic remains the same. This allows the system to scale to new providers by implementing the capture interface without changing the core conversation management logic.

When integrating new providers, focus on getting reliable response capture first - everything else builds on that foundation.