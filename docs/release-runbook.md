# Release Runbook

## 1) Pre-release gate

Run all required checks locally:

```bash
npm run lint
npm run format:check
npm run test:unit
npm run test:integration
npm run test:e2e:smoke
npm run build:release
```

Verify no empty release files:

```bash
find .dist/release -type f -size 0
```

Expected output: no files.

## 2) Version and tag

1. Update extension version in `src/manifest/manifest.base.json` (and `package.json` if needed).
2. Rebuild release artifact:

```bash
npm run build:release
```

3. Create and push tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

This triggers `.github/workflows/release.yml`.

## 3) GitHub release

1. Open the release workflow run and download uploaded artifact.
2. Publish release notes including:
    - key changes
    - migration/reset notes
    - artifact SHA-256 hash

## 4) Chrome Web Store submission

1. Upload `release/minions-council-vX.Y.Z.zip`.
2. Review `docs/chrome-web-store-submission.md` and update any stale listing copy or reviewer notes.
3. Verify listing links point to public docs:
    - Privacy policy
    - Security policy
    - Support policy
4. Confirm `debugger` permission justification for Claude send path.
5. Roll out to trusted testers first, then public.

## 5) Post-release

1. Monitor issues for provider DOM drift reports.
2. Patch blockers on a PR branch (no direct push to `main`).
3. Use Codex + CI + approval gates before merge.
