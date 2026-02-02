# Changelog

All notable user-facing and maintainer-facing changes to Multi‑LLM Coder are documented here.

Developer/maintenance source of truth: `AGENTS.md` + `AGENTSMD/`.

## [Unreleased] - 2026-02-01

### Added

- Multi-agent routing: runs now target **agents** (provider + tab profile) instead of “one per provider”, enabling **multiple instances of the same provider** (e.g., 3 ChatGPT tabs in a Debate).
- Route schema v2 (`START_RUN.route.agents[]`): each agent chooses a `provider` and a `profileId` (`'default'` or an explicit profile id).
- Connection checks for explicit profiles: `CHECK_CONNECTION` / `CONNECTION_STATUS` can report per-profile readiness via `profileStatus[profileId]`.
- Rich-response rendering: captured `contentHtml` can be shown in the transcript via a **sanitized allowlist** (fallback remains plain text).

### Changed

- Debate logic: from “two-provider ping-pong” to **round-robin across 2+ agents** (`participants[(turnIndex - 1) % participants.length]`).
- Route Builder UX:
  - Providers can be added multiple times as separate agents (requires unique profiles).
  - **New tab** now opens a fresh provider tab, claims it as a **new Tab Profile**, and auto-assigns it to an agent (fill an unassigned agent first, otherwise add a new agent).
  - Connect flows remain “default profile” oriented; use **New tab** for additional same-provider agents.
- Attachment delivery tracking: from “per provider per session” to **per agent per session** (so multiple same-provider agents each receive attachments once).
- Encrypted history payloads now include `agentId` / `agentLabel` for assistant messages so same-provider debates remain readable when browsing past chats.

### Fixed

- “Connected but still asks to connect” edge cases when the content script is missing after extension reload:
  - connection checks now attempt to inject `captureUtils.js` + `contentScript.js` on demand and retry `PING` once.
- Reduced “Offline profile clutter” from repeated Connect:
  - Connect prefers rebinding an existing default profile where possible (instead of creating a new profile every time).

### Docs

- Updated `README.md` and `AGENTS.md`/`AGENTSMD/` to reflect multi-agent (multi-profile) routing, New tab auto-claim+assign, per-agent attachment delivery, and sanitized rich HTML rendering.
