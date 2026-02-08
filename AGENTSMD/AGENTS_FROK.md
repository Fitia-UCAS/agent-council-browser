# AGENTS_FROK.md — Grok (grok.com) Integration (UI Automation)

This document explains, end-to-end, how **Grok** was integrated into the Multi‑LLM Coder extension, mirroring the level of detail in `AGENTSMD/AGENTS_CLAUDE.md`.

It covers:

- where Grok support lives in the codebase,
- how we connect Grok tabs (profiles + readiness),
- how we send prompts (DOM injection),
- how we capture answers (content script + stabilization heuristics),
- how attachments work (best‑effort auto upload + safe fallback),
- known failure modes and a debugging playbook,
- and what to change when Grok’s DOM inevitably drifts.

> Naming note: the file name says “Frok” because of a historical typo, but it documents the **Grok** provider (`providerId = "grok"`).

---

## 0) Executive summary (what ships now)

Grok is integrated as a first‑class provider (`grok`) alongside `chatgpt`, `gemini`, and `claude`.

### What works

- **Sending prompts** to Grok works via the existing DOM-injection sender (`simpleInteraction(...)`).
- **Capturing Grok answers** works via the content-script capture pipeline (`contentScript.js`) with Grok-specific extraction heuristics.
- Grok send acknowledgment uses a **guarded best-effort policy** tuned for the new UI states:
  - send/draft: `Soumettre` (submit),
  - generating: `Arrêter la réponse du modèle`,
  - done/idle: `Passer en mode vocal`.
- Grok capture strips UI footer artifacts (latency labels like `773ms` and satisfaction prompts) so transcript entries only include answer text.
- **Attachments** are **best-effort auto-uploaded** to Grok using the same attachment automation system as ChatGPT/Claude:
  - If attachment automation fails on Grok, the run continues **text-only** and a notice is appended in the transcript.
- Grok works in:
  - **Single** routes,
  - **Compare / Parallel** (concurrent) runs,
  - **Debate** (round-robin across 2+ agents).

### Key design choices

- **No provider APIs**: everything is done through Grok’s web UI (same as other providers).
- **Fail-open** for attachments: never block the run just because upload automation fails.
- **Scalable provider plumbing**: Grok’s connect URLs, host validation, and tab discovery are centralized in `PROVIDER_METADATA` in `background.js` so the next provider is easier.

### 0.1 Incident report (Feb 2026): send OK, capture missing/dirty

We hit a production issue where Grok prompts were sent successfully, but answers were not reliably visible in the side panel transcript.

Observed symptoms:

- Send acknowledged in injected logs (submit clicked and ack signals observed).
- Capture logs showed repeated `composer_overlap` rejections for Grok candidates.
- Content script logged `Response captured for prompt ...` but side panel still showed no new assistant message.
- Some captured answers included Grok UI footer artifacts (for example `773ms` and `Are you satisfied with Grok's answer?`).

Root causes:

1. Runtime bundle mismatch during debugging:
   - Chrome was loading an older built bundle while source files were already patched.
2. Capture emission mismatch:
   - Capture decision used one extraction object, but emission re-ran extraction and could produce empty payloads.
3. Over-aggressive composer filtering:
   - Candidate roots that merely contained composer subtree were rejected too broadly.
4. Grok UI footer leakage:
   - Footer controls/latency lines were appended near answer text and leaked into captured output.

What we changed to fix it:

- Synced the actual loaded extension bundle(s) with patched source.
- Emission now sends the already-resolved extraction (`emitCaptureFromResolvedExtraction(...)`) instead of re-extracting at emit time.
- Grok candidate filtering now:
  - rejects nodes inside composer,
  - uses composer-zone geometry filtering,
  - does not blanket-reject wrappers only because they contain composer.
- Transcript-tail fallback was hardened (scaffold/control filtering and quality gates).
- Grok footer artifacts are stripped from captured text:
  - latency tails (`NNNms`, `Ns`),
  - satisfaction prompts (`Are you satisfied ...` and FR variants).
- Grok now emits plain text only for capture payloads to avoid rich-footer widget leakage.
- Background now logs explicit empty-capture drops (`empty_content_after_capture`) instead of silently returning.

Result:

- Grok send remains stable on modern/french UI.
- Captured answers reliably appear in side panel.
- Footer artifacts no longer appear in transcript content.

---

## 1) Where Grok is wired in

### Manifest integration

File: `manifest.json`

- Host permissions include:
  - `https://grok.com/*`
  - `https://*.grok.com/*`
- Content script injection includes Grok:
  - `matches: ["https://grok.com/*", "https://*.grok.com/*"]`
  - `js: ["captureUtils.js", "contentScript.js"]`

Why:

- Host permissions are required so the background can inject scripts (`chrome.scripting.executeScript`) into Grok pages.
- Content scripts are required for:
  - connection readiness (PING/PONG),
  - response capture (answer extraction + stabilization),
  - best-effort model label reporting.

---

## 2) Provider registry: metadata + capabilities (scalability)

File: `background.js`

### 2.1 `PROVIDER_METADATA`

Grok’s metadata is defined in:

- `const PROVIDER_METADATA = { ... grok: { ... } }`

Fields used by the system:

- `label`: shown in UI (`formatLLMLabel`)
- `openUrl`: what “Connect” / “New tab” opens
- `expectedHosts`: used to validate profiles and to mark “Wrong host”
- `urlPatterns`: used to find tabs (`listLLMTabs`)

This metadata is used by:

- `openProviderTab(...)` → opens `PROVIDER_METADATA[provider].openUrl`
- `getExpectedHosts(...)` → validates that a tab URL host is expected for the provider
- `listLLMTabs(...)` → queries tabs using `PROVIDER_METADATA[provider].urlPatterns`
- `formatLLMLabel(...)` → UI labels and logs

### 2.2 `PROVIDER_CAPABILITIES`

Grok’s attachment capability is defined in:

- `const PROVIDER_CAPABILITIES = { ... grok: { attachments: { mode: 'auto' } } }`

Meaning:

- Side panel will treat Grok as an **auto** provider for attachments (no manual warning modal).
- Background will attempt to upload attachments to Grok using UI automation.
- If the upload automation fails, the background immediately retries the prompt without attachments and logs a transcript notice.

This mode exists because different providers can (and do) block file automation.

---

## 3) Connecting Grok (profiles + readiness)

Connection is the same mechanism used for ChatGPT/Gemini/Claude:

### 3.1 The “Connect” flow

Side panel (`sidepanel.js`):

- User clicks **Connect** for Grok.
- UI sends:
  - `{ type: 'CONNECT_PROVIDER', provider: 'grok' }`

Background (`background.js`):

1. `openProviderTab('grok')` opens `https://grok.com/`.
2. `claimTabAsProfile(...)` stores the tab as a **Tab Profile** and sets it as default for provider `grok`.
3. UI refreshes profiles and pings the content script.

### 3.2 What “Ready” means (important)

We intentionally define “connected/ready” as:

- a default profile tab exists, **and**
- the content script responds to `PING` with `PONG`.

This prevents false “connected” states when:

- user is on a login/redirect page,
- the page is on an unsupported host,
- or the content script is not injected (no matches).

Troubleshooting:

- If Grok shows “Not connected” after Connect:
  - ensure the Grok tab is actually on `grok.com` and fully loaded,
  - then use **Refresh connections** (Settings → Connections).

---

## 4) Sending prompts to Grok (DOM injection)

### 4.1 Entry points

Most sends go through the unified session runner:

- Parallel: `sendParallelTurn(...)` → `injectAndExecute(tabId, provider, promptText, context)`
- Debate: `sendDebateTurn(...)` → `injectAndExecute(tabId, expectedLLM, promptText, context)`

### 4.2 How Grok send works

File: `background.js`

Function: `injectAndExecute(tabId, llmType, prompt, context)`

For Grok, `injectAndExecute` uses DOM injection:

- `chrome.scripting.executeScript({ func: simpleInteraction, args: [prompt, 'grok', attachments] })`

The injected function `simpleInteraction(...)` does:

1. **Find a composer input element**
   - Uses `inputSelectors.grok` (textarea + contentEditable fallbacks).
   - Chooses the **best visible** candidate (bottom-most) via `pickBestVisibleElement(...)`.
2. **(Optional) Attach files**
   - If attachments are provided, calls `attachFilesToComposer(...)`.
3. **Set prompt text**
   - For textarea: uses a native setter + input/change events.
   - For contentEditable: uses `document.execCommand('insertText')` + input event.
4. **Send**
   - Uses `providerUiConfig.grok.sendSelectors` to locate the send button.
   - Clicks send, or falls back to Enter.
5. **Acknowledge**
   - Grok uses signal-based acknowledgment:
     - Strong signals: stop control visible, or voice control after stop.
     - Secondary signals: draft shrinks/clears and submit visibility/enabled transitions.
   - Ack rule: `strong >= 1` OR `secondary >= 2` within timeout.

### 4.3 Why “pickBestVisibleElement” matters

Some providers render multiple candidate inputs (hidden editors, shadow or offscreen clones, etc.).
Selecting the wrong input is the #1 cause of “typed text doesn’t send”.

We mitigate this by:

- filtering to visible elements,
- preferring the bottom-most (closest to the real composer).

### 4.4 When a Grok send fails

Symptoms:

- “Send button not found”
- “Failed to send message: no acknowledgement”
- Prompt appears but nothing is sent

Fix path:

- Open Grok DevTools and inspect composer; update selectors in:
  - `background.js` → `simpleInteraction` → `inputSelectors.grok` and `providerUiConfig.grok`

---

## 5) Capturing Grok answers (content script pipeline)

File: `contentScript.js`

### 5.1 Provider detection

On page load, content script sets:

- `isGrok = location.hostname.includes('grok.com')`
- `currentLLM = 'grok'`

### 5.2 Capture lifecycle

1. Background notifies:
   - `{ type: 'MLC_PROMPT_SENT', llmType: 'grok', promptId, sessionId, turnIndex, promptPreview }`
2. Content script `armCapture(...)` stores:
   - `baselineText` (what was already on the page before send),
   - timestamps and prompt metadata.
3. A MutationObserver + periodic polling calls `evaluateCapture()`:
   - extracts the latest answer candidate,
   - waits for stability (text not changing),
   - uses “generating” heuristics to decide when it’s safe to emit.
4. When stable, content script sends:
   - For sessions: `MLC_RESPONSE_CAPTURED`
   - For non-session one-offs: `GROK_RESPONSE_CAPTURED`

### 5.3 “Generating” detection (Grok)

Function: `isGrokGenerating()`

Best-effort heuristics:

- visible Stop/Cancel button
- visible spinners/progress bars
- explicit voice-mode detection as “not generating” for modern Grok UI

This is deliberately heuristic because Grok can change UI.

### 5.4 Answer extraction (Grok)

Function: `extractGrokResponse({ withHtml, withMeta })`

Strategy:

- search near `main` (fallback `body`) for candidate nodes using broad selectors:
  - assistant/message/testid-like hooks, markdown/prose, `article`, etc.
- exclude:
  - the composer subtree (to avoid capturing the input itself),
  - nodes that appear to be user messages (`isGrokUserMessage(...)`),
  - nodes that are just prompt echoes (`looksLikePromptEcho(...)`).
- composer overlap filtering is geometry-aware:
  - reject nodes inside composer,
  - reject candidate content that overlaps the composer zone,
  - do not blanket-reject wrappers that merely contain composer subtree.
- pick the best candidate using `CaptureUtils.chooseBestTextCandidate(..., { provider: 'grok' })`.
- ship both:
  - `text` (canonical, used for debate logic),
  - `html` (optional, UI-only rendering), except Grok now emits plain text only to avoid footer widget leakage.

### 5.5 Emission + fallback hardening (important)

- Capture decisions and emission now use the **same resolved extraction object** (no second fresh re-extract at emit time).
- Grok transcript-tail fallback is gated to avoid false positives:
  - strips scaffold lines,
  - strips control/footer text,
  - rejects low-quality short fragments.
- Background now logs explicit empty-content drops (`empty_content_after_capture`) instead of silently returning.

---

## 6) Attachments on Grok (auto, but best-effort)

### 6.1 What we do now

- Grok is configured as `attachments.mode = 'auto'`.
- If a run includes attachments, Grok is sent attachments through DOM automation:
  - convert base64 → `File`,
  - set `input[type="file"]` via `DataTransfer`,
  - fallback to synthetic drag/drop,
  - confirm attachment best-effort (input.files or filenames in UI text).

### 6.2 Why it might still fail (and what happens)

Some websites block scripted uploads by:

- using closed shadow DOM for file inputs,
- requiring trusted drag/drop (`event.isTrusted === true`),
- enforcing user gesture restrictions.

If upload automation fails:

- background retries the prompt **without attachments** (so the run continues),
- a transcript notice is appended via `notifyAttachmentFallback(...)`.

This keeps the run reliable even when providers drift.

### 6.3 Prefetch behavior (performance)

During a session, attachments are managed in-memory (`sessionAttachmentsById`):

- attachments are delivered at most once per agent per session,
- background can “prefetch” attachments into other agents while one agent is generating:
  - uses `injectAndPrepareAttachments(..., mode: 'prepare_attachments')`.

This reduces “send too early while upload is still processing” failures.

---

## 7) Side panel UX and how Grok appears

File: `sidepanel.js`

- Grok is included in `DEFAULT_PROVIDER_IDS` so it appears immediately even before capabilities load.
- Provider labels include Grok (`formatProviderLabel`, `formatRoleLabel`).

File: `styles.css`

- Grok transcript bubbles have a distinct style (`.message.grok`) so Compare/Debate transcripts are easier to scan.

---

## 8) Background message routing for Grok

For session runs (debate/parallel):

- content script sends `MLC_RESPONSE_CAPTURED` with `sourceLLM: 'grok'`.
- background’s `handleDebateResponse(...)` is provider-agnostic and handles it normally.

For non-session single sends:

- content script sends `GROK_RESPONSE_CAPTURED`,
- background forwards it to the UI through `handleGrokResponse(...)` as `LLM_RESPONSE`.

---

## 9) Debugging playbook (when Grok breaks)

### 9.1 Confirm content script is running

In Grok tab DevTools console:

- You should see:
  - `[MLC ContentScript] Initializing for grok.`

If not:

- verify `manifest.json` matches include `https://grok.com/*`,
- verify you reloaded the extension.

### 9.2 Confirm readiness (PING/PONG)

From extension side panel:

- Settings → Connections → **Refresh connections**

If Grok doesn’t become “Ready”:

- ensure the Grok tab is on `grok.com` (not a login/redirect host),
- refresh that tab and retry.

### 9.3 If sending fails

Most common cause: selector drift.

Update:

- `background.js` → injected `simpleInteraction`:
  - `inputSelectors.grok`
  - `providerUiConfig.grok.sendSelectors` / `stopSelectors` / `voiceSelectors`
  - Grok control classifier + `waitForSendAcknowledged(...)` signal policy

Sanity checks in Grok DevTools:

- Find input: `document.querySelectorAll('textarea, [contenteditable=\"true\"]').length`
- Find send button by aria label/title/testid.

### 9.4 If capture fails (empty response)

Update:

- `contentScript.js`:
  - `isGrokGenerating()` (stop/spinner selectors)
  - `extractGrokResponse()` candidate selectors, composer zone filtering, and user-message detection
  - `emitCaptureFromResolvedExtraction(...)` for final payload emission
  - `sanitizeGrokTranscriptCandidate(...)` / footer artifact stripping

Enable capture debug (optional):

- In Grok tab console:
  - `localStorage.setItem('mlc_capture_debug', '1')`

Reload Grok and retry to see capture decision logs.

If content script says “Response captured” but UI is still empty:

- Check service-worker logs for:
  - `[MLC Debate] Dropping captured response: empty content.`
  - `[MLC Parallel] Dropping captured response: empty content.`
- Those logs include `sessionId`, `promptId`, `turnIndex`, `agentId`, and `sourceLLM`.

### 9.5 If attachment upload fails

In Grok DevTools:

- Check if file input exists:
  - `document.querySelectorAll('input[type=\"file\"]').length`

If it is 0:

- Grok likely hides it in closed shadow DOM or uses a trusted gesture gate.
- The extension will fall back to text-only and show a transcript notice.
- Manual upload in Grok tab is the reliable path.

---

## 10) Extension points for future providers (lessons from Grok)

If adding another provider, Grok’s integration shows the minimal set:

1. Add host permissions + content script matches in `manifest.json`.
2. Add `PROVIDER_METADATA` entry:
   - openUrl, expectedHosts, urlPatterns.
3. Add capability entry in `PROVIDER_CAPABILITIES`:
   - start attachments as `manual` unless proven otherwise.
4. Add `simpleInteraction` input/send/stop selectors (or a CDP sender if DOM is unreliable).
5. Add capture extraction + generating detection in `contentScript.js`.
6. Update labels/colors in side panel for good UX.

---

## 11) Known limitations (honest constraints)

- DOM automation is inherently brittle; Grok UI changes can break selectors.
- Attachment automation may fail depending on Grok’s implementation and browser security constraints.
- We do not attempt to bypass trusted-event gating; if Grok requires user gestures, manual upload is the correct fallback.
