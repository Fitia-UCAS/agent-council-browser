# Provider DOM Drift Playbook

When a provider UI update breaks automation/capture:

1. Reproduce quickly on a clean profile and capture exact failing flow.
2. Identify if breakage is in input discovery, send action, attachment injection, or response capture.
3. Inspect selectors on affected provider tab and collect before/after evidence.
4. Update provider-specific selectors/heuristics only (avoid cross-provider regressions).
5. Run:
    - `npm run test:integration`
    - `npm run test:e2e:smoke`
6. Document change scope in PR with provider label and rollback notes.

Guideline: prefer narrow provider-specific fixes over broad global selector changes.
