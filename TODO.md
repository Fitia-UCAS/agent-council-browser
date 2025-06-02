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
The basic structure for the feature has been implemented in both background.js and contentScript.js, but the most critical part that needs refinement is the Gemini response detection in contentScript.js.

### Critical Focus Area: Gemini Response Detection
The primary challenge is to accurately detect when Gemini has finished generating a response. Current implementation uses:
- Monitoring for the absence of a "Stop generating" button
- Checking the response container for content
- Using a MutationObserver to detect DOM changes

This needs to be refined and tested extensively with different Gemini response scenarios to ensure reliable operation.