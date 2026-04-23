# Chrome Web Store Submission Guide

Use this file as the canonical pre-submit checklist for Multi Agent Council. Keep it in sync with the release artifact, public policy pages, and the current permission model.

## 1) Release artifact

- Build from a clean tree with `npm run build:release`.
- Upload only `release/multi-agent-council-v<version>.zip`.
- Do not upload an unpacked dev build or files from repo root.

## 2) Public links

Before every submission, confirm these URLs are public and resolve without authentication:

- Homepage: `https://github.com/AmT42/agent-council-browser`
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

`Compare multiple AI models in Chrome to cross-check important questions across your ChatGPT, Claude, Gemini, and Grok tabs.`

### Long description

`Multi Agent Council is a Chrome side-panel extension for comparing and debating answers across ChatGPT, Claude, Gemini, and Grok directly in the browser tabs you already use. Inspired by the LLM Council idea, it works through vendor websites instead of APIs, so you keep the native provider experience, current web features, attachments, and model tooling without paying API costs or routing prompts through a relay backend.`

`This extension is built for questions where the answer matters. LLMs are often better at challenging, correcting, and refining answers than at getting everything right on the first pass. Running multiple models with different strengths, retrieval behavior, style biases, and blind spots gives you a clearer map of where answers agree, where they disagree, and what still needs verification.`

Feature highlights:

- `Compare`: run the same prompt across multiple AI models in parallel.
- `Debate`: let models challenge and improve each other's answers across rounds.
- `Tab Profiles`: use multiple tabs from the same provider for duplicate agents or independent contexts.
- `Attachments`: send files with provider-specific browser automation.
- `Local-first history`: keep chats on-device with optional passphrase protection.

Use cases:

- Cross-checking important decisions when one answer feels too narrow or too confident.
- Comparing conflicting explanations and drafting better follow-up questions before another appointment.
- Pressure-testing research, planning, and everyday choices such as finding the best date spot in Paris.

`Multi Agent Council helps you compare perspectives and prepare better questions. It does not replace licensed professional judgment, medical advice, or ordinary due diligence.`

### Suggested screenshots

- Side panel with a four-model route configured for an important question
- Compare run showing visible agreement and disagreement across providers
- Debate run showing one model refining its answer after another model responds
- Route builder with multiple profiles of the same provider
- Security settings showing local-first history and passphrase protection

## 4) Reviewer notes

Paste or adapt the following note in the Chrome Web Store reviewer field:

`Multi Agent Council opens a side panel and coordinates prompts across already-open provider websites (ChatGPT, Claude, Gemini, Grok). It does not use provider APIs or a project-operated relay backend.`

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
