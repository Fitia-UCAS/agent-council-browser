# AGENTS_ROUTE_BUILDER.md — Route Builder (To / Providers UX)

This document is the “deep memory” for the **Route Builder** UI in the side panel: how users choose where to send a prompt (**Single / Parallel / Debate**), how provider order is represented, and how **connect-on-demand** works (including **Connect all**).

The goal is that future work (adding Claude/Grok/etc.) can extend routing without re-learning the current UX/state model.

---

## 1) What the Route Builder is

The Route Builder is the control behind the composer’s **`To`** pill. It replaces the old “Send to / iterations” controls with a single, scalable model:

- Users pick one or more providers (chips).
- Users can reorder providers (drag chips).
- Users choose a run mode (Parallel vs Debate) when applicable.
- The UI only asks the user to connect the providers that are needed for the selected route.

The Route Builder is a **popover dialog** inside the composer (`sidepanel.html`).

---

## 2) Route data model (persisted preference)

Routes are stored in the side panel and persisted in `chrome.storage.local`:

- Storage key: `mlc_last_route_v1`

Shape (see `sanitizeRoute(...)` in `sidepanel.js`):

```js
{
  kind: 'single' | 'parallel' | 'debate',
  providers: ['chatgpt' | 'gemini', ...], // order matters
  rounds: number // used only for debate (1..12)
}
```

Rules enforced by sanitization:

- Providers are normalized (`chatgpt`, `gemini`) and deduplicated.
- If `providers.length === 0` → route is invalid (Send disabled).
- If `providers.length === 1` → `kind` becomes `single`.
- If `providers.length >= 2` → `kind` becomes `parallel` unless it’s explicitly `debate` with exactly 2 providers.

Notes:

- “Chain” mode was removed (not supported by UI or sanitization).
- Provider order only matters for **Debate** (who goes first) and for future modes.

---

## 3) UI layout and user actions

Route Builder sections (top → bottom):

### Presets

- **Single**: sets route to one provider (keeps current first provider when possible).
- **Compare**: sets `kind='parallel'` with both providers.
- **Debate**: sets `kind='debate'` with both providers.

### Selected (chips)

- Displays selected providers as draggable chips.
- Dragging chips reorders the `route.providers[]` array.
- Clicking the `×` removes that provider from the route.

### Mode

Shown only when `providers.length >= 2`.

- **Parallel**: run both providers independently (compare).
- **Debate**: only available when exactly 2 providers are selected.
  - Enables **Rounds** and **Swap order** (reverses `route.providers[]`).

### Providers (connect + manage)

The provider list is always shown (supported providers).

At the top of this section:

- **Connect all**: large, full-width button that connects any provider that is not ready.
  - Label/disabled state:
    - `Connecting…` when any provider is currently connecting.
    - `All connected` when none need connection.
    - `Connect all` otherwise.

Each provider row shows:

- Provider name + a dot indicator (ready/connecting).
- A status string (best effort), e.g.:
  - `Not connected`, `Connecting…`, `Ready`, `Wrong host`, `Loading…`, `Waiting…`
  - plus a “Using/Last” profile label and optional model hint.

Provider row actions are **state-dependent**:

- If the provider is **not ready**: show only **Connect**.
  - `Connect` opens a provider tab, claims it as the default profile, and **auto-adds** that provider to the route.
- If the provider is **ready**: show:
  - **Add / Remove** (route membership)
  - **Focus** (focuses the bound default profile tab)
  - **New tab** (opens a new provider tab and rebinds the default profile to it; focuses it)

Focus highlighting:

- The most recently focused/connected provider row is highlighted (`state.lastFocusedProvider`).

Footer:

- **Manage providers** opens the Settings drawer (Tab Profiles manager).
- **Done** closes the popover.

---

## 4) What “connected/ready” means (important)

In the Route Builder, “connected” is intentionally stricter than “a tabId exists”.

A provider is considered **ready** only when:

- the default profile has a `tabId`, **and**
- the content script responds to `PING` (background → tab → `PONG`)

This is surfaced in UI as `state.connectionStatus[provider]` (from `CHECK_CONNECTION` / `CONNECTION_STATUS`).

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
- required providers for the route are **ready**.

If required providers are not ready:

- the UI triggers connect for each required provider and stops (does not start the run yet).

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

