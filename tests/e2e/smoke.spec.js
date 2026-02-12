const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test('build artifacts required for extension runtime exist', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const required = [
        'manifest.json',
        'background.js',
        'contentScript.js',
        'sidepanel.js',
        'sidepanel.html',
        'runtime/protocolV3.js',
        'runtime/safeLogger.js',
        'runtime/schemaResetV3.js',
    ];

    required.forEach((relPath) => {
        const abs = path.join(repoRoot, relPath);
        expect(fs.existsSync(abs), `${relPath} should exist`).toBeTruthy();
    });
});
