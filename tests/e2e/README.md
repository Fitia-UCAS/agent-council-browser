# E2E Extension Tests

These tests load the unpacked extension in Playwright's bundled Chromium using a persistent context.

Why this setup:

- MV3 extensions need a real browser context with the extension loaded.
- The tests target the extension runtime itself, not a normal web page.
- The side panel is opened as `chrome-extension://<id>/sidepanel.html`, which is stable for automation.

Typical command:

```bash
npm run test:e2e:extension
```
