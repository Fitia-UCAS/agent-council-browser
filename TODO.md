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

2. 🔄 CRITICAL BUG: currentPromptId being set to null prematurely, breaking all response capture:
   - **Issue**: `currentPromptId` becomes `null` before response capture completes
   - **Evidence from logs**: 
     ```
     currentPromptId: 'prompt_1748982441003_qobjn4u7l'  // Initially set correctly
     ...
     currentPromptId: null  // Later becomes null, breaking capture
     ```
   - **Impact**: All response capture fails because `currentPromptId` is null
   - **Solution Applied**: 
     - Added `currentPromptId` check to capture conditions
     - Set `captureComplete = true` IMMEDIATELY to prevent duplicate captures
     - Only clear `currentPromptId` after successful message send
     - Added error handling to reset state if message sending fails
   - **Fix Details**:
     ```javascript
     if (!captureComplete && pendingPromptTimestamp > 0 && currentPromptId) {
       // Set capture as complete IMMEDIATELY to prevent duplicate captures
       captureComplete = true;
       // Send message and only clear currentPromptId on success
     }
     ```

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
   - **NEW**: Font Icon State Detection for response completion:
     - Added `getCurrentIconState()` function to monitor `mat-icon[fonticon]` states
     - Enhanced `isResponseComplete()` to detect `stop` → `mic` transitions
     - Implemented 500ms stabilization delay after transition detection
     - Provides much more reliable completion detection than previous methods
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

2. ⚠️ IN PROGRESS: The extension stopped sending any responses from Gemini back to ChatGPT:
   - Initial fix with strict validation was preventing valid responses from being accepted
   - Temporarily disabled strict validation and reduced stability requirement from 3 to 1
   - Added extensive debug logging to diagnose the exact issue
   - This should allow responses to be sent while we diagnose the underlying cause
   - Current hypothesis: The strict validation criteria and prompt-response pairing was too restrictive

### Next Steps
1. **Testing the New Icon State Detection**:
   - Test the complete prompt-response-follow-up flow with the new icon state transition detection
   - Verify that the `stop` → `mic` transition reliably captures responses at the right time
   - Test multiple consecutive interactions to ensure proper prompt-response pairing
   - Test different response lengths and generation speeds to verify the 500ms delay is appropriate

2. **Comprehensive Testing After Icon State Implementation**:
   - Basic prompts from ChatGPT to Gemini and back
   - Prompts with code blocks or complex formatting  
   - Multiple consecutive prompts in a conversation (to verify only latest response is captured)
   - Different network conditions and response times
   - Edge cases like very fast or very slow responses

3. **Fine-tuning**:
   - Monitor logs to see if the 500ms delay needs adjustment
   - Verify that fallback methods still work when icon detection fails
   - Ensure the icon state detection doesn't interfere with normal user interactions

Once the icon state detection is confirmed to work reliably, the feature will be ready for production use.