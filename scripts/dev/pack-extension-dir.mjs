/**
 * Pack the built extension into a clean, loadable directory outside the repo.
 *
 * The repo root is a source tree (src/, scripts/, tests/, node_modules/, .git/ ...).
 * Loading it directly in Chrome/Edge works but is noisy and easy to break. This
 * script produces a minimal unpacked-extension folder containing only the files
 * listed in scripts/release/release-allowlist.txt.
 *
 * Usage:
 *   node scripts/dev/pack-extension-dir.mjs --out=E:/edge-extensions/multi-agent-council
 *   node scripts/dev/pack-extension-dir.mjs --out=..\multi-agent-council --mode=dev --no-build
 *   node scripts/dev/pack-extension-dir.mjs --out=../multi-agent-council --name="My Council"
 *
 * Flags:
 *   --out=<dir>     Required (or set AGC_EXTENSION_DIR). Must be outside the repo.
 *   --mode=<mode>   dev | release. Default: release (no "dev-*" version_name label).
 *   --no-build      Skip the src -> runtime build and pack whatever is currently at repo root.
 *   --name=<name>   Override the extension display name in the packaged manifest.
 *   --keep          Leave unrecognized extra files in the target folder alone.
 *   --force         Allow overwriting a non-empty folder that this script did not create.
 *                   The existing folder is moved to "<dir>.bak-<timestamp>", never deleted.
 *
 * Safety: the target folder is only cleared automatically when it contains the
 * marker file written by a previous run. Any other non-empty folder is treated as
 * someone else's data and is left untouched unless --force is passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const ICON_SIZES = [16, 32, 48, 128];
const MARKER_FILE = '.agc-pack.json';

function parseArgs(argv) {
    const options = {
        out: process.env.AGC_EXTENSION_DIR || '',
        mode: 'release',
        build: true,
        name: '',
        keep: false,
        force: false,
    };

    for (const arg of argv) {
        if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
        else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
        else if (arg.startsWith('--name=')) options.name = arg.slice('--name='.length);
        else if (arg === '--no-build') options.build = false;
        else if (arg === '--keep') options.keep = true;
        else if (arg === '--force') options.force = true;
        else if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else {
            fail(`Unknown argument: ${arg}`);
        }
    }

    if (!options.out) {
        fail('Missing --out=<dir> (or set AGC_EXTENSION_DIR).');
    }
    if (options.mode !== 'dev' && options.mode !== 'release') {
        fail(`Invalid --mode: ${options.mode} (expected dev or release).`);
    }
    return options;
}

function printUsage() {
    console.log(
        [
            'Usage: node scripts/dev/pack-extension-dir.mjs --out=<dir> [--mode=dev|release] [--no-build] [--name=<name>] [--keep] [--force]',
            '',
            'Example:',
            '  node scripts/dev/pack-extension-dir.mjs --out=E:/edge-extensions/multi-agent-council',
        ].join('\n'),
    );
}

function fail(message) {
    console.error(`[pack-extension] ${message}`);
    process.exit(1);
}

function log(message) {
    console.log(`[pack-extension] ${message}`);
}

function runNodeScript(scriptRelPath, args) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, scriptRelPath), ...args], {
        cwd: repoRoot,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        fail(`${scriptRelPath} failed with exit code ${result.status}.`);
    }
}

function ensureRuntimeBuilt(mode) {
    log(`Building runtime from src (mode=${mode})...`);
    runNodeScript('scripts/build/build-from-src.mjs', [`--mode=${mode}`]);
}

function ensureIcons() {
    const missing = ICON_SIZES.filter(
        (size) => !fs.existsSync(path.join(repoRoot, 'variant-icons', `variant-${size}.png`)),
    );
    if (missing.length === 0) return;

    log(`Missing icon sizes (${missing.join(', ')}); regenerating variant-icons/...`);
    runNodeScript('scripts/dev/render-council-icon.mjs', []);
}

function readAllowlist() {
    const allowlistPath = path.join(repoRoot, 'scripts', 'release', 'release-allowlist.txt');
    const entries = fs
        .readFileSync(allowlistPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

    const missing = entries.filter((entry) => !fs.existsSync(path.join(repoRoot, entry)));
    if (missing.length > 0) {
        fail(
            `Built artifacts missing from repo root: ${missing.join(', ')}\n` +
                'Run npm run build:src (or drop --no-build) before packing.',
        );
    }
    return entries;
}

/**
 * Windows Node cannot resolve WSL-style paths. Accept /mnt/e/foo when running
 * node.exe from WSL and translate it to E:/foo.
 */
function normalizeOutPath(rawPath) {
    const wslMatch = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(rawPath);
    if (process.platform === 'win32' && wslMatch) {
        return `${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`;
    }
    return rawPath;
}

function assertSafeTarget(outDir) {
    const resolvedRepo = fs.realpathSync(repoRoot);
    const normalizedOut = path.resolve(outDir);
    const repoWithSep = resolvedRepo + path.sep;

    if (normalizedOut === resolvedRepo || normalizedOut.startsWith(repoWithSep)) {
        fail(
            `Refusing to pack into the repo (${normalizedOut}).\n` +
                'Pick a folder outside the repository, e.g. E:\\edge-extensions\\multi-agent-council.',
        );
    }
    if (path.parse(normalizedOut).root === normalizedOut) {
        fail(`Refusing to pack into a drive root: ${normalizedOut}`);
    }
}

function clearDirectory(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        try {
            fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
        } catch (error) {
            // Chrome/Edge may briefly hold files open right after a Reload.
            log(`Warning: could not remove ${entry.name} (${error.message}); it will be overwritten.`);
        }
    }
}

function isForeignFolder(outDir) {
    if (!fs.existsSync(outDir)) return false;
    if (fs.readdirSync(outDir).length === 0) return false;
    return !fs.existsSync(path.join(outDir, MARKER_FILE));
}

/**
 * Fail before doing expensive work when the target is someone else's folder.
 */
function assertTargetAllowed(outDir, options) {
    if (!isForeignFolder(outDir)) return;
    if (options.force || options.keep) return;

    fail(
        [
            `Target folder is not empty and was not created by this script: ${outDir}`,
            '',
            'Refusing to touch it, because it may contain another extension or hand-edited files.',
            'Choose a different --out, or rerun with --force to move the existing folder',
            `aside to "${path.basename(outDir)}.bak-<timestamp>" and pack a fresh copy.`,
        ].join('\n'),
    );
}

/**
 * Only folders carrying our marker are cleared in place. Anything else is
 * treated as unrelated user data: with --force it is moved aside, never deleted.
 */
function prepareTarget(outDir, options) {
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
        return;
    }

    if (fs.readdirSync(outDir).length === 0) return;

    if (!isForeignFolder(outDir)) {
        if (!options.keep) clearDirectory(outDir);
        return;
    }

    if (options.keep && !options.force) {
        log('Target folder is not ours but --keep was passed; writing over matching files only.');
        return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = `${outDir}.bak-${stamp}`;
    fs.renameSync(outDir, backupDir);
    fs.mkdirSync(outDir, { recursive: true });
    log(`Existing folder moved aside to: ${backupDir}`);
}

function copyEntry(entry, outDir) {
    const src = path.join(repoRoot, entry);
    const dst = path.join(outDir, entry);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
}

function applyNameOverride(outDir, name) {
    if (!name) return;
    const manifestPath = path.join(outDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.name = name;
    if (manifest.action && typeof manifest.action === 'object') {
        manifest.action.default_title = `Click to open ${name}`;
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function writeMarker(outDir) {
    const marker = {
        tool: 'agent-council-browser/pack-extension-dir',
        source: repoRoot,
        packedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
        path.join(outDir, MARKER_FILE),
        `${JSON.stringify(marker, null, 2)}\n`,
        'utf8',
    );
}

function listManifestReferences(manifest) {
    const refs = new Set();

    if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
    if (manifest.side_panel?.default_path) refs.add(manifest.side_panel.default_path);
    for (const value of Object.values(manifest.icons || {})) refs.add(value);
    for (const value of Object.values(manifest.action?.default_icon || {})) refs.add(value);
    for (const script of manifest.content_scripts || []) {
        for (const file of [...(script.js || []), ...(script.css || [])]) refs.add(file);
    }
    return [...refs];
}

function verifyPackage(outDir) {
    const manifestPath = path.join(outDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) fail('Packaged folder has no manifest.json.');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const missing = listManifestReferences(manifest).filter(
        (ref) => !fs.existsSync(path.join(outDir, ref)),
    );
    if (missing.length > 0) {
        fail(
            `Packaged extension is missing files referenced by manifest.json:\n - ${missing.join('\n - ')}`,
        );
    }

    if (!fs.existsSync(path.join(outDir, 'runtime'))) {
        fail(
            'Packaged extension is missing runtime/ (needed by background, side panel, and content scripts).',
        );
    }
    if (!manifest.side_panel?.default_path) {
        log('Warning: manifest has no side_panel entry; the UI will open as a tab.');
    }
    return manifest;
}

function directorySizeBytes(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += directorySizeBytes(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
    }
    return total;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const outDir = path.resolve(repoRoot, normalizeOutPath(options.out));

    assertSafeTarget(outDir);
    assertTargetAllowed(outDir, options);

    // Fail fast before spending time on the build.
    if (options.build) ensureRuntimeBuilt(options.mode);
    ensureIcons();

    prepareTarget(outDir, options);

    const entries = readAllowlist();
    for (const entry of entries) copyEntry(entry, outDir);
    applyNameOverride(outDir, options.name);
    writeMarker(outDir);

    const manifest = verifyPackage(outDir);
    const sizeMb = (directorySizeBytes(outDir) / (1024 * 1024)).toFixed(1);

    log(`Packed ${manifest.name} v${manifest.version} -> ${outDir} (${sizeMb} MB)`);
    log('Load it with: chrome://extensions (or edge://extensions) -> Developer mode -> Load unpacked.');
    log('After changing src/, rerun this command and click Reload on the extension.');
}

main();
