# AGENTS_CLAUDE.md — Claude (claude.ai) Integration (UI Automation)

This document explains, end-to-end, how **Claude** was integrated into the Multi‑LLM Coder extension, including:

- what was failing originally (symptoms),
- the *actual* root causes we identified,
- why the usual DOM‑injection approach wasn’t reliable on Claude,
- the final architecture (CDP via `chrome.debugger` for send, content script for capture),
- attachments support,
- the key files/functions/selectors,
- and a concrete debugging playbook.

The goal is that a future maintainer can re‑derive the reasoning quickly when Claude (or another provider with similar constraints) changes its UI.

---

## 0) Executive summary (what we ship now)

Claude is integrated as a first‑class provider (`claude`) alongside `chatgpt`, `gemini`, and `grok`.

### What works reliably

- **Sending prompts** to `claude.ai` works via **Chrome DevTools Protocol (CDP)** using `chrome.debugger` (not DOM-only clicking).
- **Capturing Claude answers** works via the existing content‑script capture pipeline, with Claude‑specific extraction heuristics.
- **Claude attachments** can be **auto‑uploaded**:
  - attachments are prepared in the Claude page (DOM automation),
  - then the prompt is sent (CDP automation).
- **Parallel** works for any agent set.
- **Debate** supports **2+ agents** (including multiple agents of the same provider).

### Why CDP is necessary

Claude often ignores synthetic DOM input/click events and keeps the Send button disabled unless input is produced in a way its internal editor state recognizes. CDP input simulation is significantly closer to “real typing” than setting `textarea.value`.

---

## 1) The failure modes we saw (symptoms)

These failures were observed repeatedly during integration:

### 1.1 “Send button not found / timed out”

Example error:

- `Timed out waiting for Send to become ready (send button not found)`

This often happened even though a send button existed in the DOM, because:

- it was **present but disabled** (`disabled=""`),
- and/or CSS prevented interaction (`pointer-events: none`),
- and our “ready” logic was intentionally filtering out disabled buttons.

### 1.2 Prompt sometimes appears but doesn’t send

We could programmatically set text (especially in the SSR textarea), but Claude:

- did not enable the send button,
- did not treat it as “user typed text”,
- so Enter/click didn’t dispatch a message.

### 1.3 Prompt sometimes doesn’t even appear

Some sessions showed:

- “typed” text not being committed into the active composer,
- or the active element being `document.body` (focus missing),
- which suggested the page/editor was not in a “hydrated/interactive” state yet.

### 1.4 Confusing “errors” in the Claude console (CSP violations)

Logs like:

- `Refused to connect because it violates the document's Content Security Policy`

…were coming from Claude’s own analytics/metrics scripts. They are **not** the cause of the extension’s send/capture failures.

---

## 2) Root causes (what was actually wrong)

### 2.1 Claude has *two* “inputs” (SSR vs hydrated editor)

Claude commonly renders:

- an SSR textarea: `textarea[data-testid="chat-input-ssr"]`
- and a real interactive editor: `div[data-testid="chat-input"][role="textbox"][contenteditable="true"]`

The SSR textarea may be present/visible, but it’s often **not the canonical state** the app uses to enable Send. Setting its value + dispatching `input` events can be ignored by the real editor state machine.

### 2.2 Disabled send is not just a DOM attribute

The button can be:

- `disabled=""`,
- plus `pointer-events: none`,
- and its enabled/disabled state depends on Claude’s internal editor state and upload state.

So even when we found the correct DOM node, “click” did nothing if the internal app logic didn’t consider the composer “dirty”.

### 2.3 `/new` behaves differently than `/chat/<id>`

Claude frequently navigates:

- from `https://claude.ai/new`
- to `https://claude.ai/chat/<uuid>`

The `/new` page can be in a transient state where:

- focus is not on the editor,
- the hydrated editor isn’t ready,
- or a “shell” composer exists without the same stable message list.

### 2.4 Multi-tab selection amplified flakiness

When many Claude tabs were open, the extension could pick a `/new` tab or a half-hydrated tab, making failures appear “random”.

---

## 3) Why DOM-only automation was unreliable on Claude

The extension’s original model (used by ChatGPT/Gemini) is:

1. locate an input element
2. set `.value` or insert contentEditable text
3. dispatch `input/change` events
4. find a send button and click it (or press Enter)

This breaks for Claude because:

- Claude’s editor logic often ignores synthetic events and requires true editor integration.
- The send button enablement is gated on internal state not reliably toggled by a scripted `.value = ...`.
- Some sessions appear to require “real user focus” (a genuine click into the editor) before programmatic input is accepted.

We confirmed this by observing:

- send button exists but stays disabled even when the textarea contains text,
- retries sometimes succeeded only after manually focusing the composer once.

Conclusion: to be reliable, we needed a send mechanism that looks like *real typing and clicking* to the app.

---

## 4) Final architecture (how Claude is integrated now)

### 4.1 Manifest

File: `manifest.json`

- Add `https://claude.ai/*` to `host_permissions` and `content_scripts.matches` (so capture + PING/PONG work).
- Add `"debugger"` permission (required for CDP).

### 4.2 Provider capabilities (attachments)

File: `background.js`

- `PROVIDER_CAPABILITIES.claude.attachments.mode = 'auto'`

Claude exposes a real `input[type="file"]` in the composer, so “DataTransfer → input.files” works in many sessions.

### 4.3 Sending prompts: CDP via `chrome.debugger`

File: `background.js`

Entry point:

- `injectAndExecute(tabId, 'claude', prompt, context)`

Claude branch flow:

1. (optional) if attachments exist:
   - call `injectAndPrepareAttachments(tabId, 'claude', attachments)`
2. call `sendPromptViaClaudeDebugger(tabId, prompt, { readyTimeoutMs })`
3. after send succeeds:
   - notify content script with `MLC_PROMPT_SENT`
   - use `sendTabMessageWithRetry` because Claude may navigate on send

Why this split matters:

- Attachments are easiest to set using DOM APIs (build `File` objects from base64 and set `input.files`).
- Sending is most reliable via CDP (insertText + real mouse events).

### 4.4 How `sendPromptViaClaudeDebugger()` works (step-by-step)

File: `background.js`

Key steps:

1. **Attach debugger**: `chrome.debugger.attach({tabId}, '1.3')`
2. **Make tab active**: focus window and activate tab to reduce frame/focus weirdness
3. **Find composer + send button** using `Runtime.evaluate`:
   - prefer the hydrated editor:
     - `div[data-testid="chat-input"][role="textbox"]`
   - fall back to:
     - `[contenteditable="true"][role="textbox"]`, `.ProseMirror`, generic `[contenteditable]`
     - `textarea[data-testid="chat-input-ssr"]`
   - find send by localized aria-label:
     - `button[aria-label*="message" i]`, `button[aria-label*="envoyer" i]`, `button[aria-label*="send" i]`
   - compute click coordinates (center of rect)
   - store references on `window.__mlcClaudeInputEl`, `window.__mlcClaudeSendBtn`, `window.__mlcClaudeComposerRoot`
4. **Force focus**: dispatch mouse click at the input coordinates
5. **Clear existing text**:
   - Cmd+A + Backspace (mac)
   - Ctrl+A + Backspace (fallback)
6. **Type prompt**:
   - `Input.insertText`
   - then a “nudge” (`Input.dispatchKeyEvent` with a space + backspace) to trigger editor watchers
7. **Verify input received text**:
   - `Runtime.evaluate` reads the editor’s text (contentEditable textContent / textarea.value)
8. **Wait for send enabled**:
   - Poll until the send button is visible and not disabled and not `pointer-events:none`
   - Timeout configurable (`readyTimeoutMs`, longer when attachments exist)
9. **Click send**:
   - `Input.dispatchMouseEvent` at send coordinates
10. **Confirm send acknowledgement**:
    - Claude may navigate `/new → /chat/<id>`; detect URL change
    - or detect “generating” state:
      - presence of stop/cancel button (includes FR labels: `Annuler`, `Arrêter`)
      - visible spinner/progress indicators
    - or detect input cleared
    - if not acknowledged quickly, press Enter once and retry ack checks
11. **Detach debugger** (`chrome.debugger.detach`) in `finally`

Important constraint:

- Only one debugger can attach to a tab. If DevTools is open on the Claude tab, `chrome.debugger.attach` fails.

### 4.5 Tab selection reliability: prefer `/chat/` tabs

File: `background.js`

- `resolveTabForLLM('claude', ...)` prefers tabs with URLs matching `https://claude.ai/chat/...`.

This avoids sending into “transient” `/new` tabs whenever a stable chat tab exists.

### 4.6 Capture: content script extraction

File: `contentScript.js`

Claude uses the same capture lifecycle as other providers:

- background sends `MLC_PROMPT_SENT`
- content script “arms” capture:
  - stores baseline text, timestamps
  - polls until generating finishes and text stabilizes
  - emits `MLC_RESPONSE_CAPTURED` (session) or `CLAUDE_RESPONSE_CAPTURED` (non-session)

Claude-specific improvements:

- broader and safer message selectors (preferring bottom-most assistant message nodes)
- excludes the composer subtree from candidate extraction
- uses `CaptureUtils.chooseBestTextCandidate()` to avoid returning sources-only fragments when multiple candidates exist
- aggregates content nodes within the latest assistant message root to avoid truncation
- appends link/reference-only blocks that appear immediately after the answer

### 4.7 Capture arming across navigation

File: `background.js`

Claude can navigate immediately after send; if we send `MLC_PROMPT_SENT` during navigation, the content script may not receive it.

Fix:

- background uses `sendTabMessageWithRetry(tabId, payload, { retries, delayMs })`
- and adds a small delay when the debugger ack reason indicates navigation

---

## 5) Attachments on Claude (auto-upload)

Claude supports auto attachment through the existing attachment subsystem:

### 5.1 UI layer

File: `sidepanel.js`

- Attachments are read as base64 (in-memory) and included in `START_RUN` only for providers whose mode is `auto`.

### 5.2 Background session attachment state

File: `background.js`

- attachments are stored in-memory per session (`sessionAttachmentsById`)
- optional prefetch occurs for `auto` providers

### 5.3 Claude-specific send ordering (important)

We explicitly upload first, then send prompt:

1. `injectAndPrepareAttachments(...)` (DOM automation inside Claude page)
2. `sendPromptViaClaudeDebugger(...)` (CDP send)

This is required because:

- the send button may remain disabled until upload completes,
- and CDP send readiness waiting needs a longer timeout when files exist.

---

## 6) Debate / parallel UX changes related to Claude

Claude is treated as another **agent provider** in route selection:

- `single`: any 1 agent
- `parallel`: 2+ agents (e.g., ChatGPT A + ChatGPT B + Claude)
- `debate`: 2+ agents, round-robin turns across the ordered agent list

Debate scheduling:

- expected agent = `participants[(turnIndex - 1) % participants.length]`
- round index = `ceil(turnIndex / participants.length)`
- total turns = `rounds * participants.length`

This removed the earlier limitation where adding a third provider forced “parallel only”.

---

## 7) What we removed as irrelevant (audit outcome)

We initially added extra “DOM-only Claude send” fallbacks inside `simpleInteraction()` (e.g., force-enable the disabled send button).

After moving Claude sending to the CDP path (`chrome.debugger`), those DOM-only send fallbacks were no longer used by the pipeline, so they were removed to keep the injected script smaller and reduce maintenance surface.

What remains in `simpleInteraction()` for Claude:

- input discovery sufficient for **attachments preparation** mode (`prepare_attachments`)
- generic send logic for other providers

---

## 8) Debugging playbook (when Claude breaks again)

### 8.1 Where to look

- Background logs: Extension → Service Worker console
  - `[MLC Background] ...`
  - `Claude debugger send ...`
- Claude tab logs: DevTools console (but remember: DevTools open can block `chrome.debugger`)
- Side panel logs: Inspect side panel

### 8.2 Common failure reasons and what they mean

- **“another debugger is already attached”**
  - DevTools is open on the Claude tab (or another extension attached).
  - Fix: close DevTools for that tab, retry.

- **“Claude focus failed: input_not_found”**
  - You’re on a login/landing/unsupported page or the composer is not visible.
  - Fix: open a real chat where the message box is present (`/chat/...`), retry.

- **“Claude input stayed empty after typing”**
  - CDP typed, but the editor didn’t accept the input (focus/overlay/iframe).
  - Fix: click inside the composer once manually, ensure no modal is open, retry.

- **“send button stayed disabled after typing”**
  - Claude still thinks composer is empty or upload not finished.
  - Fix: wait for uploads; verify you can send manually; increase ready timeout if needed.

### 8.3 Quick DOM checks (Claude console)

If you *temporarily* open DevTools (knowing it can block CDP), you can inspect:

- hydrated editor exists?
  - `document.querySelector('div[data-testid="chat-input"][role="textbox"]')`
- SSR textarea exists?
  - `document.querySelector('textarea[data-testid="chat-input-ssr"]')`
- send button state?
  - `(() => { const b = document.querySelector('button[aria-label*=\"message\" i],button[aria-label*=\"envoyer\" i],button[aria-label*=\"send\" i]'); return b && { label:b.getAttribute('aria-label'), disabled:b.disabled, pointerEvents:getComputedStyle(b).pointerEvents }; })()`

### 8.4 Capture debugging

Enable capture debug logging in the provider tab:

- `localStorage.setItem('mlc_capture_debug', '1')`

Then send a prompt and watch `[MLC Capture Debug]` output for:

- baseline text,
- generating state,
- stabilization,
- extracted candidates.

---

## 9) Scalability lessons (for the next provider)

Claude taught us a reusable provider pattern:

- “DOM injection” works for some providers (ChatGPT) but not all.
- Some providers require a **lower-level automation channel**:
  - CDP input/click (like Claude),
  - or other platform-specific approaches.

Recommended architecture for future providers:

1. Keep capture as a content-script concern (provider-specific extraction + stability).
2. Abstract sending as `sendPrompt(provider)` with per-provider implementations:
   - DOM send (`simpleInteraction`)
   - CDP send (`chrome.debugger`)
3. Keep attachments as a separate stage (`prepare_attachments`) so send can be swapped without rewriting upload logic.

---

## 10) Key code locations (quick index)

- `manifest.json`
  - `"debugger"` permission
  - Claude host permissions + content script matches
- `background.js`
  - `PROVIDER_CAPABILITIES.claude`
  - `resolveTabForLLM()` (prefers `/chat/`)
  - `injectAndExecute()` Claude branch
  - `sendPromptViaClaudeDebugger()` (CDP send)
  - `sendTabMessageWithRetry()` (arming capture across navigation)
  - `injectAndPrepareAttachments()` + `simpleInteraction(..., {mode:'prepare_attachments'})`
- `contentScript.js`
  - Claude capture arming (`MLC_PROMPT_SENT`)
  - Claude extraction + generating detection
- `captureUtils.js`
  - `chooseBestTextCandidate()` (avoid returning sources-only lists)
