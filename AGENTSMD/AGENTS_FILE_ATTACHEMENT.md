# AGENTS_FILE_ATTACHEMENT.md — Attachments (Files/Images) via UI Automation

This document explains, in detail, how the extension’s “attachments” feature works **today**: files/images selected in the side panel and delivered to provider web UIs via UI automation (no official provider APIs).

It captures the subtle bits (provider capability gating, prefetch uploads, retries, and why Gemini is manual) so future work doesn’t have to rediscover them.

---

## 0) Problem statement (why this exists)

We want a side panel “attachments” experience that:

- lets users select files/images in the extension UI,
- sends those attachments to providers **through their own web UI** (no provider APIs),
- stays reliable across providers that do / do not allow programmatic uploads,
- avoids getting stuck when uploads take time (e.g., PDFs),
- scales to additional providers later.

The core constraint: some providers accept **manual** drag & drop, but intentionally block **synthetic** (programmatic) drag/drop and/or hide file inputs behind closed DOM.

---

## 1) Capability model (per provider)

Attachments are gated by a provider capability flag:

- `auto`: the extension will attempt to programmatically attach files.
- `manual`: the extension will **not** attempt programmatic attach; it sends text-only (and the UI asks the user to upload manually if they want the provider to use the file).
- `none`: provider does not support files at all (reserved for future providers).

### Where it’s defined

- Background service worker: `PROVIDER_CAPABILITIES` in `background.js`
  - ChatGPT: `attachments.mode = 'auto'`
  - Gemini: `attachments.mode = 'manual'`

### Why Gemini is `manual`

Observed on `gemini.google.com`:

- `document.querySelectorAll('input[type="file"]').length === 0` (no usable file input in light DOM)
- manual user drop events:
  - `drop isTrusted=true`
  - `dataTransfer.items[0].webkitGetAsEntry()` returns a `FileEntry`
- synthetic drop events created by scripts:
  - `drop isTrusted=false`
  - `webkitGetAsEntry()` is `null`

Browsers don’t allow extensions/scripts to fabricate `isTrusted=true`. If Gemini gates uploads on trusted gestures or closed-shadow file inputs, programmatic upload is not reliably possible.

Conclusion: Gemini is treated as `manual` until there’s a fundamentally different integration path.

---

## 2) Attachment lifecycle (end-to-end)

### 2.1 Side panel: selecting + reading files

Files are selected via the side panel and read into memory:

- File reading:
  - `FileReader.readAsDataURL(file)`
  - Strip the `data:*/*;base64,` prefix and store only the base64 payload.
- Storage:
  - Stored in `state.attachments[]` in `sidepanel.js` (UI state only).
- Limits (UI enforcement):
  - Max files: `ATTACHMENTS_MAX_FILES` (10)
  - Max per file: `ATTACHMENTS_MAX_FILE_BYTES` (10 MB)
  - Max total: `ATTACHMENTS_MAX_TOTAL_BYTES` (20 MB)
- UI behavior:
  - attachments are disabled while a run is active/paused.
  - list rendering shows name, type, size; user can remove individual files or clear all.

### 2.2 Side panel: deciding which providers get attachments

Before starting a run, the side panel computes an “attachment plan”:

- `getAttachmentProviderPlan(route)` returns:
  - `required`: providers involved in the run
  - `autoProviders`: subset where `attachments.mode === 'auto'`
  - `manualProviders`: subset where `attachments.mode !== 'auto'`

Important behavior:

- If **no** `autoProviders` exist, the UI does **not** include attachments in the message sent to the background.
  - This avoids heavy base64 payloads when a run is text-only anyway.

### 2.3 Side panel: “manual upload required” modal (ack-only)

If attachments exist and the run includes any `manualProviders`, the side panel shows a modal.

UX rule (important): clicking **OK does not start the run**.

Flow:

1. User clicks **Send**.
2. Modal shows:
   - how many files and total size,
   - which providers can auto-upload,
   - which providers require manual upload,
   - explicit instruction: upload manually in those provider tabs.
3. User clicks **OK**:
   - the modal closes,
   - the UI stores an acknowledgement key (`state.manualUploadAckKey`),
   - the run is **not** started.
4. User manually uploads in the provider tab(s).
5. User returns to side panel and clicks **Send** again:
   - if the acknowledgement key still matches the current attachments/providers, the run starts.

Acknowledgement key details:

- computed from:
  - `route` (kind + providers + rounds)
  - `manualProviders` (sorted)
  - current attachment IDs
- any change to providers/attachments implicitly invalidates the previous ack (because the key changes), so the user is re-warned when needed.

### 2.4 Background: receiving attachments (in-memory only)

Attachments are intentionally not persisted to `chrome.storage.local` (quota + privacy).

Background stores attachments in-memory for the active session only:

- `activeSessionAttachments` in `background.js`:
  - `sessionId`
  - `attachments[]` (sanitized)
  - `sentTo: { [provider]: boolean }`
  - `preparedTo: { [provider]: boolean }` (prefetch status; see below)

Sanitization:

- `normalizeIncomingAttachments(...)` enforces max files and max total size.
- Base64 is stripped of any data URL prefix.
- `size` is trusted if provided; otherwise estimated from base64 length.

Persistence note:

- Debate session state (`activeDebateState`) is persisted to `chrome.storage.local`.
- Attachment payloads are **not**. If the service worker restarts mid-run, attachments are lost (the run may continue but will be text-only from that point).

---

## 3) Delivery model (send-time + retry)

Attachments are delivered **once per provider per session**.

This avoids:

- re-uploading large files every round in a debate,
- repeated provider UI churn,
- accidental duplicate file attachments.

### 3.1 Core decision: should this provider receive attachments now?

In `sendDebateTurn(session)`:

1. Check if the session has attachments:
   - `hasSessionAttachments(session.sessionId)`
2. Read provider mode:
   - `getProviderAttachmentMode(expectedLLM)`
3. Compute:
   - If mode is not `auto`: send text-only (no attachments).
   - If mode is `auto`: attempt to attach if not already prepared/sent.

### 3.2 “Sent” vs “Prepared”

Two flags exist per provider:

- `preparedTo[provider]`:
  - attachments were pre-attached to the provider UI (prefetch path)
  - does **not** mean the message was sent yet
- `sentTo[provider]`:
  - attachments are “accounted for” for that provider
  - meaning:
    - either we successfully sent the message after attaching, or
    - we intentionally skipped attachment because provider is `manual`, or
    - we fell back to text-only after an attachment failure.

Important subtlety:

- `getPendingSessionAttachments(sessionId, provider)` returns `null` if:
  - `sentTo[provider] === true`, OR
  - `preparedTo[provider] === true` (by default)

So when prefetch succeeded, later sends do not re-attach payloads (prevents duplicates).

### 3.3 Failure handling: never block the run

If an `auto` provider attachment attempt fails, the run should continue.

Mechanism:

- `injectAndExecute(...)` throws an error with `code = 'ATTACHMENTS_FAILED'` when the injected script reports `details.stage === 'attachments'`.
- `sendDebateTurn(...)` catches this and immediately retries the same prompt **without** attachments.
- The provider gets text-only, but the session does not stall.

This is critical because provider DOMs drift frequently, and attachment automation is inherently brittle.

---

## 4) Prefetch uploads (so later sends don’t wait)

Uploading can take seconds (or more) depending on file size.

To reduce “send too early” failures and improve UX, the background pre-attaches files to other providers **as soon as possible**.

### 4.1 When prefetch runs

After a prompt is successfully sent to a provider (or after a text-only retry), the background calls:

- `prefetchSessionAttachments(session, excludeProvider)`

This tries to attach the same session attachments to other `auto` providers, while the current provider is generating.

### 4.2 What prefetch does

For each other provider involved in the run:

- skip if provider mode is not `auto`
- skip if `sentTo[provider]` is already true
- skip if `preparedTo[provider]` is already true
- resolve the provider’s tab (`resolveSessionTab(...)`)
- inject an attachment-only interaction:
  - `injectAndPrepareAttachments(tabId, provider, attachments)`
  - which calls the injected function `simpleInteraction` with:
    - `prompt = ''`
    - `options.mode = 'prepare_attachments'`

On success:

- mark `preparedTo[provider] = true`

On failure:

- log a warning
- do not pause the session (prefetch is best-effort)

### 4.3 Why prefetch doesn’t “wait for upload finished”

There is no stable cross-provider DOM API to detect upload completion.

Instead, we rely on a safe heuristic already in the send logic:

- before sending, `simpleInteraction` waits for the provider’s send button to become enabled (or a stop button to appear) and uses a long timeout if the send button starts disabled.

In practice, for providers like ChatGPT where uploads disable Send, this is sufficient.

---

## 5) Injected page logic (how attaching works)

All DOM-level attachment + sending is done inside the provider page via injected code:

- `simpleInteraction(prompt, llmType, attachments, options)` in `background.js`

### 5.1 Attachment payload format (what the injected script receives)

`attachments` is an array of objects with:

- `name`
- `type`
- `size`
- `lastModified`
- `base64` (raw base64 string, no data URL prefix)

The injected script rebuilds `File` objects:

- decode base64 → `Uint8Array`
- `new File([bytes], name, { type, lastModified })`

### 5.2 Strategy order

`attachFilesToComposer(targetInput)` tries:

1. **File input assignment** (preferred)
   - Search for `input[type="file"]` in:
     - the composer’s nearby DOM (form/main)
     - the full document
     - open shadow roots (deep query)
   - Use `DataTransfer` to set `input.files`
   - Dispatch `input` + `change` events
   - Respect `accept="..."` best-effort:
     - chooses an input that accepts the file’s extension or mime type when possible

2. **Drag/drop fallback**
   - Build `DataTransfer` with files
   - Dispatch `dragenter`, `dragover`, `drop` on likely targets
   - Confirm attachment by checking (within ~8s):
     - any file input gained files, OR
     - the page text contains attached filenames

If both fail:

- return an error like:
  - `No file input found on the page (including open shadow roots), and drag/drop fallback failed: ...`

### 5.3 Prepare-only mode

Prefetch uses:

- `options.mode = 'prepare_attachments'`

In this mode:

- `simpleInteraction` finds the composer input element,
- attaches files (if provided),
- returns success **before** setting any prompt or clicking send.

---

## 6) UI automation limitations (what’s possible vs not)

### 6.1 How to determine if a provider can be automated

A provider is a strong candidate for `auto` if:

- there is an accessible `input[type="file"]` (light DOM or open shadow roots), AND/OR
- synthetic drag/drop triggers an upload pipeline that can be confirmed (file name appears, attachment chip appears, or input.files fills).

A provider is likely `manual` if:

- no accessible file inputs exist, AND
- synthetic drag/drop is ignored (common if the app checks `event.isTrusted` or requires `webkitGetAsEntry()` to return a real `FileEntry`), AND
- upload requires a real user gesture.

### 6.2 Why manual drag/drop can work when automation cannot

When a user drags a file:

- the browser sets `event.isTrusted=true`
- `DataTransferItem.webkitGetAsEntry()` can produce a real file entry in some browsers
- apps can (and do) gate sensitive actions on “trusted” events

When a script dispatches events:

- `event.isTrusted` is always false (cannot be spoofed)
- file entry APIs may not return real file system entries
- apps can ignore the event or treat it as unsafe

This is exactly the Gemini behavior observed during debugging.

---

## 7) Extending to new providers (scalable path)

When adding a provider:

1. Add host matches + content script injection in `manifest.json` (so capture + ping work).
2. Add provider selector logic in `simpleInteraction`:
   - input selectors
   - send/stop button selectors
3. Decide attachment mode:
   - start with `manual` unless `auto` is confirmed reliable
   - flip to `auto` once file input assignment or synthetic drop works reliably
4. Add to `PROVIDER_CAPABILITIES`:
   - `{ attachments: { mode: 'auto' | 'manual' | 'none' } }`
5. (Optional but recommended) add provider-specific confirmation heuristics for attachment chips if the provider has a stable DOM marker.

Design intent:

- capability flag keeps the UI + background behaviors consistent as the provider list grows.
- providers can graduate from `manual` → `auto` without changing the UI contract.

---

## 8) Debugging checklist (when attachments break)

### Symptoms

- Session pauses with:
  - `Failed to interact with <provider>: ... Attachment upload failed ...`
- Prefetch logs warnings but run continues text-only.

### Quick triage (provider page)

In DevTools console on the provider page:

- Check file inputs:
  - `document.querySelectorAll('input[type="file"]').length`
- Check whether synthetic drop is ignored:
  - install a `drop` listener and compare `isTrusted` for manual vs scripted drops.

### Extension logs

Background logs include:

- `[MLC Attachments] Prefetch ...`
- `[SimpleInteraction INJECTED] Attaching ...`
- errors with stage:
  - `details.stage === 'attachments'`
  - `details.stage === 'send'` / `send_not_acknowledged`

### Common causes

- Provider DOM changed (selectors / shadow DOM)
- Provider added “trusted event” gating (isTrusted checks)
- Upload UI changed so confirmation heuristics no longer detect attachments

---

## 9) Security / privacy notes

- Attachment base64 exists in extension memory and is injected into provider pages to construct `File` objects.
- Attachments are not written to persistent storage by design.
- Any debugging that prints base64 should be avoided (large + sensitive).
