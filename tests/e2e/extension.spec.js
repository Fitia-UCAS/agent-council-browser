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
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
        ],
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
        const repoRoot = path.resolve(__dirname, '..', '..');
        const runtime = await launchExtensionContext(repoRoot);

        try {
            const { context, extensionId } = runtime;
            const page = await context.newPage();
            await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

            await expect(page).toHaveTitle('Minions Council');
            await expect(page.locator('#route-pill-text')).toHaveText('Select agents…');
            await expect(page.locator('#empty-state')).toContainText('Choose where to send your message');

            await page.locator('#empty-open-route').click();
            await expect(page.locator('#route-popover')).toBeVisible();
            await expect(page.locator('#route-popover')).toHaveAttribute('aria-hidden', 'false');

            await page.locator('#route-preset-single').click();
            await expect(page.locator('#route-pill-text')).not.toHaveText('Select agents…');
            await expect(page.locator('#route-selected .route-agent')).toHaveCount(1);

            await page.locator('#route-preset-compare').click();
            await expect(page.locator('#route-selected .route-agent')).toHaveCount(4);
            await expect(page.locator('#route-mode-section')).not.toBeHidden();

            await page.locator('#route-preset-debate').click();
            await expect(page.locator('#route-selected .route-agent')).toHaveCount(2);
            await expect(page.locator('#route-debate-settings')).not.toBeHidden();
            await expect(page.locator('#route-rounds')).toHaveValue('3');

            await page.locator('#route-done').click();
            await expect(page.locator('#route-popover')).toBeHidden();

            await page.locator('#settings-button').click();
            await expect(page.locator('#settings-drawer')).toHaveAttribute('aria-hidden', 'false');
            await expect(page.locator('label[for="history-quick-lock-new"], .passphrase-quick-toggle')).toContainText(
                'Require passphrase for new chats'
            );

            await page.locator('#close-settings').click();
            await expect(page.locator('#settings-drawer')).toHaveAttribute('aria-hidden', 'true');
        } finally {
            await closeExtensionContext(runtime);
        }
    });
});
