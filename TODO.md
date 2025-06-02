# TODO: Auto-Follow-Up Feature Implementation

## Overview
Implement an automatic follow-up feature where when a user sends a prompt from ChatGPT to Gemini (using the forwarding toggle), after both ChatGPT and Gemini have generated their responses, the extension will automatically populate ChatGPT's input field with Gemini's response and a follow-up prompt.

## Tasks

### 1. Background.js Modifications
- [x] Add state management for tracking follow-up status
- [x] Modify `handleForwardPrompt` to initialize follow-up state when originating from ChatGPT
- [x] Implement `handleGeminiResponse` function to process captured Gemini responses
- [x] Create `triggerFollowUpIfReady` function to check conditions and trigger follow-up
- [x] Implement `injectFollowUpIntoChatGPT` function to insert text into ChatGPT
- [x] Create `simpleInteraction_InjectOnly` function to set input text without sending

### 2. ContentScript.js Modifications (Gemini Detection)
- [x] Implement `observeGeminiResponses` function to detect when Gemini has completed generating a response
- [x] Refine selectors for Gemini response detection:
  - [x] Implement multiple fallback `responseContainerSelectors`
  - [x] Expand `stopGeneratingSelectors` with various options
  - [x] Add comprehensive `responseTextSelectors`
- [x] Implement robust response completion detection
  - [x] Added text stability detection (check if content length remains stable)
  - [x] Added multiple checks (stop button, input field state, regenerate buttons)
  - [x] Added throttling to prevent excessive processing
- [x] Add error handling for Gemini response capture
- [ ] Test response capture in different conversation scenarios

### 3. Testing
- [ ] Test basic end-to-end flow (ChatGPT → Gemini → Follow-up)
- [ ] Test with different types of prompts (short/long, code, etc.)
- [ ] Test with multiple consecutive prompts
- [ ] Test timing issues (slow responses, network delays)
- [ ] Test edge cases (page refresh, tab close during process)

### 4. Refinement
- [ ] Optimize Gemini response detection for reliability
- [ ] Add logging for easier debugging
- [ ] Consider adding user-configurable options (enable/disable feature)

## Current Status
The auto-follow-up feature has been implemented with significant improvements to the Gemini response detection system, but there's still an issue to address.

### Known Issues
1. ✅ FIXED: The Gemini response capture was getting all the chat history instead of only capturing the latest response.

2. CURRENT ISSUE: The extension is not waiting for Gemini to complete its answer to the current prompt. Instead, it's immediately sending the previous response back to ChatGPT:
   - In the first interaction, there's no previous response, so nothing is sent back
   - In the second interaction, it immediately sends the first response
   - This is happening because the response detection isn't properly linked to the current prompt
   - We need to implement a mechanism to ensure we only capture responses that are generated after our prompt is sent

### Improvements Made
1. **Background.js**:
   - State tracking for auto-follow-up requests
   - Message handling for Gemini responses
   - Follow-up trigger logic
   - Text-only injection function for ChatGPT

2. **ContentScript.js (Gemini)**:
   - Redesigned response detection system with multiple strategies
   - Multi-strategy approach to extract response text:
     - Strategy 1: Direct targeting of message elements by data attributes
     - Strategy 2: Markdown content elements that typically contain responses
     - Strategy 3: Fallback to DOM structure analysis for potential response containers
     - Strategy 4: Main element text filtering as a last resort
   - Simplified response completion detection (stop button, input field state)
   - Added both observer-based and interval-based checking for higher reliability
   - Better stability detection with clear logging
   - Added capture throttling and completion tracking
   - Callback handling for message sending confirmation

3. **Documentation**:
   - README updated with feature description
   - Data flow documented for clarity
   - Usage instructions added

### Current Issues
1. ✅ FIXED: The Gemini response capture was getting all the chat history instead of only capturing the latest response.

2. ✅ FIXED: The extension was not waiting for Gemini to complete its answer to the current prompt, instead sending previous responses back to ChatGPT. This has been fixed with:
   - Implemented proper prompt-response pairing with unique promptIds
   - Added timestamp tracking to ensure responses correspond to the current prompt
   - Created a notification system between background script and content script
   - Enhanced response validation with multiple checks to prevent capturing stale responses

### Next Steps
1. **Final Testing**:
   - Test the complete prompt-response-follow-up flow with the new tracking system
   - Verify that responses are correctly associated with their prompts
   - Test multiple consecutive interactions to ensure proper prompt-response pairing

2. **Testing After Fix**:
   - Basic prompts from ChatGPT to Gemini and back
   - Prompts with code blocks or complex formatting
   - Multiple consecutive prompts in a conversation (to verify only latest response is captured)
   - Different network conditions and response times

Once the latest-response-only issue is fixed, the branch can be merged into the main branch.