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

  claude: {
    input: 'textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], [role="textbox"]',
    sendButton: 'button[aria-label*="message" i], button[aria-label*="Send" i], button[aria-label*="Envoyer" i], button[type="submit"]',
    responseArea: 'main, [role="main"]',
    lastResponseBlock: '[data-testid*="assistant" i], [data-testid*="message" i], article, [role="article"]',
    doneIndicator: 'button[aria-label*="Stop" i], button[aria-label*="Cancel" i], button[data-testid*="stop" i]'
  },
  
  chatgpt: {
    input: '#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea[placeholder*="Message"], textarea[data-id="root"], textarea, [contenteditable="true"]',
    sendButton: 'button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[aria-label="Send"], button[aria-label*="Send"], button[type="submit"]',
    responseArea: '[data-testid="conversation-turn"], .conversation-content, [role="main"]',
    lastResponseBlock: '[data-testid="conversation-turn"]:last-child .markdown, .message:last-child, .response:last-child',
    doneIndicator: 'button[aria-label*="Stop"]:not([disabled]), .stop-button:not([style*="display: none"])'
  },

  grok: {
    input: 'textarea, [contenteditable="true"][role="textbox"], [role="textbox"]',
    sendButton: 'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[aria-label*="Soumettre" i], button[type="submit"]',
    responseArea: 'main, [role="main"]',
    lastResponseBlock: '[data-testid*="assistant" i], [data-testid*="message" i], article, [role="article"]',
    doneIndicator: 'button[aria-label*="Stop" i], button[aria-label*="Cancel" i], button[aria-label*="Arrêter" i], button[aria-label*="Annuler" i], button[aria-label*="Passer en mode vocal" i], button[aria-label*="voice mode" i], button[data-testid*="stop" i]'
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

// Optional globals/exports for ad-hoc debugging + tests.
if (typeof window !== 'undefined') {
  window.LLM_SELECTORS = LLM_SELECTORS;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LLM_SELECTORS, validateSelector };
}
