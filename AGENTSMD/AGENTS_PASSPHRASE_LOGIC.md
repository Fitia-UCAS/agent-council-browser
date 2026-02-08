# AGENTS_PASSPHRASE_LOGIC.md — History Passphrase Logic

This document is the focused memory for the current passphrase model used by chat history in the side panel.

It describes what users should experience and how the implementation behaves.

---

## 1) Product model (current)

- Chat history is always on (local, on-device).
- Passphrase is optional.
- If passphrase is set, the extension can protect chats at rest.
- A single toggle controls whether **new chats** require passphrase.
- Existing protected chats stay protected until unlocked.
- No inactivity auto-lock timer is used.

---

## 2) User-facing rules

### A) Passphrase not set

- New chats are saved without encryption.
- There is no unlock step.

### B) Passphrase set + “Require passphrase for new chats” ON

- New chats are created as protected.
- Protected chats require unlock to open/read.

### C) Passphrase set + “Require passphrase for new chats” OFF

- New chats are created unprotected.
- Previously protected chats remain protected.
- Those protected chats still require unlock to open/read.

Important behavior:

- When the user turns the toggle OFF while currently unlocked, the UI locks protected chats again so the “paused for new chats” state is explicit and safe.

---

## 3) Security panel UX contract

Primary controls:

- `Set passphrase…` (only when not configured)
- `Unlock protected chats` (when configured + locked)
- `Lock protected chats` (when configured + unlocked)
- `Require passphrase for new chats` toggle (when configured)

Danger zone (separate collapsible section):

- `Forget passphrase (delete protected chats)…`
- `Delete all chats on this device…`

Intent:

- Keep normal daily actions simple.
- Keep destructive actions visually isolated and explicit.

---

## 4) Data behavior

### Thread creation

New thread protection is decided at creation time:

- protect thread only when:
  - encryption is configured
  - protection mode is `per_chat`
  - `lockNewChatsByDefault` is `true`

### Reading protected chats

- If a thread is protected and no unlocked key exists, chat summary is returned as:
  - title: `Locked chat`
  - preview: empty
  - `locked: true`

### Unlock key lifetime

- Unlock key is stored in `chrome.storage.session`.
- Clearing/locking session removes in-memory/session key.
- Browser restart clears session storage, so protected chats become locked again.

---

## 5) Status semantics in UI

Badge states:

- `Off`: passphrase not configured.
- `On (locked)`: passphrase configured, new chats protected, locked.
- `On (unlocked)`: passphrase configured, new chats protected, unlocked.
- `Paused`: passphrase configured, but new chats are not protected.

Status text must always clarify two things:

- what happens to **new chats**
- whether **protected chats** are currently readable

---

## 6) Message/API surface used by this UX

Used by UI:

- `HISTORY_STATUS`
- `HISTORY_CONFIGURE`
- `HISTORY_UNLOCK`
- `HISTORY_LOCK`
- `HISTORY_SET_LOCK_NEW_CHATS`
- `HISTORY_RESET_PROTECTION`
- `HISTORY_CLEAR_ALL`

Not part of primary UX (legacy/back-compat):

- `HISTORY_SET_ENABLED` (history remains on)
- `HISTORY_SET_PROTECTION_MODE` (normalized to `per_chat`)
- `HISTORY_DISABLE_PROTECTION` (supported in background/history store but not exposed in current simplified UI)

---

## 7) Key files

- `sidepanel.html`
  - Security section layout and control order.
- `sidepanel.js`
  - State model, status copy, action handlers, lock/unlock flow.
- `styles.css`
  - Security badge styles, danger zone styling, focus/readability.
- `historyStore.js`
  - IndexedDB + crypto logic, protected/unprotected thread behavior.
- `background.js`
  - Message handlers bridging UI actions to `historyStore`.

---

## 8) Test checklist (manual)

1. Fresh install, no passphrase:
   - create chat
   - verify chat is readable without unlock
2. Set passphrase:
   - create new chat
   - verify it appears as protected and can be locked/unlocked
3. Turn OFF “Require passphrase for new chats”:
   - verify protected chats lock again
   - create new chat and verify it is unprotected
4. Unlock again:
   - verify old protected chats become readable
5. Danger zone actions:
   - verify reset passphrase deletes protected chats only
   - verify delete all removes everything
