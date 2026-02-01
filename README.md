# Multi-LLM Coder Chrome Extension

Chrome extension side panel that lets you route a prompt to multiple LLM web UIs (no APIs) so you can compare outputs or run a debate.

Core idea: runs target **agents** (a provider + a specific browser tab profile), so you can run **multiple instances of the same provider** (e.g., 3 ChatGPT tabs debating each other).

It supports:

1. **Single**: send to one agent (ChatGPT / Gemini / Claude / Grok).
2. **Compare (Parallel)**: send the same prompt to 2+ agents.
3. **Debate**: multi-round round-robin across 2+ agents.
4. **In-page forwarding**: optional ⇄ toggle buttons on ChatGPT/Gemini pages (legacy flow).

## ✨ Features

-   **Multi-LLM Support**: Interact with Gemini, ChatGPT, Claude, and Grok.
-   **Route Builder (“To”)**: Choose Single / Compare / Debate, add/reorder agents, and set debate rounds.
-   **Connect-on-demand**: Connect only what your route needs (plus **Connect all**). Use **New tab** to create additional same-provider agents.
-   **Encrypted Chat History (Local-First)**: Chats and messages are stored in IndexedDB and encrypted with a user passphrase.
-   **Thread List + Paging**: Open past chats and load older messages on demand (avoids huge payloads).
-   **In-Page Forwarding**: Toggle buttons injected into ChatGPT and Gemini pages to send the current prompt to the other LLM.
-   **Auto Follow-up**: When forwarding from ChatGPT to Gemini, after both LLMs respond, the extension automatically inserts Gemini's response into ChatGPT for a comparative follow-up.
-   **Attachments**: Attach files/images in the side panel.
    - ChatGPT: best-effort auto-upload.
    - Gemini: manual upload (text-only is sent from the side panel when files are attached).
    - Claude: best-effort auto-upload.
    - Grok: best-effort auto-upload (falls back to text-only if Grok blocks automation).
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

1.  **Open the Extension Side Panel**:
    *   Click the "Multi-LLM Coder" icon in your Chrome toolbar and choose to open the side panel, or select it from the side panel dropdown if already open.
2.  **Enable encrypted history (recommended)**:
    *   Side panel → **Settings** → **Security**
    *   Set a passphrase and click **Enable encryption**
    *   After restarting Chrome, you must click **Unlock** to access history and run sessions again.
    *   If you lose the passphrase, history cannot be recovered (use **Reset history** to wipe).

### Sending prompts from the side panel

1. **Choose route**: click the `To` pill and pick **Single**, **Compare** (Parallel), or **Debate** (set rounds as needed).
2. **Add agents**: each row is a provider + a profile selection (Default or a specific tab profile).
   - Want multiple ChatGPT/Gemini/Claude/Grok agents? Use **New tab** in the provider row to open a fresh tab, claim it as a new profile, and auto-assign it to an agent.
3. **Connect** when prompted:
   - If a provider/profile is not ready, click **Connect** (or **Connect all**).
   - “Ready” means the provider tab responds to a `PING` from the content script (not just “a tab exists”).
4. **Write your prompt** and click **Send** (or press Ctrl/Cmd+Enter).
5. **Optional**: attach files via **Attach** (see Attachments notes below).

### In-page forwarding (optional)

1.  **Navigate to an LLM Page**: Go to either `chatgpt.com` or `gemini.google.com`.
2.  **Locate the Toggle Button**:
    *   On **ChatGPT**: Look for a "⇄ Gemini" button near the prompt input area.
    *   On **Gemini**: Look for a "⇄ ChatGPT" button near the prompt input area.
3.  **Activate Forwarding**: Click the toggle button. It will turn green when active, indicating that sending a prompt on this page will also send it to the other LLM.
4.  **Type and Send Your Prompt**: Write your message in the current LLM's input field and send it as you normally would (e.g., by pressing Enter or clicking its native send button).
5.  **Automatic Forwarding**: The extension will automatically take the prompt you just sent and also input and send it on the other LLM's page.
    *   *Example*: If you're on Gemini, activate "⇄ ChatGPT", and send "Hello world", "Hello world" will be sent to Gemini (by you) and then automatically sent to ChatGPT by the extension.
6.  **Auto Follow-up** (ChatGPT to Gemini only):
    *   When forwarding from ChatGPT to Gemini (but not the other way around), after both LLMs generate their responses, the extension will automatically populate ChatGPT's input field with Gemini's response and a prompt asking ChatGPT to compare and enhance its answer.
    *   The follow-up text is inserted but NOT automatically sent - you can review and edit it before sending.

### Interface Overview

- **Side panel chat**: timeline of messages + composer at the bottom.
- **Composer**:
  - prompt textarea,
  - attachments (optional),
  - the `To` pill (Route Builder) to pick Single / Compare / Debate and connect the required agents/profiles.
- **Provider status**: quick “Providers: X/Y ready” indicator, plus Settings.
- **In-page toggle buttons** (optional):
  - Appear on `chatgpt.com` (as "⇄ Gemini") and `gemini.google.com` (as "⇄ ChatGPT").
  - Control the forwarding feature (green means active).

## 🔧 How It Works

This extension uses UI automation against provider web apps:

- `sidepanel.js` sends `START_RUN` (with a Route) to `background.js`.
- `background.js`:
  - opens/claims provider tabs into persistent **Tab Profiles**,
  - injects prompts via `chrome.scripting.executeScript(...)` (see `simpleInteraction(...)`),
  - tracks sessions (Single / Parallel / Debate) and progress.
- `contentScript.js` runs on provider pages to:
  - respond to `PING`/`PONG` (used to mark a provider “Ready”),
  - capture responses and report them back to the background.
- Encrypted history is stored in IndexedDB (`mlc_history_v1`).

Developer docs (canonical): `AGENTS.md` + `AGENTSMD/`.

## ⚠️ Important Notes

### Selector Stability
The extension's ability to interact with LLM websites (finding input fields, send buttons) depends heavily on their HTML structure (DOM selectors).
-   **Websites Change**: LLM providers frequently update their websites. These updates can change the HTML, causing the extension's selectors to fail.
-   **Troubleshooting**: If the extension stops writing text or sending messages on a specific site, the first suspect is a broken selector.
-   **Updating Selectors**: You'll need to inspect the LLM website's HTML (using browser developer tools) and update the corresponding selectors in `background.js` (within the `simpleInteraction` function) and `contentScript.js` (within `findInput` and `findSendButton`).

### Limitations
-   Requires being logged in on the provider websites.
-   Functionality can break if LLM websites significantly change their DOM structure.
-   Claude sending uses `chrome.debugger` to simulate real typing (needed because Claude can ignore synthetic DOM events). This requires the `debugger` permission and the Claude tab cannot have DevTools open while sending.
-   No offline functionality.
-   Subject to the LLM websites' rate limits and usage policies.

## 🛠️ Development

### File Structure
```
manifest.json    # MV3 extension config (side panel)
background.js    # service worker: routing + injection + sessions + profiles + history APIs
contentScript.js # injected into provider pages: toggle button + response capture
sidepanel.html   # side panel UI structure
sidepanel.js     # side panel UI logic + Route Builder + messaging
styles.css       # side panel styling
selectors.js     # legacy/reference selectors
AGENTSMD/        # repo memory docs (canonical for maintainers)
tests/           # small node-based heuristics tests
```

### Debugging
-   **Side Panel**: Right-click inside the side panel and select "Inspect" to open DevTools for it.
-   **Content Scripts**: Open DevTools on the ChatGPT, Gemini, or Claude page. Console logs from `contentScript.js` will appear here. Errors during `simpleInteraction` (which is injected) will also appear here.
-   **Background Script**: Go to `chrome://extensions/`, find "Multi-LLM Coder", and click the "Service worker" link to open its DevTools.
-   **Test Selectors**: Use the browser's DevTools console on the LLM page (e.g., `document.querySelector('#prompt-textarea')`) to test if selectors are still valid.
-   **Inspect chat history DB**: DevTools → Application → IndexedDB → `mlc_history_v1` (see `AGENTSMD/AGENTS_DBS.md` for schema + encryption details).

## 🐛 Troubleshooting

### Extension Not Working / Text Not Being Sent
1.  **Check provider tabs**: Ensure the provider tab(s) you’re sending to are open, fully loaded, and you’re logged in (or click **Connect** again from the Route Builder).
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
