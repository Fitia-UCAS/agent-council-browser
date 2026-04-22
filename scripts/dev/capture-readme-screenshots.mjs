import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

const REPO_ROOT = process.cwd();
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'assets', 'store-screenshots');
const DEFAULT_PROFILE_DIR = path.join(REPO_ROOT, '.playwright-profiles', 'readme-capture');
const VIEWPORT = { width: 1440, height: 1200 };
const PROVIDERS = ['chatgpt', 'gemini', 'claude', 'grok'];
const DEFAULT_PROMPT =
    'Explain in 4 short bullets when Multi Agent Council is better than using a single LLM tab. Keep it under 90 words.';

const PROVIDER_HOST_MATCHERS = {
    chatgpt: ['chatgpt.com', 'chat.openai.com'],
    gemini: ['gemini.google.com'],
    claude: ['claude.ai'],
    grok: ['grok.com'],
};

function printUsage() {
    console.log(`Usage:
  npm run docs:screenshots:setup
  npm run docs:screenshots

Direct options:
  node scripts/dev/capture-readme-screenshots.mjs <setup|capture> [--headless] [--headed] [--profile-dir=/abs/path] [--prompt="..."]

Defaults:
  mode: capture
  browser mode: headed
  profile dir: ${DEFAULT_PROFILE_DIR}`);
}

function parseArgs(argv) {
    const args = argv.slice(2);
    let mode = 'capture';
    let headless = false;
    let profileDir = DEFAULT_PROFILE_DIR;
    let prompt = DEFAULT_PROMPT;

    for (const arg of args) {
        if (arg === 'setup' || arg === 'capture') {
            mode = arg;
            continue;
        }
        if (arg === '--headless') {
            headless = true;
            continue;
        }
        if (arg === '--headed') {
            headless = false;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (arg.startsWith('--profile-dir=')) {
            const value = arg.slice('--profile-dir='.length).trim();
            if (value) profileDir = path.resolve(REPO_ROOT, value);
            continue;
        }
        if (arg.startsWith('--prompt=')) {
            const value = arg.slice('--prompt='.length).trim();
            if (value) prompt = value;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return { mode, headless, profileDir, prompt };
}

function ensureBuiltArtifacts() {
    const required = [
        'manifest.json',
        'background.js',
        'contentScript.js',
        'sidepanel.html',
        'sidepanel.js',
    ];
    const missing = required.filter((relPath) => !fs.existsSync(path.join(REPO_ROOT, relPath)));
    if (missing.length > 0) {
        throw new Error(
            `Missing built extension files: ${missing.join(', ')}. Run "npm run build:src" first.`
        );
    }
}

function createOutputDir() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function logSection(title) {
    console.log(`\n[README screenshots] ${title}`);
}

async function launchExtensionContext({ profileDir, headless }) {
    fs.mkdirSync(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chromium',
        headless,
        viewport: VIEWPORT,
        args: [`--disable-extensions-except=${REPO_ROOT}`, `--load-extension=${REPO_ROOT}`],
    });

    let serviceWorker = context.serviceWorkers()[0] || null;
    if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', { timeout: 120_000 });
    }

    const extensionId = new URL(serviceWorker.url()).host;
    return { context, extensionId, profileDir };
}

async function openSidePanelPage(runtime) {
    const { context, extensionId } = runtime;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
        waitUntil: 'load',
        timeout: 120_000,
    });
    await page.waitForTimeout(750);
    return page;
}

async function createFreshChat(page) {
    const newChatButton = page.locator('#new-chat-button');
    if (await newChatButton.count()) {
        await newChatButton.click();
        await page.waitForTimeout(500);
    }
}

async function ensureRoutePopoverVisible(page) {
    const isHidden = await page.locator('#route-popover').evaluate((node) => node.hidden);
    if (isHidden) {
        await page.locator('#route-button').click();
        await page.waitForTimeout(250);
    }
}

async function getProviderStatuses(page) {
    return await page.evaluate(() => {
        const items = Array.from(
            document.querySelectorAll('#route-provider-list .route-provider-item[data-provider]')
        );
        return items.map((item) => {
            const provider = item.getAttribute('data-provider') || '';
            const statusText =
                item.querySelector('.route-provider-status')?.textContent?.trim() || '';
            const readyDot = Boolean(
                item.querySelector('.route-provider-dot')?.classList.contains('is-ready')
            );
            return { provider, statusText, readyDot };
        });
    });
}

function formatStatuses(statuses) {
    return statuses
        .map((entry) => `${entry.provider}: ${entry.statusText || '(no status)'}`)
        .join(' | ');
}

function areProvidersReady(statuses, providers = PROVIDERS) {
    const byProvider = new Map(statuses.map((entry) => [entry.provider, entry]));
    return providers.every((provider) => byProvider.get(provider)?.readyDot);
}

async function waitForProvidersReady(page, { timeoutMs = 1_800_000, pollMs = 2_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastLogAt = 0;

    while (Date.now() < deadline) {
        await ensureRoutePopoverVisible(page);
        const statuses = await getProviderStatuses(page);
        if (areProvidersReady(statuses)) return statuses;

        if (Date.now() - lastLogAt >= 5_000) {
            console.log(`Waiting for providers: ${formatStatuses(statuses)}`);
            lastLogAt = Date.now();
        }

        await page.waitForTimeout(pollMs);
    }

    const statuses = await getProviderStatuses(page);
    throw new Error(
        `Timed out waiting for all providers to be ready.\nCurrent status: ${formatStatuses(statuses)}\nRun "npm run docs:screenshots:setup" and complete provider logins in the dedicated docs profile.`
    );
}

async function bootstrapProviders(page) {
    await createFreshChat(page);
    await ensureRoutePopoverVisible(page);
    await page.locator('#route-connect-all').click();
    await page.waitForTimeout(750);
    await page.waitForFunction(
        () => document.querySelectorAll('#route-selected .route-agent').length === 4,
        null,
        { timeout: 60_000 }
    );
}

async function installRuntimeEventTap(page) {
    await page.evaluate(() => {
        window.__mlcDocEvents = [];
        if (window.__mlcDocEventTapInstalled) return;
        const pushEvent = (message) => {
            if (!message || typeof message.type !== 'string') return;
            if (!message.type.startsWith('UI_')) return;
            const entry = {
                type: message.type,
                role: typeof message.role === 'string' ? message.role : null,
                sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
                agentId: typeof message.agentId === 'string' ? message.agentId : null,
                agentLabel: typeof message.agentLabel === 'string' ? message.agentLabel : null,
                reason: typeof message.reason === 'string' ? message.reason : null,
                error: typeof message.error === 'string' ? message.error : null,
                turnIndex: Number.isFinite(message.turnIndex) ? message.turnIndex : null,
                roundIndex: Number.isFinite(message.roundIndex) ? message.roundIndex : null,
                timestamp: Date.now(),
            };
            window.__mlcDocEvents.push(entry);
            if (window.__mlcDocEvents.length > 500) {
                window.__mlcDocEvents.splice(0, window.__mlcDocEvents.length - 500);
            }
        };
        chrome.runtime.onMessage.addListener((message) => {
            try {
                pushEvent(message);
            } catch (error) {}
        });
        window.__mlcDocEventTapInstalled = true;
    });
}

async function resetRuntimeEventTap(page) {
    await page.evaluate(() => {
        window.__mlcDocEvents = [];
    });
}

async function readRuntimeEvents(page) {
    return await page.evaluate(() => window.__mlcDocEvents || []);
}

function getFailureEvent(events) {
    return events.find(
        (event) => event.type === 'UI_SESSION_ERROR' || event.type === 'UI_SESSION_PAUSED'
    );
}

async function waitForEvent(
    page,
    predicate,
    description,
    { timeoutMs = 300_000, pollMs = 500 } = {}
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const events = await readRuntimeEvents(page);
        const failure = getFailureEvent(events);
        if (failure) {
            throw new Error(
                `Run failed while waiting for ${description}: ${failure.reason || failure.error || failure.type}`
            );
        }
        const match = events.find(predicate);
        if (match) return match;
        await page.waitForTimeout(pollMs);
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

function readCount(events, provider) {
    return events.filter((event) => event.type === 'UI_MESSAGE_ADD' && event.role === provider)
        .length;
}

async function waitForProviderMessageCount(page, provider, count, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const events = await readRuntimeEvents(page);
        const failure = getFailureEvent(events);
        if (failure) {
            throw new Error(
                `Run failed while waiting for ${provider} output: ${failure.reason || failure.error || failure.type}`
            );
        }
        if (readCount(events, provider) >= count) {
            return events.filter(
                (event) => event.type === 'UI_MESSAGE_ADD' && event.role === provider
            )[count - 1];
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`Timed out waiting for ${provider} output ${count}.`);
}

function pageMatchesProvider(page, provider) {
    try {
        const hostname = new URL(page.url()).hostname.toLowerCase();
        return (PROVIDER_HOST_MATCHERS[provider] || []).some(
            (host) => hostname === host || hostname.endsWith(`.${host}`)
        );
    } catch (error) {
        return false;
    }
}

async function waitForProviderPage(context, provider, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const page = context.pages().find((candidate) => pageMatchesProvider(candidate, provider));
        if (page) return page;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for the ${provider} page.`);
}

async function configureDebateRun(page, prompt) {
    await ensureRoutePopoverVisible(page);
    await page.locator('#route-mode-debate').click();
    await page.locator('#route-rounds').fill('1');
    await page.locator('#route-rounds').dispatchEvent('change');
    await page.locator('#prompt-input').fill(prompt);
    await page.waitForTimeout(400);

    const sendLabel = (await page.locator('#send-button').textContent())?.trim();
    if (sendLabel !== 'Send') {
        const statuses = await getProviderStatuses(page);
        throw new Error(
            `The route is not ready to send yet (button shows "${sendLabel || 'unknown'}").\nCurrent status: ${formatStatuses(statuses)}`
        );
    }
}

async function captureRouteReadyScreenshot(page) {
    const popoverBox = await page.locator('#route-popover').boundingBox();
    const outputPath = path.join(OUTPUT_DIR, '01-sidepanel-ready-debate.png');
    if (!popoverBox) {
        await page.screenshot({ path: outputPath, fullPage: true });
        return outputPath;
    }

    const clipY = Math.max(0, Math.floor(popoverBox.y) - 16);
    const clipHeight = Math.min(VIEWPORT.height - clipY, Math.ceil(popoverBox.height) + 300);
    await page.screenshot({
        path: outputPath,
        clip: {
            x: 0,
            y: clipY,
            width: VIEWPORT.width,
            height: clipHeight,
        },
    });
    return outputPath;
}

async function closeRoutePopover(page) {
    const isHidden = await page.locator('#route-popover').evaluate((node) => node.hidden);
    if (!isHidden) {
        await page.locator('#route-done').click();
        await page.waitForTimeout(300);
    }
}

async function markProviderCaptureTarget(page, provider) {
    return await page.evaluate((targetProvider) => {
        const marker = 'data-mlc-doc-capture-target';
        document.querySelectorAll(`[${marker}]`).forEach((node) => node.removeAttribute(marker));

        const isVisible = (node) => {
            if (!(node instanceof Element)) return false;
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return (
                rect.width >= 40 &&
                rect.height >= 40 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden'
            );
        };

        const firstDescendantMatch = (root, selectors) => {
            for (const selector of selectors) {
                try {
                    const match = root.querySelector(selector);
                    if (match && isVisible(match)) return match;
                } catch (error) {}
            }
            return null;
        };

        const getLastVisible = (nodes) => {
            for (let index = nodes.length - 1; index >= 0; index -= 1) {
                const node = nodes[index];
                if (isVisible(node)) return node;
            }
            return null;
        };

        const isGeminiUserMessage = (node) => {
            if (!node) return false;
            const selectors = [
                '.user-message',
                '.user-query',
                '[data-message-author="user"]',
                '[data-message-author="human"]',
                '[data-author-is-user="true"]',
            ];
            for (const selector of selectors) {
                if (node.matches?.(selector) || node.closest?.(selector)) return true;
            }
            try {
                if (node.querySelector?.(selectors.join(', '))) return true;
            } catch (error) {}
            const ariaLabel = node.getAttribute?.('aria-label') || '';
            return /\b(you|user)\b/i.test(ariaLabel);
        };

        const isClaudeUserMessage = (node) => {
            if (!node) return false;
            const selectors = [
                '[data-testid*="user" i]',
                '[data-testid*="human" i]',
                '[data-role*="user" i]',
                '[data-author*="user" i]',
                '.user-message',
                '.human-message',
                '.message-user',
            ];
            for (const selector of selectors) {
                if (node.matches?.(selector) || node.closest?.(selector)) return true;
            }
            const ariaLabel = node.getAttribute?.('aria-label') || '';
            return /\b(you|user)\b/i.test(ariaLabel);
        };

        const isGrokUserMessage = (node) => {
            if (!node) return false;
            const selectors = [
                '[data-testid*="user" i]',
                '[data-testid*="human" i]',
                '[data-role*="user" i]',
                '[data-author*="user" i]',
                '[data-message-author-role="user"]',
                '.user-message',
                '.human-message',
                '.message-user',
                '.from-user',
            ];
            for (const selector of selectors) {
                if (node.matches?.(selector) || node.closest?.(selector)) return true;
            }
            const ariaLabel = node.getAttribute?.('aria-label') || '';
            return /\b(you|user)\b/i.test(ariaLabel);
        };

        let target = null;

        if (targetProvider === 'chatgpt') {
            const assistantRoots = Array.from(
                document.querySelectorAll('[data-message-author-role="assistant"]')
            );
            const root = getLastVisible(assistantRoots);
            if (root) {
                target =
                    firstDescendantMatch(root, [
                        '[data-testid="message-content"]',
                        '.markdown',
                        '.prose',
                        '[class*="markdown" i]',
                        '[class*="prose" i]',
                    ]) || root;
            }
        } else if (targetProvider === 'gemini') {
            const roots = [document.querySelector('main'), document.body].filter(Boolean);
            const selectors = [
                '[data-message-author="gemini"]',
                '[data-message-author="assistant"]',
                '[data-author-is-user="false"]',
                '[data-response-id]',
                '[data-message-id]',
                '.conversation-turn',
                '.message-container',
                '.response-content',
                '.model-response',
                '.model-response-text',
                '.markdown',
                '.markdown-content',
                '[data-testid="markdown-content"]',
                'article',
                '[role="article"]',
            ];
            const nodes = [];
            for (const root of roots) {
                for (const selector of selectors) {
                    try {
                        nodes.push(...root.querySelectorAll(selector));
                    } catch (error) {}
                }
                if (nodes.length) break;
            }
            for (let index = nodes.length - 1; index >= 0; index -= 1) {
                const node = nodes[index];
                if (!isVisible(node) || isGeminiUserMessage(node)) continue;
                target =
                    firstDescendantMatch(node, [
                        '.markdown',
                        '.markdown-content',
                        '[data-testid="markdown-content"]',
                        '.response-content',
                        '.model-response',
                        '.model-response-text',
                    ]) || node;
                if (target) break;
            }
        } else if (targetProvider === 'claude') {
            const roots = [document.querySelector('main'), document.body].filter(Boolean);
            const selectors = [
                '[data-testid="chat-message"]',
                '[data-testid*="chat-message" i]',
                '[data-testid*="assistant" i]',
                '[data-role*="assistant" i]',
                '[data-author*="assistant" i]',
                'article',
                '[role="article"]',
                '[class*="assistant" i]',
            ];
            const candidates = [];
            for (const root of roots) {
                for (const selector of selectors) {
                    try {
                        candidates.push(...root.querySelectorAll(selector));
                    } catch (error) {}
                }
                if (candidates.length) break;
            }
            for (let index = candidates.length - 1; index >= 0; index -= 1) {
                const node = candidates[index];
                if (!isVisible(node) || isClaudeUserMessage(node)) continue;
                target =
                    firstDescendantMatch(node, [
                        '[data-testid="chat-message-content"]',
                        '[data-testid="message-content"]',
                        '.markdown',
                        '.prose',
                        '[class*="prose" i]',
                        '[class*="markdown" i]',
                    ]) || node;
                if (target) break;
            }
        } else if (targetProvider === 'grok') {
            const roots = [document.querySelector('main'), document.body].filter(Boolean);
            const selectors = [
                '.response-content-markdown',
                '[class*="response-content-markdown" i]',
                '[data-testid*="assistant" i]',
                '[data-role*="assistant" i]',
                '[data-author*="assistant" i]',
                '[data-message-author-role="assistant"]',
                'article',
                '[role="article"]',
                '[class*="assistant" i]',
                '[class*="response" i]',
            ];
            const candidates = [];
            for (const root of roots) {
                for (const selector of selectors) {
                    try {
                        candidates.push(...root.querySelectorAll(selector));
                    } catch (error) {}
                }
                if (candidates.length) break;
            }
            for (let index = candidates.length - 1; index >= 0; index -= 1) {
                const node = candidates[index];
                if (!isVisible(node) || isGrokUserMessage(node)) continue;
                target =
                    firstDescendantMatch(node, [
                        '.response-content-markdown',
                        '[class*="response-content-markdown" i]',
                        '.markdown',
                        '.prose',
                        '[class*="markdown" i]',
                    ]) || node;
                if (target) break;
            }
        }

        if (!target || !isVisible(target)) {
            return { ok: false };
        }

        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.setAttribute(marker, 'true');

        return {
            ok: true,
            textLength: (target.innerText || target.textContent || '').trim().length,
        };
    }, provider);
}

async function captureProviderScreenshot(context, provider, index) {
    const providerPage = await waitForProviderPage(context, provider, 60_000);
    await providerPage.bringToFront();
    await providerPage.waitForLoadState('domcontentloaded').catch(() => {});
    await providerPage.waitForTimeout(750);

    const targetResult = await markProviderCaptureTarget(providerPage, provider);
    const outputPath = path.join(
        OUTPUT_DIR,
        `${String(index).padStart(2, '0')}-${provider}-turn1.png`
    );

    if (targetResult.ok) {
        const targetLocator = providerPage.locator('[data-mlc-doc-capture-target="true"]').first();
        await targetLocator.screenshot({ path: outputPath, animations: 'disabled' });
    } else {
        await providerPage.screenshot({ path: outputPath, fullPage: false });
    }

    return outputPath;
}

async function captureTranscriptScreenshot(page) {
    await page.bringToFront();
    await page.evaluate(() => {
        const timeline = document.getElementById('timeline');
        if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
    await page.waitForTimeout(400);
    const outputPath = path.join(OUTPUT_DIR, '06-sidepanel-transcript-complete.png');
    await page.screenshot({ path: outputPath, fullPage: true });
    return outputPath;
}

async function captureSettingsScreenshot(page) {
    await page.locator('#settings-button').click();
    await page.waitForTimeout(400);
    const outputPath = path.join(OUTPUT_DIR, '07-settings-security.png');
    await page.screenshot({ path: outputPath, fullPage: true });
    await page.locator('#close-settings').click();
    return outputPath;
}

async function runSetupMode(options) {
    logSection(`Setup mode using profile ${options.profileDir}`);
    const runtime = await launchExtensionContext(options);
    try {
        const page = await openSidePanelPage(runtime);
        await bootstrapProviders(page);
        console.log(
            'Provider tabs opened. Log in to ChatGPT, Gemini, Claude, and Grok in the launched Chromium window.'
        );
        console.log(
            'This command will finish automatically once all four providers are ready in the sidepanel.'
        );
        const statuses = await waitForProvidersReady(page);
        console.log(`All providers are ready: ${formatStatuses(statuses)}`);
    } finally {
        await runtime.context.close();
    }
}

async function runCaptureMode(options) {
    logSection(`Capture mode using profile ${options.profileDir}`);
    const runtime = await launchExtensionContext(options);
    const outputs = [];
    try {
        const page = await openSidePanelPage(runtime);
        await installRuntimeEventTap(page);
        await bootstrapProviders(page);
        await waitForProvidersReady(page, { timeoutMs: 180_000 });
        await configureDebateRun(page, options.prompt);
        outputs.push(await captureRouteReadyScreenshot(page));

        await resetRuntimeEventTap(page);
        await closeRoutePopover(page);
        await page.locator('#send-button').click();

        await waitForEvent(page, (event) => event.type === 'UI_SESSION_STARTED', 'session start', {
            timeoutMs: 60_000,
        });

        for (let index = 0; index < PROVIDERS.length; index += 1) {
            const provider = PROVIDERS[index];
            await waitForProviderMessageCount(page, provider, 1, 300_000);
            outputs.push(await captureProviderScreenshot(runtime.context, provider, index + 2));
        }

        await waitForEvent(page, (event) => event.type === 'UI_SESSION_ENDED', 'session end', {
            timeoutMs: 120_000,
        });

        outputs.push(await captureTranscriptScreenshot(page));
        outputs.push(await captureSettingsScreenshot(page));

        console.log('Generated README screenshots:');
        outputs.forEach((file) => console.log(`- ${path.relative(REPO_ROOT, file)}`));
    } finally {
        await runtime.context.close();
    }
}

async function main() {
    ensureBuiltArtifacts();
    createOutputDir();
    const options = parseArgs(process.argv);

    if (options.mode === 'setup') {
        await runSetupMode(options);
        return;
    }

    if (options.mode === 'capture') {
        await runCaptureMode(options);
        return;
    }

    throw new Error(`Unsupported mode: ${options.mode}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
