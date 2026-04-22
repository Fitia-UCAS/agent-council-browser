# AGENTS.md — Multi‑LLM Coder Extension Memory

This file is the durable memory for the repo. It is the canonical reference for how the extension works **today**. The README is known to be outdated; trust this file and the code.

## 1) What this extension does (current behavior)

- Chrome extension that runs a **side panel chat UI** where each message is sent via a **Route**:
  - **Single**: send to one agent (provider + tab profile).
  - **Compare (Parallel)**: send the same prompt to 2+ agents (no debate scaffolding).
  - **Debate**: multi‑round round‑robin between 2+ agents (often two).
  - Agents can be **multiple profiles of the same provider** (e.g., multiple ChatGPT tabs debating each other).
- Side panel supports **attachments** (files/images) that are delivered via provider web UI automation (no official APIs).
  - ChatGPT: attachments are auto-uploaded when possible (best-effort pre-upload may start while another provider is answering).
  - Claude: attachments are auto-uploaded when possible (uploaded first, then the prompt is sent).
  - Gemini: attachments are **not auto-uploaded**; Gemini receives text-only when files are attached in the side panel (UI warns before sending).
  - Grok: attachments are **best-effort auto-uploaded**; if Grok blocks automation, Grok receives text-only and the UI logs a notice.
- The side panel is the primary UI: clicking the extension icon opens the side panel (no popup).

### Main user flow (runs)

1. User connects providers (creates default tabs) via **Connect** / **Connect all** in the Route Builder provider list.
   - If the current route has no agents, **Connect all** seeds the route with one `Default` agent per supported provider before connecting tabs.
2. In the side panel composer, user selects a **Route** from the `To` pill:
   - Add one or more **agents** from the **Providers** list via **New tab** (opens a new provider tab and binds/assigns it).
   - The **Agents** list is order-only: drag to reorder and `×` to remove.
   - Agent rows also expose per-agent **Reconnect/Focus** actions to repair the exact tab used by that agent.
   - Set **Rounds** only for Debate.
3. User writes a message and clicks **Send**.
4. The extension runs a debate (when Route = Debate):
   - **Turn 1**: agent[0] gets full context + user query.
   - **Turn 2**: agent[1] gets full context + user query + agent[0] answer.
   - **Turns 3..N**: round‑robin across agents:
     - **2 agents**: each new prompt includes only the other agent’s latest answer (the tab thread holds history).
     - **3+ agents**: each new prompt includes **all missing answers since this agent last responded**, so every tab stays in sync.
5. The side panel shows a **single linear transcript**:
   - user query
   - agent[0] answer 1
   - agent[1] answer 1
   - agent[2] answer 1 (if enabled)
   - ...
6. Sending again in the same chat is treated as a **continuation**:
   - Run settings are prefilled from the previous user message’s stored `meta`.
   - The first turns can wrap the new user message with a follow-up template to avoid “resetting” the context.
  - Direct sends (Single) can backfill missing transcript history (tracked per chat via per-provider delivery cursors).
  - Parallel runs currently send the raw user prompt to each agent (no prompt wrapper/history injection) for fair comparison.

### Connections (Tab Profiles) UX

- Tabs are tracked as persistent **Tab Profiles** (one profile = one provider tab).
- Each **agent** in a route must resolve to a valid profile/tab; duplicate same-provider agents require multiple profiles.
- The Route Builder is the primary UI:
  - **Agents** list is order-only (drag + remove).
  - Provider-level tab creation happens in the **Providers** section (`Connect`, `Connect all`, `New tab`).
  - Agent-level repairs happen in the **Agents** section (`Reconnect`/`Focus` on each row).
- The Settings drawer no longer includes provider connection controls; provider connect/focus/new-tab lives in the Route Builder.

### Quick connect (side panel)

- The Route builder shows a per‑provider **Connect** button when a required provider is not ready, plus a **Connect all** button.
- When no agents are selected, **Connect all** acts as a bootstrap action: it adds default agents and opens/reconnects provider tabs.
- Provider rows also expose **New tab**, which opens a fresh provider tab, claims it into a new Tab Profile, and assigns it to an agent (useful for multiple agents on the same provider).
- These send `CONNECT_PROVIDER` to the background, which:
  - opens the provider homepage tab, then
  - claims the tab into a new Tab Profile and sets it as the **default** for that provider (Connect always creates a new default connection).
- **New tab** creates an additional profile and assigns it to the most-recent unassigned agent for that provider (or replaces a broken pinned agent); otherwise it adds a new pinned agent.
- Quick connect satisfies agents that use `Default`. Additional same-provider agents require extra profiles created via **New tab**.
- Per-agent **Reconnect** (in the Agents list) reopens/rebinds the specific broken agent slot instead of adding random duplicate agents.
- Connection “ready” is determined by a successful content-script `PING`/`PONG` **plus** a readiness probe that confirms the tab exposes a usable provider chat surface. Login/landing/auth-wall pages are not ready and surface as login-required instead of connected. If a tab is open but the content script isn’t injected (common after extension reload), the background will attempt to inject `captureUtils.js` + `contentScript.js` and retry once.
- Profile writes are serialized in the background to avoid lost-update races.

### Session gating and safety

- Send is disabled until:
  - Prompt is non-empty
  - Route is valid/supported
  - Required agents are connected (content script responds to `PING`, using per-profile checks when a route targets an explicit profile)
  - Rounds is valid (Debate only)
- The background still validates profiles before every prompt injection.
- If a profile goes offline or navigates away, the session pauses with a clear reason and fix actions.
- Attachments:
  - Attachments are kept **in-memory only** for the active session (not persisted to `chrome.storage.local`).
  - Attachments are delivered once per agent per session.
  - If a provider cannot be auto-attached, the extension sends **text-only** to that provider.
  - If any required provider needs manual upload, a small modal appears; clicking **OK** only acknowledges the notice (it does not start the run). The user uploads manually, then clicks **Send** again.
- Chat history + passphrase protection (optional):
  - History is **always on**; chats are always saved locally on-device.
  - History can be saved **without a passphrase** (plaintext at rest) or protected with a **passphrase** (encrypted at rest).
  - Passphrase protection behavior:
    - when passphrase is set, **new chats are protected by default**.
    - a settings toggle controls whether **new chats** require passphrase; turning it off keeps existing protected chats encrypted.
    - when passphrase is turned off for new chats, protected chats are locked again and remain inaccessible until unlock.
    - chat-level protect/unprotect controls are intentionally hidden in the UI for simpler UX.
  - Unlock keys live in `chrome.storage.session` only (cleared on browser restart or when manually locked).
  - No inactivity auto-lock timer is applied; locking is explicit (`Lock protected chats`) or by browser/session reset.
  - “Forgot passphrase” and “Delete all chats” are grouped under a **Danger zone** in Security settings.
  - The background avoids persisting plaintext transcripts in `chrome.storage.local` (sessions can be hydrated from history after worker restart).

### Long‑running responses

- Designed to work even if ChatGPT “thinking mode” takes 20+ minutes.
- Capture logic does **not** pause when the tab is hidden.
- Gemini image outputs are **ignored**; if the response is image‑only, a placeholder text is inserted to keep the debate moving.

## 2) Key files and responsibilities

- `manifest.json`
  - MV3 manifest; side panel enabled; no popup.
  - Content scripts injected into `chatgpt.com`, `chat.openai.com`, `gemini.google.com`, `claude.ai`.

- `background.js`
  - Service worker: session state machine, prompt injection, tab profile store/validation, tab discovery, message routing.
  - Persists active debate sessions.
  - Sends `MLC_PROMPT_SENT` to content scripts after injection.
  - Tracks tab lifecycle (onUpdated/onRemoved/onActivated/window focus) to update profile status.
  - Enforces profile locks during sessions and pauses if tabs drift.
  - Supports open/claim profile flows and focus tab actions.

- `historyStore.js`
  - IndexedDB chat store + settings (threads/messages).
  - Optional passphrase encryption using WebCrypto (PBKDF2-SHA256 + AES-GCM); unlock key is stored in `chrome.storage.session`.
  - Supports mixed-mode storage: unprotected chats stored plaintext; protected chats stored encrypted.

- `debate_prompts.json`
  - User-editable prompt templates for Debate, Single (legacy), and Direct runs used by `buildDebatePrompt(...)` / `buildSinglePrompt(...)` / `buildDirectPrompt(...)`.
  - Loaded by `background.js` via `fetch(chrome.runtime.getURL(...))` with a safe inline fallback.
  - Side panel can override these templates via local storage (see prompt editor below).

- `captureUtils.js`
  - Shared capture heuristics (reference-list detection + candidate scoring) used by `contentScript.js`.
  - Loaded before `contentScript.js` via `manifest.json` content script ordering.

- `docs/assets/multi_llm_council_redesign.png`
  - Current transparent council logo source used in the README and for extension icon generation.

- `variant-icons/`
  - Generated PNG branding icons for Chrome (`16/32/48/128/512`), currently rasterized from `docs/assets/multi_llm_council_redesign.png`.

- `contentScript.js`
  - Runs in ChatGPT/Gemini/Claude/Grok pages.
  - Captures LLM responses and posts them back to background.
  - Sends best‑effort model label updates for the active tab.
  - Model label updates are periodic and non-blocking; failures are ignored.

- `sidepanel.html`, `sidepanel.js`, `styles.css`
  - Chat‑like UI: Route Builder (agents + providers), settings drawer, transcript, composer.
  - Renders responses as plain text by default; if `contentHtml` is present, renders a **sanitized allowlist** subset (no raw `innerHTML`).
  - Implements route gating (unique tabs per agent), connection checks, and paused-session actions.

## 3) Debate session state machine (background.js)

### Stored state

Stored in `chrome.storage.local` key: `mlc_active_session_v2`.

Structure (`activeDebateState`):

- `isActive` (bool)
- `isPaused` (bool)
- `pausedReason` (string | null)
- `pausedProvider` (`chatgpt` | `gemini` | null)
- `pausedAgentId` (string | null)
- `pausedProfileId` (string | null)
- `pausedAt` (epoch ms)
- `sessionId` (string, `session_<ts>_<rand>`)
- `rounds` (int)
- `participants` (array of `{ agentId, provider, profileId, tabId, label }`)
- `totalTurns` (int = `rounds * participants.length` for Debate)
- `turnIndex` (int, starts at 1)
- `firstLLM` / `secondLLM` (`chatgpt` or `gemini`)
- `profileIds` (`{ chatgpt, gemini }`, profile IDs or null)
- `tabIds` (`{ chatgpt, gemini }`)
- `userQuery` (string)
- `messages` (array of `{ role, agentId?, agentLabel?, content, timestamp, turnIndex, roundIndex }`)
- `waitingFor` (current agent expected to answer; `agentId` string for Debate, `agentId[]` for Parallel)
- `lastPromptId` (string)
- `lastPromptTimestamp` (epoch ms)

### Turn logic (Debate)

- `turnIndex` 1..(`rounds * participants.length`)
- `roundIndex = ceil(turnIndex / participants.length)`
- `expectedAgent = participants[(turnIndex - 1) % participants.length]`

### Pause + resume

- Sessions pause if a profiled tab is offline, on the wrong host, or fails validation.
- Background emits `UI_SESSION_PAUSED` with provider + agentId/profileId + reason; side panel shows fix actions.
- Resume uses `RESUME_SESSION` and retries the current turn after validation.
- Pause does not advance turnIndex; the next injection is the same turn that failed.
- Pause can be triggered by tab lifecycle events (close, navigate away) or by pre-turn validation failures.
- Injection failures (e.g., scripting errors) also pause the session and surface the error.

### Session persistence + hydration

- Active session state is stored in `mlc_active_session_v2` and reloaded on service worker restart.
- Side panel calls `GET_ACTIVE_SESSION` on load to rebuild UI state.
- If the stored session is paused, the UI renders paused controls instead of running state.

### Session start resolution (agents/profiles vs legacy tabIds)

- The UI sends `route.agents[]` in `START_RUN`:
  - each agent picks a `provider` and a `profileId` (`default` or an explicit profile id).
- Resolution order:
  1. Resolve each agent to a profile (explicit profileId or provider default).
  2. Validate each profile’s tab (tab exists + host matches; optional PING on start/resume).
  3. Enforce **unique profileId across agents** (required to support multiple agents of the same provider safely).
  4. If no route agents are provided (legacy), fall back to resolving one tab per provider (no duplicates).

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
  - `provider` (`chatgpt` | `gemini` | `claude` | `grok`)
  - `tabId` (number | null)
  - `windowId` (number | null)
  - `label` (string)
  - `createdAt`, `updatedAt`, `lastSeenAt` (epoch ms)
  - `status` (`ok` | `offline` | `wrong_host` | `unknown`)
  - `modelHint` (string, best effort)
  - `lastKnownTitle`, `lastKnownUrl` (string)
  - `inUseBySessionId` (string | null)
- `defaults`: `{ chatgpt: profileId|null, gemini: profileId|null, claude: profileId|null, grok: profileId|null }`

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
- `CLAIM_TAB_AS_PROFILE` claims a specific tabId (used by Route Builder **New tab** flows).
- Both actions validate host before saving.
- Default label on claim:
  - If tab title is known, label is `Provider - <title>` (trimmed).
  - Otherwise label is `Provider profile`.
- Model hint updates:
  - `PROVIDER_MODEL_INFO` updates `profile.modelHint` when the tabId matches a profile.
  - Hints are sanitized/capped (single-line, short label); suspiciously long values are ignored/cleared.
  - Stored hint is displayed in provider connection status (best effort).

Open provider tab:

- `OPEN_PROVIDER_TAB` opens:
  - ChatGPT: `https://chatgpt.com/`
  - Gemini: `https://gemini.google.com/`
  - Claude: `https://claude.ai/new`
  - Grok: `https://grok.com/`
- Response includes `tabId` and `windowId` for the UI to claim/focus the tab.

Defaults:

- First profile created for a provider becomes default if no default exists.
- Defaults are stored in `mlc_tab_profiles_v1.defaults`.
- Side panel "Default" option resolves to the provider default profileId.

Focus tab:

- `FOCUS_TAB` activates the tab and brings its window to the foreground.

Locks:

- When a session starts, all participant profiles are locked (`inUseBySessionId`).
- Locks are released when the session ends or is stopped.

When a turn is sent:

1. Background validates the expected agent tab (profile -> tabId, host check; optional ping).
2. Background builds prompt via `buildDebatePrompt(...)`.
3. Background sets `waitingFor`, `lastPromptId`, `lastPromptTimestamp` and persists state.
4. UI receives `UI_SESSION_PROGRESS` for current round/agent.
5. `injectAndExecute` sends the prompt into the right tab:
   - Claude: `sendPromptViaClaudeDebugger(...)` (CDP path with fallback send attempts).
   - Others: `simpleInteraction(...)`.
6. Background sends `MLC_PROMPT_SENT` to that tab’s content script.
7. Content script captures response and sends `MLC_RESPONSE_CAPTURED`.
8. Background validates response (session id, agentId, promptId/turnIndex), appends to state, and advances to next turn.

Response validation rules:

- If sessionId mismatches or session is inactive, response is ignored.
- If `waitingFor` is set and response `agentId` does not match, response is ignored.
- If `promptId` or `turnIndex` do not match current turn, response is ignored.
- Empty responses are ignored.

### Prompt templates

Debate prompts are configurable via `debate_prompts.json` (schema v1) and rendered with simple `{placeholder}` substitution.

The side panel exposes a simple 3-field editor that maps to:

- `debate.header` (Initial message): used on turns 1–2 (iteration 1 context for both models)
- `debate.intermediary_message` (Intermediary message): used on non-final improvement turns (by default, turns 2..N-1)
- `debate.final_message` (Final message): used only on the last turn (`turn == total_turns`)

Implementation detail: the default turn templates include `{intermediary_message}` and the background swaps that variable to `final_message` on the final turn.

Turn selection logic (in `background.js`) uses these templates:

- `debate.turn1`: turnIndex 1 (round 1, first LLM)
- `debate.turn2`: turnIndex 2 (round 1, second LLM; includes `{first_answer}`)
- `debate.turn3plus_first`: turns 3+ when the expected LLM is `firstLLM`
- `debate.turn3plus_second`: turns 3+ when the expected LLM is `secondLLM`

Defaults are intentionally lightweight; additional role reminders can be added via templates if needed.

## 4) Prompt injection (background.js)

### Claude send path (`sendPromptViaClaudeDebugger`)

- Claude prompt send uses `chrome.debugger` (CDP) in `sendPromptViaClaudeDebugger(...)` instead of the generic DOM sender.
- Default Claude send-readiness wait is ~12s (longer when attachments exist; currently ~30s when Claude attachments are present).
- After typing, if Claude still reports send disabled, the run does **not** fail immediately. The sender tries multiple fallbacks and only fails if none are acknowledged:
  1. pointer click on resolved send coordinates
  2. Enter key send
  3. pointer click retry after re-resolving composer refs
  4. DOM send fallback (`click`/`requestSubmit`) after re-resolving refs
- Composer/input/send references are re-resolved during waits/retries to handle Claude DOM swaps (`chat-input-ssr` vs hydrated editor).
- Send success is acknowledged by URL navigation (`/new` -> `/chat/...`), generating UI signals (stop/spinner), input clear, or assistant message append heuristics.
- Final Claude send errors include richer diagnostics (`sendVisible`, `ariaDisabled`, `domDisabled`, `disabledAttr`, `pointerEvents`) to speed up troubleshooting.

### `simpleInteraction(prompt, llmType)`

- Injected into the target page via `chrome.scripting.executeScript`.
- Finds input element using LLM‑specific selectors:
  - ChatGPT: `#prompt-textarea`, `textarea[data-testid="prompt-textarea"]`, etc.
  - Gemini: `div.ql-editor[role="textbox"]`, contenteditable fallbacks.
- Claude: primarily used for attachment preparation and generic fallback interactions; debate/session prompt send uses the Claude debugger path above.
- Sets value using the correct method:
  - ChatGPT often uses **textarea**, Gemini uses **contenteditable**; uses native setters or `document.execCommand('insertText')`.
  - **Large prompts** (≈8k+ chars) use a faster contenteditable `textContent` set first, with an execCommand fallback if it doesn't stick.
  - Dispatches `input`, `change`, and key events for framework sync.
- Finds send button using selector lists; if not found, **falls back to Enter key**.
- Send readiness waits are adaptive: longer when attachments or large prompts are present, shorter otherwise.

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
  - ChatGPT guardrail: capture only starts once the selected assistant block is a **new turn** (best assistant index >= baseline assistant count), to avoid accidentally capturing the previous message during ChatGPT Pro UI rerenders / reflection panels.
  - If the ChatGPT “generating” UI is never observed, we delay capture longer for tiny fragments to avoid locking in the first token/heading.

Current force‑capture thresholds:

- ChatGPT: ~45s stable (and ~60s stable when extracted text looks like a sources-only/reference list)
- Gemini: ~15s stable
- Grok: ~22s stable
- Hidden tabs: force-capture + timeout thresholds are increased to avoid premature capture under background throttling.

### Generating detection

- ChatGPT: presence of stop button (`data-testid*="stop"` / aria-label/title Stop/Arrêter/Annuler; best effort). Visibility uses computed style + bounding rect (not `offsetParent`) because fixed/overlay UI can break `offsetParent`.
- Gemini: stop icon/button, progress spinners, or disabled send button heuristics.
- Grok: stop/voice/send control-state transitions (`stop -> voice/send`) plus spinner fallback.

### Extraction logic

**ChatGPT**:

- Collects multiple candidate content nodes within the latest `[data-message-author-role="assistant"]` (e.g., `data-testid="message-content"`, `.prose`, `.markdown`, and the message root).
- Ranks candidates using `captureUtils.js` heuristics to avoid capturing sources-only/reference blocks when a real answer is present.
- If a newer assistant block looks like link/reference content (e.g., “Sources”), it is appended to the main answer to preserve hyperlinks.
- Pro/Reasoning UI: assistant nodes are scoped to the main conversation area (prefers `[role="log"]`), and side panels (e.g. reflection/reasoning) are excluded via `<aside>`/`role=complementary` and attribute keyword checks.
- Debugging: set `localStorage.mlc_capture_debug = '1'` in the provider tab console to log candidate scoring and capture decisions.

**Claude**:

- Aggregates content inside the most recent assistant message root (`data-testid`/assistant/`article` heuristics), then ranks candidates with the same heuristics.
- Prompt-echo filtering only excludes near-identical prompt repeats; prompt-prefixed answers still capture.
- Link/reference-only blocks immediately after the answer are appended to preserve hyperlinks.

**Gemini**:

- Scans a large selector set of candidate containers from `main`/`body`.
- Filters out user messages using selectors and `aria-label` hints.
- Removes media nodes (`img`, `video`, `canvas`, `svg`, `figure`, `picture`).
- If only media is found, returns placeholder text:

```
[Gemini returned an image output; no text was captured. Proceeding with debate.]
```

**Grok**:

- Primary extraction is assistant-scoped: it first resolves the latest assistant row and prefers `.response-content-markdown` nodes inside that row.
- Composer filtering remains active, but explicit `.response-content-markdown` content is not rejected solely for overlapping the composer lane.
- Primary and emit-time Grok capture now apply an incremental trim against the pre-turn baseline transcript, so captures keep only the new answer instead of re-emitting prior user/assistant turns.
- Transcript-tail fallback remains emergency-only and now returns an incremental delta versus baseline (not the full transcript); when bounded it keeps the most recent tail slice.
- Sanitization strips leading prompt/scaffold echoes (including concatenated forms like `Please Grok answer.There is...`) before emit.
- When debate scaffold echoes are embedded at the start of the answer, sanitizer can cut everything up to the last scaffold marker (`Conversation so far` / `Here’s a new message...` / `Please Grok answer`) and drop a repeated latest user line.

### Capture message types

- Session capture: `MLC_RESPONSE_CAPTURED` (includes sessionId, promptId, turnIndex, sourceLLM, content)
- Non‑session capture:
  - `CHATGPT_RESPONSE_CAPTURED`
  - `GEMINI_RESPONSE_CAPTURED`
  - `CLAUDE_RESPONSE_CAPTURED`
  - `GROK_RESPONSE_CAPTURED`

### Model label detection (best effort)

- Content scripts periodically attempt to detect the currently selected model label.
- Detection uses light DOM heuristics (model switcher UI + aria labels).
- Labels are sanitized (single-line, short) to avoid accidentally capturing page/chat text.
- Emitted as `PROVIDER_MODEL_INFO` to background and then side panel.
- Background sanitizes again and stores as `profile.modelHint` if the tabId matches a profile.
- Never blocks claiming or session start; informational only.
- Current polling cadence: initial attempt after ~2.5s, then every ~8s.

## 6) UI and message protocol

The side panel’s primary run control is the **Route Builder** (`To` pill). See `AGENTSMD/AGENTS_ROUTE_BUILDER.md` for the full UX + state model.

### Side panel -> background

- `START_RUN` (primary):
  - `{ prompt, chatId, rounds, route, mode, target, firstLLM?, attachments? }`
  - `route` shape (v2): `{ kind, rounds, agents: [{ id, provider, profileId }] }` (`profileId` can be `'default'`, an explicit profile id, or `null` when unassigned; UI blocks runs until all required agents are assigned)
- History + chats:
  - `HISTORY_STATUS`
  - `HISTORY_SET_ENABLED` `{ enabled }` (legacy; history remains on)
  - `HISTORY_CONFIGURE` `{ passphrase, protectionMode: 'per_chat' }`
  - `HISTORY_UNLOCK` `{ passphrase }`
  - `HISTORY_LOCK`
  - `HISTORY_SET_PROTECTION_MODE` `{ protectionMode: 'per_chat' }` (legacy-compatible; normalized to per-chat)
  - `HISTORY_SET_LOCK_NEW_CHATS` `{ enabled }`
  - `HISTORY_DISABLE_PROTECTION` `{ passphrase }`
  - `HISTORY_RESET_PROTECTION`
  - `HISTORY_CLEAR_ALL`
  - `GET_CHATS_STATE`
  - `CREATE_CHAT`
  - `SET_ACTIVE_CHAT` `{ chatId }`
  - `GET_CHAT` `{ chatId }`
  - `GET_MESSAGES_PAGE` `{ chatId, beforeSequence?, limit? }`
  - `PROTECT_CHAT` `{ chatId }`
  - `UNPROTECT_CHAT` `{ chatId }`
  - `RENAME_CHAT` `{ chatId, title }`
  - `DELETE_CHAT` `{ chatId }`
- `START_DEBATE_SESSION` (legacy; still accepted by background):
  - `{ prompt, firstLLM, rounds, profileIds: { chatgpt, gemini } }` (tabIds still accepted for backward compat)
- `STOP_SESSION`:
  - `{ sessionId }`
- `RESUME_SESSION`
- `CONNECT_PROVIDER` `{ provider }`
- `CHECK_CONNECTION` `{ profileIds?: string[] }`
- `GET_PROVIDER_CAPABILITIES`
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
- `SEND_PROMPT` (legacy; non-session direct send):
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

- `UI_SESSION_STARTED` `{ sessionId, rounds, mode, tabIds, profileIds, participants? }`
- `UI_MESSAGE_ADD` `{ role, agentId?, agentLabel?, content, timestamp, turnIndex, roundIndex }`
- `UI_SESSION_PROGRESS` `{ sessionId, waitingFor, waitingForLabel?, waitingForAgentId?, waitingForAgentIds?, roundIndex, totalRounds }`
  - `waitingFor` may be a string or an array (parallel mode); `waitingForLabel` disambiguates duplicates.
- `UI_SESSION_PAUSED` `{ sessionId, provider, agentId?, profileId?, agentLabel?, reason }`
- `UI_SESSION_RESUMED` `{ sessionId }`
- `UI_SESSION_ENDED` `{ sessionId, reason }`
- `UI_SESSION_ERROR` `{ error }`
- `TAB_PROFILES` `{ profiles, defaults }`
- `HISTORY_STATUS` `{ status }`
- `CHATS_STATE` `{ activeChatId, chats }`
- `ACTIVE_SESSION` `{ session }`
- `PROVIDER_MODEL_INFO` `{ provider, tabId, modelLabel }`
- `LLM_RESPONSE` `{ llm, content }` (non‑session replies)
- `LLM_PROGRESS` / `LLM_ERROR`
- `CONNECTION_STATUS` `{ status: { chatgpt, gemini, ... }, profileStatus?: { [profileId]: boolean } }`
  - Uses default profile tabId when available; otherwise falls back to legacy tab discovery.

TAB_PROFILES updates:

- Emitted after any profile change (create, update, delete, default change).
- Also emitted during background validation (tab updates/removals).

### Background <-> content scripts

- `MLC_PROMPT_SENT`:
  - `{ sessionId, promptId, llmType, agentId?, turnIndex, timestamp, promptPreview? }`
- `MLC_RESPONSE_CAPTURED` (session)
- `CHATGPT_RESPONSE_CAPTURED`, `GEMINI_RESPONSE_CAPTURED` (non‑session)
- `PING` / `PONG` for connection checks
- `PROVIDER_MODEL_INFO` (content -> background/UI)

### Side panel behavior details

- Routes are selected via the `To` pill (Route Builder) and persisted as `mlc_last_route_v2` (migrated from `mlc_last_route_v1`).
- Routes target **agents** (provider + profile selection). Each agent can use `Default` or a specific profile; duplicates require distinct profiles.
- Send is disabled unless the route is valid/supported and the route’s required providers are ready (PING/PONG).
- Paused sessions show a "Paused" state with actions:
  - Focus tab (uses profile tabId)
  - Rebind to current tab (calls CREATE_PROFILE_FROM_ACTIVE_TAB with profileId)
  - Resume session (RESUME_SESSION)
- Prompt templates can be edited in the side panel (3-field editor) and saved to `mlc_debate_prompts_override_v1`.
- The composer prompt input has no extension-enforced character limit (provider UIs may still impose their own).

## 7) Tab selection logic

- Debate sessions resolve tabs strictly from **Tab Profiles** (defaults or explicit selection). Auto tab selection is not used for debates.
- Profiles are validated by host + tab existence before injection; invalid profiles pause the session.
- Non‑session one‑off prompts still use legacy selection (`listLLMTabs` + preferred tabs + active/last accessed) as a fallback.
- Host validation rules:
  - ChatGPT: `chatgpt.com`, `chat.openai.com`, `openai.com`, `platform.openai.com`
  - Gemini: `gemini.google.com`
  - Claude: `claude.ai`
- Content script responsiveness can be checked via `PING` (used on start/resume).
- Legacy preferred tabs (`mlc_preferred_tabs`) still exist and are used for non-session prompts and for migration into profiles.

Non-session prompt behavior:

- `SEND_PROMPT` (non-debate) uses `processLLM`:
  - Prefers the default profile tabId if available.
  - Otherwise falls back to legacy preferred tabs and auto-selection.

## 8) Legacy in-page forwarding status

- The old in-page forwarding flow (toggle buttons on ChatGPT/Gemini + `FORWARD_PROMPT`) has been removed.
- Prompt routing now happens through side panel routes (Single / Compare / Debate) or legacy non-session `SEND_PROMPT`.

## 9) Debugging and troubleshooting

### Where to inspect logs

- **Background**: Chrome extensions page → “Service Worker” console.
- **Content scripts**: open DevTools on ChatGPT/Gemini/Claude tabs (note: DevTools on the Claude tab can block `chrome.debugger` sends).
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

To add another provider safely:

1. Update `manifest.json` host permissions and `content_scripts` matches.
2. Add provider to profile host validation rules (`getExpectedHosts`, `isExpectedHost`).
3. Extend `listLLMTabs`, `resolveTabForLLM`, and the Route Builder + connection status UI.
4. Extend `simpleInteraction` selectors and send button logic for the new provider.
5. Implement capture logic:
   - Add `is<Provider>Generating` and `extract<Provider>ResponseText`.
   - Ensure capture baseline and stability logic works.
6. Update prompt templates and `formatLLMLabel` if needed.
7. Update UI to allow selecting/connecting the provider in the Route Builder and Settings.
8. Add model hint detection (optional, best effort).
9. Add new message types if necessary, but prefer extending existing ones.
10. Test long‑running responses and hidden tabs.

## 11) Known fragilities / caveats

- LLM page DOMs change frequently → selectors may break.
- `document.execCommand` is deprecated but still used for contenteditable input; keep an alternative ready if it breaks.
- MV3 service worker can be suspended; state persistence is critical.
- Response capture relies on UI stability signals; adjust thresholds if models change rendering.
- Model label detection is best‑effort only; never assumes a model was auto‑selected.

## 12) Worktree extension variants (name/logo differentiation)

When multiple branches/worktrees are loaded in Chrome at once, build and load a per-branch variant so each extension is visually distinct.

- Script: `scripts/dev/build-extension-variant.sh`
  - Copies the current workspace into `.dist/<branch-label>/`.
  - Supports `--in-place` to rewrite the current workspace manifest/icons directly (useful when Chrome already points to that folder).
  - Rewrites `.dist/<branch-label>/manifest.json` with:
    - `name: "Multi Agent Council [<branch-label>]"`
    - `action.default_title: "... [<branch-label>]"`
    - `version_name: "dev-<branch-label>"`
    - `icons` and `action.default_icon` set to generated branch-specific PNG icons (`variant-icons/variant-16.png`, `variant-icons/variant-32.png`, `variant-icons/variant-48.png`, `variant-icons/variant-128.png`)
  - Excludes `.git`, `.dist`, `node_modules`, and `worktrees` from the build output.
- NPM shortcut (main + worktrees): `npm run build:variant`
- In-place branding for current workspace: `npm run brand:in-place`
- Main-only batch helper: `npm run build:variant:all-local-worktrees`
  - Builds `.dist` variants for all currently attached git worktrees.
- Main/worktree helper for already-loaded extensions: `npm run brand:all-worktrees`
  - Applies branch branding in place across all currently attached git worktrees.
- Chrome usage:
  - Open `chrome://extensions`
  - If loading from `.dist`: use **Load unpacked** on each generated `.dist/<branch-label>` folder
  - If loading from raw worktree folders: run `npm run brand:all-worktrees` first, then **Reload** each extension
  - Click **Reload** if the extension is already loaded so new name/icon metadata is applied.
  - Keep `"key"` unset in `manifest.json` so local unpacked variants can coexist.

---

## Maintenance rule (must follow)

Each time a feature is validated or behavior changes, **update `AGENTS.md` to match the new reality** so future work can rely on it without re‑reading the entire codebase.
