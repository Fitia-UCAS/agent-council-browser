# Codex PR Pipeline Setup

## Objective

Enforce a predictable merge gate for first-time maintenance:

- CI checks pass
- Codex review check passes
- At least one human approval

## Setup steps

1. Install/authorize Codex GitHub App on this repository.
2. Open a small test PR and confirm a Codex status check appears.
3. Go to `Settings -> Branches -> Branch protection rules -> main`.
4. Require status checks and add:
    - `CI / validate`
    - `PR Hygiene / hygiene`
    - Codex review check shown by the app
5. Require 1 approval and CODEOWNERS review.
6. Disable direct pushes to `main`.

## Daily operating model

1. Create a branch per change.
2. Open PR with the template completed.
3. Wait for CI + Codex + reviewer approval.
4. Merge with Squash.
5. Delete merged branch.

## If Codex check is missing

- Confirm app installation scope includes this repository.
- Re-open/synchronize PR to retrigger checks.
- Verify the required check name in branch protection exactly matches the status check emitted by Codex.
