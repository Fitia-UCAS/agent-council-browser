# AGENTS.md — Multi‑LLM Coder Extension Memory

This file is the durable memory for the repo. It is the canonical reference for how the extension works **today**. The README is known to be outdated; trust this file and the code.

## 1) What this extension does (current behavior)

- Chrome extension that runs a **side panel chat UI** with a multi‑iteration debate between ChatGPT and Gemini.
- It can also **forward prompts between LLM pages** via injected toggle buttons (legacy flow, still present).
- The side panel is the primary UI: clicking the extension icon opens the side panel (no popup).

### Main user flow (debate sessions)

1. User creates **Tab Profiles** for ChatGPT and Gemini in the Provider Manager:
   - Use the current tab, or open a new provider tab and claim it after manual model selection.
2. In the side panel, user selects:
   - First LLM (ChatGPT or Gemini)
   - Number of iterations (rounds)
   - Which ChatGPT and Gemini profile to use (or Default)
3. User submits a prompt (start is blocked until both selected profiles are valid).
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

### Provider Manager (Tab Profiles) UX

- Profiles are the only way to run debate sessions. Each provider (ChatGPT, Gemini) needs a valid profile.
- Profile list is grouped by provider with cards showing:
  - User label (renameable)
  - Status pill (OK / Offline / Wrong host / Unknown)
  - Tab info (last known title or URL, tabId if known)
  - Window id (when available)
  - Optional model hint (best effort)
  - Badges: Default, In use
- Actions per profile card:
  - Focus (brings the tab + window to front)
  - Set default
  - Rename (local label only, does not touch provider UI)
  - Rebind to current tab (claims the active tab as this profile)
  - Remove (unassigns and deletes the profile)
- Global actions:
  - "Use current ChatGPT tab" / "Use current Gemini tab"
  - "Open new ChatGPT tab" / "Open new Gemini tab"

### Open tab + claim wizard (best effort model selection)

- "Open new ..." opens the provider homepage in a new tab.
- A claim wizard appears in the side panel:
  - Instructs the user to manually pick a model in the provider UI.
  - Shows a best effort detected model label if available.
  - "Claim this tab" assigns the opened tab to a new profile.
  - Claiming does not depend on model detection.
- Wizard is dismissed on claim or cancel; cancel does not close the tab.

### Session gating and safety

- "Start debate" is disabled until:
  - Prompt is non-empty
  - Iterations > 0
  - Selected ChatGPT + Gemini profiles are valid (status OK, tab exists)
- The background still validates profiles before every prompt injection.
- If a profile goes offline or navigates away, the session pauses with a clear reason and fix actions.

### Long‑running responses

- Designed to work even if ChatGPT “thinking mode” takes 20+ minutes.
- Capture logic does **not** pause when the tab is hidden.
- Gemini image outputs are **ignored**; if the response is image‑only, a placeholder text is inserted to keep the debate moving.

## 2) Key files and responsibilities

- `manifest.json`
  - MV3 manifest; side panel enabled; no popup.
  - Content scripts injected into `chatgpt.com`, `chat.openai.com`, `gemini.google.com`.

- `background.js`
  - Service worker: session state machine, prompt injection, tab profile store/validation, tab discovery, message routing.
  - Persists active debate sessions.
  - Sends `MLC_PROMPT_SENT` to content scripts after injection.
  - Tracks tab lifecycle (onUpdated/onRemoved/onActivated/window focus) to update profile status.
  - Enforces profile locks during sessions and pauses if tabs drift.
  - Supports open/claim profile flows and focus tab actions.

- `debate_prompts.json`
  - User-editable debate prompt templates (header + turn prompts) used by `buildDebatePrompt(...)`.
  - Loaded by `background.js` via `fetch(chrome.runtime.getURL(...))` with a safe inline fallback.
  - Side panel can override these templates via local storage (see prompt editor below).

- `captureUtils.js`
  - Shared capture heuristics (reference-list detection + candidate scoring) used by `contentScript.js`.
  - Loaded before `contentScript.js` via `manifest.json` content script ordering.

- `contentScript.js`
  - Runs in ChatGPT/Gemini pages.
  - Injects “⇄ OtherLLM” toggle button and forwarding listeners (legacy).
  - Captures LLM responses and posts them back to background.
  - Sends best‑effort model label updates for the active tab.
  - Model label updates are periodic and non-blocking; failures are ignored.

- `sidepanel.html`, `sidepanel.js`, `styles.css`
  - Chat‑like UI: Provider Manager (profiles), session settings, transcript, composer.
  - Renders responses as **plain text** (no `innerHTML`).
  - Implements claim wizard, profile selection gating, and paused-session actions.

- `popup.html`, `popup.js`
  - Present but **not used** by default.

## 3) Debate session state machine (background.js)

### Stored state

Stored in `chrome.storage.local` key: `mlc_active_session_v2`.

Structure (`activeDebateState`):

- `isActive` (bool)
- `isPaused` (bool)
- `pausedReason` (string | null)
- `pausedProvider` (`chatgpt` | `gemini` | null)
- `pausedAt` (epoch ms)
- `sessionId` (string, `session_<ts>_<rand>`)
- `rounds` (int)
- `totalTurns` (int = 2 * rounds)
- `turnIndex` (int, starts at 1)
- `firstLLM` / `secondLLM` (`chatgpt` or `gemini`)
- `profileIds` (`{ chatgpt, gemini }`, profile IDs or null)
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

### Pause + resume

- Sessions pause if a profiled tab is offline, on the wrong host, or fails validation.
- Background emits `UI_SESSION_PAUSED` with provider + reason; side panel shows fix actions.
- Resume uses `RESUME_SESSION` and retries the current turn after validation.
- Pause does not advance turnIndex; the next injection is the same turn that failed.
- Pause can be triggered by tab lifecycle events (close, navigate away) or by pre-turn validation failures.
- Injection failures (e.g., scripting errors) also pause the session and surface the error.

### Session persistence + hydration

- Active session state is stored in `mlc_active_session_v2` and reloaded on service worker restart.
- Side panel calls `GET_ACTIVE_SESSION` on load to rebuild UI state.
- If the stored session is paused, the UI renders paused controls instead of running state.

### Session start resolution (profiles vs legacy tabIds)

- The UI now sends `profileIds` in `START_DEBATE_SESSION`.
- Resolution order:
  1. If `profileIds` are provided, resolve them (explicit selection or "default" mapping).
  2. If no explicit profileIds but defaults exist for both providers, use defaults.
  3. If explicit `tabIds` are provided (legacy), use them.
  4. Otherwise fall back to legacy auto-selection only for non-session features.
- A session will not start unless both providers resolve to valid profiles/tabs.

### Pre-turn validation rules

- Before every injection, the background validates:
  - Tab exists for the provider (tabId is present and chrome.tabs.get succeeds)
  - Host matches the provider domain rules
  - Optional PING response from content script when starting a session or resuming
- If any check fails:
  - Session is paused
  - UI gets an actionable error via `UI_SESSION_PAUSED`
- When validation succeeds via profile, the session's `tabIds` are refreshed from the profile so rebinds take effect mid-session.
- Rebinding a profile during a paused session updates its tabId and lets resume use the new tab.

### Tab profiles store (background.js)

Stored in `chrome.storage.local` key: `mlc_tab_profiles_v1`.

Prompt template overrides:

- Stored in `chrome.storage.local` key: `mlc_debate_prompts_override_v1`.
- If present, overrides `debate_prompts.json` for `buildDebatePrompt(...)`.

Structure:

- `profiles`: array of
  - `profileId` (string)
  - `provider` (`chatgpt` | `gemini`)
  - `tabId` (number | null)
  - `windowId` (number | null)
  - `label` (string)
  - `createdAt`, `updatedAt`, `lastSeenAt` (epoch ms)
  - `status` (`ok` | `offline` | `wrong_host` | `unknown`)
  - `modelHint` (string, best effort)
  - `lastKnownTitle`, `lastKnownUrl` (string)
  - `inUseBySessionId` (string | null)
- `defaults`: `{ chatgpt: profileId|null, gemini: profileId|null }`

Migration:

- On install/update, if `mlc_preferred_tabs` exists and `mlc_tab_profiles_v1` is absent, profiles are created from preferred tab IDs.
- Profiles selected for a debate are marked `inUseBySessionId` until the session ends.

Profile lifecycle + status rules:

- Status values:
  - `ok`: tab exists and host matches provider
  - `offline`: tabId missing or chrome.tabs.get failed (tab closed)
  - `wrong_host`: tab exists but URL host does not match provider
  - `unknown`: tab exists but URL missing or not yet populated
- Status is updated on:
  - `chrome.tabs.onUpdated` (url/title/status changes)
  - `chrome.tabs.onRemoved` (tab closed)
  - `chrome.tabs.onActivated` (tab focus changes)
  - `chrome.windows.onFocusChanged` (window focus changes)
- Validation uses `chrome.tabs.get(tabId)` plus URL host checks:
  - If tab lookup fails => `offline`
  - If URL exists but host does not match provider => `wrong_host`
  - If URL missing => `unknown`
  - Otherwise => `ok`
- `lastSeenAt` is updated whenever a tab is validated or updated.
- `lastKnownTitle` and `lastKnownUrl` are updated on tab updates or when claiming.
- If a profile is deleted while in use, the session is paused.

Claiming / rebinding:

- `CREATE_PROFILE_FROM_ACTIVE_TAB` claims the active tab in the current window.
  - If `profileId` is provided, it rebinds that profile.
  - If `profileId` is omitted, it creates a new profile (and sets default if none).
- `CLAIM_TAB_AS_PROFILE` claims a specific tabId (used by the claim wizard).
- Both actions validate host before saving.
- Default label on claim:
  - If tab title is known, label is `Provider - <title>` (trimmed).
  - Otherwise label is `Provider profile`.
- Model hint updates:
  - `PROVIDER_MODEL_INFO` updates `profile.modelHint` when the tabId matches a profile.
  - Hints are sanitized/capped (single-line, short label); suspiciously long values are ignored/cleared.
  - Stored hint is displayed in profile cards and the claim wizard (best effort).

Open provider tab:

- `OPEN_PROVIDER_TAB` opens:
  - ChatGPT: `https://chatgpt.com/`
  - Gemini: `https://gemini.google.com/`
- Response includes `tabId` and `windowId` for the claim wizard.

Defaults:

- First profile created for a provider becomes default if no default exists.
- Defaults are stored in `mlc_tab_profiles_v1.defaults`.
- Side panel "Default" option resolves to the provider default profileId.

Focus tab:

- `FOCUS_TAB` activates the tab and brings its window to the foreground.

Locks:

- When a session starts, both profiles are locked (`inUseBySessionId`).
- Locks are released when the session ends or is stopped.

When a turn is sent:

1. Background validates the expected provider tab (profile -> tabId, host check; optional ping).
2. Background builds prompt via `buildDebatePrompt(...)`.
3. Background sets `waitingFor`, `lastPromptId`, `lastPromptTimestamp` and persists state.
4. UI receives `UI_SESSION_PROGRESS` for current round/provider.
5. `injectAndExecute` sends the prompt into the right tab using `simpleInteraction`.
6. Background sends `MLC_PROMPT_SENT` to that tab’s content script.
7. Content script captures response and sends `MLC_RESPONSE_CAPTURED`.
8. Background validates response (session id, LLM, promptId/turnIndex), appends to state, and advances to next turn.

Response validation rules:

- If sessionId mismatches or session is inactive, response is ignored.
- If `waitingFor` is set and response sourceLLM does not match, response is ignored.
- If `promptId` or `turnIndex` do not match current turn, response is ignored.
- Empty responses are ignored.

### Prompt templates

Debate prompts are configurable via `debate_prompts.json` (schema v1) and rendered with simple `{placeholder}` substitution.

Turn selection logic (in `background.js`) uses these templates:

- `debate.turn1`: turnIndex 1 (round 1, first LLM)
- `debate.turn2`: turnIndex 2 (round 1, second LLM; includes `{first_answer}`)
- `debate.turn3plus_first`: turns 3+ when the expected LLM is `firstLLM`
- `debate.turn3plus_second`: turns 3+ when the expected LLM is `secondLLM`

Defaults include explicit role reminders (e.g., “You are {expected_llm}… do not simulate {other_llm}”) to prevent a model from replying as both participants.

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
  - `baselineAssistantCount` (ChatGPT only; number of assistant messages pre-turn)
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

- ChatGPT: 20s stable (45s stable when extracted text looks like a sources-only/reference list)
- Gemini: 15s stable

### Generating detection

- ChatGPT: presence of stop button (`button[data-testid="stop-button"]` or aria Stop).
- Gemini: stop icon/button, progress spinners, or disabled send button heuristics.

### Extraction logic

**ChatGPT**:

- Collects multiple candidate content nodes within the latest `[data-message-author-role="assistant"]` (e.g., `data-testid="message-content"`, `.prose`, `.markdown`, and the message root).
- Ranks candidates using `captureUtils.js` heuristics to avoid capturing sources-only/reference blocks when a real answer is present.
- Debugging: set `localStorage.mlc_capture_debug = '1'` in the provider tab console to log candidate scoring and capture decisions.

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

### Model label detection (best effort)

- Content scripts periodically attempt to detect the currently selected model label.
- Detection uses light DOM heuristics (model switcher UI + aria labels).
- Labels are sanitized (single-line, short) to avoid accidentally capturing page/chat text.
- Emitted as `PROVIDER_MODEL_INFO` to background and then side panel.
- Background sanitizes again and stores as `profile.modelHint` if the tabId matches a profile.
- Never blocks claiming or session start; informational only.
- Current polling cadence: initial attempt after ~2.5s, then every ~8s.

## 6) UI and message protocol

### Side panel -> background

- `START_DEBATE_SESSION`:
  - `{ prompt, firstLLM, rounds, profileIds: { chatgpt, gemini } }` (tabIds still accepted for backward compat)
- `STOP_SESSION`:
  - `{ sessionId }`
- `RESUME_SESSION`
- `GET_TAB_PROFILES`
- `CREATE_PROFILE_FROM_ACTIVE_TAB` `{ provider, label?, profileId? }`
- `CLAIM_TAB_AS_PROFILE` `{ provider, tabId, label?, profileId? }`
- `UPDATE_TAB_PROFILE` `{ profileId, patch:{ label, tabId?, windowId? } }`
- `DELETE_TAB_PROFILE` `{ profileId }`
- `SET_DEFAULT_PROFILE` `{ provider, profileId|null }`
- `OPEN_PROVIDER_TAB` `{ provider, windowId?, focus }`
- `FOCUS_TAB` `{ tabId }`
- `GET_ACTIVE_SESSION`
- `GET_DEBATE_PROMPTS`
- `SET_DEBATE_PROMPTS` `{ config }`
- `RESET_DEBATE_PROMPTS`
- `SEND_PROMPT`:
  - `{ prompt, targets:{chatgpt, gemini}, multiAgent:{enabled, maxIterations} }`
- Legacy (still supported by background):
  - `LIST_LLM_TABS`
  - `SET_PREFERRED_TABS` `{ chatgptTabId, geminiTabId }`

Responses (for profile actions):

- Most profile actions return `{ ok: true, profile? }` or `{ ok: false, error }`.
- `OPEN_PROVIDER_TAB` returns `{ ok, provider, tabId, windowId }` on success.
- Common errors:
  - "Tab not found" (tab closed or missing)
  - "Selected tab is not valid for this provider" (wrong host)
  - "Profile not found" (bad profileId)

### Background -> side panel

- `UI_SESSION_STARTED` `{ sessionId, rounds, firstLLM, tabIds, profileIds }`
- `UI_MESSAGE_ADD` `{ role, content, timestamp, turnIndex, roundIndex }`
- `UI_SESSION_PROGRESS` `{ sessionId, waitingFor, roundIndex, totalRounds }`
- `UI_SESSION_PAUSED` `{ sessionId, provider, reason }`
- `UI_SESSION_RESUMED` `{ sessionId }`
- `UI_SESSION_ENDED` `{ sessionId, reason }`
- `UI_SESSION_ERROR` `{ error }`
- `TAB_PROFILES` `{ profiles, defaults }`
- `ACTIVE_SESSION` `{ session }`
- `PROVIDER_MODEL_INFO` `{ provider, tabId, modelLabel }`
- `LLM_RESPONSE` `{ llm, content }` (non‑session replies)
- `LLM_PROGRESS` / `LLM_ERROR`
- `CONNECTION_STATUS` `{ status: { chatgpt, gemini } }`
  - Uses default profile tabId when available; otherwise falls back to legacy tab discovery.

TAB_PROFILES updates:

- Emitted after any profile change (create, update, delete, default change).
- Also emitted during background validation (tab updates/removals).

### Background <-> content scripts

- `MLC_PROMPT_SENT`:
  - `{ sessionId, promptId, llmType, turnIndex, timestamp }`
- `MLC_RESPONSE_CAPTURED` (session)
- `CHATGPT_RESPONSE_CAPTURED`, `GEMINI_RESPONSE_CAPTURED` (non‑session)
- `FORWARD_PROMPT` (legacy in‑page forwarding)
- `PING` / `PONG` for connection checks
- `PROVIDER_MODEL_INFO` (content -> background/UI)

### Side panel behavior details

- Profile dropdown values are `default` or a concrete `profileId`.
- "Default" entry resolves to `defaults[provider]` in storage.
- Start button is disabled unless both resolved profiles exist and have status `ok`.
- Paused sessions show a "Paused" state with actions:
  - Focus tab (uses profile tabId)
  - Rebind to current tab (calls CREATE_PROFILE_FROM_ACTIVE_TAB with profileId)
  - Resume session (RESUME_SESSION)
- Dropdown entries show profile label plus status and in-use hints when applicable.
- Prompt templates can be edited in the side panel and saved to `mlc_debate_prompts_override_v1` (JSON).

## 7) Tab selection logic

- Debate sessions resolve tabs strictly from **Tab Profiles** (defaults or explicit selection). Auto tab selection is not used for debates.
- Profiles are validated by host + tab existence before injection; invalid profiles pause the session.
- Non‑session one‑off prompts still use legacy selection (`listLLMTabs` + preferred tabs + active/last accessed) as a fallback.
- Host validation rules:
  - ChatGPT: `chatgpt.com`, `chat.openai.com`, `openai.com`, `platform.openai.com`
  - Gemini: `gemini.google.com`
- Content script responsiveness can be checked via `PING` (used on start/resume).
- Legacy preferred tabs (`mlc_preferred_tabs`) still exist and are used for non-session prompts and for migration into profiles.

Non-session prompt behavior:

- `SEND_PROMPT` (non-debate) uses `processLLM`:
  - Prefers the default profile tabId if available.
  - Otherwise falls back to legacy preferred tabs and auto-selection.

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
- `[MLC Profiles]` (profile CRUD and tab events)
- `[MLC Capture - chatgpt|gemini]` (capture and arming)
- `[SimpleInteraction INJECTED]` (injected DOM operations)

### Common breakpoints

- DOM selector changes on ChatGPT/Gemini.
- “Send button NOT found” warnings are common; fallback to Enter is intentional.
- Gemini capture can fail if selectors drift; update `extractGeminiResponseText`.

## 10) Adding a new provider (high‑level checklist)

To add a third LLM provider safely:

1. Update `manifest.json` host permissions and `content_scripts` matches.
2. Add provider to profile host validation rules (`getExpectedHosts`, `isExpectedHost`).
3. Extend `listLLMTabs`, `resolveTabForLLM`, and the Provider Manager/profile selection UI.
4. Extend `simpleInteraction` selectors and send button logic for the new provider.
5. Implement capture logic:
   - Add `is<Provider>Generating` and `extract<Provider>ResponseText`.
   - Ensure capture baseline and stability logic works.
6. Update prompt templates and `formatLLMLabel` if needed.
7. Update UI to allow selecting the provider in settings and profile manager.
8. Add model hint detection (optional, best effort).
9. Add new message types if necessary, but prefer extending existing ones.
10. Test long‑running responses and hidden tabs.

## 11) Known fragilities / caveats

- LLM page DOMs change frequently → selectors may break.
- `document.execCommand` is deprecated but still used for contenteditable input; keep an alternative ready if it breaks.
- MV3 service worker can be suspended; state persistence is critical.
- Response capture relies on UI stability signals; adjust thresholds if models change rendering.
- Model label detection is best‑effort only; never assumes a model was auto‑selected.

---

## Maintenance rule (must follow)

Each time a feature is validated or behavior changes, **update `AGENTS.md` to match the new reality** so future work can rely on it without re‑reading the entire codebase.
