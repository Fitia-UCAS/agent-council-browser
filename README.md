# Multi-LLM Coder Chrome Extension

Chrome extension side panel that lets you route a prompt to multiple LLM web UIs (no APIs) so you can compare outputs or run a debate.

Core idea: runs target **agents** (a provider + a specific browser tab profile), so you can run **multiple instances of the same provider** (e.g., 3 ChatGPT tabs debating each other).

It supports:

1. **Single**: send to one agent (ChatGPT / Gemini / Claude / Grok).
2. **Compare (Parallel)**: send the same prompt to 2+ agents.
3. **Debate**: multi-round round-robin across 2+ agents.

## ✨ Features

- **Multi-LLM Support**: Interact with Gemini, ChatGPT, Claude, and Grok.
- **Route Builder (“To”)**: Choose Single / Compare / Debate, add/reorder agents, and set debate rounds.
- **Connect-on-demand**: Connect only what your route needs (plus **Connect all**). Use **New tab** to create additional same-provider agents.
- **Encrypted Chat History (Local-First)**: Chats and messages are stored in IndexedDB and encrypted with a user passphrase.
- **Thread List + Paging**: Open past chats and load older messages on demand (avoids huge payloads).
- **Attachments**: Attach files/images in the side panel.
    - ChatGPT: best-effort auto-upload.
    - Gemini: manual upload (text-only is sent from the side panel when files are attached).
    - Claude: best-effort auto-upload.
    - Grok: best-effort auto-upload (falls back to text-only if Grok blocks automation).
- **Dark Theme**: Professional dark theme optimized for developers.
- **Real-time Status**: Live connection status in the side panel.
- **Syntax Highlighting**: Code blocks are automatically highlighted in the side panel.
- **Keyboard Shortcuts**: Ctrl/Cmd+Enter to send prompts from the side panel.

## 🚀 Installation

### Load Unpacked Extension (Recommended)

1.  **Download or Clone**: Get this repository onto your local machine.
2.  **Open Chrome Extensions**: Navigate to `chrome://extensions/`.
3.  **Enable Developer Mode**: Toggle the switch in the top-right corner.
4.  **Build runtime**: Run `npm run build:src` once (this generates `manifest.json` and runtime files in repo root).
5.  **Load Unpacked**: Click "Load unpacked" and select the repo root folder.
6.  **Pin the Extension**: Click the puzzle piece icon (Extensions) in your Chrome toolbar and pin "Multi-LLM Coder" for easy access.
7.  **Open Side Panel**: Click the pinned "Multi-LLM Coder" icon. Chrome will ask if you want to show the side panel; confirm. You can then select "Multi-LLM Coder" from the side panel dropdown.

## 📖 Usage

### Initial Setup

1.  **Open the Extension Side Panel**:
    - Click the "Multi-LLM Coder" icon in your Chrome toolbar and choose to open the side panel, or select it from the side panel dropdown if already open.
2.  **Enable encrypted history (recommended)**:
    - Side panel → **Settings** → **Security**
    - Set a passphrase and click **Enable encryption**
    - After restarting Chrome, you must click **Unlock** to access history and run sessions again.
    - If you lose the passphrase, history cannot be recovered (use **Reset history** to wipe).

### Sending prompts from the side panel

1. **Choose route**: click the `To` pill and pick **Single**, **Compare** (Parallel), or **Debate** (set rounds as needed).
2. **Add agents**: each row is a provider + a profile selection (Default or a specific tab profile).
    - Want multiple ChatGPT/Gemini/Claude/Grok agents? Use **New tab** in the provider row to open a fresh tab, claim it as a new profile, and auto-assign it to an agent.
3. **Connect** when prompted:
    - If a provider/profile is not ready, click **Connect** (or **Connect all**).
    - “Ready” means the provider tab responds to a `PING` from the content script (not just “a tab exists”).
4. **Write your prompt** and click **Send** (or press Ctrl/Cmd+Enter).
5. **Optional**: attach files via **Attach** (see Attachments notes below).

### Interface Overview

- **Side panel chat**: timeline of messages + composer at the bottom.
- **Composer**:
    - prompt textarea,
    - attachments (optional),
    - the `To` pill (Route Builder) to pick Single / Compare / Debate and connect the required agents/profiles.
- **Provider status**: quick “Providers: X/Y ready” indicator, plus Settings.

## 🔧 How It Works

This extension uses UI automation against provider web apps:

- `src/sidepanel/index.js` (generated to `sidepanel.js`) sends `START_RUN` (with a Route) to background.
- `src/background/index.js` (generated to `background.js`):
    - opens/claims provider tabs into persistent **Tab Profiles**,
    - injects prompts via `chrome.scripting.executeScript(...)` (see `simpleInteraction(...)`),
    - tracks sessions (Single / Parallel / Debate) and progress.
- `src/content/index.js` (generated to `contentScript.js`) runs on provider pages to:
    - respond to `PING`/`PONG` (used to mark a provider “Ready”),
    - capture responses and report them back to the background.
- Encrypted history is stored in IndexedDB (`mlc_history_v1`).

Developer docs (canonical): `AGENTS.md` + `AGENTSMD/`.

## ⚠️ Important Notes

### Selector Stability

The extension's ability to interact with LLM websites (finding input fields, send buttons) depends heavily on their HTML structure (DOM selectors).

- **Websites Change**: LLM providers frequently update their websites. These updates can change the HTML, causing the extension's selectors to fail.
- **Troubleshooting**: If the extension stops writing text or sending messages on a specific site, the first suspect is a broken selector.
- **Updating Selectors**: Inspect provider HTML in DevTools and update selectors in `src/background/index.js` and `src/content/index.js`.

### Limitations

- Requires being logged in on the provider websites.
- Functionality can break if LLM websites significantly change their DOM structure.
- Claude sending uses `chrome.debugger` to simulate real typing (needed because Claude can ignore synthetic DOM events). This requires the `debugger` permission and the Claude tab cannot have DevTools open while sending.
- No offline functionality.
- Subject to the LLM websites' rate limits and usage policies.

## 🛠️ Development

### Build workflow (JS-first)

This repo now uses `src/` as the source of truth and generates runtime files in the root:

```bash
npm ci
npm run build:src
```

For release artifacts:

```bash
npm run build:release
```

The release pipeline is allowlist-based (`scripts/release/release-allowlist.txt`) and verified by `scripts/release/verify-release-artifact.sh`.

### File Structure

```
src/               # source of truth (JS)
  background/      # service worker logic and runtime modules
  content/         # provider capture/send content script logic
  sidepanel/       # side panel app JS/HTML/CSS
  shared/          # protocol and shared runtime helpers
scripts/build/     # source-to-runtime generation scripts
scripts/release/   # release artifact build + verification
background.js      # generated at build time (do not edit directly)
contentScript.js   # generated at build time (do not edit directly)
sidepanel.js       # generated at build time (do not edit directly)
manifest.json      # generated from src/manifest/manifest.base.json at build time
tests/             # unit/integration/e2e tests
```

### Debugging

- **Side Panel**: Right-click inside the side panel and select "Inspect" to open DevTools for it.
- **Content Scripts**: Open DevTools on the ChatGPT, Gemini, or Claude page. Console logs from generated `contentScript.js` appear here.
- **Background Script**: Go to `chrome://extensions/`, find "Multi-LLM Coder", and click the "Service worker" link to open its DevTools.
- **Test Selectors**: Use the browser's DevTools console on the LLM page (e.g., `document.querySelector('#prompt-textarea')`) to test if selectors are still valid.
- **Inspect chat history DB**: DevTools → Application → IndexedDB → `mlc_history_v1` (see `AGENTSMD/AGENTS_DBS.md` for schema + encryption details).

## 🐛 Troubleshooting

### Extension Not Working / Text Not Being Sent

1.  **Check provider tabs**: Ensure the provider tab(s) you’re sending to are open, fully loaded, and you’re logged in (or click **Connect** again from the Route Builder).
2.  **Console Errors**: Open all three DevTools consoles (Side Panel, Content Script on LLM page, Background Script) and look for errors.
    - **Background Script**: Check injection/send errors from `simpleInteraction`.
    - **LLM Page Console**: Look for capture/send errors in generated `contentScript.js`.
3.  **Selector Issues**: Website UIs change. Update selectors in `src/background/index.js` and `src/content/index.js`, then run `npm run build:src`.
4.  **Refresh**: Try refreshing the LLM website tabs and then the extension (via `chrome://extensions/`).
5.  **Re-enable Extension**: Disable and then re-enable the extension in `chrome://extensions/`.

### Connection Status in Side Panel Shows "Not Connected"

1.  Make sure the LLM websites are fully loaded.
2.  Check that the URLs match the host permissions in `manifest.json`.
3.  Try refreshing the extension and the LLM tabs.

## 📝 License

This project is open source and available under the MIT License.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests. Key areas:

- Keeping DOM selectors up-to-date.
- Adding support for new LLM providers.
- Improving UI/UX and error handling.

## 📞 Support

If you encounter issues:

1.  Follow the Troubleshooting steps above.
2.  Carefully examine console logs from all relevant parts of the extension.
3.  Create an issue on the project repository, providing:
    - Chrome version.
    - Extension version (if applicable, or commit hash).
    - Detailed steps to reproduce the issue.
    - Relevant console logs and screenshots.

## 📦 Dependencies

This extension remains JavaScript-first, with build/test tooling for production quality:

- Chrome Extension APIs + native Web APIs
- `esbuild` (runtime generation from `src/`)
- `eslint` + `prettier` (quality gates)
- `vitest` (unit tests)
- `@playwright/test` (smoke E2E checks)

Remote Google Fonts fetches were removed; side panel fonts now resolve locally via `assets/fonts.css`.
