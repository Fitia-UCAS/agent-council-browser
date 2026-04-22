const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createTempUserDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-extension-test-'));
}

async function launchExtensionContext(repoRoot) {
    const extensionPath = repoRoot;
    const userDataDir = createTempUserDataDir();
    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });

    let serviceWorker = context.serviceWorkers()[0] || null;
    if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker');
    }

    const extensionId = new URL(serviceWorker.url()).host;
    return { context, extensionId, userDataDir };
}

async function closeExtensionContext({ context, userDataDir }) {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
}

test.describe('extension runtime', () => {
    test('loads the MV3 service worker and side panel UI', async () => {
        test.setTimeout(60_000);
        const repoRoot = path.resolve(__dirname, '..', '..');
        const runtime = await launchExtensionContext(repoRoot);

        try {
            const { context, extensionId } = runtime;
            const page = await context.newPage();
            await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

            expect(await page.title()).toBe('Multi Agent Council');
            expect(await page.locator('#route-pill-text').textContent()).toBe('Select agents…');
            expect(await page.locator('#empty-state').textContent()).toContain(
                'Choose where to send your message'
            );
            expect(await page.locator('#route-selected .route-agent').count()).toBe(0);
            if ((await page.locator('#route-popover').getAttribute('aria-hidden')) !== 'false') {
                await page.locator('#route-button').click();
            }
            expect(await page.locator('#route-popover').getAttribute('aria-hidden')).toBe('false');

            await page.locator('#route-connect-all').click();
            await page.waitForFunction(
                () => document.querySelectorAll('#route-selected .route-agent').length === 4
            );
            expect(await page.locator('#route-selected .route-agent').count()).toBe(4);
            expect(await page.locator('#route-mode-section').evaluate((el) => el.hidden)).toBe(
                false
            );
            expect(await page.locator('#route-debate-settings').evaluate((el) => el.hidden)).toBe(
                false
            );
            expect(await page.locator('#route-rounds').inputValue()).toBe('3');

            await page.locator('#route-done').click();
            expect(await page.locator('#route-popover').evaluate((el) => el.hidden)).toBe(true);

            await page.locator('#settings-button').click();
            expect(await page.locator('#settings-drawer').getAttribute('aria-hidden')).toBe(
                'false'
            );
            expect(await page.locator('#history-quick-lock-new').isVisible()).toBe(true);

            await page.locator('#close-settings').click();
            expect(await page.locator('#settings-drawer').getAttribute('aria-hidden')).toBe('true');
        } finally {
            await closeExtensionContext(runtime);
        }
    });
});
