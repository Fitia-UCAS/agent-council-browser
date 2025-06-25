# Multi-LLM Extension Debug Analysis

Hello! I've analyzed the code for your Multi-LLM extension and found the root causes for the inconsistent and random behavior. The issues stem from two main areas:

1.  **State Management (`background.js`):** The extension uses a single, global object (`activeFollowUpState`) to track the mirroring process. When you send prompts quickly or from both Gemini and ChatGPT around the same time, these processes overwrite each other's state, leading to unpredictable results. One cycle breaks the other.
2.  **Content Script Logic (`contentScript.js`):** There is a major bug where the function to capture ChatGPT responses (`observeChatGPTResponses`) is defined twice. This means the second, more complex version completely replaces the first one, which is likely not the intended behavior. Furthermore, the logic to detect when a response is "complete" is very complex and fragile, relying on timers and UI elements that can change, making it unreliable.

Here is a breakdown of the specific problems and the code to fix them.

---

## 1. The State Management Problem in `background.js`

The fundamental issue is that `activeFollowUpState` can only handle one "mirroring" job at a time. If you send a prompt from ChatGPT to Gemini, the state is set. If you then send another from Gemini to ChatGPT before the first one is finished, `resetFollowUpState()` is called, and the original job's context is lost.

### Solution: Manage Multiple Follow-Up "Jobs"

Instead of one global state, we should manage a collection of active jobs, using the `promptId` to keep them separate. This ensures that work from ChatGPT-to-Gemini doesn't interfere with work from Gemini-to-ChatGPT.

#### Corrected `background.js`

I've modified the script to handle multiple states. I'm only showing the changed parts. The rest of your `background.js` can remain the same.

```javascript
// MODIFIED: Replace the single activeFollowUpState with a dictionary to hold multiple jobs
const activeFollowUpJobs = {};

// Helper to create a new job state
function createNewFollowUpJob() {
    return {
        originalPrompt: null,
        originalSourceLLM: null,
        originalSourceTabId: null,
        targetLLM: null,
        capturedResponseContent: null,
        responseScraped: false,
        promptTimestamp: 0,
        promptId: null,
        waitingForResponse: false
    };
}

// MODIFIED: No longer a single global reset, we delete jobs by ID
function completeAndRemoveJob(promptId) {
    if (activeFollowUpJobs[promptId]) {
        console.log(`[MLC FollowUp] Completing and removing job: ${promptId}`);
        delete activeFollowUpJobs[promptId];
    }
}

// Generate a unique ID for each prompt-response cycle
function generatePromptId() {
    return 'prompt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[MLC Background] Received message:', message);
    
    // Keep the switch statement, but modify the handlers it calls
    switch (message.type) {
        case 'SEND_PROMPT':
            handleSendPrompt(message);
            sendResponse({ status: 'received', type: message.type });
            break;
        case 'FORWARD_PROMPT':
            // MODIFICATION: Pass sender to the handler
            handleForwardPrompt(message, sender);
            sendResponse({ status: 'forward_received', type: message.type });
            break;
        case 'GEMINI_RESPONSE_CAPTURED':
            handleGeminiResponse(message);
            sendResponse({ status: 'gemini_response_received', type: message.type });
            break;
        case 'CHATGPT_RESPONSE_CAPTURED':
            handleChatGPTResponse(message);
            sendResponse({ status: 'chatgpt_response_received', type: message.type });
            break;
        case 'CHECK_CONNECTION':
            checkConnectionStatus().then(status => {
                sendResponse({ 
                    type: 'CONNECTION_STATUS',
                    status: status 
                });
            });
            return true; // Keep message channel open for async response
        default:
            console.warn('[MLC Background] Unknown message type:', message.type);
            sendResponse({ status: 'unknown_message_type' });
            break;
    }
    
    return false;
});


// MODIFIED: handleForwardPrompt to use the new job system
function handleForwardPrompt(message, sender) {
    const { from, prompt } = message;
    console.log(`[MLC Background] Processing FORWARD_PROMPT from ${from}`);
    if (!prompt) {
        console.warn('[MLC Background] Forward prompt is empty, aborting.');
        return;
    }

    // Create a new job for this request
    const promptId = generatePromptId();
    const newJob = createNewFollowUpJob();
    
    newJob.promptId = promptId;
    newJob.originalPrompt = prompt;
    newJob.originalSourceLLM = from;
    newJob.originalSourceTabId = sender?.tab?.id || null;
    newJob.promptTimestamp = Date.now();
    newJob.waitingForResponse = true;
    newJob.targetLLM = (from === 'chatgpt') ? 'gemini' : 'chatgpt';

    // Store the job
    activeFollowUpJobs[promptId] = newJob;
    console.log(`[MLC FollowUp] Created and stored new job ${promptId}:`, newJob);

    // Process the LLM request
    processLLM(newJob.targetLLM, prompt).then(() => {
        // After processing, notify the target tab
        findLLMTab(newJob.targetLLM).then(targetTab => {
            if (targetTab) {
                chrome.tabs.sendMessage(targetTab.id, {
                    type: 'NEW_PROMPT_SENT',
                    promptId: newJob.promptId,
                    timestamp: newJob.promptTimestamp,
                    to: newJob.targetLLM
                });
                console.log(`[MLC FollowUp] Notified ${newJob.targetLLM} tab ${targetTab.id} of new prompt ${newJob.promptId}`);
            }
        });
    }).catch(error => {
        console.error(`[MLC Background] Error during processLLM for job ${promptId}:`, error);
        completeAndRemoveJob(promptId); // Clean up failed job
    });
}


// MODIFIED: handleGeminiResponse to use the job system
function handleGeminiResponse(message) {
    const { promptId, content } = message;
    const job = activeFollowUpJobs[promptId];

    console.log(`[MLC FollowUp] Gemini response received for promptId: ${promptId}`);

    if (!job) {
        console.warn(`[MLC FollowUp] Received Gemini response for an unknown or completed job: ${promptId}. Ignoring.`);
        return;
    }

    if (!content || content.trim().length === 0) {
        console.log('[MLC FollowUp] Received empty Gemini response, ignoring.');
        return;
    }

    // Update the specific job
    job.capturedResponseContent = content;
    job.responseScraped = true;
    job.waitingForResponse = false;
    
    console.log(`[MLC FollowUp] Stored Gemini response for job ${promptId}. Attempting to trigger follow-up.`);
    triggerFollowUpIfReady(promptId);
}

// MODIFIED: handleChatGPTResponse to use the job system
function handleChatGPTResponse(message) {
    const { promptId, content } = message;
    const job = activeFollowUpJobs[promptId];

    console.log(`[MLC FollowUp] ChatGPT response received for promptId: ${promptId}`);

    if (!job) {
        console.warn(`[MLC FollowUp] Received ChatGPT response for an unknown or completed job: ${promptId}. Ignoring.`);
        return;
    }

    if (!content || content.trim().length === 0) {
        console.log('[MLC FollowUp] Received empty ChatGPT response, ignoring.');
        return;
    }

    // Update the specific job
    job.capturedResponseContent = content;
    job.responseScraped = true;
    job.waitingForResponse = false;

    console.log(`[MLC FollowUp] Stored ChatGPT response for job ${promptId}. Attempting to trigger follow-up.`);
    triggerFollowUpIfReady(promptId);
}

// MODIFIED: triggerFollowUpIfReady to operate on a specific job ID
function triggerFollowUpIfReady(promptId) {
    const job = activeFollowUpJobs[promptId];

    if (!job) {
        console.log(`[MLC FollowUp] Cannot trigger follow-up, job ${promptId} not found.`);
        return;
    }

    // Check if this job is ready
    if (job.responseScraped && job.capturedResponseContent && job.originalSourceTabId) {
        console.log(`[MLC FollowUp] Conditions met for job ${promptId}, injecting follow-up.`);
        
        let followUpPromptText = '';
        
        if (job.originalSourceLLM === 'chatgpt') { // The original prompt was on ChatGPT
            followUpPromptText = `I also asked Gemini the same question, and here's its response:\n\n"${job.capturedResponseContent}"\n\nCould you review this and see if you can enhance your previous answer or confirm if your current one is comprehensive?`;
            injectFollowUpIntoChatGPT(job.originalSourceTabId, followUpPromptText);
        } else { // The original prompt was on Gemini
            followUpPromptText = `I also asked ChatGPT the same question, here's its answer:\n${job.capturedResponseContent}\n\nCould you read your answer and its answer to see if you can enhance yours or if everything's good.`;
            injectFollowUpIntoGemini(job.originalSourceTabId, followUpPromptText);
        }
        
        // The job is done, remove it
        completeAndRemoveJob(promptId);

    } else {
        console.log(`[MLC FollowUp] Not ready for follow-up for job ${promptId} yet.`, job);
    }
}

// The rest of the functions (injectFollowUpIntoChatGPT, injectFollowUpIntoGemini, simpleInteraction_InjectOnly, etc.) can remain the same.
```

---

## 2. The Content Script Problem in `contentScript.js`

Your `contentScript.js` has a copy-paste error: the `observeChatGPTResponses` function is defined twice. The second definition overwrites the first. This is a critical bug.

Additionally, the response capture logic is overly complex, making it prone to failure. I've simplified it and corrected the duplicate function bug.

### Solution: Fix the Duplicate Function and Simplify

I will provide a corrected version of the `contentScript.js` file. The main changes are:
1.  **Remove the duplicate `observeChatGPTResponses` function.**
2.  **Standardize the response capture logic** to be more robust and less dependent on fragile timers and UI state.
3.  **Ensure `promptId` is handled correctly** to prevent acting on stale messages.

#### Corrected `contentScript.js`

This is a complete, corrected version of `contentScript.js`. You should replace the entire file with this.

```javascript
(function() {
    const host = location.hostname;
    const isChatGPT = host.includes('openai.com') || host.includes('chatgpt.com');
    const isGemini = host.includes('gemini.google.com');
    if (!isChatGPT && !isGemini) return;

    const currentLLM = isChatGPT ? 'chatgpt' : 'gemini';
    console.log(`[MLC ContentScript] Initializing for ${currentLLM}.`);

    let forwardEnabled = false;
    
    // --- Element Finders ---
    function findInput() {
        const selectors = isChatGPT ? [
            '#prompt-textarea',
            'textarea[data-testid="prompt-textarea"]'
        ] : [ 
            'div.ql-editor[role="textbox"]',
            '.ql-editor.textarea'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function findSendButton() {
        const selectors = isChatGPT ? [
            'button[data-testid="send-button"]'
        ] : [ 
            'button[aria-label="Send message"]',
            'button.send-button'
        ];
        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetParent !== null) {
                return btn;
            }
        }
        return null;
    }

    function getPromptText(inputElement) {
        if (!inputElement) return '';
        return inputElement.isContentEditable ? (inputElement.innerText || '') : (inputElement.value || '');
    }

    // --- Core Logic: Forwarding ---
    function handlePromptSubmission() {
        if (forwardEnabled) {
            const input = findInput();
            const prompt = getPromptText(input).trim();
            if (prompt) {
                console.log(`[MLC ContentScript - ${currentLLM}] Forwarding enabled. Sending prompt.`);
                chrome.runtime.sendMessage({
                    type: 'FORWARD_PROMPT',
                    from: currentLLM,
                    prompt
                });
            }
        }
    }

    function attachListeners() {
        const input = findInput();
        const sendBtn = findSendButton();

        if (input && !input.dataset.mlcForwardKey) {
            input.addEventListener('keydown', evt => {
                if (evt.key === 'Enter' && !evt.shiftKey) {
                    handlePromptSubmission();
                }
            });
            input.dataset.mlcForwardKey = 'true';
        }

        if (sendBtn && !sendBtn.dataset.mlcForwardClick) {
            sendBtn.addEventListener('click', handlePromptSubmission, true); 
            sendBtn.dataset.mlcForwardClick = 'true';
        }
    }

    // --- UI: Toggle Button ---
    function addToggleButton() {
        if (document.getElementById('mlc-forward-toggle')) return;

        const parentElement = findSendButton()?.parentElement || findInput()?.parentElement;
        if (!parentElement) return;

        const btn = document.createElement('button');
        btn.id = 'mlc-forward-toggle';
        btn.textContent = isChatGPT ? `⇄ Gemini` : `⇄ ChatGPT`;
        Object.assign(btn.style, {
            marginLeft: '8px',
            padding: '6px 10px',
            fontSize: '12px',
            border: '1px solid #555',
            background: '#3a3a3a',
            color: '#e0e0e0',
            borderRadius: '6px',
            cursor: 'pointer'
        });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            forwardEnabled = !forwardEnabled;
            btn.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
            console.log(`[MLC ContentScript - ${currentLLM}] Forwarding ${forwardEnabled ? 'ENABLED' : 'DISABLED'}.`);
        });

        parentElement.appendChild(btn);
    }

    // --- Response Capturing Logic ---
    function observeResponses() {
        console.log(`[MLC Capture - ${currentLLM}] Starting response capture...`);

        let currentPromptId = null;
        let captureComplete = false;

        // Listen for new prompts from the background script
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.type === 'NEW_PROMPT_SENT' && message.to === currentLLM) {
                console.log(`[MLC Capture - ${currentLLM}] Notified of new prompt: ${message.promptId}`);
                currentPromptId = message.promptId;
                captureComplete = false; // Reset for the new response
                if (sendResponse) sendResponse({ received: true });
            }
            return true;
        });

        const isGenerating = () => {
            if (isChatGPT) {
                return !!document.querySelector('button[data-testid="stop-button"]');
            }
            if (isGemini) {
                // Gemini shows a "stop" icon or disables the input
                return !!document.querySelector('mat-icon[fonticon="stop"]') || document.querySelector('div.ql-editor[aria-disabled="true"]');
            }
            return false;
        };

        const getResponseText = () => {
            let responseElements;
            if (isChatGPT) {
                // Get all assistant messages and pick the last one
                responseElements = document.querySelectorAll('div[data-message-author-role="assistant"] .markdown');
            } else { // Gemini
                // Get all model responses and pick the last one
                responseElements = document.querySelectorAll('.model-response-text .markdown');
            }
            
            if (responseElements.length > 0) {
                const lastResponse = responseElements[responseElements.length - 1];
                return lastResponse?.innerText?.trim() || '';
            }
            return '';
        };

        let wasGenerating = false;
        const observer = new MutationObserver(() => {
            if (!currentPromptId || captureComplete) return;

            const generating = isGenerating();

            // If it was generating and just stopped, that's our signal to capture.
            if (wasGenerating && !generating) {
                const responseText = getResponseText();
                if (responseText) {
                    console.log(`[MLC Capture - ${currentLLM}] Response finished. Sending content for prompt ${currentPromptId}.`);
                    chrome.runtime.sendMessage({
                        type: `${currentLLM.toUpperCase()}_RESPONSE_CAPTURED`,
                        content: responseText,
                        promptId: currentPromptId,
                        timestamp: Date.now()
                    });
                    captureComplete = true; // Mark as done
                    currentPromptId = null; // Clear the ID
                }
            }
            
            wasGenerating = generating;
        });

        observer.observe(document.body, { childList: true, subtree: true });
        console.log(`[MLC Capture - ${currentLLM}] Response observer started.`);
    }


    // --- Initialization ---
    function initialize() {
        addToggleButton();
        attachListeners();
    }

    // Use a MutationObserver to re-run initialization if the UI changes (common in SPAs)
    const domObserver = new MutationObserver(initialize);
    domObserver.observe(document.body, { childList: true, subtree: true });

    // Initial setup after a delay
    setTimeout(() => {
        initialize();
        observeResponses();
    }, 2500);

})();
```

---

## Summary of Fixes

1.  **Job-Based State:** The new `background.js` can now handle multiple mirroring requests at once without them interfering with each other. This is the most critical fix for the random behavior.
2.  **Corrected Content Script:** The new `contentScript.js` removes the duplicate function bug and uses a much simpler, more reliable method for detecting when a response is finished. It waits for the "Stop Generating" button/indicator to disappear before capturing the text.
3.  **Reliable Communication:** By using `promptId` throughout the entire process (from forwarding, to response capture, to follow-up), the system ensures that a response is always matched to its original request.

To apply these fixes, please **replace the entire contents** of your `background.js` and `contentScript.js` with the corrected versions I've provided above. This should resolve the unpredictable behavior and make your extension work reliably.
