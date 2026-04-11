# AGENTS_PROVIDER_CONNECTION.md — Provider Connection Workflow

This document explains how the extension “connects” to provider tabs (ChatGPT, Gemini, Claude, Grok) and what “connected” means in practice.

## Goals

- Bind provider tabs to persistent **Tab Profiles** (including multiple profiles per provider so the same provider can appear as multiple agents in a route).
- Ensure the background worker can:
  - inject prompts into the right provider tab, and
  - receive captured responses from the provider page via content scripts.

## Key concepts

- **Provider**: `chatgpt` | `gemini` | `claude` | `grok`.
- **Tab Profile**: A stored record pointing at a specific provider tab (`tabId`) with metadata and a `status`.
- **Default profile**: Per-provider `profileId` stored in `defaults[provider]`.
- **Agent**: A route participant = `provider + profile selection` (Default or an explicit profile).
- **Connected (UI)**: The provider tab is reachable and the content script responds to a `PING` (not just “tab exists”).
- **History unlocked (UI)**: Running sessions and loading chat history also requires encrypted history to be unlocked (Settings → Security).

## Storage

- Key: `mlc_tab_profiles_v1` in `chrome.storage.local`
- Shape:
  - `profiles[]`: `{ profileId, provider, tabId, windowId, label, status, lastKnownUrl, modelHint, ... }`
  - `defaults`: `{ chatgpt: profileId|null, gemini: profileId|null, claude: profileId|null, grok: profileId|null }`

`status` is updated over time:

- `ok`: tab exists and is on an expected host for the provider
- `wrong_host`: tab exists but navigated to a different host
- `unknown`: tab exists but URL isn’t known yet
- `offline`: tab no longer exists

## The “Connect” flow (single provider)

### 1) Side panel triggers connect

When the user clicks **Connect** for a provider (in the Route Builder or Settings), the side panel (`sidepanel.js`) sends:

- `{ type: 'CONNECT_PROVIDER', provider: 'chatgpt' | 'gemini' | 'claude' | 'grok' }`

### 2) Background opens the provider tab

The service worker (`background.js`) handles `CONNECT_PROVIDER` by:

1. `openProviderTab(provider)` → `chrome.tabs.create({ url: PROVIDER_METADATA[provider].openUrl })`
2. `claimTabAsProfile({ provider, tabId, label, setDefault: true })`
   - Host validation uses `getTabUrlCandidate(tab)`:
     - prefers `tab.url`
     - falls back to `tab.pendingUrl` (important right after `chrome.tabs.create`)
   - If strict host validation fails (redirects / URL not ready), it retries with `skipHostCheck: true` so the tab still gets bound and can later become `ok` once it finishes navigation.
   - Connect always creates a **new default connection**:
     - it opens a new tab,
     - claims it into a new Tab Profile,
     - and sets that profile as the provider default.
   - This avoids stealing a tab from an active session and makes Connect a reliable “reset the connection” action.

### 3) Profiles are persisted + UI is notified

`claimTabAsProfile(...)` updates `mlc_tab_profiles_v1` and emits:

- `TAB_PROFILES` (profiles list + defaults)

The side panel refreshes its connection UI based on the new profile/default state.

### 4) “Connected” is verified by pinging the content script and probing page readiness

Separately, the UI sends `{ type: 'CHECK_CONNECTION' }`.

The background checks the **default profile tabIds**, pings each tab, and reads the content-script readiness probe:

- `chrome.tabs.sendMessage(tabId, { type: 'PING' })`
- The content script replies `{ type: 'PONG', readiness }`

If the ping fails because the content script is missing (common after extension reload), the background attempts to inject `captureUtils.js` + `contentScript.js` into the tab (when the URL is injectable) and retries once.

The background returns:

- `CONNECTION_STATUS`: `{ status: { [provider]: boolean }, profileStatus?: { [profileId]: boolean }, statusDetails?, profileStatusDetails? }`

The side panel only shows **ready/connected** once the provider tab responds to `PING` and the readiness probe confirms a usable composer. Login/auth-wall pages surface as `Login required`.

## The “New tab” flow (create an additional profile/agent)

In the Route Builder, **New tab** is for creating *additional* profiles (e.g., multiple ChatGPT agents debating).

The side panel:

1. sends `OPEN_PROVIDER_TAB` (open the provider URL),
2. then `CLAIM_TAB_AS_PROFILE` (claim into a new Tab Profile):
   - uses `setDefault: true` only when the provider has no default profile yet (so `Default` agents can run),
   - otherwise uses `setDefault: false` (so extra connections don’t steal/replace the default tab).
3. then assigns that profile to an agent in the route:
   - fills the most-recent unassigned agent for that provider,
   - otherwise replaces a broken pinned agent,
   - otherwise adds a new pinned agent.

Readiness is still determined by `PING`/`PONG` (same connection checks).

## The “Connect all” flow (why it used to fail)

**Connect all** triggers `CONNECT_PROVIDER` for each supported provider that is not ready, **or** whose default profile is blocked (In use / Wrong host / Offline).

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
- If the provider opens on a login/redirect host where the content script is *not* injectable, `PING` will fail and the UI will stay “Not connected” until the tab finishes login and navigates to a matched host.

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
