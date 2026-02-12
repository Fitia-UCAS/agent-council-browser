# Recommended Branch Protection (`main`)

- Require pull request before merge.
- Require at least 1 approval.
- Require all checks to pass:
    - CI / validate
    - Codex GitHub App review check
- Dismiss stale approvals when new commits are pushed.
- Block direct pushes to `main`.
