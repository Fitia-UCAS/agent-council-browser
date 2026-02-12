/* global chrome, indexedDB, crypto */

(() => {
    'use strict';

    const DB_NAME = 'mlc_history_v1';
    const DB_VERSION = 1;

    const STORE_THREADS = 'threads';
    const STORE_MESSAGES = 'messages';
    const STORE_SETTINGS = 'settings';

    const SESSION_KEY_STORAGE = 'mlc_history_key_v1';
    const SECURITY_SETTINGS_KEY = 'security';

    const KEYCHECK_PLAINTEXT = 'mlc-history-keycheck-v1';
    const KDF_ITERATIONS = 250_000;
    const SALT_BYTES = 16;
    const AES_GCM_IV_BYTES = 12;

    const DEFAULT_SECURITY_SETTINGS = {
        version: 1,
        historyEnabled: true,
        protectionMode: 'off', // 'off' | 'per_chat'
        lockNewChatsByDefault: false,
    };

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let cachedDbPromise = null;
    let cachedCryptoKey = null;

    function nowMs() {
        return Date.now();
    }

    function openDb() {
        if (cachedDbPromise) return cachedDbPromise;
        cachedDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
            request.onupgradeneeded = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains(STORE_THREADS)) {
                    const store = db.createObjectStore(STORE_THREADS, { keyPath: 'threadId' });
                    store.createIndex('updatedAt', 'updatedAt', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }

                if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
                    const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'messageId' });
                    store.createIndex('threadId', 'threadId', { unique: false });
                    store.createIndex('threadId_sequence', ['threadId', 'sequence'], {
                        unique: false,
                    });
                    store.createIndex('threadId_createdAt', ['threadId', 'createdAt'], {
                        unique: false,
                    });
                }

                if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
                    db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
        });
        return cachedDbPromise;
    }

    function randomBytes(length) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return bytes;
    }

    function bytesToBase64(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    function base64ToBytes(base64) {
        const binary = atob(String(base64 || ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function normalizePassphrase(passphrase) {
        return String(passphrase || '').normalize('NFKC');
    }

    function normalizeProtectionMode(mode, { encryptionConfigured = false } = {}) {
        if (!encryptionConfigured) return 'off';
        return 'per_chat';
    }

    async function getSetting(db, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_SETTINGS], 'readonly');
            const store = tx.objectStore(STORE_SETTINGS);
            const request = store.get(key);
            request.onerror = () => reject(request.error || new Error('Failed to read setting'));
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    async function setSetting(db, key, value) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_SETTINGS], 'readwrite');
            const store = tx.objectStore(STORE_SETTINGS);
            const request = store.put({ key, value });
            request.onerror = () => reject(request.error || new Error('Failed to write setting'));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to write setting'));
        });
    }

    async function deleteSetting(db, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_SETTINGS], 'readwrite');
            const store = tx.objectStore(STORE_SETTINGS);
            const request = store.delete(key);
            request.onerror = () => reject(request.error || new Error('Failed to delete setting'));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to delete setting'));
        });
    }

    async function getCryptoConfig(db) {
        const record = await getSetting(db, 'crypto');
        return record?.value && typeof record.value === 'object' ? record.value : null;
    }

    async function getSecuritySettings(db, { encryptionConfigured = false } = {}) {
        const record = await getSetting(db, SECURITY_SETTINGS_KEY);
        const raw = record?.value && typeof record.value === 'object' ? record.value : null;

        if (!raw) {
            if (encryptionConfigured) {
                return {
                    ...DEFAULT_SECURITY_SETTINGS,
                    historyEnabled: true,
                    protectionMode: 'per_chat',
                    lockNewChatsByDefault: true,
                };
            }
            return { ...DEFAULT_SECURITY_SETTINGS };
        }

        const merged = { ...DEFAULT_SECURITY_SETTINGS, ...raw, version: 1 };
        const hasLockNewFlag = Object.prototype.hasOwnProperty.call(raw, 'lockNewChatsByDefault');
        merged.historyEnabled = true;
        merged.lockNewChatsByDefault = hasLockNewFlag
            ? Boolean(merged.lockNewChatsByDefault)
            : Boolean(encryptionConfigured);
        merged.protectionMode = normalizeProtectionMode(merged.protectionMode, {
            encryptionConfigured,
        });
        return merged;
    }

    async function setSecuritySettings(db, settings) {
        const raw = settings && typeof settings === 'object' ? settings : {};
        const merged = { ...DEFAULT_SECURITY_SETTINGS, ...raw, version: 1 };
        merged.historyEnabled = true;
        merged.lockNewChatsByDefault = Boolean(merged.lockNewChatsByDefault);
        const encryptionConfigured = Boolean(raw?.protectionMode && raw.protectionMode !== 'off');
        merged.protectionMode = normalizeProtectionMode(merged.protectionMode, {
            encryptionConfigured,
        });
        await setSetting(db, SECURITY_SETTINGS_KEY, merged);
    }

    async function updateSecuritySettings(db, patch, { encryptionConfigured = false } = {}) {
        const current = await getSecuritySettings(db, { encryptionConfigured });
        const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
        next.historyEnabled = true;
        next.lockNewChatsByDefault = Boolean(next.lockNewChatsByDefault);
        next.protectionMode = normalizeProtectionMode(next.protectionMode, {
            encryptionConfigured,
        });
        await setSecuritySettings(db, next);
        return next;
    }

    async function deriveKeyMaterial(passphrase, saltBytes, iterations) {
        const normalized = normalizePassphrase(passphrase);
        if (!normalized) {
            const err = new Error('Passphrase is empty.');
            err.code = 'PASSPHRASE_EMPTY';
            throw err;
        }
        const passphraseBytes = encoder.encode(normalized);
        const material = await crypto.subtle.importKey(
            'raw',
            passphraseBytes,
            { name: 'PBKDF2' },
            false,
            ['deriveBits', 'deriveKey']
        );

        const bits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                hash: 'SHA-256',
                salt: saltBytes,
                iterations,
            },
            material,
            256
        );

        const keyBytes = new Uint8Array(bits);
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
            'encrypt',
            'decrypt',
        ]);
        return { key, keyBytes };
    }

    async function encryptString(key, plaintext) {
        const iv = randomBytes(AES_GCM_IV_BYTES);
        const data = encoder.encode(String(plaintext || ''));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
        return { iv: iv.buffer, data: ciphertext };
    }

    async function decryptString(key, payload) {
        if (!payload || !payload.iv || !payload.data) return '';
        const iv =
            payload.iv instanceof ArrayBuffer
                ? new Uint8Array(payload.iv)
                : new Uint8Array(payload.iv.buffer);
        const plaintextBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            payload.data
        );
        return decoder.decode(plaintextBuffer);
    }

    async function encryptJson(key, obj) {
        return encryptString(key, JSON.stringify(obj ?? null));
    }

    async function decryptJson(key, payload) {
        const text = await decryptString(key, payload);
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    async function storeSessionKeyBytes(keyBytes) {
        const bytes = keyBytes instanceof Uint8Array ? keyBytes : new Uint8Array(keyBytes || []);
        const base64 = bytesToBase64(bytes);
        await chrome.storage.session.set({ [SESSION_KEY_STORAGE]: base64 });
    }

    async function importKeyFromSession() {
        const stored = await chrome.storage.session.get(SESSION_KEY_STORAGE);
        const base64 = stored?.[SESSION_KEY_STORAGE];
        if (!base64) return null;
        const bytes = base64ToBytes(base64);
        if (!bytes.length) return null;
        return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
            'encrypt',
            'decrypt',
        ]);
    }

    async function clearSessionKey() {
        cachedCryptoKey = null;
        await chrome.storage.session.remove([SESSION_KEY_STORAGE, 'mlc_history_unlocked_at_v1']);
    }

    async function getUnlockedKey() {
        if (cachedCryptoKey) return cachedCryptoKey;
        try {
            const key = await importKeyFromSession();
            if (key) {
                cachedCryptoKey = key;
                return key;
            }
        } catch (error) {
            console.warn('[MLC History] Failed to load session key:', error);
        }
        return null;
    }

    async function requireUnlockedKey() {
        const key = await getUnlockedKey();
        if (!key) {
            const err = new Error('History is locked.');
            err.code = 'HISTORY_LOCKED';
            throw err;
        }
        return key;
    }

    async function isEncryptionConfigured() {
        const db = await openDb();
        const config = await getCryptoConfig(db);
        return Boolean(config && config.version === 1 && config.salt && config.keyCheck);
    }

    async function requireHistoryEnabled(db, { encryptionConfigured = false } = {}) {
        const security = await getSecuritySettings(db, { encryptionConfigured });
        return security;
    }

    async function configureEncryption(passphrase, options = {}) {
        const db = await openDb();
        const already = await getCryptoConfig(db);
        if (already) {
            const err = new Error('Encryption is already configured.');
            err.code = 'ENCRYPTION_ALREADY_CONFIGURED';
            throw err;
        }

        const salt = randomBytes(SALT_BYTES);
        const derived = await deriveKeyMaterial(passphrase, salt, KDF_ITERATIONS);
        const keyCheck = await encryptString(derived.key, KEYCHECK_PLAINTEXT);

        const config = {
            version: 1,
            kdf: 'PBKDF2-SHA256',
            iterations: KDF_ITERATIONS,
            salt: salt.buffer,
            algorithm: 'AES-GCM',
            keyCheck,
        };

        await setSetting(db, 'crypto', config);
        cachedCryptoKey = derived.key;
        await storeSessionKeyBytes(derived.keyBytes);

        const requestedMode = normalizeProtectionMode(options?.mode, {
            encryptionConfigured: true,
        });
        await updateSecuritySettings(
            db,
            { historyEnabled: true, protectionMode: requestedMode, lockNewChatsByDefault: true },
            { encryptionConfigured: true }
        );

        return getStatus();
    }

    async function unlock(passphrase) {
        const db = await openDb();
        const config = await getCryptoConfig(db);
        if (!config) {
            const err = new Error('Encryption is not configured.');
            err.code = 'ENCRYPTION_NOT_CONFIGURED';
            throw err;
        }

        const saltBytes =
            config.salt instanceof ArrayBuffer
                ? new Uint8Array(config.salt)
                : new Uint8Array(config.salt.buffer);
        const derived = await deriveKeyMaterial(
            passphrase,
            saltBytes,
            config.iterations || KDF_ITERATIONS
        );

        let plaintext = '';
        try {
            plaintext = await decryptString(derived.key, config.keyCheck);
        } catch (error) {
            const err = new Error('Incorrect passphrase.');
            err.code = 'PASSPHRASE_INVALID';
            throw err;
        }

        if (plaintext !== KEYCHECK_PLAINTEXT) {
            const err = new Error('Incorrect passphrase.');
            err.code = 'PASSPHRASE_INVALID';
            throw err;
        }

        cachedCryptoKey = derived.key;
        await storeSessionKeyBytes(derived.keyBytes);
        return getStatus();
    }

    async function lock() {
        await clearSessionKey();
        return getStatus();
    }

    async function getStatus() {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await getSecuritySettings(db, { encryptionConfigured });
        const unlocked = encryptionConfigured ? Boolean(await getUnlockedKey()) : false;
        return {
            historyEnabled: Boolean(security.historyEnabled),
            configured: encryptionConfigured,
            unlocked,
            protectionMode: security.protectionMode,
            lockNewChatsByDefault: Boolean(security.lockNewChatsByDefault),
        };
    }

    function normalizeTitle(title) {
        return String(title || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function makePreview(text, maxLen = 80) {
        const cleaned = String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned) return '';
        return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen).trim()}…` : cleaned;
    }

    function inferThreadProtected(thread) {
        if (!thread || typeof thread !== 'object') return false;
        if (typeof thread.protected === 'boolean') return thread.protected;
        return Boolean(thread.titleEnc || thread.lastPreviewEnc);
    }

    async function createThread({
        threadId,
        title = 'New chat',
        createdAt = nowMs(),
        updatedAt = nowMs(),
        titleIsDefault = true,
    }) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await requireHistoryEnabled(db, { encryptionConfigured });
        const protectionMode = normalizeProtectionMode(security.protectionMode, {
            encryptionConfigured,
        });

        const normalizedTitle = normalizeTitle(title) || 'New chat';
        const shouldProtect =
            encryptionConfigured &&
            protectionMode === 'per_chat' &&
            Boolean(security.lockNewChatsByDefault);

        const key = shouldProtect ? await requireUnlockedKey() : null;

        const thread = {
            threadId,
            createdAt,
            updatedAt,
            protected: shouldProtect,
            titleEnc: shouldProtect ? await encryptString(key, normalizedTitle) : null,
            title: shouldProtect ? null : normalizedTitle,
            titleIsDefault: Boolean(titleIsDefault),
            messageCount: 0,
            nextSequence: 1,
            lastPreviewEnc: null,
            lastPreview: null,
        };

        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to create thread'));
            tx.objectStore(STORE_THREADS).add(thread);
        });

        return thread;
    }

    async function upsertThread(thread) {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to update thread'));
            tx.objectStore(STORE_THREADS).put(thread);
        });
    }

    async function getThreadRecord(threadId) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS], 'readonly');
            const request = tx.objectStore(STORE_THREADS).get(threadId);
            request.onerror = () => reject(request.error || new Error('Failed to load thread'));
            request.onsuccess = () => resolve(request.result || null);
        });
    }

    async function getThreadSummary(threadId) {
        const thread = await getThreadRecord(threadId);
        if (!thread) return null;
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        await requireHistoryEnabled(db, { encryptionConfigured });
        const key =
            inferThreadProtected(thread) && encryptionConfigured ? await getUnlockedKey() : null;
        return decryptThreadSummary(thread, { key });
    }

    async function ensureThread(threadId) {
        const existing = await getThreadRecord(threadId);
        if (existing) return existing;
        return createThread({ threadId, title: 'New chat', titleIsDefault: true });
    }

    async function decryptThreadSummary(thread, { key = null } = {}) {
        const protectedThread = inferThreadProtected(thread);
        if (protectedThread && !key) {
            return {
                chatId: thread.threadId,
                title: 'Locked chat',
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
                messageCount: thread.messageCount || 0,
                lastPreview: '',
                isProtected: true,
                locked: true,
            };
        }

        const title = protectedThread
            ? await decryptString(key, thread.titleEnc)
            : normalizeTitle(thread.title) || 'New chat';

        const lastPreview = protectedThread
            ? thread.lastPreviewEnc
                ? await decryptString(key, thread.lastPreviewEnc)
                : ''
            : thread.lastPreview
              ? String(thread.lastPreview || '')
              : '';

        return {
            chatId: thread.threadId,
            title: title || 'New chat',
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            messageCount: thread.messageCount || 0,
            lastPreview: lastPreview || '',
            isProtected: protectedThread,
            locked: false,
        };
    }

    async function listThreads({ limit = 100, cursorUpdatedAt = null } = {}) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        await requireHistoryEnabled(db, { encryptionConfigured });
        const key = encryptionConfigured ? await getUnlockedKey() : null;
        const results = [];

        const range = cursorUpdatedAt ? IDBKeyRange.upperBound(cursorUpdatedAt, true) : null;

        const nextCursor = await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS], 'readonly');
            const store = tx.objectStore(STORE_THREADS);
            const index = store.index('updatedAt');
            const request = index.openCursor(range, 'prev');
            let last = null;

            request.onerror = () => reject(request.error || new Error('Failed to list threads'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(last ? last.updatedAt : null);
                    return;
                }
                const thread = cursor.value;
                results.push(thread);
                last = thread;
                if (results.length >= limit) {
                    resolve(last.updatedAt);
                    return;
                }
                cursor.continue();
            };
        });

        const decrypted = [];
        for (const thread of results) {
            decrypted.push(await decryptThreadSummary(thread, { key }));
        }
        return { threads: decrypted, nextCursorUpdatedAt: nextCursor };
    }

    async function renameThread(threadId, title) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await requireHistoryEnabled(db, { encryptionConfigured });
        const thread = await ensureThread(threadId);
        const protectedThread = inferThreadProtected(thread);
        const normalized = normalizeTitle(title);
        if (!normalized) {
            const err = new Error('Title is empty.');
            err.code = 'TITLE_EMPTY';
            throw err;
        }
        if (protectedThread) {
            const key = await requireUnlockedKey();
            thread.titleEnc = await encryptString(key, normalized);
        } else {
            thread.title = normalized;
        }
        thread.titleIsDefault = false;
        thread.updatedAt = Math.max(
            Number.isFinite(thread.updatedAt) ? thread.updatedAt : 0,
            nowMs()
        );
        await upsertThread(thread);
        const key = protectedThread ? await getUnlockedKey() : null;
        return decryptThreadSummary(thread, { key });
    }

    async function deleteThread(threadId) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        await requireHistoryEnabled(db, { encryptionConfigured });
        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS, STORE_MESSAGES], 'readwrite');
            const threadsStore = tx.objectStore(STORE_THREADS);
            const messagesStore = tx.objectStore(STORE_MESSAGES);
            const index = messagesStore.index('threadId');
            const range = IDBKeyRange.only(threadId);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to delete thread'));

            threadsStore.delete(threadId);
            index.openCursor(range).onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                cursor.delete();
                cursor.continue();
            };
        });
        return { ok: true };
    }

    function generateMessageId() {
        return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }

    async function appendMessage(threadId, message) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await requireHistoryEnabled(db, { encryptionConfigured });
        const thread = await ensureThread(threadId);
        const protectedThread = inferThreadProtected(thread);

        const key = protectedThread ? await requireUnlockedKey() : null;

        const role = String(message?.role || 'assistant');
        const provider = message?.provider ? String(message.provider) : null;
        const createdAt = Number.isFinite(message?.timestamp) ? message.timestamp : nowMs();

        const payload = {
            content: String(message?.content || ''),
            contentHtml: typeof message?.contentHtml === 'string' ? message.contentHtml : undefined,
            agentId: typeof message?.agentId === 'string' ? message.agentId : undefined,
            agentLabel: typeof message?.agentLabel === 'string' ? message.agentLabel : undefined,
            sessionId: message?.sessionId || undefined,
            turnIndex: Number.isFinite(message?.turnIndex) ? message.turnIndex : undefined,
            roundIndex: Number.isFinite(message?.roundIndex) ? message.roundIndex : undefined,
            status: message?.status || undefined,
            error: message?.error || undefined,
            meta: message?.meta || undefined,
        };

        if (!payload.content.trim()) {
            const err = new Error('Empty message content.');
            err.code = 'MESSAGE_EMPTY';
            throw err;
        }

        const sequence = Number.isFinite(thread.nextSequence)
            ? thread.nextSequence
            : (thread.messageCount || 0) + 1;
        const messageId = generateMessageId();
        const payloadEnc = protectedThread ? await encryptJson(key, payload) : null;

        const record = {
            messageId,
            threadId,
            sequence,
            createdAt,
            role,
            provider,
            payloadEnc,
            payload: protectedThread ? null : payload,
        };

        const preview = makePreview(payload.content);
        const previewEnc = protectedThread && preview ? await encryptString(key, preview) : null;

        if (thread.titleIsDefault && role === 'user') {
            const titleCandidate = makePreview(payload.content, 48);
            if (titleCandidate) {
                if (protectedThread) {
                    thread.titleEnc = await encryptString(key, titleCandidate);
                } else {
                    thread.title = titleCandidate;
                }
                thread.titleIsDefault = false;
            }
        }

        thread.updatedAt = nowMs();
        thread.messageCount = (thread.messageCount || 0) + 1;
        thread.nextSequence = sequence + 1;
        thread.protected = protectedThread;
        if (protectedThread) {
            if (previewEnc) thread.lastPreviewEnc = previewEnc;
            thread.lastPreview = null;
        } else {
            if (preview) thread.lastPreview = preview;
            thread.lastPreviewEnc = null;
        }

        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS, STORE_MESSAGES], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to append message'));
            tx.objectStore(STORE_MESSAGES).add(record);
            tx.objectStore(STORE_THREADS).put(thread);
        });

        const decryptedPayload = payload;
        return {
            messageId,
            threadId,
            sequence,
            timestamp: createdAt,
            role,
            provider,
            ...decryptedPayload,
        };
    }

    async function listMessages(threadId, { limit = 50, beforeSequence = null } = {}) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await requireHistoryEnabled(db, { encryptionConfigured });
        const thread = await getThreadRecord(threadId);
        if (!thread) {
            const err = new Error('Chat not found.');
            err.code = 'CHAT_NOT_FOUND';
            throw err;
        }
        const protectedThread = inferThreadProtected(thread);
        const key = protectedThread ? await requireUnlockedKey() : null;
        const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
        if (safeLimit === 0) {
            return { messages: [], nextCursorSequence: null, hasMore: false };
        }
        const messages = [];

        const upper = Number.isFinite(beforeSequence)
            ? Math.max(0, Math.floor(beforeSequence) - 1)
            : Number.MAX_SAFE_INTEGER;
        const range = IDBKeyRange.bound([threadId, 0], [threadId, upper]);

        let hasMore = false;
        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_MESSAGES], 'readonly');
            const store = tx.objectStore(STORE_MESSAGES);
            const index = store.index('threadId_sequence');
            const request = index.openCursor(range, 'prev');
            request.onerror = () => reject(request.error || new Error('Failed to list messages'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                if (messages.length >= safeLimit + 1) {
                    resolve();
                    return;
                }
                messages.push(cursor.value);
                cursor.continue();
            };
        });

        if (messages.length > safeLimit) {
            hasMore = true;
            messages.length = safeLimit;
        }

        messages.reverse();

        const decoded = [];
        for (const record of messages) {
            const payload = protectedThread
                ? (await decryptJson(key, record.payloadEnc)) || {}
                : record.payload && typeof record.payload === 'object'
                  ? record.payload
                  : {};
            decoded.push({
                messageId: record.messageId,
                chatId: record.threadId,
                sequence: record.sequence,
                role: record.role,
                provider: record.provider,
                content: payload.content || '',
                contentHtml: payload.contentHtml,
                agentId: payload.agentId,
                agentLabel: payload.agentLabel,
                timestamp: record.createdAt,
                sessionId: payload.sessionId,
                turnIndex: payload.turnIndex,
                roundIndex: payload.roundIndex,
                status: payload.status,
                error: payload.error,
                meta: payload.meta,
            });
        }

        const nextCursor = hasMore && decoded.length ? decoded[0].sequence : null;
        return { messages: decoded, nextCursorSequence: nextCursor, hasMore };
    }

    async function getThreadWithMessages(threadId, { limit = 50, beforeSequence = null } = {}) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await requireHistoryEnabled(db, { encryptionConfigured });

        const thread = await getThreadRecord(threadId);
        if (!thread) {
            const err = new Error('Chat not found.');
            err.code = 'CHAT_NOT_FOUND';
            throw err;
        }
        const protectedThread = inferThreadProtected(thread);
        const key = protectedThread ? await requireUnlockedKey() : null;
        const summary = await decryptThreadSummary(thread, { key });
        const page = await listMessages(threadId, { limit, beforeSequence });
        return { thread: summary, page };
    }

    async function setHistoryEnabled() {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        await updateSecuritySettings(db, { historyEnabled: true }, { encryptionConfigured });
        return getStatus();
    }

    async function setLockNewChatsByDefault(enabled) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        await updateSecuritySettings(
            db,
            { lockNewChatsByDefault: Boolean(enabled) },
            { encryptionConfigured }
        );
        return getStatus();
    }

    async function loadAllThreadsRaw(db) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS], 'readonly');
            const store = tx.objectStore(STORE_THREADS);
            const threads = [];
            const request = store.openCursor();
            request.onerror = () => reject(request.error || new Error('Failed to load threads'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(threads);
                    return;
                }
                threads.push(cursor.value);
                cursor.continue();
            };
        });
    }

    async function loadAllMessagesForThreadRaw(db, threadId) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_MESSAGES], 'readonly');
            const store = tx.objectStore(STORE_MESSAGES);
            const index = store.index('threadId');
            const range = IDBKeyRange.only(threadId);
            const messages = [];
            const request = index.openCursor(range);
            request.onerror = () => reject(request.error || new Error('Failed to load messages'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(messages);
                    return;
                }
                messages.push(cursor.value);
                cursor.continue();
            };
        });
    }

    async function protectThreadRecords(db, thread, key) {
        const threadId = thread?.threadId;
        if (!threadId) {
            const err = new Error('Chat not found.');
            err.code = 'CHAT_NOT_FOUND';
            throw err;
        }
        if (inferThreadProtected(thread)) return;

        const normalizedTitle = normalizeTitle(thread.title) || 'New chat';
        const preview = thread.lastPreview ? String(thread.lastPreview || '') : '';

        const updatedThread = {
            ...thread,
            protected: true,
            title: null,
            lastPreview: null,
            titleEnc: await encryptString(key, normalizedTitle),
            lastPreviewEnc: preview ? await encryptString(key, preview) : null,
        };

        const messages = await loadAllMessagesForThreadRaw(db, threadId);
        const updatedMessages = [];
        for (const record of messages) {
            if (!record || typeof record !== 'object') continue;
            if (record.payloadEnc) {
                if (record.payload) updatedMessages.push({ ...record, payload: null });
                continue;
            }
            const payload =
                record.payload && typeof record.payload === 'object' ? record.payload : null;
            if (!payload) continue;
            const payloadEnc = await encryptJson(key, payload);
            updatedMessages.push({ ...record, payload: null, payloadEnc });
        }

        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS, STORE_MESSAGES], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to protect chat'));
            tx.objectStore(STORE_THREADS).put(updatedThread);
            const store = tx.objectStore(STORE_MESSAGES);
            updatedMessages.forEach((record) => store.put(record));
        });
    }

    async function unprotectThreadRecords(db, thread, key) {
        const threadId = thread?.threadId;
        if (!threadId) {
            const err = new Error('Chat not found.');
            err.code = 'CHAT_NOT_FOUND';
            throw err;
        }
        if (!inferThreadProtected(thread)) return;

        const title = await decryptString(key, thread.titleEnc);
        const preview = thread.lastPreviewEnc
            ? await decryptString(key, thread.lastPreviewEnc)
            : '';

        const updatedThread = {
            ...thread,
            protected: false,
            title: normalizeTitle(title) || 'New chat',
            lastPreview: preview ? String(preview || '') : '',
            titleEnc: null,
            lastPreviewEnc: null,
        };

        const messages = await loadAllMessagesForThreadRaw(db, threadId);
        const updatedMessages = [];
        for (const record of messages) {
            if (!record || typeof record !== 'object') continue;
            if (!record.payloadEnc) continue;
            const payload = (await decryptJson(key, record.payloadEnc)) || {};
            updatedMessages.push({ ...record, payloadEnc: null, payload });
        }

        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS, STORE_MESSAGES], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to unprotect chat'));
            tx.objectStore(STORE_THREADS).put(updatedThread);
            const store = tx.objectStore(STORE_MESSAGES);
            updatedMessages.forEach((record) => store.put(record));
        });
    }

    async function protectThread(threadId) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        if (!encryptionConfigured) {
            const err = new Error('Encryption is not configured.');
            err.code = 'ENCRYPTION_NOT_CONFIGURED';
            throw err;
        }
        await requireHistoryEnabled(db, { encryptionConfigured });
        const key = await requireUnlockedKey();
        const thread = await getThreadRecord(threadId);
        if (!thread) {
            const err = new Error('Chat not found.');
            err.code = 'CHAT_NOT_FOUND';
            throw err;
        }
        await protectThreadRecords(db, thread, key);
        return getThreadSummary(threadId);
    }

    async function unprotectThread(threadId) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        if (!encryptionConfigured) {
            const err = new Error('Encryption is not configured.');
            err.code = 'ENCRYPTION_NOT_CONFIGURED';
            throw err;
        }
        await requireHistoryEnabled(db, { encryptionConfigured });
        const key = await requireUnlockedKey();
        const thread = await getThreadRecord(threadId);
        if (!thread) {
            const err = new Error('Chat not found.');
            err.code = 'CHAT_NOT_FOUND';
            throw err;
        }
        await unprotectThreadRecords(db, thread, key);
        return getThreadSummary(threadId);
    }

    async function setProtectionMode(mode) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        if (!encryptionConfigured) {
            const err = new Error('Encryption is not configured.');
            err.code = 'ENCRYPTION_NOT_CONFIGURED';
            throw err;
        }
        await requireHistoryEnabled(db, { encryptionConfigured });
        const nextMode = normalizeProtectionMode(mode, { encryptionConfigured });
        await updateSecuritySettings(
            db,
            { historyEnabled: true, protectionMode: nextMode },
            { encryptionConfigured }
        );
        return getStatus();
    }

    async function disableProtection(passphrase) {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        if (!encryptionConfigured) {
            const err = new Error('Encryption is not configured.');
            err.code = 'ENCRYPTION_NOT_CONFIGURED';
            throw err;
        }
        await requireHistoryEnabled(db, { encryptionConfigured });

        const status = await getStatus();
        if (!status.unlocked) {
            await unlock(passphrase);
        }
        const key = await requireUnlockedKey();

        const threads = await loadAllThreadsRaw(db);
        for (const thread of threads) {
            if (!thread) continue;
            if (!inferThreadProtected(thread)) continue;
            await unprotectThreadRecords(db, thread, key);
        }

        await deleteSetting(db, 'crypto');
        await updateSecuritySettings(
            db,
            { protectionMode: 'off' },
            { encryptionConfigured: false }
        );
        await clearSessionKey();
        return getStatus();
    }

    async function resetProtection() {
        const db = await openDb();
        const cryptoConfig = await getCryptoConfig(db);
        const encryptionConfigured = Boolean(
            cryptoConfig && cryptoConfig.version === 1 && cryptoConfig.salt && cryptoConfig.keyCheck
        );
        const security = await getSecuritySettings(db, { encryptionConfigured });

        if (!encryptionConfigured) {
            await updateSecuritySettings(
                db,
                { protectionMode: 'off' },
                { encryptionConfigured: false }
            );
            await clearSessionKey();
            return getStatus();
        }

        const threads = await loadAllThreadsRaw(db);
        const protectedIds = threads
            .filter((thread) => thread && inferThreadProtected(thread))
            .map((thread) => thread.threadId)
            .filter(Boolean);

        if (protectedIds.length > 0) {
            await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE_THREADS, STORE_MESSAGES], 'readwrite');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('Failed to reset protection'));
                const threadsStore = tx.objectStore(STORE_THREADS);
                const messagesStore = tx.objectStore(STORE_MESSAGES);
                const index = messagesStore.index('threadId');

                protectedIds.forEach((threadId) => {
                    threadsStore.delete(threadId);
                    const range = IDBKeyRange.only(threadId);
                    index.openCursor(range).onsuccess = (event) => {
                        const cursor = event.target.result;
                        if (!cursor) return;
                        cursor.delete();
                        cursor.continue();
                    };
                });
            });
        }

        await deleteSetting(db, 'crypto');
        await updateSecuritySettings(
            db,
            { historyEnabled: true, protectionMode: 'off' },
            { encryptionConfigured: false }
        );
        await clearSessionKey();
        return getStatus();
    }

    async function resetAllData() {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_THREADS, STORE_MESSAGES, STORE_SETTINGS], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Failed to reset history'));
            tx.objectStore(STORE_THREADS).clear();
            tx.objectStore(STORE_MESSAGES).clear();
            tx.objectStore(STORE_SETTINGS).clear();
        });
        await clearSessionKey();
        return { ok: true };
    }

    async function setActiveThreadId(threadId) {
        const db = await openDb();
        await setSetting(db, 'activeThreadId', threadId || null);
        return { ok: true, activeChatId: threadId || null };
    }

    async function getActiveThreadId() {
        const db = await openDb();
        const record = await getSetting(db, 'activeThreadId');
        const value = record?.value;
        return typeof value === 'string' ? value : null;
    }

    async function getMeta(key) {
        const db = await openDb();
        const record = await getSetting(db, key);
        return record ? record.value : null;
    }

    async function setMeta(key, value) {
        const db = await openDb();
        await setSetting(db, key, value);
        return { ok: true };
    }

    async function deleteMeta(key) {
        const db = await openDb();
        await deleteSetting(db, key);
        return { ok: true };
    }

    self.mlcHistoryStore = {
        openDb,
        getStatus,
        setHistoryEnabled,
        setProtectionMode,
        setLockNewChatsByDefault,
        configureEncryption,
        unlock,
        lock,
        resetProtection,
        disableProtection,
        resetAllData,
        listThreads,
        getThreadSummary,
        getThreadWithMessages,
        createThread,
        renameThread,
        deleteThread,
        protectThread,
        unprotectThread,
        appendMessage,
        listMessages,
        setActiveThreadId,
        getActiveThreadId,
        getMeta,
        setMeta,
        deleteMeta,
    };
})();
