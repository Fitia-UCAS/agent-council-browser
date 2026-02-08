# AGENTS_ROUTE_BUILDER.md — Route Builder (To / Agents UX)

This document is the “deep memory” for the **Route Builder** UI in the side panel: how users choose where to send a prompt (**Single / Parallel / Debate**), how agent order is represented, and how **connect-on-demand** works (including **Connect all**).

The goal is that future work (adding Claude/Grok/etc.) can extend routing without re-learning the current UX/state model.

---

## 1) What the Route Builder is

The Route Builder is the control behind the composer’s **`To`** pill. It replaces the old “Send to / iterations” controls with a single, scalable model:

- Users build a route of one or more **agents** (rows). An agent is a provider + a tab profile binding (`Default` or a pinned profile).
- Multiple agents can use the **same provider** (e.g., multiple ChatGPT tabs debating), but each agent must resolve to a **different profile/tab**.
- Users can reorder agents (drag handles).
- Users choose a run mode (Parallel vs Debate) when applicable.
- The UI only asks the user to connect what’s needed for the selected route (default profile connection, plus explicit-profile checks when applicable).

The Route Builder is a **popover dialog** inside the composer (`sidepanel.html`).

---

## 2) Route data model (persisted preference)

Routes are stored in the side panel and persisted in `chrome.storage.local`:

- Storage key: `mlc_last_route_v2` (migrated from `mlc_last_route_v1`)

Shape (see `sanitizeRoute(...)` in `sidepanel.js`):

```js
{
  kind: 'single' | 'parallel' | 'debate',
  agents: [
    {
      id: string,
      provider: 'chatgpt' | 'gemini' | 'claude' | 'grok',
      profileId: 'default' | 'profile_...' | null
    }
  ], // order matters
  rounds: number // used only for debate (1..12)
}
```

Rules enforced by sanitization:

- Agents are normalized (`provider` id, generated `id` when missing).
- If `agents.length === 0` → route is invalid (Send disabled).
- If `agents.length === 1` → `kind` becomes `single`.
- If `agents.length >= 2` → `kind` becomes `parallel` unless explicitly set to `debate`.

Notes:

- `profileId: 'default'` resolves to the provider’s current default profile id at run start.
- `profileId: 'profile_...'` pins the agent to a specific Tab Profile.
- `profileId: null` means **unassigned** (route is invalid until the user assigns a tab).
- The UI highlights duplicate/invalid profile bindings; background enforces **unique resolved profile ids** per run (required to support same-provider agents).

---

## 3) UI layout and user actions

Route Builder sections (top → bottom):

### Presets

- **Single**: sets route to one default agent.
- **Compare**: sets `kind='parallel'` with default agents for common providers.
- **Debate**: sets `kind='debate'` with default agents for common providers.

### Agents (rows)

- Displays selected agents as draggable rows (drag handle).
- Dragging rows reorders the `route.agents[]` array.
- Agent rows are **order-first**: provider label (with index when duplicated, e.g. “ChatGPT 1”, “ChatGPT 2”), status, plus remove.
- Agent rows expose per-agent actions:
  - **Focus**: focuses the exact tab bound to this agent.
  - **Reconnect / Connect tab**: repairs this specific agent by opening a fresh tab and rebinding this row.
- Provider-level tab creation still happens in the **Providers** section below (Connect / New tab).
- Clicking `×` removes that agent from the route.

### Mode

Shown only when `agents.length >= 2`.

- **Parallel**: run both providers independently (compare).
- **Debate**: round-robin across 2+ agents.
  - Enables **Rounds** and **Swap order** (reverses `route.agents[]`).

### Providers (connect + manage)

The provider list is always shown (supported providers).

At the top of this section:

- **Connect all**: large, full-width button that connects any provider that is not ready.
  - Label/disabled state:
    - `Connecting…` when any provider is currently connecting.
    - `All connected` when none need connection **and** no default is blocked by another session.
    - `Connect all` otherwise.

Each provider row shows:

- Provider name + a dot indicator (ready/connecting).
- A status string (best effort), e.g.:
  - `Not connected`, `Connecting…`, `Ready`, `Wrong host`, `Loading…`, `Waiting…`
  - `In use` when the default tab is locked by another session
  - plus a “Using/Last” profile label and optional model hint.

Provider row actions are **state-dependent**:

- If the provider is **not ready**: show:
  - **Connect**: opens a provider tab and binds it as the **default profile** (always creates a new default connection; does not rebind an existing default tab).
  - **New tab**: opens a fresh provider tab, claims it into a **new Tab Profile**, and assigns it to an agent:
    - if the provider has no default profile yet, the new profile also becomes the provider **default** (so `Default` agents can run).
    - fills the most-recent unassigned agent for that provider if one exists,
    - otherwise replaces a broken pinned agent,
    - otherwise adds a new pinned agent.
    - does **not** require an extra Connect click afterwards.
- If the provider is **ready**: show:
  - **Focus**: focuses the bound default profile tab.
  - **New tab**: opens a fresh provider tab, claims it into a **new Tab Profile**, and assigns it to an agent (same behavior as above).
    - This does not change the provider’s default profile (unless no default exists yet); it creates a new profile and assigns it to a route agent.

Important: provider rows no longer have **Add agent**.  
New agent slots are created only by **New tab** so each added agent immediately gets its own tab/profile.

Focus highlighting:

- The most recently focused/connected provider row is highlighted (`state.lastFocusedProvider`).

Footer:

- **Settings** opens the Settings drawer.
- **Done** closes the popover.

---

## 4) What “connected/ready” means (important)

In the Route Builder, “connected” is intentionally stricter than “a tabId exists”.

A provider is considered **ready** only when:

- the default profile has a `tabId`, **and**
- the content script responds to `PING` (background → tab → `PONG`)

If the tab exists but the content script isn’t injected (common after extension reload), the background attempts to inject `captureUtils.js` + `contentScript.js` and retries the ping once.

This is surfaced in UI as `state.connectionStatus[provider]` (from `CHECK_CONNECTION` / `CONNECTION_STATUS`).

When an agent targets an explicit (non-default) profile, readiness is tracked per profile id via:

- `CHECK_CONNECTION { profileIds }`
- `state.profileConnectionStatus[profileId]`

Why:

- A tab can exist but be on a login/redirect page (no content script).
- A tab can exist but the content script isn’t responsive (navigation or host mismatch).
- We only want to show “ready” when injection/capture should work.

---

## 5) Session start: how the route maps to background behavior

When the user clicks **Send**, `sidepanel.js` validates:

- history unlocked (if encryption configured),
- non-empty prompt,
- route is valid and supported,
- required agents for the route are **ready** (default providers + explicit profiles).

If required providers are not ready:

- for agents using `Default`, the UI triggers connect for each required provider and stops (does not start the run yet).
- for agents using explicit profiles, the UI blocks send with an actionable “fix route” message (the extension cannot auto-create extra profiles automatically).

If ready:

- the side panel sends `START_RUN` to `background.js` with:
  - `prompt`, `chatId`, `rounds`, and `route`
  - `mode`:
    - `debate` when `route.kind === 'debate'`
    - `direct` when `route.kind !== 'debate'`
  - `target`:
    - `both` when `route.kind === 'parallel'`
    - `chatgpt|gemini` when `route.kind === 'single'`

Background notes:

- Background derives a session mode of `'parallel'` when `route.kind === 'parallel'` and runs the providers concurrently.
- Parallel mode currently sends the **raw user prompt** to each provider (no wrapper/history injection) to keep comparisons fair.

---

## 6) Extending to more providers (intent)

The Route Builder is designed to scale beyond 2 providers:

- The provider list is populated from `state.providerCapabilities` when available (fallback to `['chatgpt','gemini']`).
- Routes store an ordered provider list, so future “chain”/multi-step workflows can be implemented without reinventing UI.

When adding new providers:

- Ensure `normalizeProviderId(...)` and route sanitization accept the new provider id.
- Add provider to capabilities and profile/connection logic so `connectionStatus[provider]` can be computed.
- Ensure the provider row can reflect readiness and expose `Connect/Focus/New tab`.
