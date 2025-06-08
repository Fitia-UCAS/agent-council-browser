# LLM Integration Guide

## Overview

This guide explains how to integrate new AI providers (like Claude, Grok, Perplexity) into the Multi-LLM Coder Chrome extension. The extension enables seamless communication between different AI providers through two main features:

### Feature 1: Cross-Provider Message Sending

**What it does:** When you send a prompt in one AI provider (e.g., ChatGPT), the extension can automatically send the same prompt to another provider (e.g., Gemini) simultaneously.

**How it works:**

1. User types a prompt in ChatGPT and enables the "⇄ Gemini" toggle
2. When user clicks Send, the extension captures the prompt text
3. Extension finds Gemini's input field and send button in another tab
4. Extension automatically fills Gemini's input and clicks send
5. Both AIs now process the same prompt simultaneously

**Technical challenges:**

- Each AI provider uses different web frameworks (React, Angular, Vue)
- Input fields require different value-setting techniques
- DOM selectors change frequently when providers update their UIs
- Send buttons have varying attributes and visibility states

### Feature 2: Auto-Follow-Up (Response Detection)

**What it does:** After both AIs respond, the extension captures the second AI's response and automatically creates a comparative follow-up prompt in the first AI.

**How it works:**

1. Extension monitors the second AI (e.g., Gemini) for response completion
2. When response is complete, extension extracts only the latest response text
3. Extension constructs a follow-up prompt: "I also asked Gemini... [Gemini's response]... Could you compare and enhance your answer?"
4. Extension injects this follow-up into the first AI's input field (without auto-sending)
5. User can review and send the comparison prompt

**Technical challenges:**

- Detecting when AI finishes generating response (streaming responses)
- Extracting only the latest response (not entire chat history)
- Avoiding race conditions and duplicate captures
- Managing state between multiple prompt-response cycles

### Integration Complexity

Adding a new provider requires:

1. **Framework analysis** - Understanding React/Angular/Vue input handling
2. **DOM investigation** - Finding reliable selectors for inputs and buttons  
3. **Response detection** - Identifying completion signals (icons, buttons, loading states)
4. **State management** - Preventing race conditions and ensuring reliable capture

This guide provides step-by-step instructions for both features, with real code examples and lessons learned from implementing ChatGPT ↔ Gemini integration.

## Part 1: Basic Integration (Sending Messages)

### Step 1: Investigate the Provider

Open the provider's website and use DevTools console:

```javascript
// 1. Check framework
console.log('React:', !!window.React);
console.log('Vue:', !!window.Vue); 
console.log('Angular:', !!window.angular);

// 2. Find input element
document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');

// 3. Find send button
document.querySelectorAll('button[aria-label*="Send"], button[data-testid*="send"], form button');
```

### Step 2: Create Provider Configuration

```javascript
const newProviderConfig = {
  name: 'ProviderName',
  domains: ['provider.com'],
  framework: 'react', // or 'angular', 'vue', 'unknown'
  
  // Input selectors (ordered by reliability)
  inputSelectors: [
    'textarea#main-input',           // Most specific
    'textarea[placeholder*="Ask"]',  // Placeholder-based
    '[contenteditable="true"]',      // Generic fallback
    'textarea'                       // Last resort
  ],
  
  // Send button selectors
  sendButtonSelectors: [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]'
  ]
};
```

### Step 3: Input Value Setting (Framework-Specific)

```javascript
function setInputValue(element, text, framework) {
  element.focus();
  
  switch (framework) {
    case 'react':
      // React requires native property setter
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      break;
      
    case 'contenteditable':
      // For contenteditable divs (like Gemini)
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      break;
      
    default:
      // Standard input/textarea
      element.value = text;
      element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
```

### Step 4: Robust Element Finding

```javascript
function findElement(selectors, validationFn = null) {
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (isElementUsable(el) && (!validationFn || validationFn(el))) {
        return el;
      }
    }
  }
  return null;
}

function isElementUsable(element) {
  const style = window.getComputedStyle(element);
  return element.offsetParent !== null &&
         style.display !== 'none' &&
         style.visibility !== 'hidden' &&
         !element.disabled &&
         element.offsetHeight > 0;
}
```

### Step 5: Integration in contentScript.js

```javascript
// Add to provider detection
const providers = {
  // ... existing providers
  newprovider: {
    domains: ['newprovider.com'],
    config: newProviderConfig
  }
};

// Add to simpleInteraction function in background.js
const inputSelectors = {
  'chatgpt': ['#prompt-textarea'],
  'gemini': ['div.ql-editor[role="textbox"]'],
  'newprovider': newProviderConfig.inputSelectors  // Add this
};
```

## Part 2: Follow-Up Feature (Response Detection)

### Step 1: Analyze Response Generation States

Look for UI indicators that show generation status:

```javascript
// Monitor the provider while it generates a response
function analyzeGenerationStates() {
  console.log('=== GENERATION STATE ANALYSIS ===');
  
  // Check for stop buttons
  console.log('Stop buttons:', document.querySelectorAll('button[aria-label*="Stop"]'));
  
  // Check for disabled inputs
  console.log('Disabled inputs:', document.querySelectorAll('input[disabled], [aria-disabled="true"]'));
  
  // Check for loading indicators
  console.log('Loading elements:', document.querySelectorAll('.loading, .spinner, [class*="loading"]'));
  
  // Check for icon states (like Gemini's fonticon system)
  console.log('Icons:', document.querySelectorAll('mat-icon[fonticon], i[class*="icon"], svg[class*="icon"]'));
}
```

### Step 2: Response Detection Strategy

Choose the most reliable method for your provider:

#### Method 1: Icon State Detection (Best - like Gemini)

```javascript
function getCurrentIconState() {
  // Adapt these selectors to your provider's icon system
  const stopIcon = document.querySelector('mat-icon[fonticon="stop"]');
  const readyIcon = document.querySelector('mat-icon[fonticon="mic"]');
  
  if (stopIcon) return 'generating';
  if (readyIcon) return 'ready';
  return 'unknown';
}

function detectCompletion() {
  const currentState = getCurrentIconState();
  
  // Detect the critical transition: generating → ready
  if (lastIconState === 'generating' && currentState === 'ready') {
    console.log('Response completion detected via icon transition!');
    
    // Wait 500ms for stability then capture
    setTimeout(() => {
      if (getCurrentIconState() === 'ready') {
        captureResponse();
      }
    }, 500);
  }
  
  lastIconState = currentState;
}
```

#### Method 2: Button State Detection

```javascript
function isResponseComplete() {
  // Check if stop button disappeared
  const stopButton = document.querySelector('button[aria-label*="Stop generating"]');
  if (stopButton) return false;
  
  // Check if input is re-enabled
  const input = document.querySelector('textarea, [contenteditable="true"]');
  if (input && (input.disabled || input.getAttribute('aria-disabled') === 'true')) {
    return false;
  }
  
  return true; // Likely complete
}
```

#### Method 3: Content Stability Detection (Fallback)

```javascript
let lastResponseText = '';
let stableCount = 0;

function checkContentStability() {
  const currentText = getResponseText();
  
  if (currentText === lastResponseText) {
    stableCount++;
    if (stableCount >= 3) { // Stable for 3 checks
      captureResponse();
    }
  } else {
    stableCount = 0;
    lastResponseText = currentText;
  }
}
```

### Step 3: Response Text Extraction

```javascript
function getResponseText() {
  // Strategy 1: Provider-specific selectors
  const responseSelectors = [
    '.ai-response',           // Provider-specific class
    '.message.assistant',     // Generic assistant message
    '[data-role="assistant"]', // Role-based
    '.response-content'       // Generic response content
  ];
  
  // Get ONLY the latest response (not entire chat history)
  for (const selector of responseSelectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      const lastElement = elements[elements.length - 1]; // Only the last one!
      
      // Make sure it's not a user message
      if (!isUserMessage(lastElement)) {
        const text = lastElement.innerText || lastElement.textContent;
        if (text && text.trim()) return text.trim();
      }
    }
  }
  
  return '';
}

function isUserMessage(element) {
  return element.classList.contains('user-message') ||
         element.querySelector('.user-message') ||
         element.hasAttribute('data-author-is-user');
}
```

### Step 4: Critical Race Condition Prevention

```javascript
// The key lesson: prevent duplicate captures with immediate locking
function captureResponse() {
  if (!captureComplete && pendingPromptTimestamp > 0 && currentPromptId) {
    
    // CRITICAL: Set complete IMMEDIATELY to prevent duplicates
    captureComplete = true;
    
    const responseText = getResponseText();
    if (responseText && responseText !== lastResponseText) {
      
      chrome.runtime.sendMessage({
        type: 'PROVIDER_RESPONSE_CAPTURED',
        content: responseText,
        promptId: currentPromptId,
        timestamp: Date.now()
      }, response => {
        if (chrome.runtime.lastError) {
          // Reset on error to allow retry
          captureComplete = false;
        } else {
          // Only clear state after successful send
          lastResponseText = responseText;
          currentPromptId = null;
        }
      });
    }
  }
}
```

### Step 5: State Management

```javascript
// Complete state reset when starting new prompt
function resetStateForNewPrompt() {
  captureComplete = false;
  currentPromptId = null;
  pendingPromptTimestamp = 0;
  lastResponseText = '';
  lastIconState = null;
  
  // Clear any pending timeouts
  if (stateTransitionTimeout) {
    clearTimeout(stateTransitionTimeout);
    stateTransitionTimeout = null;
  }
}

// Call this when new prompt is sent
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NEW_PROMPT_SENT') {
    resetStateForNewPrompt();
    currentPromptId = message.promptId;
    pendingPromptTimestamp = message.timestamp;
  }
});
```

## Quick Integration Checklist

### For Basic Integration

- [ ] Identify framework (React/Angular/Vue)
- [ ] Find input selectors (test in console)
- [ ] Find send button selectors
- [ ] Test value setting method for the framework
- [ ] Add to provider configuration
- [ ] Test sending messages

### For Follow-Up Feature

- [ ] Analyze generation state indicators
- [ ] Choose detection method (icon/button/content stability)
- [ ] Find response text selectors
- [ ] Implement state transition detection
- [ ] Add race condition prevention
- [ ] Test response capture timing

### Common Pitfalls

- ❌ **React value setting**: Use native property setter, not `element.value`
- ❌ **Capturing entire chat**: Extract only the latest response
- ❌ **Race conditions**: Lock capture immediately, clear state only after success
- ❌ **Stale responses**: Always validate response belongs to current prompt
- ❌ **Missing events**: Dispatch proper events after setting values

This guide covers the essentials learned from implementing ChatGPT ↔ Gemini integration. The icon state detection method (like Gemini's `stop` → `mic` transition) is the most reliable when available.