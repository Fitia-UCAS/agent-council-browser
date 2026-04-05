# Chrome Web Store Submission Guide

Use this file as the canonical pre-submit checklist for Minions Council. Keep it in sync with the release artifact, public policy pages, and the current permission model.

## 1) Release artifact

- Build from a clean tree with `npm run build:release`.
- Upload only `release/minions-council-v<version>.zip`.
- Do not upload an unpacked dev build or files from repo root.

## 2) Public links

Before every submission, confirm these URLs are public and resolve without authentication:

- Homepage: `https://github.com/AmT42/multi-llm-ext`
- Privacy policy: GitHub Pages URL generated from `docs/privacy-policy.md`
- Security policy: GitHub Pages URL generated from `docs/security-policy.md`
- Support page: GitHub Pages URL generated from `docs/support-policy.md`

If GitHub Pages is not enabled yet, use the public GitHub repo pages for `PRIVACY.md`, `SECURITY.md`, and `SUPPORT.md` as a fallback. If Pages is enabled, prefer the Pages URLs in the Chrome Web Store listing because they are cleaner and more stable for reviewers.

## 2a) Store assets inventory

Already versioned in the repo:

- Store icon: `docs/assets/store-icon-128.png`
- Small promo tile: `docs/assets/store-small-promo-440x280.png`

Still required before submission:

- At least one Chrome Web Store screenshot captured from the current release build
- Preferably 4-5 screenshots covering the key flows listed below
- Capture plan and suggested filenames: `docs/assets/store-screenshots/README.md`

## 3) Store listing copy

### Short description

`Run an LLM council in Chrome: compare ChatGPT, Claude, Gemini, and Grok directly in your provider tabs.`

### Long description

`Minions Council is a side-panel Chrome extension for running prompts across multiple LLM provider websites without an API relay. Build a route of agents, compare answers side by side, or run debate rounds across ChatGPT, Claude, Gemini, and Grok using the browser tabs you already use.`

`The extension is local-first: chat history stays on-device, optional passphrase protection is available for saved chats, and provider interactions happen through the provider websites in your own browser session.`

### Suggested screenshots

- Side panel with a multi-agent route configured
- Compare run showing two providers answering the same prompt
- Debate run showing round-by-round transcript
- Route builder with multiple profiles of the same provider
- Security settings showing passphrase protection

## 4) Reviewer notes

Paste or adapt the following note in the Chrome Web Store reviewer field:

`Minions Council opens a side panel and coordinates prompts across already-open provider websites (ChatGPT, Claude, Gemini, Grok). It does not use provider APIs or a project-operated relay backend.`

`The debugger permission is used only for Claude prompt sending because Claude's web UI can disable normal DOM automation while attachments and hydrated composer state are settling. The extension uses Chrome DevTools Protocol on claude.ai to type and confirm prompt submission more reliably.`

`Host permissions are limited to the supported provider domains so the content script can read model output, confirm readiness, and deliver prompts or attachment actions inside those tabs.`

## 5) Manual smoke test before submit

Run this on a clean Chrome profile using the release zip or unpacked release build:

1. Install the extension and confirm the permission prompt matches the documented permissions.
2. Connect ChatGPT, Claude, Gemini, and Grok.
3. Run one `Single`, one `Compare`, and one `Debate` route.
4. Verify attachment behavior:
    - ChatGPT auto-upload path
    - Claude auto-upload path
    - Gemini manual-upload warning path
    - Grok best-effort upload fallback
5. Pause a session, reload the extension, and verify resume still works with existing provider tabs.
6. Validate one long answer with citations on ChatGPT and one long answer on Claude.
7. Confirm privacy, security, and support links from the listing open the expected public pages.

## 6) Submission blockers

Do not submit if any of the following are true:

- The uploaded zip was not built from `npm run build:release`
- Public policy URLs are broken, private, or point to the wrong repo
- Reviewer notes are stale relative to the current permissions
- Clean-profile smoke tests fail for any supported provider
- The release artifact contains local junk files or non-allowlisted content
