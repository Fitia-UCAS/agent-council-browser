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
The auto-follow-up feature has been fully implemented and enhanced with significant improvements to solve the Gemini response detection issue. Key improvements include:

1. **Background.js**:
   - State tracking for auto-follow-up requests
   - Message handling for Gemini responses
   - Follow-up trigger logic
   - Text-only injection function for ChatGPT

2. **ContentScript.js (Gemini)**:
   - **FIXED: Completely redesigned response detection system**
   - Multi-strategy approach to extract response text:
     - Strategy 1: Direct targeting of message elements by data attributes
     - Strategy 2: Markdown content elements that typically contain responses
     - Strategy 3: Fallback to DOM structure analysis for potential response containers
     - Last resort: Main element text filtering
   - Simplified response completion detection (stop button, input field state)
   - Added both observer-based and interval-based checking for higher reliability
   - Better stability detection with clear logging
   - Added capture throttling and completion tracking
   - Callback handling for message sending confirmation

3. **Documentation**:
   - README updated with feature description
   - Data flow documented for clarity
   - Usage instructions added

### Next Steps
The feature is ready for testing with the new Gemini response detection system. Key test scenarios include:
1. Basic prompts from ChatGPT to Gemini and back
2. Prompts with code blocks or complex formatting
3. Multiple consecutive prompts
4. Different network conditions and response times

After successful testing, this branch can be merged into the main branch.