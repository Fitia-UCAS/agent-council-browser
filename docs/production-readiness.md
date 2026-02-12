# Production Readiness Guide (JS-first v3)

This repository ships a Chrome MV3 extension with a side panel UI.

## 1) Build from source-of-truth

Runtime source lives in `src/`.

```bash
npm ci
npm run build:src
```

This generates root runtime outputs (`background.js`, `contentScript.js`, `sidepanel.js`, `manifest.json`, etc.).

## 2) Release artifact (allowlist-verified)

```bash
npm run build:release
```

This pipeline:

1. builds from `src/` in release mode,
2. packages only `scripts/release/release-allowlist.txt` entries,
3. verifies no extra files are included.

Output:

- `release/multi-llm-coder-v<version>.zip`

## 3) CI gate expectations

Required checks for `main`:

- lint
- format check
- unit tests
- integration tests
- e2e smoke
- release build
- artifact policy verification
- Codex PR review check

## 4) Schema v3 reset-on-upgrade

v3 architecture intentionally uses reset-on-upgrade for legacy local state.

- Side panel requests schema status on startup.
- If legacy local schema is detected, user must run one-time reset.
- Reset clears legacy local storage keys and old `mlc_history_v1` IndexedDB data.

## 5) Chrome Web Store checklist

- Publish from `release/*.zip` only.
- Keep privacy and permission justification current (especially `debugger` for Claude flow).
- Validate on a clean Chrome profile before submission.
- Roll out to trusted testers first, then public release.
