# Contributing

## Development setup

1. Clone the repository.
2. Install dependencies:

```bash
npm ci
```

3. Build runtime files from `src/`:

```bash
npm run build:src
```

4. Run checks:

```bash
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e:smoke
```

5. Load the extension in Chrome:

- Open `chrome://extensions`.
- Enable Developer mode.
- Click **Load unpacked** and select this repository root.

## Pull requests

1. Create a feature branch.
2. Keep changes scoped and include tests when behavior changes.
3. Ensure CI passes (lint, format, unit, integration, e2e smoke, release artifact policy checks).
4. Request review before merging.

## Release expectations

- `src/` is source-of-truth; root runtime files are generated.
- Use `npm run build:release` for production artifacts.
- Use `npm run build:variant` only for local/dev variant branding.
- Release artifacts are allowlist-verified via `scripts/release/release-allowlist.txt`.
