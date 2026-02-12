module.exports = [
    {
        ignores: ['.dist/**', 'release/**', 'worktrees/**', 'node_modules/**'],
    },
    {
        files: ['src/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                chrome: 'readonly',
                indexedDB: 'readonly',
                crypto: 'readonly',
                self: 'readonly',
                window: 'readonly',
                document: 'readonly',
                Node: 'readonly',
                NodeFilter: 'readonly',
                IDBKeyRange: 'readonly',
                File: 'readonly',
                DataTransfer: 'readonly',
                DragEvent: 'readonly',
                InputEvent: 'readonly',
                atob: 'readonly',
                btoa: 'readonly',
                fetch: 'readonly',
            },
        },
        rules: {
            'no-console': 'off',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
];
