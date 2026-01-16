/**
 * Test suite for selectors.js validation
 * Tests DOM selector structure and completeness
 */

// Mock selectors for testing
let LLM_SELECTORS;

// Load selectors.js for testing
async function loadSelectors() {
  try {
    if (typeof window !== 'undefined' && window.LLM_SELECTORS) {
      LLM_SELECTORS = window.LLM_SELECTORS;
      return LLM_SELECTORS;
    }

    if (typeof require !== 'undefined') {
      const module = require('../selectors.js');
      LLM_SELECTORS = module.LLM_SELECTORS;
      return LLM_SELECTORS;
    }

    throw new Error('Cannot load selectors.js (no window.LLM_SELECTORS and no require())');
  } catch (error) {
    console.error('Failed to load selectors.js:', error);
    return null;
  }
}

// Test suite
const selectorsTests = {
  
  testSelectorsStructure() {
    console.log('Testing selectors structure...');
    if (!LLM_SELECTORS) {
      throw new Error('LLM_SELECTORS not loaded');
    }
    
    // Test that we have both LLM providers
    const expectedProviders = ['gemini', 'chatgpt', 'claude'];
    for (const provider of expectedProviders) {
      if (!LLM_SELECTORS[provider]) {
        throw new Error(`Missing provider: ${provider}`);
      }
    }
    
    console.log('✅ All required providers present');
    return true;
  },

  testGeminiSelectors() {
    console.log('Testing Gemini selectors...');
    const gemini = LLM_SELECTORS.gemini;
    
    const requiredSelectors = [
      'input',
      'sendButton', 
      'responseArea',
      'lastResponseBlock',
      'doneIndicator'
    ];
    
    for (const selector of requiredSelectors) {
      if (!gemini[selector]) {
        throw new Error(`Missing Gemini selector: ${selector}`);
      }
      
      if (typeof gemini[selector] !== 'string') {
        throw new Error(`Gemini selector ${selector} must be a string`);
      }
      
      if (gemini[selector].trim() === '') {
        throw new Error(`Gemini selector ${selector} cannot be empty`);
      }
    }
    
    console.log('✅ All Gemini selectors present and valid');
    return true;
  },

  testChatGPTSelectors() {
    console.log('Testing ChatGPT selectors...');
    const chatgpt = LLM_SELECTORS.chatgpt;
    
    const requiredSelectors = [
      'input',
      'sendButton',
      'responseArea', 
      'lastResponseBlock',
      'doneIndicator'
    ];
    
    for (const selector of requiredSelectors) {
      if (!chatgpt[selector]) {
        throw new Error(`Missing ChatGPT selector: ${selector}`);
      }
      
      if (typeof chatgpt[selector] !== 'string') {
        throw new Error(`ChatGPT selector ${selector} must be a string`);
      }
      
      if (chatgpt[selector].trim() === '') {
        throw new Error(`ChatGPT selector ${selector} cannot be empty`);
      }
    }
    
    console.log('✅ All ChatGPT selectors present and valid');
    return true;
  },

  testClaudeSelectors() {
    console.log('Testing Claude selectors...');
    const claude = LLM_SELECTORS.claude;
    
    const requiredSelectors = [
      'input',
      'sendButton', 
      'responseArea',
      'lastResponseBlock',
      'doneIndicator'
    ];
    
    for (const selector of requiredSelectors) {
      if (!claude[selector]) {
        throw new Error(`Missing Claude selector: ${selector}`);
      }
      
      if (typeof claude[selector] !== 'string') {
        throw new Error(`Claude selector ${selector} must be a string`);
      }
      
      if (claude[selector].trim() === '') {
        throw new Error(`Claude selector ${selector} cannot be empty`);
      }
    }
    
    console.log('✅ All Claude selectors present and valid');
    return true;
  },

  testSelectorFormat() {
    console.log('Testing selector format...');
    
    const allSelectors = [
      ...Object.values(LLM_SELECTORS.gemini),
      ...Object.values(LLM_SELECTORS.chatgpt),
      ...Object.values(LLM_SELECTORS.claude)
    ];
    
    for (const selector of allSelectors) {
      // Basic CSS selector validation
      if (!selector.match(/^[#.]?[\w\-\[\]="':*\s,>+~()]+$/)) {
        console.warn(`⚠️  Potentially invalid CSS selector: ${selector}`);
      }
    }
    
    console.log('✅ Selector format validation complete');
    return true;
  },

  testSelectorUniqueness() {
    console.log('Testing selector uniqueness...');
    
    const geminiSelectors = Object.values(LLM_SELECTORS.gemini);
    const chatgptSelectors = Object.values(LLM_SELECTORS.chatgpt);
    const claudeSelectors = Object.values(LLM_SELECTORS.claude);
    
    // Check for duplicates within each provider
    const geminiSet = new Set(geminiSelectors);
    const chatgptSet = new Set(chatgptSelectors);
    const claudeSet = new Set(claudeSelectors);
    
    if (geminiSet.size !== geminiSelectors.length) {
      throw new Error('Duplicate selectors found in Gemini configuration');
    }
    
    if (chatgptSet.size !== chatgptSelectors.length) {
      throw new Error('Duplicate selectors found in ChatGPT configuration');
    }

    if (claudeSet.size !== claudeSelectors.length) {
      throw new Error('Duplicate selectors found in Claude configuration');
    }
    
    console.log('✅ All selectors are unique within their providers');
    return true;
  },

  testMetadata() {
    console.log('Testing selector metadata...');
    
    // Check if metadata exists
    if (LLM_SELECTORS.metadata) {
      const metadata = LLM_SELECTORS.metadata;
      
      if (metadata.lastUpdated) {
        const lastUpdated = new Date(metadata.lastUpdated);
        if (isNaN(lastUpdated.getTime())) {
          throw new Error('Invalid lastUpdated date format');
        }
      }
      
      if (metadata.version) {
        if (typeof metadata.version !== 'string') {
          throw new Error('Version must be a string');
        }
      }
      
      console.log('✅ Metadata validation passed');
    } else {
      console.log('ℹ️  No metadata found (optional)');
    }
    
    return true;
  }
};

// Run all tests
async function runSelectorsTests() {
  console.log('🧪 Starting selectors.js tests...\n');
  
  try {
    await loadSelectors();
    
    if (!LLM_SELECTORS) {
      throw new Error('Could not load selectors.js');
    }
    
    // Run all tests
    selectorsTests.testSelectorsStructure();
    selectorsTests.testGeminiSelectors();
    selectorsTests.testChatGPTSelectors();
    selectorsTests.testClaudeSelectors();
    selectorsTests.testSelectorFormat();
    selectorsTests.testSelectorUniqueness();
    selectorsTests.testMetadata();
    
    console.log('\n🎉 All selectors tests passed!');
    return true;
    
  } catch (error) {
    console.error('\n❌ Selectors test failed:', error.message);
    return false;
  }
}

// Export for use in other test files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectorsTests, runSelectorsTests };
}

// Auto-run if this file is loaded directly
if (typeof window !== 'undefined') {
  document.addEventListener('DOMContentLoaded', runSelectorsTests);
}
