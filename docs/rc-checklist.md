# RC Checklist

## Preconditions

- Feature freeze is active.
- CI is green on the release candidate branch.
- Release artifact built from `npm run build:release`.

## Validation

- [ ] Lint + format checks pass.
- [ ] Unit + integration + e2e smoke pass.
- [ ] Release artifact verify script passes.
- [ ] Clean-profile Chrome unpacked install works.
- [ ] Side panel launch and route builder basic flows validated.
- [ ] Session pause/resume and attachment fallback behavior validated.

## Trusted tester rollout

- [ ] Upload ZIP to Chrome Web Store trusted tester channel.
- [ ] Collect and triage tester findings.
- [ ] Resolve blocker issues and rebuild RC if needed.

## Production go/no-go

- [ ] No open P0/P1 issues.
- [ ] Security review confirms no sensitive logging by default.
- [ ] Permission disclosures are accurate for store listing.
- [ ] Final artifact hash recorded in release notes.
