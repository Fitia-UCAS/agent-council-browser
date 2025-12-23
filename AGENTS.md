# AGENTS.md — Multi‑LLM Coder Extension Memory

This file is the durable memory for the repo. It is the canonical reference for how the extension works **today**. The README is known to be outdated; trust this file and the code.

## 1) What this extension does (current behavior)

- Chrome extension that runs a **side panel chat UI** with a multi‑iteration debate between ChatGPT and Gemini.
- It can also **forward prompts between LLM pages** via injected toggle buttons (legacy flow, still present).
- The side panel is the primary UI: clicking the extension icon opens the side panel (no popup).

### Main user flow (debate sessions)

1. User opens at least one ChatGPT tab and one Gemini tab.
2. In the side panel, user selects:
   - First LLM (ChatGPT or Gemini)
   - Number of iterations (rounds)
   - Which tab to use for ChatGPT and Gemini (or Auto)
3. User submits a prompt.
4. The extension runs a debate:
   - **Round 1**: first LLM gets full context + user query.
   - **Round 1**: second LLM gets full context + user query + first LLM answer.
   - **Rounds 2..N**: each new prompt contains only the previous model’s latest answer (the tab thread holds history).
5. The side panel shows a **single linear transcript**:
   - user query
   - GPT answer 1
   - Gemini answer 1
   - GPT answer 2
   - Gemini answer 2
   - ...

### Long‑running responses

- Designed to work even if ChatGPT “thinking mode” takes 20+ minutes.
- Capture logic does **not** pause when the tab is hidden.
- Gemini image outputs are **ignored**; if the response is image‑only, a placeholder text is inserted to keep the debate moving.

## 2) Key files and responsibilities

- `manifest.json`
  - MV3 manifest; side panel enabled; no popup.
  - Content scripts injected into `chatgpt.com`, `chat.openai.com`, `gemini.google.com`.

- `background.js`
  - Service worker: session state machine, prompt injection, tab discovery, message routing.
  - Persists active debate sessions.
  - Sends `MLC_PROMPT_SENT` to content scripts after injection.

- `contentScript.js`
  - Runs in ChatGPT/Gemini pages.
  - Injects “⇄ OtherLLM” toggle button and forwarding listeners (legacy).
  - Captures LLM responses and posts them back to background.

- `sidepanel.html`, `sidepanel.js`, `styles.css`
  - Chat‑like UI: settings + transcript + composer.
  - Renders responses as **plain text** (no `innerHTML`).

- `popup.html`, `popup.js`
  - Present but **not used** by default.

## 3) Debate session state machine (background.js)

### Stored state

Stored in `chrome.storage.local` key: `mlc_active_session_v2`.

Structure (`activeDebateState`):

- `isActive` (bool)
- `sessionId` (string, `session_<ts>_<rand>`)
- `rounds` (int)
- `totalTurns` (int = 2 * rounds)
- `turnIndex` (int, starts at 1)
- `firstLLM` / `secondLLM` (`chatgpt` or `gemini`)
- `tabIds` (`{ chatgpt, gemini }`)
- `userQuery` (string)
- `messages` (array of `{ role, content, timestamp, turnIndex, roundIndex }`)
- `waitingFor` (current LLM expected to answer)
- `lastPromptId` (string)
- `lastPromptTimestamp` (epoch ms)

### Turn logic

- `turnIndex` 1..(2*rounds)
- `roundIndex = ceil(turnIndex / 2)`
- `expectedLLM = turnIndex % 2 === 1 ? firstLLM : secondLLM`

When a turn is sent:

1. Background builds prompt via `buildDebatePrompt(...)`.
2. `injectAndExecute` sends the prompt into the right tab using `simpleInteraction`.
3. Background sends `MLC_PROMPT_SENT` to that tab’s content script.
4. Content script captures response and sends `MLC_RESPONSE_CAPTURED`.
5. Background validates response (session id, LLM, promptId/turnIndex), appends to state, and advances to next turn.

### Prompt templates

**Header** (used in first two turns only):

```
Here is a multi-agent session with ChatGPT and Gemini over N iterations.
Please be constructive during your debate to bring the most accurate answer to the user.
Be critical, constructive, and fair.
```

**Turn 1** (Round 1, first LLM):

```
[HEADER]

Iteration: 1
Turn: <ChatGPT|Gemini>

User query:
<user_query>
```

**Turn 2** (Round 1, second LLM):

```
[HEADER]

Iteration: 1
Turn: <ChatGPT|Gemini>

User query:
<user_query>

<FirstLLM> answer:
<first_answer>

Now respond with critique and improvements. If you disagree, explain why.
```

**Turns 3+**:

- If expected LLM is firstLLM:

```
Iteration: <round>
Here is <OtherLLM> answer from iteration <round-1>:
<last_other_answer>

Now respond as <FirstLLM>.
```

- If expected LLM is secondLLM:

```
Iteration: <round>
Here is <OtherLLM> answer:
<last_other_answer>

Now respond as <SecondLLM>.
```

## 4) Prompt injection (background.js)

### `simpleInteraction(prompt, llmType)`

- Injected into the target page via `chrome.scripting.executeScript`.
- Finds input element using LLM‑specific selectors:
  - ChatGPT: `#prompt-textarea`, `textarea[data-testid="prompt-textarea"]`, etc.
  - Gemini: `div.ql-editor[role="textbox"]`, contenteditable fallbacks.
- Sets value using the correct method:
  - ChatGPT often uses **contenteditable**; uses `document.execCommand('insertText')`.
  - Dispatches `input`, `change`, and key events for framework sync.
- Finds send button using selector lists; if not found, **falls back to Enter key**.

### `simpleInteraction_InjectOnly(...)`

- Used for **legacy follow‑up** (forwarding flow).
- Injects text into the input without sending.

## 5) Response capture (contentScript.js)

### Capture arming

- Content script listens for `MLC_PROMPT_SENT`.
- `armCapture` stores:
  - `promptId`, `sessionId`, `turnIndex`
  - `baselineText` (current latest response text, to avoid capturing old output)
  - `hasNewText` flag (must see new output before capturing)

### Capture algorithm

- `MutationObserver` + interval polling run continuously.
- Each `evaluateCapture()`:
  - Requires a minimum delay from prompt sent.
  - Extracts latest response text.
  - Waits for **new text** (different from baseline).
  - Tracks `stableTicks` and `lastTextChangeAt`.
  - If generation appears to be still ongoing but text is stable for a long time, it forces a capture (`forceCaptureMs`).

Current force‑capture thresholds:

- ChatGPT: 20s stable
- Gemini: 15s stable

### Generating detection

- ChatGPT: presence of stop button (`button[data-testid="stop-button"]` or aria Stop).
- Gemini: stop icon/button, progress spinners, or disabled send button heuristics.

### Extraction logic

**ChatGPT**:

- Uses `[data-message-author-role="assistant"]` and `.markdown/.prose` fallbacks.
- Returns last assistant text found.

**Gemini**:

- Scans a large selector set of candidate containers from `main`/`body`.
- Filters out user messages using selectors and `aria-label` hints.
- Removes media nodes (`img`, `video`, `canvas`, `svg`, `figure`, `picture`).
- If only media is found, returns placeholder text:

```
[Gemini returned an image output; no text was captured. Proceeding with debate.]
```

### Capture message types

- Session capture: `MLC_RESPONSE_CAPTURED` (includes sessionId, promptId, turnIndex, sourceLLM, content)
- Non‑session capture:
  - `CHATGPT_RESPONSE_CAPTURED`
  - `GEMINI_RESPONSE_CAPTURED`

## 6) UI and message protocol

### Side panel -> background

- `START_DEBATE_SESSION`:
  - `{ prompt, firstLLM, rounds, tabIds: { chatgpt, gemini } }`
- `STOP_SESSION`:
  - `{ sessionId }`
- `LIST_LLM_TABS`
- `SET_PREFERRED_TABS`:
  - `{ chatgptTabId, geminiTabId }`
- `GET_ACTIVE_SESSION`
- `SEND_PROMPT`:
  - `{ prompt, targets:{chatgpt, gemini}, multiAgent:{enabled, maxIterations} }`

### Background -> side panel

- `UI_SESSION_STARTED` `{ sessionId, rounds, firstLLM, tabIds }`
- `UI_MESSAGE_ADD` `{ role, content, timestamp, turnIndex, roundIndex }`
- `UI_SESSION_PROGRESS` `{ sessionId, waitingFor, roundIndex, totalRounds }`
- `UI_SESSION_ENDED` `{ sessionId, reason }`
- `UI_SESSION_ERROR` `{ error }`
- `LLM_TABS_LIST` `{ tabs:{chatgpt, gemini}, preferred }`
- `ACTIVE_SESSION` `{ session }`
- `LLM_RESPONSE` `{ llm, content }` (non‑session replies)
- `LLM_PROGRESS` / `LLM_ERROR`
- `CONNECTION_STATUS` `{ status: { chatgpt, gemini } }`

### Background <-> content scripts

- `MLC_PROMPT_SENT`:
  - `{ sessionId, promptId, llmType, turnIndex, timestamp }`
- `MLC_RESPONSE_CAPTURED` (session)
- `CHATGPT_RESPONSE_CAPTURED`, `GEMINI_RESPONSE_CAPTURED` (non‑session)
- `FORWARD_PROMPT` (legacy in‑page forwarding)
- `PING` / `PONG` for connection checks

## 7) Tab selection logic

- Tabs are discovered by URL patterns in `listLLMTabs`.
- User preferences stored in `chrome.storage.local` key: `mlc_preferred_tabs`.
- Selection order:
  1. Requested tab id (from UI)
  2. Preferred tab id
  3. Active tab
  4. Most recently accessed tab

## 8) Legacy forwarding flow (still present)

- `contentScript.js` injects a **⇄** toggle button on ChatGPT and Gemini pages.
- When enabled, user’s prompt is forwarded to the other LLM (`FORWARD_PROMPT`).
- Background maintains a follow‑up state (`activeFollowUpState`) to optionally insert the other model’s response back into the original tab (`simpleInteraction_InjectOnly`).

This flow is separate from debate sessions but shares capture logic.

## 9) Debugging and troubleshooting

### Where to inspect logs

- **Background**: Chrome extensions page → “Service Worker” console.
- **Content scripts**: open DevTools on ChatGPT/Gemini tabs.
- **Side panel**: right‑click → Inspect.

### Useful log prefixes

- `[MLC Background]` (routing, injection, session state)
- `[MLC Debate]` (turn progression)
- `[MLC Capture - chatgpt|gemini]` (capture and arming)
- `[SimpleInteraction INJECTED]` (injected DOM operations)

### Common breakpoints

- DOM selector changes on ChatGPT/Gemini.
- “Send button NOT found” warnings are common; fallback to Enter is intentional.
- Gemini capture can fail if selectors drift; update `extractGeminiResponseText`.

## 10) Adding a new provider (high‑level checklist)

To add a third LLM provider safely:

1. Update `manifest.json` host permissions and `content_scripts` matches.
2. Add provider to `listLLMTabs`, `resolveTabForLLM`, and side panel tab dropdown.
3. Extend `simpleInteraction` selectors and send button logic for the new provider.
4. Implement capture logic:
   - Add `is<Provider>Generating` and `extract<Provider>ResponseText`.
   - Ensure capture baseline and stability logic works.
5. Update prompt templates and `formatLLMLabel` if needed.
6. Update UI to allow selecting the provider in settings.
7. Add new message types if necessary, but prefer extending existing ones.
8. Test long‑running responses and hidden tabs.

## 11) Known fragilities / caveats

- LLM page DOMs change frequently → selectors may break.
- `document.execCommand` is deprecated but still used for contenteditable input; keep an alternative ready if it breaks.
- MV3 service worker can be suspended; state persistence is critical.
- Response capture relies on UI stability signals; adjust thresholds if models change rendering.

---

## Maintenance rule (must follow)

Each time a feature is validated or behavior changes, **update `AGENTS.md` to match the new reality** so future work can rely on it without re‑reading the entire codebase.
