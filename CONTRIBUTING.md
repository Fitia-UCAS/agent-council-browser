# Contributing

## Development setup

1. Clone the repository.
2. Run tests:

```bash
npm test
```

3. Load the extension in Chrome:
- Open `chrome://extensions`.
- Enable Developer mode.
- Click **Load unpacked** and select this repository root.

## Pull requests

1. Create a feature branch.
2. Keep changes scoped and include tests when behavior changes.
3. Ensure CI passes.
4. Request review before merging.

## Release expectations

- Use `npm run build:release` for production artifacts.
- Use `npm run build:variant` only for local/dev variant branding.
