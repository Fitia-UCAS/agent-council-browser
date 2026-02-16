# Recommended Branch Protection (`main`)

## GitHub setup path

1. GitHub repository -> `Settings` -> `Branches`.
2. Add branch protection rule for `main`.
3. Enable `Require a pull request before merging`.
4. Enable `Require approvals` with minimum `1`.
5. Enable `Require review from Code Owners`.
6. Enable `Require status checks to pass before merging`.
7. Select required checks:
    - `CI / validate`
    - `PR Hygiene / hygiene`
    - Codex GitHub App review check (name depends on your app installation)
8. Enable `Dismiss stale approvals when new commits are pushed`.
9. Enable `Block force pushes`.
10. Enable `Do not allow bypassing the above settings`.

## Repository defaults

- Merge strategy: prefer `Squash` for clean history.
- No direct pushes to `main`.
- CODEOWNERS must point to maintainers you actually control.
