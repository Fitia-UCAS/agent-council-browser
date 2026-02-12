# Architecture (JS-first v3)

## Source of truth

- Runtime source lives under `src/`.
- Generated extension runtime files are written to repo root by `npm run build:src`.

## Major components

- `src/background/`: session engine, profile orchestration, runtime message handling.
- `src/content/`: capture and provider interaction logic.
- `src/sidepanel/`: UI state, rendering, route builder, security UX.
- `src/shared/`: protocol and shared runtime helpers.

## Runtime module loading

- Background worker loads domain modules from `runtime/background/*` (router, provider registry/adapters, profile store, session engine/state store, history bridge).
- Sidepanel loads UI modules from `runtime/sidepanel/*` (store, route builder, transcript sanitizer/view helpers).
- Content scripts load provider capture modules from `runtime/content/*` before `contentScript.js`.
- Runtime bundles in repo root are generated artifacts; edit files under `src/`.

## Runtime protocol

- Protocol envelope is v3 (`protocolVersion: 3` + `command`).
- Background accepts command and legacy `type` forms, normalizes inbound payloads, and rejects unsupported protocol versions.

## Storage policy

- Schema v3 uses reset-on-upgrade.
- Legacy local keys/databases are cleared after explicit user confirmation.
- Session persistence in local storage is redacted metadata-only when history-backed chats are used.

## Build and release

- Build: `npm run build:src`
- Release artifact: `npm run build:release`
- Artifact policy is allowlist-based via `scripts/release/release-allowlist.txt`.
