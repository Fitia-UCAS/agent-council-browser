# README Screenshots

This folder holds the screenshots used by the root `README.md`.

The intended capture set is:

- `01-sidepanel-ready-debate.png`
- `02-chatgpt-turn1.png`
- `03-gemini-turn1.png`
- `04-claude-turn1.png`
- `05-grok-turn1.png`
- `06-sidepanel-transcript-complete.png`
- `07-settings-security.png`

These are meant to come from a real extension run, not static mocks.

Choose prompts that make the product story obvious in one glance:

- one important question where cross-checking matters,
- visible agreement and disagreement across providers,
- and a final transcript that shows refinement rather than isolated one-shot answers.

Good prompt categories are serious decisions, research or analysis tasks, and everyday taste questions. Avoid copy or screenshots that imply medical diagnosis or guaranteed correctness.

## One-time setup

The capture flow uses a dedicated persistent Chromium profile at:

```text
.playwright-profiles/readme-capture/
```

Use it once to log into the providers:

```bash
npm run docs:screenshots:setup
```

That command:

- loads the unpacked extension in Chromium,
- opens the sidepanel,
- runs the real `Connect all` bootstrap flow,
- opens the provider tabs,
- and waits until ChatGPT, Gemini, Claude, and Grok all become ready.

## Capture

After the dedicated docs profile is logged into all four providers:

```bash
npm run docs:screenshots
```

That command captures:

- the sidepanel ready-to-run debate state,
- one real provider output screenshot per LLM for a 4-agent, 1-round debate,
- the final sidepanel transcript,
- and the settings drawer.

## Notes

- If capture fails with `Composer missing`, `Login required`, or `Wrong host`, rerun `npm run docs:screenshots:setup` and repair the provider tabs in the dedicated docs profile.
- The script supports `--headless`, `--headed`, `--profile-dir=...`, and `--prompt="..."` when run directly.
- If the UI changes, update `scripts/dev/capture-readme-screenshots.mjs` first, then regenerate.
