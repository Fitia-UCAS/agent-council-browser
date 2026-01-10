# AGENTS_DBS.md — Encrypted Chat History (IndexedDB)

This document explains the extension’s **local-first**, **encrypted** chat history system: why it exists, how it works, and how to inspect/debug it.

## Why we did this

We wanted “real chat app” history in an MV3 Chrome extension, meaning:

- History must persist across service-worker suspends/restarts.
- Chats must scale to **lots of messages** without becoming slow or exceeding message-size limits.
- Chat content should not be stored in plaintext on disk.

### Why not `chrome.storage.local` for messages

`chrome.storage.local` is great for settings and small state, but it’s effectively **JSON blob storage**. Large transcripts become slow and can be fragile under concurrent writes. Also, loading an entire thread in one go risks hitting Chrome’s `runtime.sendMessage` payload limits.

### Why IndexedDB

IndexedDB is the browser’s built-in database. It gives us:

- “Tables” (object stores), indexes, and fast paging.
- Efficient “load last N messages” and “load older messages” flows.
- A clean place to store structured thread/message data.

### Why passphrase-based encryption

If we generate a key and store it next to the data, that hides plaintext but does not protect against someone who can copy the Chrome profile (they can take the key too).

With a **passphrase**, the decryption key is not stored on disk; users must unlock after restarting Chrome. This is the strongest local-only model we can do without OS/hardware keychains.

## Where the code lives

- Storage + crypto: `historyStore.js`
- Background APIs (MV3-safe): `background.js`
- UI (Security settings + paging): `sidepanel.html`, `sidepanel.js`, `styles.css`

## Database overview

### Database name / version

- IndexedDB database: `mlc_history_v1`
- Schema version: `1`

### Object stores (“tables”)

#### `threads`

Key: `threadId` (string; used as `chatId` in the UI)

Fields:

- `threadId`: primary key
- `createdAt`, `updatedAt`: timestamps (ms)
- `titleEnc`: encrypted `{ iv, data }` for the title
- `titleIsDefault`: boolean; helps auto-title on first user message
- `messageCount`: integer
- `nextSequence`: integer; monotonically increasing per thread
- `lastPreviewEnc`: encrypted `{ iv, data }` for the last message preview

Indexes:

- `updatedAt` (for listing threads newest-first)
- `createdAt`

#### `messages`

Key: `messageId` (string)

Fields:

- `messageId`: primary key
- `threadId`: foreign key-ish (string)
- `sequence`: integer; monotonic ordering inside a thread
- `createdAt`: timestamp (ms)
- `role`: `user | assistant | system | chatgpt | gemini` (current app uses `chatgpt|gemini` for assistants)
- `provider`: `chatgpt | gemini | null`
- `payloadEnc`: encrypted `{ iv, data }` for the full message payload JSON

Indexes:

- `threadId`
- `threadId_sequence` = `[threadId, sequence]` (paging backwards efficiently)
- `threadId_createdAt` = `[threadId, createdAt]`

#### `settings`

Key: `key` (string)

We use this as a small “settings/meta table” inside the same DB:

- `crypto`: encryption configuration + key-check
- `activeThreadId`: currently selected chat
- `migrationVersion`: legacy migration marker

## Encryption design

### Algorithms

- KDF: PBKDF2-SHA256
- Iterations: `250_000`
- Salt: 16 random bytes
- Data encryption: AES-GCM (256-bit key)
- IV: 12 random bytes per encrypted record

### What is encrypted

- Thread title: `threads.titleEnc`
- Thread preview: `threads.lastPreviewEnc`
- Message payload JSON: `messages.payloadEnc` contains:
  - `content` (plaintext string inside the encrypted JSON)
  - optional `contentHtml`
  - `sessionId`, `turnIndex`, `roundIndex`, etc.

Nothing meaningful is stored as plaintext in the message rows besides metadata like `threadId`, `sequence`, and `role`.

### Key-check (detect wrong passphrase)

On first setup we encrypt a constant plaintext:

- `KEYCHECK_PLAINTEXT = "mlc-history-keycheck-v1"`

We store that ciphertext as `settings.crypto.value.keyCheck`. When unlocking, we derive the key again and attempt to decrypt that key-check. If it fails (or plaintext mismatches), the passphrase is wrong.

### “Unlocked” state and MV3 service-worker restarts

MV3 service workers are suspended frequently, so we cannot rely on in-memory keys.

We cache the derived key bytes in **session storage**:

- `chrome.storage.session['mlc_history_key_v1'] = base64(derivedKeyBytes)`

This means:

- It stays unlocked across service-worker sleeps (good UX).
- It is cleared when Chrome restarts (so users must unlock again).
- The “Lock” button removes this session key.

## Storage API (in `historyStore.js`)

The storage layer is exposed as:

- `self.mlcHistoryStore`

Key methods:

- `getStatus()` → `{ configured, unlocked }`
- `configureEncryption(passphrase)` → sets up crypto config + unlocks
- `unlock(passphrase)` / `lock()`
- `listThreads({ limit, cursorUpdatedAt })` → paginated thread list
- `createThread({ threadId, title, createdAt, updatedAt, titleIsDefault })`
- `renameThread(threadId, title)`
- `deleteThread(threadId)` → cascades messages
- `appendMessage(threadId, message)` → encrypts payload + updates thread counters/preview
- `getThreadWithMessages(threadId, { limit, beforeSequence })` → used for initial thread load
- `listMessages(threadId, { limit, beforeSequence })` → “Load older messages”
- `getMeta/setMeta/deleteMeta(key)` → used for migration markers

## Background ↔ UI message APIs (MV3-safe)

The side panel **does not** touch IndexedDB directly. It talks to the background service worker, which owns reads/writes.

Security messages:

- `HISTORY_STATUS`
- `HISTORY_CONFIGURE` (passphrase)
- `HISTORY_UNLOCK` (passphrase)
- `HISTORY_LOCK`
- `HISTORY_RESET`

History messages:

- `GET_CHATS_STATE` → list threads + active thread
- `GET_CHAT` → loads last page of messages (default `60`)
- `GET_MESSAGES_PAGE` → loads older messages (cursor paging)
- `CREATE_CHAT`, `SET_ACTIVE_CHAT`, `RENAME_CHAT`, `DELETE_CHAT`

### Why paging exists

We intentionally avoid sending “the entire chat history” over `runtime.sendMessage`.

- `GET_CHAT` returns **only the most recent N messages**.
- Older messages are loaded on demand with `GET_MESSAGES_PAGE`.

This prevents message-size failures and keeps the UI responsive.

## Legacy migration (`mlc_chats_v1` → encrypted DB)

Old versions stored chats in:

- `chrome.storage.local['mlc_chats_v1']`

Migration happens:

- automatically, once, after history is unlocked
- in the background via `ensureLegacyChatsMigrated(...)`
- tracked with `settings.migrationVersion = 1`

What we do:

1. Read `mlc_chats_v1`.
2. For each legacy chat:
   - create a new thread (same `chatId` when possible),
   - append each message (encrypted),
   - preserve timestamps/turn indices where possible.
3. Preserve the active chat if it exists.

The legacy key is left in `chrome.storage.local` for rollback unless the user clicks **Reset history**, which deletes both the encrypted DB and the legacy key to prevent re-import.

## How to inspect the encrypted DB

1. `chrome://extensions` → your extension → **Inspect views** → `sidepanel.html`
2. DevTools → **Application** tab
3. Left sidebar → **IndexedDB** → `mlc_history_v1`
4. Click `messages` and open a row:
   - `payloadEnc.iv` is an `ArrayBuffer(12)`
   - `payloadEnc.data` is an `ArrayBuffer(...)` ciphertext

To sanity-check encryption:

- You should **not** see your prompt text in any plaintext field in IndexedDB.

## Common issues / troubleshooting

- **“History: locked” even after typing a passphrase**: typing does nothing until you click **Unlock**.
- **Clicked “Enable encryption” twice**: second click returns “already configured”. Use **Unlock** instead.
- **Wrong passphrase**: unlock fails with “Incorrect passphrase.” There is no recovery; use **Reset history** to wipe.
- **Service worker restarted**: unlocked state should survive via `chrome.storage.session`, but if the session key was cleared, just unlock again.

