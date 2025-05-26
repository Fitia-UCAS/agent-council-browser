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
    input: '#prompt-textarea, textarea[placeholder*="Message"], [data-testid="prompt-textarea"]',
    sendButton: 'button[data-testid="send-button"], button[aria-label*="Send"], [data-testid="fruitjuice-send-button"]',
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