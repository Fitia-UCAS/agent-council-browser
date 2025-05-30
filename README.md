# Multi-LLM Coder Chrome Extension

A powerful Chrome extension designed to streamline your workflow with Large Language Models (LLMs). It allows you to:

1.  **Send prompts simultaneously** to Gemini and ChatGPT from a dedicated Chrome side panel.
2.  **Compare responses** side-by-side.
3.  **Forward conversations between LLMs**: Write a prompt in ChatGPT and have it automatically sent to Gemini (and vice-versa) using injected toggle buttons directly on the LLM websites.

## ✨ Features

-   **Multi-LLM Support**: Interact with Gemini and ChatGPT.
-   **Side Panel Interface**: Persistent UI for sending prompts to both LLMs and comparing responses.
-   **In-Page Forwarding**: Toggle buttons injected into ChatGPT and Gemini pages to send the current prompt to the other LLM.
-   **Response Comparison**: View responses side-by-side in the side panel.
-   **Dark Theme**: Professional dark theme optimized for developers.
-   **Real-time Status**: Live connection status in the side panel.
-   **Syntax Highlighting**: Code blocks are automatically highlighted in the side panel.
-   **Keyboard Shortcuts**: Ctrl/Cmd+Enter to send prompts from the side panel.

## 🚀 Installation

### Load Unpacked Extension (Recommended)

1.  **Download or Clone**: Get this repository onto your local machine.
2.  **Open Chrome Extensions**: Navigate to `chrome://extensions/`.
3.  **Enable Developer Mode**: Toggle the switch in the top-right corner.
4.  **Load Unpacked**: Click "Load unpacked" and select the folder where you downloaded/cloned the extension files (the root folder containing `manifest.json`).
5.  **Pin the Extension**: Click the puzzle piece icon (Extensions) in your Chrome toolbar and pin "Multi-LLM Coder" for easy access.
6.  **Open Side Panel**: Click the pinned "Multi-LLM Coder" icon. Chrome will ask if you want to show the side panel; confirm. You can then select "Multi-LLM Coder" from the side panel dropdown.

## 📖 Usage

### Initial Setup

1.  **Open LLM Websites**:
    *   Open [Gemini](https://gemini.google.com) in one tab.
    *   Open [ChatGPT](https://chat.openai.com) in another tab.
    *   Ensure you are logged into both services.
2.  **Open the Extension Side Panel**:
    *   Click the "Multi-LLM Coder" icon in your Chrome toolbar and choose to open the side panel, or select it from the side panel dropdown if already open.

### Sending Prompts (Two Main Ways)

**1. Using the Side Panel (for sending to one or both LLMs simultaneously):**

1.  **Enter Your Prompt**: Type your question in the side panel's text area.
2.  **Select LLMs**: Check the boxes for Gemini and/or ChatGPT.
3.  **Send**: Click "Send Prompt" or press Ctrl/Cmd+Enter.
4.  **View Responses**: The side panel will update with responses, or indicate they are being processed. You can view individual responses in their respective tabs within the side panel or use the "Compare" tab.

**2. Using In-Page Forwarding (for sending a prompt from one LLM to the other):**

1.  **Navigate to an LLM Page**: Go to either `chatgpt.com` or `gemini.google.com`.
2.  **Locate the Toggle Button**:
    *   On **ChatGPT**: Look for a "⇄ Gemini" button near the prompt input area.
    *   On **Gemini**: Look for a "⇄ ChatGPT" button near the prompt input area.
3.  **Activate Forwarding**: Click the toggle button. It will turn green when active, indicating that sending a prompt on this page will also send it to the other LLM.
4.  **Type and Send Your Prompt**: Write your message in the current LLM's input field and send it as you normally would (e.g., by pressing Enter or clicking its native send button).
5.  **Automatic Forwarding**: The extension will automatically take the prompt you just sent and also input and send it on the other LLM's page.
    *   *Example*: If you're on Gemini, activate "⇄ ChatGPT", and send "Hello world", "Hello world" will be sent to Gemini (by you) and then automatically sent to ChatGPT by the extension.

### Interface Overview

-   **Side Panel**:
    -   **Input Area**: Large text area with character counter.
    -   **LLM Selection**: Checkboxes to choose LLMs for simultaneous sending.
    -   **Send Button**: Sends prompt from side panel to selected LLMs.
    -   **Tabs**: "Gemini", "ChatGPT", "Compare" for viewing responses.
    -   **Status Bar**: Shows connection status.
-   **In-Page Toggle Buttons**:
    -   Appear on `chatgpt.com` (as "⇄ Gemini") and `gemini.google.com` (as "⇄ ChatGPT").
    -   Control the forwarding feature. Green means active.

## 🔧 How It Works

The extension combines a side panel interface with content scripts that interact directly with the LLM websites.

1.  **Manifest (`manifest.json`)**:
    *   Defines the extension's permissions (access to LLM sites, scripting, side panel).
    *   Declares the background service worker, content scripts, and side panel HTML.

2.  **Background Script (`background.js`)**:
    *   **Core Logic**: Acts as the central coordinator.
    *   **Tab Management**: `findLLMTab()` locates open and active tabs for ChatGPT and Gemini.
    *   **Message Handling**: Listens for messages from the side panel (`SEND_PROMPT`) and content scripts (`FORWARD_PROMPT`).
    *   **Script Injection**: Uses `chrome.scripting.executeScript()` to run the `simpleInteraction` function within the context of the target LLM's webpage.
    *   **`simpleInteraction(prompt, llmType)` function**:
        *   This function is dynamically injected into the target LLM's page.
        *   **DOM Element Finding**: Locates the correct input field (e.g., `#prompt-textarea` for ChatGPT, `div.ql-editor` for Gemini) and the send button on the page using predefined selectors.
        *   **Setting Input Value**:
            *   For ChatGPT (`TEXTAREA`): Uses `Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(inputElement, prompt);` to reliably set the textarea's value in a way that React (ChatGPT's framework) recognizes.
            *   For Gemini (`contentEditable div`): Uses `document.execCommand('insertText', false, prompt);`.
        *   **Event Dispatching**: After setting the input value, it dispatches `input`, `change`, and sometimes `keydown`/`keyup` events to ensure the LLM's webpage processes the input as if it were typed by a user. This is crucial for frameworks to update their internal state.
        *   **Clicking Send Button**: Simulates a click on the LLM's native send button.
    *   **Communication**: Sends status updates (`LLM_PROGRESS`, `LLM_RESPONSE`, `LLM_ERROR`) back to the side panel or popup.

3.  **Content Script (`contentScript.js`)**:
    *   **Injected into LLM Pages**: Runs automatically on `chatgpt.com` and `gemini.google.com`.
    *   **Toggle Button Injection**:
        *   Detects which LLM page it's on.
        *   Dynamically creates and inserts a "⇄ OtherLLM" toggle button near the native prompt input area. The `addToggleButton()` function handles finding a suitable parent element and styling the button.
        *   Manages the `forwardEnabled` state based on button clicks.
    *   **Event Listening**:
        *   Attaches event listeners to the LLM page's native input field (for 'Enter' key presses) and its native send button (for clicks).
        *   If `forwardEnabled` is true when a prompt is sent on the current page, it captures the prompt text.
    *   **Message Sending**: Sends a `FORWARD_PROMPT` message (containing the `from` LLM and the `prompt` text) to the `background.js` script.
    *   **DOM Monitoring**: Uses a `MutationObserver` to re-apply button injection and listeners if the LLM page's DOM changes significantly (e.g., due to navigation or dynamic content loading).

4.  **Side Panel (`sidepanel.html`, `sidepanel.js`)**:
    *   **User Interface**: Provides the main UI for sending prompts to multiple LLMs and viewing/comparing responses.
    *   **Communication**: Sends `SEND_PROMPT` messages to `background.js` when the user submits a prompt.
    *   **Display Logic**: Receives messages from `background.js` (like responses or errors) and updates the UI accordingly.

5.  **Selectors (`selectors.js`)**:
    *   *Currently, selectors are embedded within `background.js` (`simpleInteraction`) and `contentScript.js`. This file is present but the primary selector logic has been integrated directly into the relevant scripts for more contextual control in the dev branch.*
    *   The core idea is that these selectors (CSS query strings) are used to find specific HTML elements (input boxes, send buttons) on the LLM websites. **These are the most fragile part of the extension**, as LLM websites can change their HTML structure at any time, breaking the selectors.

**Flow for In-Page Forwarding (e.g., Gemini to ChatGPT):**

1.  User is on `gemini.google.com`.
2.  `contentScript.js` (running on Gemini) injects the "⇄ ChatGPT" button.
3.  User clicks "⇄ ChatGPT", setting `forwardEnabled = true` in that content script.
4.  User types "Hello" in Gemini's input and presses Enter.
5.  Gemini's `contentScript.js` detects the Enter key press, sees `forwardEnabled` is true, gets "Hello".
6.  It sends a message `{ type: 'FORWARD_PROMPT', from: 'gemini', prompt: 'Hello' }` to `background.js`.
7.  `background.js` receives this message. `handleForwardPrompt` determines the target is 'chatgpt'.
8.  `processLLM('chatgpt', 'Hello')` is called.
9.  `findLLMTab('chatgpt')` finds the ChatGPT tab.
10. `injectAndExecute(chatgptTabId, 'chatgpt', 'Hello')` runs the `simpleInteraction` function on the ChatGPT page.
11. Inside ChatGPT's page, `simpleInteraction` finds `#prompt-textarea`, sets its value to "Hello" (using native setter + events), finds the send button, and clicks it.
12. ChatGPT processes "Hello" and generates a response.

## ⚠️ Important Notes

### Selector Stability
The extension's ability to interact with LLM websites (finding input fields, send buttons) depends heavily on their HTML structure (DOM selectors).
-   **Websites Change**: LLM providers frequently update their websites. These updates can change the HTML, causing the extension's selectors to fail.
-   **Troubleshooting**: If the extension stops writing text or sending messages on a specific site, the first suspect is a broken selector.
-   **Updating Selectors**: You'll need to inspect the LLM website's HTML (using browser developer tools) and update the corresponding selectors in `background.js` (within the `simpleInteraction` function) and `contentScript.js` (within `findInput` and `findSendButton`).

### Limitations
-   Requires active tabs with Gemini and ChatGPT open and logged in for interactions.
-   Functionality can break if LLM websites significantly change their DOM structure.
-   No offline functionality.
-   Subject to the LLM websites' rate limits and usage policies.

## 🛠️ Development

### File Structure
Use code with caution.
Markdown
chromeEX/
├── manifest.json # Extension configuration and permissions
├── background.js # Service worker: core logic, script injection, message routing
├── contentScript.js # Injected into LLM pages: adds toggle button, captures prompts for forwarding
├── sidepanel.html # Side panel UI structure
├── sidepanel.js # Side panel UI logic and communication with background.js
├── popup.html # Popup UI (currently simpler than sidepanel)
├── popup.js # Popup UI logic
├── styles.css # Styling for side panel and popup
├── selectors.js # (Legacy/Reference) Centralized selectors (dev branch integrates them)
└── README.md # This file

### Debugging
-   **Side Panel**: Right-click inside the side panel and select "Inspect" to open DevTools for it.
-   **Content Scripts**: Open DevTools on the ChatGPT or Gemini page. Console logs from `contentScript.js` will appear here. Errors during `simpleInteraction` (which is injected) will also appear here.
-   **Background Script**: Go to `chrome://extensions/`, find "Multi-LLM Coder", and click the "Service worker" link to open its DevTools.
-   **Test Selectors**: Use the browser's DevTools console on the LLM page (e.g., `document.querySelector('#prompt-textarea')`) to test if selectors are still valid.

## 🐛 Troubleshooting

### Extension Not Working / Text Not Being Sent
1.  **Check LLM Tabs**: Ensure Gemini and ChatGPT tabs are open, fully loaded, and you're logged in.
2.  **Console Errors**: Open all three DevTools consoles (Side Panel, Content Script on LLM page, Background Script) and look for errors.
    *   **Background Script**: Check "Injection results" for errors from `simpleInteraction`.
    *   **LLM Page Console**: Look for errors from `simpleInteraction` or `contentScript.js`.
3.  **Selector Issues**: This is the most common problem. Website UIs change. You may need to update selectors in `background.js` (inside `simpleInteraction`) and `contentScript.js`.
4.  **Refresh**: Try refreshing the LLM website tabs and then the extension (via `chrome://extensions/`).
5.  **Re-enable Extension**: Disable and then re-enable the extension in `chrome://extensions/`.

### In-Page Toggle Button Missing or Misplaced
1.  Ensure the `contentScript.js` is running on the page (check console for its initial log).
2.  The logic in `addToggleButton()` in `contentScript.js` might need adjustment if the site's layout around the input area has drastically changed.

### Connection Status in Side Panel Shows "Not Connected"
1.  Make sure the LLM websites are fully loaded.
2.  Check that the URLs match the host permissions in `manifest.json`.
3.  Try refreshing the extension and the LLM tabs.

## 📝 License

This project is open source and available under the MIT License.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests. Key areas:
-   Keeping DOM selectors up-to-date.
-   Adding support for new LLM providers.
-   Improving UI/UX and error handling.

## 📞 Support

If you encounter issues:
1.  Follow the Troubleshooting steps above.
2.  Carefully examine console logs from all relevant parts of the extension.
3.  Create an issue on the project repository, providing:
    *   Chrome version.
    *   Extension version (if applicable, or commit hash).
    *   Detailed steps to reproduce the issue.
    *   Relevant console logs and screenshots.

## 📦 Dependencies
This Chrome extension is built with vanilla JavaScript and relies on:
-   Chrome Extension APIs (built into Chrome).
-   Native Web APIs.
-   **highlight.js** (CDN) and **Material Icons** (CDN) for the side panel UI.

No build process or Node.js dependencies are required for the core functionality.