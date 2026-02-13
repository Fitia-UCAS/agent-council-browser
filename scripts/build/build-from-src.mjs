import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const modeArg = args.find((arg) => arg.startsWith('--mode='));
const versionArg = args.find((arg) => arg.startsWith('--version='));

const mode = modeArg ? modeArg.split('=')[1] : 'dev';
const versionOverride = versionArg ? versionArg.split('=')[1] : '';

const ENTRYPOINTS = [
    { src: 'src/background/index.js', dst: 'background.js' },
    { src: 'src/content/index.js', dst: 'contentScript.js' },
    { src: 'src/sidepanel/index.js', dst: 'sidepanel.js' },
    { src: 'src/history/index.js', dst: 'historyStore.js' },
];

const COPY_SPECS = [
    { src: 'src/content/captureUtils.js', dst: 'captureUtils.js' },
    { src: 'src/background/debatePromptUtils.js', dst: 'debatePromptUtils.js' },
    { src: 'src/background/debate_prompts.json', dst: 'debate_prompts.json' },
    { src: 'src/sidepanel/index.html', dst: 'sidepanel.html' },
    { src: 'src/sidepanel/styles.css', dst: 'styles.css' },

    { src: 'src/shared/protocolV3.js', dst: 'runtime/protocolV3.js' },
    { src: 'src/background/security/safeLogger.js', dst: 'runtime/safeLogger.js' },
    { src: 'src/background/runtime/schemaResetV3.js', dst: 'runtime/schemaResetV3.js' },
    { src: 'src/background/runtime/messageRouter.js', dst: 'runtime/background/messageRouter.js' },
    { src: 'src/background/sessions/sessionEngine.js', dst: 'runtime/background/sessionEngine.js' },
    {
        src: 'src/background/sessions/sessionStateStore.js',
        dst: 'runtime/background/sessionStateStore.js',
    },
    {
        src: 'src/background/profiles/tabProfileStore.js',
        dst: 'runtime/background/tabProfileStore.js',
    },
    { src: 'src/background/history/historyBridge.js', dst: 'runtime/background/historyBridge.js' },
    {
        src: 'src/background/providers/providerRegistry.js',
        dst: 'runtime/background/providerRegistry.js',
    },
    {
        src: 'src/background/providers/chatgptAdapter.js',
        dst: 'runtime/background/providers/chatgptAdapter.js',
    },
    {
        src: 'src/background/providers/geminiAdapter.js',
        dst: 'runtime/background/providers/geminiAdapter.js',
    },
    {
        src: 'src/background/providers/claudeAdapter.js',
        dst: 'runtime/background/providers/claudeAdapter.js',
    },
    {
        src: 'src/background/providers/grokAdapter.js',
        dst: 'runtime/background/providers/grokAdapter.js',
    },
    {
        src: 'src/background/runtime/handlers/sessionHandlers.js',
        dst: 'runtime/background/handlers/sessionHandlers.js',
    },
    {
        src: 'src/background/runtime/handlers/profileHandlers.js',
        dst: 'runtime/background/handlers/profileHandlers.js',
    },
    {
        src: 'src/background/runtime/handlers/historyHandlers.js',
        dst: 'runtime/background/handlers/historyHandlers.js',
    },
    {
        src: 'src/background/runtime/handlers/schemaHandlers.js',
        dst: 'runtime/background/handlers/schemaHandlers.js',
    },
    {
        src: 'src/background/runtime/handlers/providerHandlers.js',
        dst: 'runtime/background/handlers/providerHandlers.js',
    },

    { src: 'src/content/core/captureEngine.js', dst: 'runtime/content/captureEngine.js' },
    {
        src: 'src/content/providers/chatgptCapture.js',
        dst: 'runtime/content/providers/chatgptCapture.js',
    },
    {
        src: 'src/content/providers/geminiCapture.js',
        dst: 'runtime/content/providers/geminiCapture.js',
    },
    {
        src: 'src/content/providers/claudeCapture.js',
        dst: 'runtime/content/providers/claudeCapture.js',
    },
    {
        src: 'src/content/providers/grokCapture.js',
        dst: 'runtime/content/providers/grokCapture.js',
    },

    { src: 'src/sidepanel/state/store.js', dst: 'runtime/sidepanel/store.js' },
    { src: 'src/sidepanel/state/actions.js', dst: 'runtime/sidepanel/actions.js' },
    { src: 'src/sidepanel/state/reducer.js', dst: 'runtime/sidepanel/reducer.js' },
    { src: 'src/sidepanel/features/routeBuilder.js', dst: 'runtime/sidepanel/routeBuilder.js' },
    { src: 'src/sidepanel/features/routeBinding.js', dst: 'runtime/sidepanel/routeBinding.js' },
    { src: 'src/sidepanel/views/transcriptView.js', dst: 'runtime/sidepanel/transcriptView.js' },
    {
        src: 'src/sidepanel/services/backgroundClient.js',
        dst: 'runtime/sidepanel/services/backgroundClient.js',
    },
    {
        src: 'src/sidepanel/controllers/sessionController.js',
        dst: 'runtime/sidepanel/controllers/sessionController.js',
    },
    {
        src: 'src/sidepanel/controllers/historyController.js',
        dst: 'runtime/sidepanel/controllers/historyController.js',
    },
    {
        src: 'src/sidepanel/controllers/schemaController.js',
        dst: 'runtime/sidepanel/controllers/schemaController.js',
    },

    { src: 'src/assets/fonts.css', dst: 'assets/fonts.css' },
];

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyFile(srcRel, dstRel) {
    const src = path.join(repoRoot, srcRel);
    const dst = path.join(repoRoot, dstRel);
    ensureDir(dst);
    fs.copyFileSync(src, dst);
}

function readJson(relPath) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function writeJson(relPath, value) {
    const abs = path.join(repoRoot, relPath);
    ensureDir(abs);
    fs.writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stripVariantSuffix(value) {
    return typeof value === 'string' ? value.replace(/\s+\[[^\]]+\]$/, '') : value;
}

function assertSourcesExist(paths) {
    const missing = paths.filter((relPath) => !fs.existsSync(path.join(repoRoot, relPath)));
    if (missing.length === 0) return;
    const message = [
        'Missing required source files for build:',
        ...missing.map((p) => ` - ${p}`),
    ].join('\n');
    throw new Error(message);
}

async function buildEntry(srcRel, dstRel) {
    const outfile = path.join(repoRoot, dstRel);
    ensureDir(outfile);
    await esbuild({
        entryPoints: [path.join(repoRoot, srcRel)],
        outfile,
        bundle: false,
        format: 'iife',
        platform: 'browser',
        target: ['chrome120'],
        legalComments: 'none',
        charset: 'utf8',
        logLevel: 'silent',
    });
}

async function main() {
    const requiredSources = [
        'src/manifest/manifest.base.json',
        ...ENTRYPOINTS.map((entry) => entry.src),
        ...COPY_SPECS.map((spec) => spec.src),
    ];
    assertSourcesExist(requiredSources);

    const manifest = readJson('src/manifest/manifest.base.json');

    if (versionOverride) {
        manifest.version = versionOverride;
    }

    if (mode === 'release') {
        manifest.name = stripVariantSuffix(manifest.name || 'Multi-LLM Coder');
        const existingAction =
            manifest.action && typeof manifest.action === 'object' ? manifest.action : {};
        manifest.action = {
            ...existingAction,
            default_title: stripVariantSuffix(existingAction.default_title || manifest.name),
        };
        if (Object.prototype.hasOwnProperty.call(manifest, 'version_name')) {
            delete manifest.version_name;
        }
    }

    for (const entry of ENTRYPOINTS) {
        await buildEntry(entry.src, entry.dst);
    }

    for (const spec of COPY_SPECS) {
        copyFile(spec.src, spec.dst);
    }

    writeJson('manifest.json', manifest);
    console.log(`[build-from-src] Generated runtime files from src (mode=${mode}).`);
}

main().catch((error) => {
    console.error('[build-from-src] Failed:', error);
    process.exitCode = 1;
});
