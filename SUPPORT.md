# Support and Maintenance

## Getting help

1. Read `README.md` troubleshooting.
2. Search existing issues.
3. Open a new issue with reproduction steps, logs, and screenshots (redacted).

Browser note:
On Chrome, clicking the extension icon should open the side panel. On Arc, the extension tries the side panel first and falls back to an extension tab if the panel does not open reliably.

## Security issues

Do not open public issues for vulnerabilities. Use private reporting in `SECURITY.md`.

## Maintenance policy

- Supported: latest `main` and latest tagged release.
- Best-effort support for provider DOM drift fixes.
- Breaking provider UI changes may require quick patch releases.

## Pull requests

- Keep scope focused.
- Include test evidence and risk notes.
- Expect CI + review before merge.

## Release channels

- Trusted testers first when risk is high.
- Public release after blockers are closed and release checklist passes.
