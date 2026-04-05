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

- `release/minions-council-v<version>.zip`

## 3) CI gate expectations

Required checks for `main`:

- lint
- format check
- unit tests
- integration tests
- e2e smoke
- release build
- artifact policy verification
- PR hygiene check
- Codex PR review check

## 4) Schema v3 reset-on-upgrade

v3 architecture intentionally uses reset-on-upgrade for legacy local state.

- Side panel requests schema status on startup.
- If legacy local schema is detected, user must run one-time reset.
- Reset clears legacy local storage keys and old `mlc_history_v1` IndexedDB data.

## 5) Public policy pages (GitHub Pages)

Serve docs from `/docs` so store/repo links are stable.

1. GitHub -> `Settings` -> `Pages`
2. Build and deployment -> `Deploy from a branch`
3. Branch: `main`, Folder: `/docs`
4. Publish `docs/privacy-policy.md`, `docs/security-policy.md`, `docs/support-policy.md`, and `docs/index.md`.
5. Reuse the generated Pages URLs for those three policy pages in the Chrome Web Store listing.

## 6) PR pipeline setup

1. Install/authorize Codex GitHub App for this repository.
2. Configure branch protection as documented in `docs/branch-protection.md`.
3. Require CI + PR Hygiene + Codex review checks before merge.

## 7) Chrome Web Store checklist

- Publish from `release/*.zip` only.
- Keep `docs/chrome-web-store-submission.md` current before every release candidate.
- Keep privacy and permission justification current (especially `debugger` for Claude flow).
- Validate on a clean Chrome profile before submission.
- Roll out to trusted testers first, then public release.
