# Plan: V2 Extension - Auto-Follow-up Prompt in ChatGPT

## 1. Current State (Relevant Functionality)

*   **Extension Core:** A Chrome extension with a `contentScript.js` injected into ChatGPT and Gemini pages, and a `background.js` service worker.
*   **Cross-Site Prompting:**
    *   Users on ChatGPT can have their prompt (sent via native send button/Enter) also sent to Gemini if a toggle button (injected by `contentScript.js`) is active.
    *   Users on Gemini can have their prompt (sent via native send button/Enter) also sent to ChatGPT if a toggle button is active.
*   **Mechanism:**
    *   `contentScript.js` detects prompt submission (Enter key or send button click) on the current LLM page.
    *   If forwarding is enabled, it sends a `FORWARD_PROMPT` message to `background.js` with the prompt content and the source LLM.
    *   `background.js` receives `FORWARD_PROMPT`, identifies the target LLM, finds the target LLM's tab, and injects `simpleInteraction` function.
    *   `simpleInteraction` (executed in the target LLM's page context) attempts to:
        *   Find the input textarea/contenteditable.
        *   Set the prompt text into it.
        *   Find the send button.
        *   Click the send button.
    *   `background.js` currently sends a simple `LLM_RESPONSE` message to the popup/sidepanel indicating "Prompt sent successfully," not the actual LLM-generated content.

## 2. Desired New Feature: Automated Follow-up Prompt

**Scenario:** User is on `chatgpt.com`.

1.  User types a prompt in ChatGPT's input.
2.  User has the "⇄ Gemini" toggle enabled.
3.  User sends the prompt in ChatGPT (e.g., presses Enter).
    *   The prompt is sent to ChatGPT (natively).
    *   The prompt is also sent to Gemini.com by the extension.
4.  **After BOTH ChatGPT AND Gemini have finished generating their respective responses to this initial prompt:**
5.  The extension will **automatically populate ChatGPT's input field** with the following new message (but **NOT** automatically send it):

    ```
    I also asked Gemini the same question here's his answer:
    <gemini_answer_content_here>
    Could you read your answer and his answer to see if you can enhance yours or if everything's good.
    ```

    Where `<gemini_answer_content_here>` is the actual text content of Gemini's response.

## 3. High-Level Plan

1.  **State Management in `background.js`:** Introduce variables to track the status of responses from both LLMs for a given cross-site request.
2.  **Gemini Response Capturing (`contentScript.js` on Gemini):** Implement logic to detect when Gemini has finished generating a response and scrape its content.
3.  **Communication of Gemini's Response:** The Gemini `contentScript.js` will send Gemini's complete response content to `background.js`.
4.  **ChatGPT Response Detection (Implicit):** We'll assume ChatGPT's response is "complete" when our initial `simpleInteraction` for ChatGPT (if applicable, or the user's native send) has finished its UI interaction. For this specific feature, the trigger is *Gemini's response being ready after an initial prompt was sent from ChatGPT to both*.
5.  **Synchronization Logic (`background.js`):** Check if both original responses are ready and if the request originated from ChatGPT.
6.  **Follow-up Prompt Injection (`background.js` & `simpleInteraction`):** If conditions are met, construct the follow-up prompt and use a modified `simpleInteraction` (or a new function) to inject it into ChatGPT's input field *without* clicking send.

## 4. Detailed Step-by-Step Implementation

### Step 4.1: `background.js` - State Management & Core Logic

*   **Modify `handleForwardPrompt` (and potentially `handleSendPrompt` if it's used for dual sends from popup/sidepanel):**
    *   When a prompt is initiated from `chatgpt` and targets `gemini` (and `chatgpt` itself):
        *   Store the original prompt text.
        *   Store the source of the request (e.g., `chatgpt`).
        *   Initialize flags: `chatGPTResponseAcknowledged = false;`, `geminiResponseContentForFollowUp = null;`, `geminiResponseScraped = false;`.
        *   Keep track of the `tabId` for the original ChatGPT tab.

    ```javascript
    // In background.js
    let activeFollowUpState = {
        originalPrompt: null,
        originalSourceLLM: null, // 'chatgpt' or 'gemini'
        originalChatGPTTabId: null,
        chatGPTResponseAcknowledged: false, // True when ChatGPT has processed the initial prompt
        geminiResponseContentForFollowUp: null,
        geminiResponseScraped: false, // True when Gemini's response has been scraped
        // Potentially add a timestamp or ID for the request
    };

    function resetFollowUpState() {
        activeFollowUpState = { /* ... re-initialize ... */ };
    }

    // In handleForwardPrompt or a similar initiating function:
    if (message.from === 'chatgpt' /* and also sending to Gemini */) {
        resetFollowUpState(); // Reset for a new dual-send operation
        activeFollowUpState.originalPrompt = message.prompt;
        activeFollowUpState.originalSourceLLM = 'chatgpt';
        activeFollowUpState.originalChatGPTTabId = sender.tab.id; // Tab that sent the FORWARD_PROMPT
        // ... proceed to send to Gemini ...

        // We need a way to know ChatGPT has processed its own prompt.
        // For now, we can infer this after a short delay or if we get an LLM_RESPONSE for ChatGPT.
        // This part is tricky as ChatGPT's "done" is not explicitly signaled to the background script yet for its *own* responses.
        // For now, let's assume the user interaction on ChatGPT page completes.
        // A more robust way would be for ChatGPT's content script to also signal "response started/completed" for its own native generations.
        // For this feature, we'll primarily key off Gemini's response.
        // We can set chatGPTResponseAcknowledged = true after some time, or if we had a separate signal from chatgpt's content script for its own response completion.
        // Let's assume for now, when a prompt is sent from ChatGPT and also forwarded, ChatGPT is considered "processing". We'll wait for Gemini.
    }
    ```

*   **New Message Listener for Gemini's Response:**
    *   Listen for a new message type, e.g., `GEMINI_RESPONSE_CAPTURED`, from Gemini's `contentScript.js`.
    *   This message should contain ` { type: 'GEMINI_RESPONSE_CAPTURED', content: '...' }`.
    *   When received:
        *   If `activeFollowUpState.originalSourceLLM === 'chatgpt'`, store the `content` in `activeFollowUpState.geminiResponseContentForFollowUp` and set `activeFollowUpState.geminiResponseScraped = true`.
        *   Call `triggerFollowUpIfReady()`.

    ```javascript
    // In background.js onMessage listener
    // case 'GEMINI_RESPONSE_CAPTURED':
    //     if (activeFollowUpState.originalSourceLLM === 'chatgpt') {
    //         activeFollowUpState.geminiResponseContentForFollowUp = message.content;
    //         activeFollowUpState.geminiResponseScraped = true;
    //         console.log('[MLC Background] Gemini response captured for follow-up:', message.content.substring(0, 100));
    //         triggerFollowUpIfReady();
    //     }
    //     sendResponse({status: 'gemini_response_received_by_background'});
    //     break;
    ```

*   **New Function: `triggerFollowUpIfReady()`:**
    *   Checks if `activeFollowUpState.originalSourceLLM === 'chatgpt'`, `activeFollowUpState.geminiResponseScraped === true`, and `activeFollowUpState.geminiResponseContentForFollowUp` is not null.
    *   (Optional: also check `activeFollowUpState.chatGPTResponseAcknowledged === true` if we implement a reliable way to set it).
    *   If all conditions are met:
        *   Construct the follow-up prompt string.
        *   Call `injectFollowUpIntoChatGPT(activeFollowUpState.originalChatGPTTabId, followUpPromptText)`.
        *   `resetFollowUpState()`.

    ```javascript
    // In background.js
    function triggerFollowUpIfReady() {
        if (
            activeFollowUpState.originalSourceLLM === 'chatgpt' &&
            activeFollowUpState.geminiResponseScraped &&
            activeFollowUpState.geminiResponseContentForFollowUp &&
            activeFollowUpState.originalChatGPTTabId
            // && activeFollowUpState.chatGPTResponseAcknowledged // Add this if we have a good signal for ChatGPT's own completion
        ) {
            console.log('[MLC Background] Conditions met for follow-up prompt.');
            const followUpPromptText = `I also asked Gemini the same question here's his answer:\n${activeFollowUpState.geminiResponseContentForFollowUp}\n\nCould you read your answer and his answer to see if you can enhance yours or if everything's good.`;

            injectFollowUpIntoChatGPT(activeFollowUpState.originalChatGPTTabId, followUpPromptText);
            resetFollowUpState();
        } else {
            console.log('[MLC Background] Conditions for follow-up NOT YET met.', activeFollowUpState);
        }
    }
    ```

*   **New Function: `injectFollowUpIntoChatGPT(tabId, promptText)`:**
    *   This function will execute a script in the ChatGPT tab to *only fill the input field*.
    *   It's a variation of `simpleInteraction` but will **not** attempt to find or click the send button.

    ```javascript
    // In background.js
    async function injectFollowUpIntoChatGPT(tabId, promptText) {
        try {
            console.log(`[MLC Background] Injecting follow-up prompt into ChatGPT Tab ID ${tabId}`);
            const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: simpleInteraction_InjectOnly, // New function to be defined below
                args: [promptText, 'chatgpt'] // llmType is 'chatgpt'
            });
            if (results && results[0] && results[0].result && results[0].result.success) {
                console.log('[MLC Background] Follow-up prompt injected into ChatGPT input successfully.');
            } else {
                console.error('[MLC Background] Failed to inject follow-up prompt into ChatGPT input.', results);
            }
        } catch (error) {
            console.error('[MLC Background] Error injecting follow-up prompt:', error);
        }
    }
    ```

*   **New Injected Function: `simpleInteraction_InjectOnly(prompt, llmType)`:**
    *   This function will be very similar to the current `simpleInteraction`.
    *   It **MUST** find the input element for `llmType` (which will be 'chatgpt').
    *   It **MUST** set the `prompt` into that input element using the robust methods already developed (e.g., native value setter + events).
    *   It **MUST NOT** look for or click a send button.
    *   It should return `{ success: true }` if text injection is successful, or `{ success: false, error: '...' }` on failure.

    ```javascript
    // This function is injected and executed in the context of the target LLM's page (ChatGPT)
    function simpleInteraction_InjectOnly(prompt, llmType) {
        console.log(`[SimpleInteraction_InjectOnly INJECTED] Attempting on ${llmType} with prompt: "${prompt.substring(0, 50)}..."`);
        try {
            let inputElement = null;
            const inputSelectors = { /* ... same as in simpleInteraction ... */ };
            const currentInputSelectors = inputSelectors[llmType];

            if (!currentInputSelectors) { /* ... error handling ... */ return { success: false, error: 'Unknown llmType' }; }

            for (const selector of currentInputSelectors) {
                inputElement = document.querySelector(selector);
                if (inputElement) break;
            }

            if (!inputElement) { /* ... error handling ... */ return { success: false, error: `No input element found for ${llmType}` }; }
            
            inputElement.focus();

            if (llmType === 'chatgpt' && inputElement.tagName === 'TEXTAREA') {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(inputElement, prompt);
                } else {
                    inputElement.value = prompt;
                }
                inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                inputElement.dispatchEvent(new KeyboardEvent('keydown',  { key: ' ', keyCode: 32, bubbles: true, composed: true }));
                inputElement.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', keyCode: 32, bubbles: true, composed: true }));
                // Crucially, trigger textarea auto-resize if ChatGPT relies on it
                // This often happens on input or keydown events.
                // If there's a known function or a way to trigger this:
                // For example, if inputElement.style.height needs to be reset and recalculated:
                // const originalHeight = inputElement.style.height;
                // inputElement.style.height = 'auto';
                // inputElement.style.height = inputElement.scrollHeight + 'px';

            } else if (inputElement.isContentEditable || inputElement.contentEditable === 'true') {
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, prompt);
                inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            } else {
                inputElement.value = prompt;
                inputElement.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                inputElement.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
             // Verify text was set
            const currentText = (inputElement.isContentEditable || inputElement.contentEditable === 'true') ? inputElement.textContent : inputElement.value;
            if (!currentText.includes(prompt.substring(0, Math.min(prompt.length, 50)))) {
                 console.warn(`[SimpleInteraction_InjectOnly INJECTED] WARNING: Prompt may not have been set correctly.`);
            } else {
                console.log(`[SimpleInteraction_InjectOnly INJECTED] Text set successfully.`);
            }

            return { success: true, method: `text_injected_for_${llmType}` };
        } catch (error) {
            console.error(`[SimpleInteraction_InjectOnly INJECTED] Error: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
    ```

### Step 4.2: `contentScript.js` (on Gemini page) - Response Capturing

*   **Identify Gemini's Response Area:**
    *   Determine the DOM selectors for the container where Gemini's final response(s) appear. This might be something like `.response-content-container`, `.message-content`, `.model-response`. Inspect Gemini's DOM carefully.
*   **Detect "Response Complete":**
    *   This is the most challenging part. How to know Gemini is *done* generating?
        *   Look for the disappearance of a "Stop generating" button.
        *   Look for a specific class added to the response container when generation is complete.
        *   Observe network activity (less reliable for content scripts).
        *   A combination of a `MutationObserver` on the response area and checking for these "done" indicators.
*   **Scrape Response Content:**
    *   Once "done" is detected, extract the text content from the response area. Handle multiple message bubbles if Gemini structures its responses that way. Concatenate them.
*   **Send to Background Script:**
    *   Use `chrome.runtime.sendMessage({ type: 'GEMINI_RESPONSE_CAPTURED', content: scrapedText });`

```javascript
// In contentScript.js (when isGemini is true)

function observeGeminiResponses() {
    // These selectors are EXAMPLES and WILL LIKELY NEED ADJUSTMENT
    const responseContainerSelector = '.response-container-content'; // Main area for responses
    const individualResponseSelector = '.model-response .markdown'; // Individual response blocks with markdown
    const stopGeneratingButtonSelector = 'button[aria-label*="Stop generating"]'; // Or similar
    const thinkingIndicatorSelector = '.loading-indicator-gemini'; // A hypothetical spinner

    let lastProcessedResponseText = ""; // To avoid sending updates for the same partial response multiple times

    const responseObserver = new MutationObserver((mutationsList, observer) => {
        const responseContainer = document.querySelector(responseContainerSelector);
        if (!responseContainer) return;

        const isGenerating = document.querySelector(stopGeneratingButtonSelector) || document.querySelector(thinkingIndicatorSelector);

        if (!isGenerating) { // If no "stop" button or thinking indicator, assume it might be done or paused
            let fullResponseText = "";
            const responseElements = responseContainer.querySelectorAll(individualResponseSelector);
            responseElements.forEach(el => {
                fullResponseText += el.innerText + "\n\n"; // Or .innerHTML if you need to preserve some formatting and clean it later
            });
            fullResponseText = fullResponseText.trim();

            if (fullResponseText && fullResponseText !== lastProcessedResponseText) {
                console.log('[MLC ContentScript - Gemini] Detected potential final response:', fullResponseText.substring(0, 100));
                lastProcessedResponseText = fullResponseText; // Update last processed text
                chrome.runtime.sendMessage({
                    type: 'GEMINI_RESPONSE_CAPTURED',
                    content: fullResponseText
                });
                // Consider disconnecting observer if we are sure this is the *final* response for the *current* prompt.
                // This is tricky if the user asks follow-up questions in Gemini.
            }
        } else {
            // Still generating, could scrape partial content if desired for other features, but not for this one.
            lastProcessedResponseText = ""; // Reset if it starts generating again for a new prompt.
        }
    });

    // Start observing the part of the page where responses appear and generation indicators are.
    // The target node for the observer should be a stable parent of the response area.
    const mainChatArea = document.querySelector('main .chat-container') || document.body; // Adjust as needed
    if (mainChatArea) {
        responseObserver.observe(mainChatArea, {
            childList: true,
            subtree: true,
            attributes: true // To catch attribute changes like 'disabled' on buttons or style changes
        });
        console.log('[MLC ContentScript - Gemini] Response observer started.');
    } else {
        console.error('[MLC ContentScript - Gemini] Could not find main chat area to observe.');
    }
}

// Call this when the script loads on Gemini page
if (isGemini) {
    // Delay observation slightly to ensure page elements are loaded
    setTimeout(observeGeminiResponses, 3000);
}
Use code with caution.
Markdown
Difficulty of Gemini Response Scraping: This is highly dependent on Gemini's DOM structure and how clearly it signals completion. It's prone to breaking if Gemini's UI changes. Thorough testing and refinement of selectors will be needed.


## 5. Key Challenges & Considerations

### Reliability of Gemini Response Capturing

- **"Done" Signal:**  
  Finding a robust way to detect when Gemini has finished generating a response is critical. A good candidate is monitoring for the disappearance of the "Stop generating" button.
- **DOM Structure:**  
  Gemini's selectors for response text may change over time, requiring maintenance.
- **Streaming Responses:**  
  If Gemini streams its response, the content script must wait for the stream to complete. The MutationObserver approach (described above) attempts to handle this by checking when generation indicators are gone.

### Synchronization & State

- Ensure that `activeFollowUpState` in `background.js` correctly corresponds to the ongoing dual-prompt interaction.
- If the user initiates multiple such interactions quickly, state could get mixed up. For more robustness, consider an ID system per request.

### Timing

- What if ChatGPT responds much faster or slower than Gemini? The logic currently relies on Gemini's response being the trigger.

### User Experience

- The feature is automatic. Consider adding a setting in the popup/sidepanel to enable or disable this "auto-follow-up" feature.
- The injected text in ChatGPT might be long. The textarea should expand correctly. The `simpleInteraction_InjectOnly` function might need to ensure this happens (often triggered by input or keydown events).

### Error Handling

- What if Gemini's response cannot be scraped? The follow-up prompt will not be generated.
- What if the ChatGPT tab is closed before the follow-up can be injected?
- **ChatGPT's Own Response "Done" Signal:**  
  The current plan does not have a strong signal from ChatGPT's content script that its own initial response is complete. This isn't strictly necessary if we only trigger the follow-up after Gemini responds and the initial prompt was from ChatGPT. However, for other potential features, this might be useful.

---

## 6. Data Flow Summary for New Feature

1. **User on ChatGPT Page:**
    - Enables "⇄ Gemini" toggle.
    - Types prompt `"P1"` and sends (to ChatGPT).

2. **contentScript.js (ChatGPT) → background.js:**  
   Sends `FORWARD_PROMPT { from: 'chatgpt', prompt: "P1" }`.

3. **background.js:**
    - Sets `activeFollowUpState` (`originalPrompt="P1"`, `originalSourceLLM='chatgpt'`, `originalChatGPTTabId=...`).
    - Calls `processLLM('gemini', "P1")`.
    - Calls `injectAndExecute(geminiTabId, 'gemini', "P1", simpleInteraction)` (Gemini page now processes "P1").

4. **Gemini Page:**
    - Generates response `"R_Gemini"` to `"P1"`.
    - `contentScript.js (Gemini)` detects `"R_Gemini"` is complete.
    - `contentScript.js (Gemini) → background.js:` Sends `GEMINI_RESPONSE_CAPTURED { content: "R_Gemini" }`.

5. **background.js:**
    - Receives `GEMINI_RESPONSE_CAPTURED`.
    - Updates `activeFollowUpState.geminiResponseContentForFollowUp = "R_Gemini"`, `geminiResponseScraped = true`.
    - Calls `triggerFollowUpIfReady()`.
    - If conditions are met:
        - Constructs `followUpPrompt = "I also asked Gemini... R_Gemini ... Could you read..."`.
        - Calls `injectFollowUpIntoChatGPT(originalChatGPTTabId, followUpPrompt)`.
        - Executes `chrome.scripting.executeScript(originalChatGPTTabId, simpleInteraction_InjectOnly, [followUpPrompt, 'chatgpt'])`.

6. **ChatGPT Page:**
    - `simpleInteraction_InjectOnly` executes.
    - Finds ChatGPT's input.
    - Inserts `followUpPrompt` into the input field.
    - **Does NOT click send.**

7. **User on ChatGPT Page:**  
   Sees the new follow-up prompt in their input field, can review/edit, and send manually.

---

## 7. Future Enhancements

- Make the auto-follow-up feature toggleable via extension settings.
- Allow customization of the follow-up prompt template.
- Handle cases where the user might ask a follow-up in Gemini before the first response is used in ChatGPT.
- Implement more robust "response complete" detection for both platforms.

---

This detailed plan should provide a solid foundation for implementing the feature. The most challenging part will be the Gemini response capturing in `contentScript.js` due to its reliance on DOM structure and behavior.