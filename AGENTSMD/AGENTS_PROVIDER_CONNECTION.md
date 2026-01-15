# AGENTS_PROVIDER_CONNECTION.md — Provider Connection Workflow

This document explains how the extension “connects” to ChatGPT and Gemini tabs and what “connected” means in practice.

## Goals

- Bind a **ChatGPT** tab and a **Gemini** tab to persistent **Tab Profiles**.
- Ensure the background worker can:
  - inject prompts into the right provider tab, and
  - receive captured responses from the provider page via content scripts.

## Key concepts

- **Provider**: `chatgpt` or `gemini`.
- **Tab Profile**: A stored record pointing at a specific provider tab (`tabId`) with metadata and a `status`.
- **Default profile**: Per-provider `profileId` stored in `defaults.chatgpt` and `defaults.gemini`.
- **Connected (UI)**: The provider tab is reachable and the content script responds to a `PING` (not just “tab exists”).
- **History unlocked (UI)**: Running sessions and loading chat history also requires encrypted history to be unlocked (Settings → Security).

## Storage

- Key: `mlc_tab_profiles_v1` in `chrome.storage.local`
- Shape:
  - `profiles[]`: `{ profileId, provider, tabId, windowId, label, status, lastKnownUrl, modelHint, ... }`
  - `defaults`: `{ chatgpt: profileId|null, gemini: profileId|null }`

`status` is updated over time:

- `ok`: tab exists and is on an expected host for the provider
- `wrong_host`: tab exists but navigated to a different host
- `unknown`: tab exists but URL isn’t known yet
- `offline`: tab no longer exists

## The “Connect” flow (single provider)

### 1) Side panel triggers connect

When the user clicks **Connect** for a provider (in the Route Builder or Settings), the side panel (`sidepanel.js`) sends:

- `{ type: 'CONNECT_PROVIDER', provider: 'chatgpt' | 'gemini' }`

### 2) Background opens the provider tab

The service worker (`background.js`) handles `CONNECT_PROVIDER` by:

1. `openProviderTab(provider)` → `chrome.tabs.create({ url: https://chatgpt.com/ | https://gemini.google.com/ })`
2. `claimTabAsProfile({ provider, tabId, label, setDefault: true })`
   - Host validation uses `getTabUrlCandidate(tab)`:
     - prefers `tab.url`
     - falls back to `tab.pendingUrl` (important right after `chrome.tabs.create`)
   - If strict host validation fails (redirects / URL not ready), it retries with `skipHostCheck: true` so the tab still gets bound and can later become `ok` once it finishes navigation.

### 3) Profiles are persisted + UI is notified

`claimTabAsProfile(...)` updates `mlc_tab_profiles_v1` and emits:

- `TAB_PROFILES` (profiles list + defaults)

The side panel refreshes its connection UI based on the new profile/default state.

### 4) “Connected” is verified by pinging the content script

Separately, the UI sends `{ type: 'CHECK_CONNECTION' }`.

The background checks the **default profile tabIds** and pings each tab:

- `chrome.tabs.sendMessage(tabId, { type: 'PING' })`
- The content script replies `{ type: 'PONG' }`

The background returns:

- `CONNECTION_STATUS`: `{ chatgpt: boolean, gemini: boolean }`

The side panel only shows **ready/connected** once the provider tab responds to `PING` (this ensures capture is possible).

## The “Connect all” flow (why it used to fail)

**Connect all** triggers *two* `CONNECT_PROVIDER` requests back-to-back (ChatGPT + Gemini).

### Previous bug (lost update)

Each connect operation did a read/modify/write to the same storage key (`mlc_tab_profiles_v1`):

1. `loadTabProfiles()`
2. modify defaults/profiles
3. `saveTabProfiles()`

With two connect operations running concurrently, the later save could overwrite the earlier one (typical lost-update race), so only one provider ended up as “connected/default” in the UI.

### Fix (serialize profile mutations)

`background.js` now uses a simple in-memory mutex/queue:

- `withTabProfilesLock(fn)` queues all operations that mutate `mlc_tab_profiles_v1`

This guarantees connect-all cannot clobber the other provider’s profile/default writes.

## Important caveat: host permissions and login redirects

The ping-based connection check requires the content script to be injected into the provider tab.

- Content scripts are only injected for hosts in `manifest.json` → `content_scripts.matches`.
- If the provider opens on a login/redirect host where the content script is *not* injected, `PING` will fail and the UI will stay “Not connected” until the tab finishes login and navigates to a matched host.

## Troubleshooting checklist

- If a provider shows **Wrong host**:
  - Click **Focus** and navigate the tab back to the provider homepage, then click **Refresh connections**.
- If a provider shows **Waiting…**:
  - A profile exists, but ping failed. Reload the provider tab once it’s on a matched host.
- If providers show **ready** but **Run** is disabled:
  - Unlock history in Settings → Security (see `AGENTSMD/AGENTS_DBS.md`).
- If “Connect all” opens tabs but only one stays connected:
  - Reload the extension (MV3 service worker updates are not hot-reloaded reliably).
  - Check Settings → Advanced connections to confirm both default profiles exist.
