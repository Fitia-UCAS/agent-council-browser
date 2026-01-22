# Answer Detection + Rich Rendering (ChatGPT/Gemini)

This repo already has a high-level architecture write-up in `AGENTSMD/AGENTS.md`.  
This document is the “deep memory” for **how we capture LLM answers** (text + rich formatting) and **how we render them safely** in the side panel transcript.

The goal is that a future agent (or you) can integrate a new provider without re-reading the full codebase.

---

## Problem we solved

We display provider answers inside the extension’s chat transcript. Initially the UI rendered answers as plain text (`textContent` with CSS `white-space: pre-wrap`), which *works only if the captured text contains newlines*.

Gemini answers were often “squashed” (no line breaks / paragraphs / list spacing). Root cause:

- Gemini capture used `clone.textContent` as a fallback when `clone.innerText` was missing.
- On detached clones, `innerText` is often empty or unreliable, so we frequently fell back to `textContent`.
- `textContent` does **not** represent layout; it ignores `<br>`, `<p>`, `<li>`, table rows, etc., so the output becomes one long line.

We fixed newline preservation and then added **rich formatting** (tables/headings/math) by capturing provider HTML and rendering it safely.

---

## Design decision: store text + optional HTML

We split “what we use for debate logic” from “what we use for UI fidelity”:

- `content` (plain text) is the canonical representation:
  - Used for debate prompts / chaining (injected back into the LLM tabs).
  - Must be stable, safe, and provider-agnostic.
- `contentHtml` (optional rich HTML) is for UI rendering only:
  - Used only by the side panel to preserve headings/lists/tables/math as the provider rendered them.
  - Treated as **untrusted input** and sanitized heavily before rendering.

This separation makes it safe to improve visuals without affecting debate turn logic.

---

## Data model (messages)

### Content script → background payload
When a response is captured, the content script sends:

- `content`: plain text
- `contentHtml` (optional): HTML snippet representing the same answer
- `promptId`, `sessionId`, `turnIndex`, `sourceLLM`, `timestamp`, `responseDelay`

### Background session state
Debate session messages (`activeDebateState.messages[]`) store:

- `role` (`user`, `chatgpt`, `gemini`)
- `content` (plain text)
- `timestamp`, `turnIndex`, `roundIndex`
- `contentHtml` (optional; capped; only if present)

### Background → side panel
`UI_MESSAGE_ADD` includes `content` and optionally `contentHtml`.

The side panel renders `contentHtml` if present, else falls back to `content`.

---

## Capture pipeline overview (content scripts)

The capture code lives in `contentScript.js`. It runs on both `chatgpt.com` and `gemini.google.com`.

### 1) Capture arming
On `MLC_PROMPT_SENT`, we “arm” capture:

- Store identifiers: `promptId`, `sessionId`, `turnIndex`
- Capture baselines to avoid re-capturing old content:
  - `baselineText = extractLatestResponseText()`
  - ChatGPT-only: `baselineAssistantCount = count([data-message-author-role="assistant"])`
- Reset stabilization state:
  - `hasNewText = false`
  - `lastTextChangeAt = startedAt` (used for time-based stability)

### 2) Ongoing evaluation
We run `evaluateCapture()` on (debounced):

- a `MutationObserver` watching the document
- a periodic interval (polling) as a safety net

To avoid MutationObserver “spam” making the capture fire too early, mutations call `scheduleEvaluateCapture(...)` which coalesces bursts and runs `evaluateCapture()` at a controlled cadence.

The loop logic is (time-based, not tick-based):

1. Extract latest response (`extractLatestResponse({ withMeta: true })`):
   - returns `{ text, meta }`
   - `meta` helps debug candidate ranking (ChatGPT) and stability logic
2. Wait until we see new output (different from baseline).
3. Track stability:
   - if text changes: update `lastTextChangeAt = now`
   - compute `stableForMs = now - lastTextChangeAt`
4. Capture conditions:
   - If provider is still generating:
     - “force capture” after a long stable period (provider-specific thresholds)
   - If provider is not generating:
     - capture when `stableForMs` exceeds a minimum stable duration

Reference-like guardrail (ChatGPT):
- If the *best current extraction* looks like a sources-only/reference block, we deliberately require a longer stable window before capturing (so we don’t “lock in” sources while the real prose answer is still being assembled or we accidentally selected a sources-only assistant block).

Current timing parameters (best-effort, may be tuned as provider UIs change):
- ChatGPT:
  - minimum stable capture window (normal): ~1.8s
  - minimum stable capture window (reference-like): ~9s
  - force capture while “generating” (normal): ~20s stable
  - force capture while “generating” (reference-like): ~45s stable
  - hard timeout (only when stable for a while): ~180s total
- Gemini:
  - minimum stable capture window (normal): ~1.2s
  - force capture while “generating”: ~15s stable
  - hard timeout (only when stable for a while): ~120s total

### 3) Generating detection
Provider-specific heuristics:

- ChatGPT: stop button visible (`button[data-testid="stop-button"]` / aria Stop)
- Gemini: stop icon/button/spinner heuristics (best effort)

This is intentionally heuristic because provider UIs change.

---

## Provider extraction: plain text + HTML (content scripts)

Extraction returns:

- `text`: what we store/use as canonical content
- `html` (optional): what we store as `contentHtml` for UI fidelity

We always capture text and we *attempt* HTML.

### Shared: HTML “cleanup” before shipping to UI
`extractCleanHtmlFromNode(node)`:

- Clones the answer node and removes:
  - `script`, `style`, `noscript`
  - form controls / inputs / buttons
  - media: `img`, `video`, `audio`, `canvas`, `picture`
- Enforces an upper bound: if HTML is too large, return empty string so UI falls back to plain text.

This keeps payload sizes reasonable and reduces the sanitizer burden in the side panel.

### ChatGPT extraction (`extractChatGPTResponse`)
Key points:

- Scans up to the **4 most recent assistant message roots** starting at `baselineAssistantCount`:
  - This fixes an intermittent ChatGPT UI behavior where “Sources/References” can be rendered as a *separate* assistant block after the main answer.
  - If we only looked at the latest assistant block, we could accidentally capture sources-only text.
- Collects candidate nodes under each scanned assistant root:
  - `[data-testid="message-content"]`, `.prose`, `.markdown`, plus each message root itself
- Deduplicates candidates by normalized text
- Picks the best candidate using `CaptureUtils.chooseBestTextCandidate(...)`:
  - this avoids capturing sources-only/reference blocks when a real answer exists
- Additional guardrail:
  - If the top-ranked candidate is a reference list, but we have another “meaningful” non-reference candidate (prose/code/multi-line), we select that instead.
- If a newer assistant block looks like link/reference content, it is appended to the main answer to preserve hyperlinks in the captured text/HTML.
- Returns:
  - `text` from the best candidate
  - optional `html` from the same best node (`extractCleanHtmlFromNode(bestNode)`)

### Claude extraction (`extractClaudeResponse`)
Key points:

- Builds candidates from the most recent assistant message roots (`data-testid`/assistant/`article` selectors).
- Aggregates `.markdown`/`.prose`/`message-content` nodes inside each root to avoid missing multi-part answers.
- Uses the same `CaptureUtils.chooseBestTextCandidate(...)` ranking and guardrails as ChatGPT.
- Prompt-echo detection only filters near-identical prompt repeats, so prompt-prefixed answers are still captured.
- Appends link/reference-only blocks that appear immediately after the main answer.

### Gemini extraction (`extractGeminiResponse`)
Key points:

- Scans a broad set of selectors under `main` (fallback to `body`) to find answer candidates.
- Avoids capturing:
  - nodes that look like user messages (`isGeminiUserMessage`)
  - nodes inside the prompt input container
- Tracks whether we saw media-only content (for image-only answers).
- **Important newline fix**:
  - Uses `target.innerText` from the *live node* for text, not `textContent`.
  - This preserves paragraphs and lists as newlines.
- Returns:
  - `text` from `innerText`
  - optional `html` from the same node (`extractCleanHtmlFromNode(target)`)
  - placeholder text if Gemini output is image-only (so the debate can continue)

---

## Sending captured responses (content scripts)

`sendCapturedResponse(...)` now accepts either:

- a plain string (legacy), or
- an extraction object `{ text, html }`

We send a payload with:

- `content` = `extraction.text`
- `contentHtml` = `extraction.html` (or empty)

The message type is:

- `MLC_RESPONSE_CAPTURED` for debate sessions (has `sessionId`)
- `CHATGPT_RESPONSE_CAPTURED` / `GEMINI_RESPONSE_CAPTURED` for non-session one-offs

---

## Background storage + forwarding

Background behavior is unchanged for debate logic, except it now:

- Accepts `message.contentHtml` (optional)
- Caps HTML size again (defense-in-depth)
- Stores `contentHtml` on the session message entry
- Forwards `contentHtml` in `UI_MESSAGE_ADD`

Non-session responses (`LLM_RESPONSE`) also forward `contentHtml` for consistency.

This is backward-compatible: if content scripts don’t send HTML, UI still works.

---

## Side panel rendering (safe rich HTML)

The side panel used to render everything via `textContent`. Now it can render rich HTML safely.

### Rendering rule
In `addMessage(message)`:

- If `message.contentHtml` is present:
  - render rich
- else:
  - render plain text (`textContent`) and rely on `white-space: pre-wrap`

### Sanitizer: `sanitizeRichHtmlToFragment(html)`
We do not use `innerHTML` directly. We parse into a `<template>`, then rebuild a safe DOM subtree using a strict allowlist.

Key properties:

- **Allowed HTML tags** (subset): headings (`h1..h6`), `p`, `br`, lists (`ul/ol/li`), `pre/code`, `blockquote`, `hr`, and table tags.
- **Allowed MathML tags**: `math`, `mrow`, `mi`, `mo`, `mn`, `mfrac`, etc.
- **Dropped tags**: scripts, iframes, images, svg, media, forms/inputs, etc.
- **Allowed attributes** are extremely limited:
  - `a[href]` only if it is a safe scheme (`http(s)`, `mailto`, `#`, relative paths)
  - `a` gets `target="_blank"` and `rel="noopener noreferrer"`
  - table cell spans: `colspan`/`rowspan` if numeric
  - MathML: `display`, `xmlns`, and `annotation[encoding]`
  - accessibility: `aria-label`, `aria-hidden`
- **KaTeX behavior**:
  - We drop nodes with class `katex-html` to avoid depending on KaTeX CSS/layout.
  - We keep the MathML portion (`<math>...`) when present.

### Table post-processing
`postProcessRichContent(rootEl)` wraps tables in a `.table-wrap` div:

- Allows horizontal scrolling for wide tables in the narrow side panel.
- Provides consistent borders/background.

---

## Styling and formatting rules (CSS)

Base transcript rendering uses:

- `.message-content { white-space: pre-wrap; }`
  - great for plain text (keeps newlines/indentation)

Rich transcript rendering switches to:

- `.message-content.rich { white-space: normal; }`
  - standard HTML flow
- `.message-content.rich pre { white-space: pre; overflow-x: auto; ... }`
  - preserves code indentation and enables scrolling

Additional rich formatting styles:

- headings: sized and spaced (`h1..h3` emphasis)
- lists: margins so bullets don’t collapse
- blockquotes: left border + muted background
- links: underline and color
- `.table-wrap` + table borders + header background
- `math[display="block"]` is block-level with vertical margins

This is intentionally “Markdown-like” in a confined side panel layout.

---

## Security model (why we did it this way)

Provider HTML is untrusted input.

We protect the extension UI by:

- Capturing only a subset of the provider DOM (answer node only).
- Removing obvious active/large elements in the content script (scripts, media, form controls).
- Sanitizing again in the side panel with:
  - tag allowlist
  - attribute allowlist
  - safe URL scheme checks for links
- Never allowing:
  - `<script>`, event handler attributes, inline styles, iframes, images, SVG, etc.

This gives rich rendering without XSS risk.

---

## Debugging and maintenance tips

### Capture debugging
In a provider tab console:

- `localStorage.mlc_capture_debug = '1'`

This enables extra logs (candidate scoring, best candidate previews, capture decisions).

ChatGPT-specific debug metadata now includes:
- Which assistant roots were scanned (`rootsScanned`)
- Candidate “origin” strings (e.g. `assistant[12] [data-testid="message-content"]`)
- Ranking details (score, reference flag, word/line/urlish/punctuation counts)

### If formatting looks wrong
First determine *where* the formatting is lost:

1. In provider tab console, inspect `extractLatestResponse({ withMeta:true, withHtml:true })`.
2. In background worker logs, verify `contentHtml` arrives and is stored.
3. In side panel inspect:
   - Does the message have `.message-content.rich`?
   - Is the sanitized DOM missing key tags (e.g., tables stripped)?

### Size caps
If the HTML is too large, `contentHtml` is intentionally dropped and the UI falls back to plain text.

---

## Adding a new provider (checklist)

This is the shortest path to integrate another LLM provider while keeping fidelity.

1. **Manifest**
   - Add `host_permissions` and a `content_scripts.matches` entry for the provider domain.

2. **Provider detection**
   - Extend host detection in `contentScript.js` (like `isChatGPT`/`isGemini`).
   - Add `currentLLM` string identifier (used as `sourceLLM` and transcript role).

3. **Input + send selectors**
   - Implement reliable `findInput()` selectors.
   - Implement `findSendButton()` selectors or keep Enter fallback.

4. **Generating heuristics**
   - Implement `is<Provider>Generating()` (stop button/spinner/disabled send button heuristics).

5. **Response extraction**
   - Implement `extract<Provider>Response({ withHtml, withMeta })` that returns `{ text, html? }`.
   - For text: prefer `innerText` (layout-aware) over `textContent`.
   - For HTML: use `extractCleanHtmlFromNode(answerNode)`.
   - Avoid capturing:
     - the composer/input area
     - the user message DOM
     - navigation sidebars or “sources-only” blocks if possible

6. **Role + styling**
   - Side panel will display unknown roles, but you’ll probably want:
     - `formatRoleLabel(...)` mapping (like “Gemini”, “ChatGPT”)
     - `.message.<provider>` CSS styling (border color/background)

7. **Security**
   - If the provider uses special tags for rich content, update the sanitizer allowlist intentionally.
   - Never add broad attribute allowances; keep it strict.

8. **QA prompts**
   - Tables, headings, nested lists, code fences, long answers, and math.

---

## Known limitations / future improvements

- We do not render images in the transcript (intentionally stripped for safety + UI simplicity).
- Math fidelity depends on what providers output in the captured HTML:
  - We preserve MathML when present.
  - We strip KaTeX HTML layout nodes (`.katex-html`) to avoid CSS dependency.
- Provider DOM changes can break extraction selectors; keep capture debug enabled during maintenance.
- ChatGPT can change how it renders citations/sources (inline vs separate assistant blocks). The multi-root scan + reference-only guardrails are designed to tolerate these UI changes, but may need selector updates over time.
