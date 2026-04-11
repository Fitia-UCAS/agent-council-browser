(function () {
    const host = location.hostname;
    const isChatGPT = host.includes('openai.com') || host.includes('chatgpt.com');
    const isGemini = host.includes('gemini.google.com');
    const isClaude = host.includes('claude.ai');
    const isGrok = host.includes('grok.com');
    if (!isChatGPT && !isGemini && !isClaude && !isGrok) return;

    const captureProviders =
        globalThis.MLCCaptureProviders && typeof globalThis.MLCCaptureProviders === 'object'
            ? globalThis.MLCCaptureProviders
            : {};
    const providerFromRegistry = Object.values(captureProviders).find((provider) => {
        if (!provider || typeof provider.matchesHost !== 'function') return false;
        return provider.matchesHost(host);
    });

    const currentLLM =
        providerFromRegistry?.id ||
        (isChatGPT ? 'chatgpt' : isGemini ? 'gemini' : isClaude ? 'claude' : 'grok');
    const providerCaptureProfile = captureProviders[currentLLM] || null;
    const CONTENT_SCRIPT_BUILD = 'readiness-r1-2026-04-05';
    const CAPTURE_TEST_MODE = globalThis.__MLC_CAPTURE_TEST_MODE__ === true;
    const READINESS_REASON_READY = 'ready';
    const READINESS_REASON_AUTH_REQUIRED = 'auth_required';
    const READINESS_REASON_LOADING = 'loading';
    const READINESS_REASON_COMPOSER_MISSING = 'composer_missing';
    const READINESS_REASON_NOT_RESPONDING = 'not_responding';

    console.log(
        `[MLC ContentScript] Initializing for ${currentLLM} (build=${CONTENT_SCRIPT_BUILD}).`
    );

    const CaptureUtils = globalThis.MLCCaptureUtils || null;

    // Cleanup for legacy builds that injected cross-provider forwarding toggles.
    document.querySelectorAll('#mlc-forward-toggle').forEach((node) => node.remove());
    if (!document.getElementById('mlc-forward-toggle-style')) {
        const style = document.createElement('style');
        style.id = 'mlc-forward-toggle-style';
        style.textContent =
            '#mlc-forward-toggle{display:none !important; visibility:hidden !important; pointer-events:none !important;}';
        (document.head || document.documentElement).appendChild(style);
    }

    function isCaptureDebugEnabled() {
        try {
            const value = localStorage.getItem('mlc_capture_debug');
            return value === '1' || value === 'true';
        } catch (error) {
            return false;
        }
    }

    function captureDebug(...args) {
        if (!isCaptureDebugEnabled()) return;
        console.log('[MLC Capture Debug]', ...args);
    }

    const captureState = {
        active: false,
        promptId: null,
        turnAttemptId: null,
        promptPreview: '',
        sessionId: null,
        turnIndex: null,
        agentId: null,
        startedAt: 0,
        lastText: '',
        baselineText: '',
        baselineBestBottom: null,
        baselineBestOrder: null,
        baselineBestSignature: '',
        baselineAssistantCount: null,
        baselineAssistantIndex: null,
        hasNewText: false,
        sawGenerating: false,
        lastTextChangeAt: 0,
        lastEmitAt: 0,
        lastExtractionMeta: null,
        grokBaselineBestBottom: null,
        grokBaselineCandidateCount: null,
        grokLastBestBottom: null,
        grokLastShapeSignature: '',
        grokSawStopControl: false,
        grokSawVoiceAfterStop: false,
        grokBaselineTranscriptTail: '',
    };

    // Global message listener for connection testing and capture arming
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'PING') {
            const readiness = probeProviderReadiness();
            console.log(`[MLC ContentScript - ${currentLLM}] Received PING, responding with PONG`);
            sendResponse({
                type: 'PONG',
                llm: currentLLM,
                status: readiness.ready ? 'ready' : 'not_ready',
                readiness,
            });
            return true; // Keep message channel open for async response
        }
        if (message.type === 'MLC_PROMPT_SENT') {
            if (!message.llmType || message.llmType === currentLLM) {
                armCapture(message);
            }
            sendResponse({ received: true });
            return true;
        }
        if (message.type === 'NEW_PROMPT_SENT' || message.type === 'NEW_MULTI_AGENT_PROMPT_SENT') {
            armCapture({
                promptId: message.promptId || message.sessionId,
                sessionId: message.sessionId || null,
                turnIndex: message.turnIndex || null,
                timestamp: message.timestamp || Date.now(),
            });
            sendResponse({ received: true });
            return true;
        }
        return false; // Don't handle other messages here
    });

    function findInput(options = {}) {
        const selectors = isChatGPT
            ? [
                  '#prompt-textarea',
                  'textarea[data-testid="prompt-textarea"]',
                  'textarea[placeholder*="Message"]',
                  'textarea',
                  '[contenteditable="true"]',
              ]
            : isGemini
              ? [
                    'div.ql-editor[role="textbox"]',
                    '.ql-editor.textarea',
                    'div[contenteditable="true"][aria-label*="prompt"]',
                    'textarea[placeholder*="Enter a prompt"]',
                    'textarea[placeholder*="Ask"]',
                    'textarea',
                    '[contenteditable="true"]',
                ]
              : isClaude
                ? [
                      'textarea[placeholder*="Message" i]',
                      'textarea[aria-label*="Message" i]',
                      'textarea[placeholder*="Send" i]',
                      'textarea',
                      '.ProseMirror[contenteditable="true"]',
                      'div[contenteditable="true"][role="textbox"]',
                      'div[contenteditable="true"]',
                      '[contenteditable="true"]',
                      '[role="textbox"]',
                  ]
                : [
                      'textarea[aria-label*="message" i]',
                      'textarea[placeholder*="message" i]',
                      'textarea[placeholder*="ask" i]',
                      'textarea[placeholder*="chat" i]',
                      'textarea',
                      'div[contenteditable="true"][role="textbox"]',
                      '[contenteditable="true"][role="textbox"]',
                      '[contenteditable="true"]',
                      '[role="textbox"]',
                  ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                // console.log(`[MLC ContentScript - ${currentLLM}] Found input with selector:`, sel, el);
                return el;
            }
        }
        if (!options.silent) {
            console.error(`[MLC ContentScript - ${currentLLM}] Input element NOT found.`);
        }
        return null;
    }

    function armCapture(message) {
        if (!message || !message.promptId) return;
        captureState.active = true;
        captureState.promptId = message.promptId;
        captureState.turnAttemptId =
            typeof message.turnAttemptId === 'string' && message.turnAttemptId.trim()
                ? message.turnAttemptId.trim()
                : null;
        captureState.promptPreview =
            typeof message.promptPreview === 'string' ? message.promptPreview : '';
        captureState.sessionId = message.sessionId || null;
        captureState.turnIndex = message.turnIndex || null;
        captureState.agentId =
            typeof message.agentId === 'string' && message.agentId.trim()
                ? message.agentId.trim()
                : null;
        captureState.startedAt = message.timestamp || Date.now();
        captureState.lastText = '';
        captureState.baselineAssistantCount = null;
        captureState.baselineAssistantIndex = null;
        const baselineExtraction = extractLatestResponse({ withMeta: true });
        captureState.baselineText = baselineExtraction.text || '';
        captureState.baselineBestBottom = Number.isFinite(baselineExtraction.meta?.bestBottom)
            ? baselineExtraction.meta.bestBottom
            : null;
        captureState.baselineBestOrder = Number.isFinite(baselineExtraction.meta?.bestOrder)
            ? baselineExtraction.meta.bestOrder
            : null;
        captureState.baselineBestSignature =
            typeof baselineExtraction.meta?.bestSignature === 'string'
                ? baselineExtraction.meta.bestSignature
                : '';
        if (isChatGPT) {
            const baselineIndex = Number.isFinite(baselineExtraction.meta?.bestAssistantIndex)
                ? baselineExtraction.meta.bestAssistantIndex
                : null;
            captureState.baselineAssistantIndex = baselineIndex;
            captureState.baselineAssistantCount =
                baselineIndex !== null
                    ? Math.max(0, baselineIndex + 1)
                    : getChatGPTConversationAssistantNodes().length;
        }
        captureState.hasNewText = false;
        captureState.sawGenerating = false;
        captureState.lastTextChangeAt = captureState.startedAt;
        captureState.lastEmitAt = 0;
        captureState.lastExtractionMeta = null;
        captureState.grokBaselineBestBottom = Number.isFinite(baselineExtraction.meta?.bestBottom)
            ? baselineExtraction.meta.bestBottom
            : null;
        captureState.grokBaselineCandidateCount = Number.isFinite(
            baselineExtraction.meta?.candidateCount
        )
            ? baselineExtraction.meta.candidateCount
            : null;
        captureState.grokLastBestBottom = captureState.grokBaselineBestBottom;
        captureState.grokLastShapeSignature =
            typeof baselineExtraction.meta?.bestShapeSignature === 'string'
                ? baselineExtraction.meta.bestShapeSignature
                : '';
        captureState.grokSawStopControl = false;
        captureState.grokSawVoiceAfterStop = false;
        captureState.grokBaselineTranscriptTail = isGrok ? extractGrokTranscriptTailText() : '';
        console.log(`[MLC Capture - ${currentLLM}] Armed for prompt ${message.promptId}`);
        captureDebug('Armed', {
            llm: currentLLM,
            promptId: message.promptId,
            turnAttemptId: captureState.turnAttemptId,
            sessionId: captureState.sessionId,
            turnIndex: captureState.turnIndex,
            baselineAssistantCount: captureState.baselineAssistantCount,
            baselineAssistantIndex: captureState.baselineAssistantIndex,
            baselinePreview: String(captureState.baselineText || '').slice(0, 160),
        });
        if (!CAPTURE_TEST_MODE) {
            setTimeout(() => scheduleEvaluateCapture(), 1200);
        }
    }

    function isElementVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        if (!el.isConnected) return false;
        let style = null;
        try {
            style = window.getComputedStyle(el);
        } catch (error) {
            style = null;
        }
        if (style) {
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            const opacity = parseFloat(style.opacity || '1');
            if (Number.isFinite(opacity) && opacity <= 0) return false;
        }

        let rect = null;
        try {
            rect = el.getBoundingClientRect();
        } catch (error) {
            rect = null;
        }
        if (!rect) return CAPTURE_TEST_MODE;
        if (!(rect.width > 0 && rect.height > 0)) {
            return CAPTURE_TEST_MODE;
        }

        return (
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
        );
    }

    function isElementDisabled(el) {
        if (!el || !(el instanceof Element)) return true;
        if ('disabled' in el && el.disabled) return true;
        if ('readOnly' in el && el.readOnly) return true;
        const ariaDisabled = el.getAttribute?.('aria-disabled');
        if (typeof ariaDisabled === 'string' && ariaDisabled.toLowerCase() === 'true') return true;
        if (el.getAttribute?.('disabled') !== null) return true;
        return false;
    }

    function findVisibleElement(selectors, { root = document, allowDisabled = true } = {}) {
        const list = Array.isArray(selectors) ? selectors : [];
        for (const selector of list) {
            let nodes = [];
            try {
                nodes = Array.from(root.querySelectorAll(selector));
            } catch (error) {
                nodes = [];
            }
            for (const node of nodes) {
                if (!(node instanceof Element)) continue;
                if (!isElementVisible(node)) continue;
                if (!allowDisabled && isElementDisabled(node)) continue;
                return node;
            }
        }
        return null;
    }

    function getElementActionLabel(element) {
        if (!element) return '';
        const candidates = [
            element.getAttribute?.('aria-label') || '',
            element.getAttribute?.('title') || '',
            element.getAttribute?.('value') || '',
            element.textContent || '',
        ];
        return String(candidates.filter(Boolean).join(' '))
            .replace(/\s+/g, ' ')
            .trim();
    }

    function findSendControlForReadiness() {
        if (isGrok) {
            return (
                findGrokControlButton('send', { allowDisabled: true, includeDocument: true }) ||
                findVisibleElement(
                    [
                        'button[aria-label*="send" i]',
                        'button[title*="send" i]',
                        'button[type="submit"]',
                    ],
                    { allowDisabled: true }
                )
            );
        }

        const selectors = isChatGPT
            ? [
                  'button[data-testid="send-button"]',
                  'button[aria-label*="send" i]',
                  'button[title*="send" i]',
                  'button[type="submit"]',
              ]
            : isGemini
              ? [
                    'button[aria-label*="send" i]',
                    'button[title*="send" i]',
                    'button[type="submit"]',
                  ]
              : [
                    'button[data-testid*="send" i]',
                    'button[aria-label*="send" i]',
                    'button[title*="send" i]',
                    'button[type="submit"]',
                  ];

        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? inputEl.closest('form') ||
              inputEl.closest('footer') ||
              inputEl.closest('[role="form"]') ||
              inputEl.parentElement
            : null;

        return (
            (composerRoot ? findVisibleElement(selectors, { root: composerRoot }) : null) ||
            findVisibleElement(selectors)
        );
    }

    function hasVisibleAuthPrompt() {
        const visibleAuthField = findVisibleElement(
            [
                'input[type="password"]',
                'input[name*="password" i]',
                'input[autocomplete="current-password"]',
                'input[autocomplete="username"]',
                'input[autocomplete="email"]',
            ],
            { allowDisabled: true }
        );
        if (visibleAuthField) return true;

        const authCtaPattern =
            /\b(sign in|sign-in|log in|login|log-in|se connecter|connexion|inscription|sign up|signup|create account|continue with google|continue with apple|continue with email|get started|commencer)\b/i;
        const candidates = Array.from(
            document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')
        );
        return candidates.some((node) => {
            if (!(node instanceof Element) || !isElementVisible(node)) return false;
            const label = getElementActionLabel(node);
            return Boolean(label) && authCtaPattern.test(label);
        });
    }

    function hasVisibleLoadingIndicator() {
        return Boolean(
            findVisibleElement(
                [
                    '[role="progressbar"]',
                    'mat-progress-spinner',
                    'mat-spinner',
                    '.loading',
                    '.spinner',
                    '.animate-spin',
                ],
                { allowDisabled: true }
            )
        );
    }

    function createReadinessResult({
        ready = false,
        reason = READINESS_REASON_NOT_RESPONDING,
        hasInput = false,
        hasSendControl = false,
    } = {}) {
        return {
            ready: Boolean(ready),
            reason: ready ? READINESS_REASON_READY : reason || READINESS_REASON_NOT_RESPONDING,
            hasInput: Boolean(hasInput),
            hasSendControl: Boolean(hasSendControl),
        };
    }

    function probeProviderReadiness() {
        try {
            const inputEl = findInput({ silent: true });
            const hasInput = Boolean(
                inputEl && isElementVisible(inputEl) && !isElementDisabled(inputEl)
            );
            const sendControl = findSendControlForReadiness();
            const hasSendControl = Boolean(sendControl && isElementVisible(sendControl));

            if (hasInput || hasSendControl) {
                return createReadinessResult({
                    ready: true,
                    hasInput,
                    hasSendControl,
                });
            }

            if (hasVisibleAuthPrompt()) {
                return createReadinessResult({
                    reason: READINESS_REASON_AUTH_REQUIRED,
                    hasInput,
                    hasSendControl,
                });
            }

            if (document.readyState !== 'complete' || hasVisibleLoadingIndicator()) {
                return createReadinessResult({
                    reason: READINESS_REASON_LOADING,
                    hasInput,
                    hasSendControl,
                });
            }

            return createReadinessResult({
                reason: READINESS_REASON_COMPOSER_MISSING,
                hasInput,
                hasSendControl,
            });
        } catch (error) {
            return createReadinessResult({
                reason: READINESS_REASON_NOT_RESPONDING,
            });
        }
    }

    function isChatGPTGenerating() {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? inputEl.closest('form') || inputEl.closest('[role="form"]') || inputEl.parentElement
            : null;

        const strictStopSelector = [
            'button[data-testid="stop-button"]',
            'button[data-testid="fruitjuice-stop-button"]',
            'button[aria-label*="Stop generating" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Arrêter" i]',
            'button[aria-label*="Annuler" i]',
            'button[title*="Stop" i]',
            'button[title*="Arrêter" i]',
            'button[title*="Annuler" i]',
        ].join(', ');
        const looseStopSelector = `${strictStopSelector}, button[data-testid*="stop" i]`;

        const isBottomViewportControl = (node) => {
            if (!node) return false;
            try {
                const rect = node.getBoundingClientRect();
                return Number.isFinite(rect.bottom) && rect.bottom >= window.innerHeight - 260;
            } catch (error) {
                return false;
            }
        };

        if (composerRoot) {
            const stopButton = composerRoot.querySelector(looseStopSelector);
            if (stopButton && isElementVisible(stopButton)) return true;
        }

        const stopCandidates = Array.from(document.querySelectorAll(strictStopSelector));
        for (const candidate of stopCandidates) {
            if (!isElementVisible(candidate)) continue;
            if (composerRoot && composerRoot.contains(candidate)) return true;
            if (isBottomViewportControl(candidate)) return true;
        }

        // Fallback: look for a visible button whose text indicates generation is running.
        const buttonScope = composerRoot || document;
        const buttons = Array.from(buttonScope.querySelectorAll('button'));
        for (const button of buttons) {
            if (!isElementVisible(button)) continue;
            const label = (button.textContent || '').trim().toLowerCase();
            if (!label) continue;
            if (label === 'stop' || label === 'arrêter' || label === 'annuler') return true;
        }
        return false;
    }

    function isGeminiGenerating() {
        const stopIcon = document.querySelector('mat-icon[fonticon=\"stop\"]');
        if (stopIcon && isElementVisible(stopIcon)) return true;
        const stopButton = document.querySelector(
            'button[aria-label*=\"Stop\" i], button[aria-label*=\"Cancel\" i]'
        );
        if (stopButton && isElementVisible(stopButton)) return true;
        const spinner = document.querySelector(
            'mat-progress-spinner, mat-spinner, [role=\"progressbar\"], .loading, .spinner'
        );
        if (spinner && isElementVisible(spinner)) return true;
        const sendButton = document.querySelector(
            'button[aria-label*=\"Send\" i], button[data-testid=\"send-button\"]'
        );
        if (sendButton && isElementVisible(sendButton) && !sendButton.disabled) return false;
        return false;
    }

    function isClaudeGenerating() {
        const stopButton = document.querySelector(
            'button[aria-label*=\"Stop\" i], button[aria-label*=\"Cancel\" i], button[aria-label*=\"Annuler\" i], button[aria-label*=\"Arrêter\" i], button[title*=\"Stop\" i], button[title*=\"Cancel\" i], button[title*=\"Annuler\" i], button[title*=\"Arrêter\" i], button[data-testid*=\"stop\" i]'
        );
        if (stopButton && isElementVisible(stopButton)) return true;
        const spinner = document.querySelector(
            '[role=\"progressbar\"], .loading, .spinner, .animate-spin'
        );
        if (spinner && isElementVisible(spinner)) return true;
        return false;
    }

    function normalizeGrokControlLabel(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function getGrokControlLabel(element) {
        if (!element) return '';
        const parts = [
            element.getAttribute?.('aria-label') || '',
            element.getAttribute?.('title') || '',
            element.textContent || '',
            element.getAttribute?.('data-testid') || '',
        ];
        return normalizeGrokControlLabel(parts.filter(Boolean).join(' '));
    }

    function classifyGrokControlElement(element) {
        if (!element) return 'unknown';
        const label = getGrokControlLabel(element);
        const stopPatterns = [
            /\bstop\b/i,
            /\bcancel\b/i,
            /\bannuler\b/i,
            /\barreter\b/i,
            /\barreter la reponse du modele\b/i,
        ];
        if (stopPatterns.some((re) => re.test(label))) return 'stop';

        const voicePatterns = [/\bpasser en mode vocal\b/i, /\bmode vocal\b/i, /\bvoice mode\b/i];
        if (voicePatterns.some((re) => re.test(label))) return 'voice';

        const sendPatterns = [/\bsend\b/i, /\bsubmit\b/i, /\bsoumettre\b/i, /\benvoyer\b/i];
        const typeAttr = normalizeGrokControlLabel(element.getAttribute?.('type') || '');
        if (sendPatterns.some((re) => re.test(label)) || typeAttr === 'submit') return 'send';
        return 'unknown';
    }

    function findGrokControlButton(role, { allowDisabled = true, includeDocument = true } = {}) {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? inputEl.closest('form') ||
              inputEl.closest('footer') ||
              inputEl.closest('[role="form"]') ||
              inputEl.parentElement
            : null;
        const roots = [];
        if (composerRoot) roots.push(composerRoot);
        if (includeDocument) roots.push(document);
        const seen = new Set();

        for (const root of roots) {
            let buttons = [];
            try {
                buttons = Array.from(root.querySelectorAll('button'));
            } catch (error) {
                buttons = [];
            }
            for (const button of buttons) {
                if (!(button instanceof HTMLElement)) continue;
                if (seen.has(button)) continue;
                seen.add(button);
                if (!isElementVisible(button)) continue;
                if (
                    !allowDisabled &&
                    (button.disabled ||
                        String(button.getAttribute?.('aria-disabled') || '').toLowerCase() ===
                            'true')
                )
                    continue;
                const currentRole = classifyGrokControlElement(button);
                if (currentRole === role) return button;
            }
        }
        return null;
    }

    function getGrokControlState() {
        const stopButton = findGrokControlButton('stop', {
            allowDisabled: true,
            includeDocument: true,
        });
        const voiceButton = findGrokControlButton('voice', {
            allowDisabled: true,
            includeDocument: true,
        });
        const sendButton = findGrokControlButton('send', {
            allowDisabled: true,
            includeDocument: true,
        });
        return {
            stopVisible: Boolean(stopButton && isElementVisible(stopButton)),
            voiceVisible: Boolean(voiceButton && isElementVisible(voiceButton)),
            sendVisible: Boolean(sendButton && isElementVisible(sendButton)),
            sendDisabled: Boolean(
                sendButton &&
                (sendButton.disabled ||
                    String(sendButton.getAttribute?.('aria-disabled') || '').toLowerCase() ===
                        'true')
            ),
        };
    }

    function isGrokControlOnlyText(text) {
        if (!text || !String(text).trim()) return false;
        if (CaptureUtils && typeof CaptureUtils.looksLikeUiControlText === 'function') {
            return CaptureUtils.looksLikeUiControlText(text, { provider: 'grok' });
        }
        const normalized = normalizeGrokControlLabel(text);
        if (!normalized) return false;
        const lines = normalized
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length === 0 || lines.length > 5) return false;
        const wordCount = normalized.split(/\s+/).filter(Boolean).length;
        if (wordCount > 24) return false;
        const patterns = [
            /\bsend\b/i,
            /\bsubmit\b/i,
            /\bsoumettre\b/i,
            /\benvoyer\b/i,
            /\bstop\b/i,
            /\bcancel\b/i,
            /\bannuler\b/i,
            /\barreter\b/i,
            /\bpasser en mode vocal\b/i,
            /\bmode vocal\b/i,
            /\bvoice mode\b/i,
            /\bare you satisfied with .* answer\b/i,
            /\bsatisfied with .* answer\b/i,
            /\betes[-\s]?vous satisfait\b/i,
        ];
        const latencyOnlyPattern = /^\s*~?\d+(?:[.,]\d+)?\s*(ms|s)\s*$/i;
        if (lines.length === 1 && latencyOnlyPattern.test(lines[0])) return true;
        const controlLines = lines.filter((line) => patterns.some((pattern) => pattern.test(line)));
        return controlLines.length > 0 && controlLines.length === lines.length;
    }

    function isGrokGenerating() {
        const control = getGrokControlState();
        if (control.voiceVisible) return false;
        if (control.stopVisible) return true;
        const spinner = document.querySelector(
            '[role=\"progressbar\"], .loading, .spinner, .animate-spin'
        );
        if (spinner && isElementVisible(spinner)) return true;
        return false;
    }

    function isGenerating() {
        if (isChatGPT) return isChatGPTGenerating();
        if (isGemini) return isGeminiGenerating();
        if (isClaude) return isClaudeGenerating();
        return isGrokGenerating();
    }

    function getTrimmedText(node) {
        if (!node) return '';
        const text = node.innerText || node.textContent || '';
        return (text || '').trim();
    }

    function looksLikeUiChromeText(text, options = {}) {
        const raw = String(text || '').trim();
        if (!raw) return false;
        if (CaptureUtils && typeof CaptureUtils.looksLikeUiControlText === 'function') {
            if (CaptureUtils.looksLikeUiControlText(raw, { provider: options.provider || '' })) {
                return true;
            }
        }

        const normalized = normalizeCaptureCandidateText(raw).toLowerCase();
        if (!normalized) return false;

        const wordCount = getCaptureWordCount(normalized);
        if (wordCount === 0 || wordCount > 12) return false;

        const chromePatterns = [
            /^copy$/,
            /^copier$/,
            /^share$/,
            /^partager$/,
            /^edit$/,
            /^modifier$/,
            /^retry$/,
            /^try again$/,
            /^regenerate$/,
            /^read aloud$/,
            /^listen$/,
            /^speak$/,
            /^voice$/,
            /^thumbs up$/,
            /^thumbs down$/,
            /^good response$/,
            /^bad response$/,
            /^continue generating$/,
            /^show more$/,
            /^show less$/,
            /^more$/,
            /^less$/,
        ];
        return chromePatterns.some((pattern) => pattern.test(normalized));
    }

    function looksLikeUiChromeElement(element, options = {}) {
        if (!element || element.nodeType !== 1) return false;
        const descriptor = [
            getElementAttributeValue(element, 'role'),
            getElementAttributeValue(element, 'aria-label'),
            getElementAttributeValue(element, 'title'),
            getElementAttributeValue(element, 'data-testid'),
            String(element.className || '').toLowerCase(),
        ].join(' ');
        const text = getTrimmedText(element);
        if (looksLikeUiChromeText(text, options)) return true;
        if (!descriptor) return false;
        if (
            /\b(toolbar|feedback|controls?|copy|share|edit|retry|regenerate|thumb|vote|reaction|composer|button|action)\b/.test(
                descriptor
            )
        ) {
            return !text || looksLikeUiChromeText(text, options);
        }
        return false;
    }

    function sanitizeContentClone(node, options = {}) {
        if (!node) return null;
        const clone = node.cloneNode(true);

        const removeSelectors = [
            'script',
            'style',
            'noscript',
            'button',
            'form',
            'input',
            'textarea',
            'select',
            'option',
            'img',
            'video',
            'audio',
            'canvas',
            'picture',
            'svg',
            'nav',
            'footer',
            '[role="button"]',
            '[role="menu"]',
            '[role="menuitem"]',
            '[role="tooltip"]',
            '[contenteditable="true"]',
        ];
        clone.querySelectorAll(removeSelectors.join(',')).forEach((el) => el.remove());

        const toRemove = [];
        clone.querySelectorAll('*').forEach((el) => {
            if (looksLikeUiChromeElement(el, options)) {
                toRemove.push(el);
            }
        });
        toRemove.forEach((el) => el.remove());
        return clone;
    }

    function getBoundedHtmlFromNode(node) {
        if (!node) return '';
        const html = node.innerHTML || '';
        const MAX_HTML_CHARS = 120000;
        if (html.length > MAX_HTML_CHARS) return '';
        return html;
    }

    function extractCleanHtmlFromNode(node, options = {}) {
        if (!node) return '';
        const prepared = options.skipSanitize ? node : sanitizeContentClone(node, options);
        return getBoundedHtmlFromNode(prepared);
    }

    function looksLikeChatGPTSourcesOnly(text) {
        if (CaptureUtils && typeof CaptureUtils.looksLikeReferenceList === 'function') {
            return CaptureUtils.looksLikeReferenceList(text, { provider: 'chatgpt' });
        }

        const raw = (text || '').trim();
        if (!raw) return false;

        const lines = raw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        if (lines.length < 4) return false;

        // Legacy fallback: list of titles plus "+N" lines.
        const plusLines = lines.filter((line) => /^\+\d+$/.test(line)).length;
        if (plusLines === 0) return false;

        const totalLen = lines.reduce((sum, line) => sum + line.length, 0);
        const avgLen = totalLen / Math.max(1, lines.length);
        const hasSentencePunct = /[.!?]\s/.test(raw);

        if (hasSentencePunct) return false;

        const uniqueRatio = new Set(lines).size / lines.length;
        if (avgLen <= 45 && uniqueRatio <= 0.9) return true;
        return avgLen <= 32;
    }

    function getElementAttributeValue(element, attr) {
        if (!element || typeof element.getAttribute !== 'function') return '';
        return (element.getAttribute(attr) || '').toLowerCase();
    }

    function hasChatGPTReflectionAncestor(node) {
        const keywords = ['reflection', 'réflexion', 'reasoning'];
        let current = node;
        while (current && current !== document.body) {
            const tag = current.tagName?.toLowerCase?.();
            if (tag === 'aside' || tag === 'nav') return true;
            const role = getElementAttributeValue(current, 'role');
            if (role === 'complementary' || role === 'navigation') return true;
            const combined = [
                getElementAttributeValue(current, 'data-testid'),
                getElementAttributeValue(current, 'aria-label'),
                getElementAttributeValue(current, 'data-role'),
            ].join(' ');
            if (keywords.some((keyword) => combined.includes(keyword))) {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    }

    function findChatGPTConversationRoots() {
        const preferredSelectors = [
            '[role="log"]',
            '[data-testid="conversation-panel"]',
            '[data-testid="conversation-container"]',
            '[data-testid="chat-panel"]',
            '[data-testid="chat-app"]',
        ];
        const preferred = [];
        for (const selector of preferredSelectors) {
            try {
                const el = document.querySelector(selector);
                if (el && !preferred.includes(el)) preferred.push(el);
            } catch (error) {}
        }
        if (preferred.length) return preferred;

        const fallbackSelectors = ['main', '[role="main"]'];
        const roots = [];
        for (const selector of fallbackSelectors) {
            try {
                const el = document.querySelector(selector);
                if (el && !roots.includes(el)) roots.push(el);
            } catch (error) {}
        }
        return roots.length ? roots : [document.body];
    }

    function isChatGPTConversationNode(node, roots) {
        if (!node) return false;
        if (hasChatGPTReflectionAncestor(node)) return false;
        if (!roots || !roots.length) return true;
        return roots.some((root) => root.contains(node));
    }

    function getChatGPTConversationAssistantNodes() {
        const rawAssistantNodes = Array.from(
            document.querySelectorAll('[data-message-author-role="assistant"]')
        );
        if (!rawAssistantNodes.length) return [];

        const turnScoped = rawAssistantNodes.filter((node) =>
            node.closest?.('[data-testid="conversation-turn"]')
        );
        const baseNodes = turnScoped.length ? turnScoped : rawAssistantNodes;

        const roots = findChatGPTConversationRoots();
        const scoped = baseNodes.filter((node) => isChatGPTConversationNode(node, roots));
        if (scoped.length) return scoped;

        const noReflection = baseNodes.filter((node) => !hasChatGPTReflectionAncestor(node));
        return noReflection.length ? noReflection : baseNodes;
    }

    function normalizeCaptureCandidateText(text) {
        const normalized = CaptureUtils?.normalizeWhitespace
            ? CaptureUtils.normalizeWhitespace(text)
            : String(text).replace(/\s+/g, ' ').trim();
        return normalized;
    }

    function getCaptureWordCount(text) {
        if (CaptureUtils && typeof CaptureUtils.countWords === 'function') {
            return CaptureUtils.countWords(text);
        }
        const normalized = normalizeCaptureCandidateText(text);
        return normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;
    }

    function extendsCandidateMeaningfully(baseText, candidateText, options = {}) {
        if (CaptureUtils && typeof CaptureUtils.extendsMeaningfully === 'function') {
            return CaptureUtils.extendsMeaningfully(baseText, candidateText, options);
        }
        const baseFragments = Array.isArray(baseText)
            ? baseText.map((value) => normalizeCaptureCandidateText(value || '')).filter(Boolean)
            : [normalizeCaptureCandidateText(baseText || '')].filter(Boolean);
        const baseNormalized = baseFragments.join(' ');
        const candidateNormalized = normalizeCaptureCandidateText(candidateText || '');
        if (!baseNormalized || !candidateNormalized || candidateNormalized === baseNormalized) {
            return false;
        }
        let cursor = 0;
        for (const fragment of baseFragments) {
            const nextIndex = candidateNormalized.indexOf(fragment, cursor);
            if (nextIndex === -1) return false;
            cursor = nextIndex + fragment.length;
        }
        const minExtraWords = Number.isFinite(options.minExtraWords)
            ? Math.max(1, Number(options.minExtraWords))
            : 12;
        const minExtraChars = Number.isFinite(options.minExtraChars)
            ? Math.max(1, Number(options.minExtraChars))
            : 80;
        const baseWordCount = Array.isArray(baseText)
            ? getCaptureWordCount(baseText.join(' '))
            : getCaptureWordCount(baseText);
        const extraWords = Math.max(0, getCaptureWordCount(candidateText) - baseWordCount);
        const extraChars = Math.max(0, candidateNormalized.length - baseNormalized.length);
        return extraWords >= minExtraWords || extraChars >= minExtraChars;
    }

    function getTopLevelNodes(nodes) {
        const arr = Array.from(nodes || []).filter(Boolean);
        if (arr.length <= 1) return arr;
        const topLevel = arr.filter(
            (node) => !arr.some((other) => other !== node && other.contains(node))
        );
        return topLevel.sort((a, b) => {
            if (a === b) return 0;
            const position = a.compareDocumentPosition?.(b);
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });
    }

    function collectSanitizedFragmentCandidate(rootNode, selectors, options = {}) {
        const clone = sanitizeContentClone(rootNode, options);
        if (!clone) {
            return {
                text: '',
                html: '',
                partCount: 0,
                nodeCount: 0,
                usedRoot: false,
            };
        }

        let fragmentNodes = [];
        if (Array.isArray(selectors) && selectors.length > 0) {
            try {
                fragmentNodes = getTopLevelNodes(clone.querySelectorAll(selectors.join(', ')));
            } catch (error) {
                fragmentNodes = [];
            }
        }

        const seenText = new Set();
        const parts = [];
        const htmlParts = [];
        for (const node of fragmentNodes) {
            const text = getTrimmedText(node);
            if (!text || looksLikeUiChromeText(text, options)) continue;
            const normalized = normalizeCaptureCandidateText(text);
            if (!normalized || seenText.has(normalized)) continue;
            seenText.add(normalized);
            parts.push(text);
            if (options.withHtml) {
                const html = extractCleanHtmlFromNode(node, {
                    ...options,
                    skipSanitize: true,
                });
                if (html) htmlParts.push(html);
            }
        }

        const combinedText = parts.join('\n\n').trim();
        const rootText = getTrimmedText(clone);
        const canUseRootText = Boolean(
            rootText &&
            !looksLikeUiChromeText(rootText, options) &&
            (!combinedText ||
                (!looksLikePromptEcho(rootText) &&
                    extendsCandidateMeaningfully(parts.length ? parts : combinedText, rootText, {
                        minExtraWords: 10,
                        minExtraChars: 48,
                    })))
        );

        const finalText = canUseRootText ? rootText : combinedText || rootText || '';
        let finalHtml = '';
        if (options.withHtml && finalText) {
            finalHtml = canUseRootText
                ? extractCleanHtmlFromNode(clone, { ...options, skipSanitize: true })
                : htmlParts.join('\n').trim();
            if (!finalHtml) {
                finalHtml = extractCleanHtmlFromNode(clone, {
                    ...options,
                    skipSanitize: true,
                });
            }
        }

        return {
            text: finalText,
            html: finalHtml,
            partCount: parts.length,
            nodeCount: fragmentNodes.length,
            usedRoot: canUseRootText || (!combinedText && Boolean(rootText)),
        };
    }

    function buildChatGPTAssistantCandidate(messageRoot, assistantIndex, options = {}) {
        if (!messageRoot) {
            return {
                text: '',
                html: '',
                assistantIndex,
                origin: null,
                partCount: 0,
                nodeCount: 0,
            };
        }

        const selectors = [
            '[data-testid="message-content"]',
            '.markdown',
            '.prose',
            '[data-testid*="citation" i]',
            '[data-testid*="reference" i]',
            '[data-testid*="source" i]',
            '[class*="citation" i]',
            '[class*="reference" i]',
            '[class*="source" i]',
        ];
        const collected = collectSanitizedFragmentCandidate(messageRoot, selectors, {
            withHtml: options.withHtml,
            provider: 'chatgpt',
        });
        const finalText = collected.text;
        const combinedHtml = options.withHtml ? collected.html || '' : '';

        const origin = Number.isFinite(assistantIndex)
            ? `assistant[${assistantIndex}] ${collected.usedRoot ? 'root-sanitized' : `aggregated(${collected.partCount}/${collected.nodeCount})`}`
            : 'assistant aggregated';

        return {
            text: finalText,
            html: combinedHtml,
            assistantIndex,
            origin,
            partCount: collected.partCount,
            nodeCount: collected.nodeCount,
        };
    }

    function extractChatGPTResponse(options = {}) {
        const conversationRoots = findChatGPTConversationRoots();
        const assistantNodes = getChatGPTConversationAssistantNodes();
        const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
            ? captureState.baselineAssistantCount
            : null;

        const preferredStart =
            baselineCount !== null
                ? Math.min(baselineCount, Math.max(0, assistantNodes.length - 1))
                : 0;

        const roots = [];
        const startIndex = Math.max(0, Math.max(preferredStart, assistantNodes.length - 4));
        for (let i = startIndex; i < assistantNodes.length; i++) {
            const node = assistantNodes[i];
            if (!node) continue;
            if (
                node.querySelector('[data-testid="message-content"], .markdown, .prose') ||
                getTrimmedText(node)
            ) {
                roots.push({ node, assistantIndex: i });
            }
        }
        if (roots.length === 0) {
            for (let i = assistantNodes.length - 1; i >= 0; i--) {
                const node = assistantNodes[i];
                if (!node) continue;
                if (
                    node.querySelector('[data-testid="message-content"], .markdown, .prose') ||
                    getTrimmedText(node)
                ) {
                    roots.unshift({ node, assistantIndex: i });
                }
                if (roots.length >= 4) break;
            }
        }

        const seenText = new Set();
        const candidates = [];
        for (const rootEntry of roots) {
            const candidate = buildChatGPTAssistantCandidate(
                rootEntry.node,
                rootEntry.assistantIndex,
                options
            );
            if (!candidate?.text) continue;
            const normalized = normalizeCaptureCandidateText(candidate.text);
            if (!normalized) continue;
            if (seenText.has(normalized)) continue;
            seenText.add(normalized);
            candidates.push(candidate);
        }

        // Fallback: scan for recent content nodes outside of assistant roots (best effort).
        if (candidates.length === 0) {
            const selector = '[data-testid="message-content"], .prose, .markdown';
            const searchRoot =
                conversationRoots && conversationRoots.length ? conversationRoots[0] : document;
            const nodes = Array.from(searchRoot.querySelectorAll(selector)).filter(
                (node) => !hasChatGPTReflectionAncestor(node)
            );
            const recent = nodes.slice(Math.max(0, nodes.length - 8));
            for (let i = 0; i < recent.length; i++) {
                const node = recent[i];
                const text = getTrimmedText(node);
                if (!text) continue;
                const normalized = normalizeCaptureCandidateText(text);
                if (!normalized) continue;
                if (seenText.has(normalized)) continue;
                seenText.add(normalized);
                candidates.push({
                    text,
                    html: options.withHtml ? extractCleanHtmlFromNode(node) : '',
                    assistantIndex: null,
                    origin: `global[${i}]`,
                    partCount: 1,
                    nodeCount: 1,
                });
            }
        }

        if (candidates.length === 0) {
            return options.withMeta ? { text: '', meta: null } : { text: '' };
        }

        const texts = candidates.map((candidate) => candidate.text);
        const ranking = CaptureUtils?.chooseBestTextCandidate
            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'chatgpt' })
            : {
                  bestIndex: 0,
                  best: {
                      index: 0,
                      score: texts[0].length,
                      isReferenceList: looksLikeChatGPTSourcesOnly(texts[0]),
                  },
                  ranked: [],
              };

        const rankingBestIndex =
            Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0 ? ranking.bestIndex : 0;
        let chosenIndex = rankingBestIndex;

        const analysisByIndex = new Map();
        const referenceByIndex = new Map();
        if (Array.isArray(ranking.ranked)) {
            ranking.ranked.forEach((item) => {
                analysisByIndex.set(item.index, item.analysis || null);
                referenceByIndex.set(item.index, Boolean(item.isReferenceList));
            });
        }

        const getAnalysisForIndex = (index) => {
            if (analysisByIndex.has(index)) return analysisByIndex.get(index);
            if (CaptureUtils && typeof CaptureUtils.analyzeText === 'function') {
                try {
                    return CaptureUtils.analyzeText(texts[index]);
                } catch (error) {
                    // ignore
                }
            }
            const raw = String(texts[index] || '').trim();
            const lines = raw
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            const urlMatches = raw.match(/\bhttps?:\/\/\S+|\bwww\.\S+/gi) || [];
            const domainMatches =
                raw.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi) || [];
            return {
                raw,
                lines,
                lineCount: lines.length,
                wordCount: raw ? raw.split(/\s+/).filter(Boolean).length : 0,
                urlCount: urlMatches.length,
                domainCount: domainMatches.length,
                urlishLineCount: lines.filter((line) =>
                    /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/i.test(line)
                ).length,
                sentenceEndPunctCount: (raw.match(/[.!?](?:\s|$)/g) || []).length,
                codeFenceCount: (raw.match(/```/g) || []).length,
                startsWithSourcesHeading: /^(sources?|references?|citations?)\b[:\s-]*/i.test(
                    lines[0] || ''
                ),
            };
        };

        const getWordCount = (index) => {
            const analysis = getAnalysisForIndex(index) || {};
            const wordCount = Number.isFinite(analysis.wordCount) ? analysis.wordCount : 0;
            return wordCount;
        };

        const getUrlishRatio = (index) => {
            const analysis = getAnalysisForIndex(index) || {};
            const lineCount = Number.isFinite(analysis.lineCount) ? analysis.lineCount : 0;
            const urlishLineCount = Number.isFinite(analysis.urlishLineCount)
                ? analysis.urlishLineCount
                : 0;
            return lineCount ? urlishLineCount / Math.max(1, lineCount) : 0;
        };

        const isReferenceCandidate = (index) => {
            if (referenceByIndex.has(index)) return referenceByIndex.get(index);
            return looksLikeChatGPTSourcesOnly(texts[index]);
        };

        // Guardrail: avoid selecting sources-only blocks when a real answer exists.
        const bestIsReference = isReferenceCandidate(chosenIndex);
        if (bestIsReference && Array.isArray(ranking.ranked)) {
            const alt = ranking.ranked.find((item) => {
                if (item.index === chosenIndex) return false;
                if (item.isReferenceList) return false;
                const analysis = item.analysis || {};
                const wordCount = analysis.wordCount || 0;
                const sentenceEndPunctCount = analysis.sentenceEndPunctCount || 0;
                const codeFenceCount = analysis.codeFenceCount || 0;
                const lineCount = analysis.lineCount || 0;
                return (
                    wordCount >= 18 ||
                    sentenceEndPunctCount >= 2 ||
                    codeFenceCount >= 1 ||
                    lineCount >= 4
                );
            });
            if (alt && Number.isFinite(alt.index) && alt.index >= 0) {
                chosenIndex = alt.index;
            }
        }

        // Guardrail: avoid capturing tiny fragments (often a lone hyperlink) when longer candidates exist.
        const chosenWordCount = getWordCount(chosenIndex);
        if (chosenWordCount > 0 && chosenWordCount < 12) {
            let bestAltIndex = chosenIndex;
            let bestAltWordCount = chosenWordCount;
            for (let i = 0; i < texts.length; i++) {
                if (i === chosenIndex) continue;
                const wc = getWordCount(i);
                if (wc <= bestAltWordCount + 10) continue;
                if (isReferenceCandidate(i) && !isReferenceCandidate(chosenIndex)) continue;
                const urlishRatio = getUrlishRatio(i);
                if (urlishRatio >= 0.95 && wc < 24) continue;
                bestAltIndex = i;
                bestAltWordCount = wc;
            }
            if (bestAltIndex !== chosenIndex) {
                chosenIndex = bestAltIndex;
            }
        }

        // Guardrail: if the chosen text is a strict substring of another non-reference candidate, prefer the longer one.
        const chosenNormalized = normalizeCaptureCandidateText(texts[chosenIndex]);
        if (chosenNormalized) {
            let substringAltIndex = null;
            const chosenWc = getWordCount(chosenIndex);
            for (let i = 0; i < texts.length; i++) {
                if (i === chosenIndex) continue;
                const otherNormalized = normalizeCaptureCandidateText(texts[i]);
                if (!otherNormalized) continue;
                if (otherNormalized === chosenNormalized) continue;
                if (!otherNormalized.includes(chosenNormalized)) continue;
                const otherWc = getWordCount(i);
                if (otherWc <= chosenWc + 8) continue;
                if (isReferenceCandidate(i) && !isReferenceCandidate(chosenIndex)) continue;
                substringAltIndex = i;
                break;
            }
            if (substringAltIndex !== null) {
                chosenIndex = substringAltIndex;
            }
        }

        const bestIndex = chosenIndex;
        const bestCandidate =
            candidates[bestIndex] || candidates[rankingBestIndex] || candidates[0] || null;
        const bestText = bestCandidate?.text || '';
        const combined = (() => {
            if (!bestCandidate || !bestText) {
                return { text: bestText, html: bestCandidate?.html || '', supplementalIndices: [] };
            }

            const combinedTexts = [bestText];
            const combinedHtmlParts =
                options.withHtml && bestCandidate?.html ? [bestCandidate.html] : [];
            const supplementalIndices = [];
            const normalizedSet = new Set([normalizeCaptureCandidateText(bestText)]);
            const bestAssistantIndex = Number.isFinite(bestCandidate.assistantIndex)
                ? bestCandidate.assistantIndex
                : null;
            const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
                ? captureState.baselineAssistantCount
                : null;

            const ordered = candidates
                .map((candidate, index) => ({
                    ...candidate,
                    index,
                    assistantIndex: Number.isFinite(candidate.assistantIndex)
                        ? candidate.assistantIndex
                        : null,
                }))
                .sort((a, b) => {
                    const aIdx =
                        a.assistantIndex !== null ? a.assistantIndex : Number.POSITIVE_INFINITY;
                    const bIdx =
                        b.assistantIndex !== null ? b.assistantIndex : Number.POSITIVE_INFINITY;
                    if (aIdx !== bIdx) return aIdx - bIdx;
                    return a.index - b.index;
                });

            for (const entry of ordered) {
                if (entry.index === bestIndex) continue;
                if (
                    bestAssistantIndex !== null &&
                    entry.assistantIndex !== null &&
                    entry.assistantIndex < bestAssistantIndex
                ) {
                    continue;
                }
                if (
                    baselineCount !== null &&
                    entry.assistantIndex !== null &&
                    entry.assistantIndex < baselineCount
                ) {
                    continue;
                }

                const normalized = normalizeCaptureCandidateText(entry.text || '');
                if (!normalized || normalizedSet.has(normalized)) continue;

                const analysis = getAnalysisForIndex(entry.index) || {};
                const urlishRatio = getUrlishRatio(entry.index);
                const isReference = isReferenceCandidate(entry.index);
                const urlCount = Number.isFinite(analysis.urlCount) ? analysis.urlCount : 0;
                const domainCount = Number.isFinite(analysis.domainCount)
                    ? analysis.domainCount
                    : 0;
                const hasLinks = urlCount > 0 || domainCount > 0 || urlishRatio >= 0.45;
                if (!isReference && !hasLinks) continue;

                combinedTexts.push(entry.text);
                if (options.withHtml && entry.html) combinedHtmlParts.push(entry.html);
                supplementalIndices.push(entry.index);
                normalizedSet.add(normalized);
            }

            const combinedText = combinedTexts.join('\n\n').trim();
            let combinedHtml = '';
            if (options.withHtml && combinedHtmlParts.length) {
                combinedHtml = combinedHtmlParts.join('\n<hr>\n').trim();
                const MAX_HTML_CHARS = 120000;
                if (combinedHtml.length > MAX_HTML_CHARS) combinedHtml = '';
            }
            return { text: combinedText, html: combinedHtml, supplementalIndices };
        })();
        const finalText = combined.text || bestText;
        const finalHtml = options.withHtml ? combined.html || bestCandidate?.html || '' : '';

        const meta = {
            provider: 'chatgpt',
            assistantCount: assistantNodes.length,
            baselineAssistantCount: captureState.baselineAssistantCount,
            rootsScanned: roots.map((root) => root.assistantIndex),
            candidateCount: texts.length,
            bestIndex: bestIndex,
            rankingBestIndex: rankingBestIndex,
            rankingBestIsReferenceList: ranking.best?.isReferenceList ?? null,
            didOverrideReferenceBest: bestIndex !== rankingBestIndex,
            bestOrigin: bestCandidate?.origin || null,
            bestAssistantIndex: Number.isFinite(bestCandidate?.assistantIndex)
                ? bestCandidate.assistantIndex
                : null,
            bestWordCount: Number.isFinite(getAnalysisForIndex(bestIndex)?.wordCount)
                ? getAnalysisForIndex(bestIndex).wordCount
                : null,
            bestScore: Array.isArray(ranking.ranked)
                ? (ranking.ranked.find((r) => r.index === bestIndex)?.score ?? null)
                : (ranking.best?.score ?? null),
            bestIsReferenceList: Array.isArray(ranking.ranked)
                ? (ranking.ranked.find((r) => r.index === bestIndex)?.isReferenceList ?? null)
                : (ranking.best?.isReferenceList ?? null),
            supplementalIndices: combined.supplementalIndices || [],
            supplementalCount: combined.supplementalIndices
                ? combined.supplementalIndices.length
                : 0,
            finalWordCount: getCaptureWordCount(finalText),
            finalTextLength: finalText.length,
            rankingTop: Array.isArray(ranking.ranked)
                ? ranking.ranked.slice(0, 6).map((r) => ({
                      index: r.index,
                      score: r.score,
                      isReferenceList: r.isReferenceList,
                      wordCount: r.analysis?.wordCount,
                      lineCount: r.analysis?.lineCount,
                      urlishLineCount: r.analysis?.urlishLineCount,
                      sentenceEndPunctCount: r.analysis?.sentenceEndPunctCount,
                      codeFenceCount: r.analysis?.codeFenceCount,
                      startsWithSourcesHeading: r.analysis?.startsWithSourcesHeading,
                      origin: candidates[r.index]?.origin || null,
                  }))
                : [],
        };

        captureDebug('extractChatGPTResponse', meta);
        if (isCaptureDebugEnabled()) {
            captureDebug('Best preview', String(bestText).slice(0, 200));
            if (meta.rankingTop?.length) {
                meta.rankingTop.forEach((item) => {
                    const preview = String(texts[item.index] || '').slice(0, 120);
                    captureDebug(`Candidate #${item.index}`, { ...item, preview });
                });
            }
        }

        const result = {
            text: finalText,
        };
        if (options.withHtml) {
            result.html = finalHtml;
        }
        return options.withMeta ? { ...result, meta } : result;
    }

    function isGeminiUserMessage(node) {
        if (!node) return false;
        const userSelectors = [
            '.user-message',
            '.user-query',
            '[data-message-author=\"user\"]',
            '[data-message-author=\"human\"]',
            '[data-author-is-user=\"true\"]',
        ];
        for (const sel of userSelectors) {
            if (node.matches?.(sel) || node.closest?.(sel)) return true;
        }
        if (node.querySelector?.(userSelectors.join(', '))) return true;
        const ariaLabel = node.getAttribute?.('aria-label') || '';
        if (/\b(you|user)\b/i.test(ariaLabel)) return true;
        return false;
    }

    function extractGeminiResponse(options = {}) {
        const inputEl = findInput({ silent: true });
        const inputContainer = inputEl
            ? inputEl.closest(
                  'form, .input-area-container, .input-area, .input-row, .composer, .prompt-container'
              )
            : null;
        const roots = [document.querySelector('main'), document.body].filter(Boolean);
        const selectors = [
            '[data-message-author=\"gemini\"]',
            '[data-message-author=\"assistant\"]',
            '[data-author-is-user=\"false\"]',
            '[data-response-id]',
            '[data-message-id]',
            '[data-testid*=\"conversation\"]',
            '.conversation-turn',
            '.message-container',
            '.response-content',
            '.model-response',
            '.model-response-text',
            '.markdown',
            '.markdown-content',
            '[data-testid=\"markdown-content\"]',
            'article',
            '[role=\"article\"]',
        ];

        const candidates = [];
        for (const root of roots) {
            for (const sel of selectors) {
                root.querySelectorAll(sel).forEach((node) => candidates.push(node));
            }
            if (candidates.length) break;
        }

        const seen = new Set();
        const uniqueCandidates = candidates.filter((node) => {
            if (seen.has(node)) return false;
            seen.add(node);
            return true;
        });

        let sawMedia = false;

        for (let i = uniqueCandidates.length - 1; i >= 0; i--) {
            const node = uniqueCandidates[i];
            if (!node) continue;
            if (inputContainer && inputContainer.contains(node)) continue;
            if (isGeminiUserMessage(node)) continue;

            const targetSelectors =
                '.markdown, .markdown-content, [data-testid=\"markdown-content\"], .response-content, .model-response, .model-response-text';
            const targetNodes = node.querySelectorAll(targetSelectors);
            let target = null;
            for (let j = targetNodes.length - 1; j >= 0; j--) {
                if (!isGeminiUserMessage(targetNodes[j])) {
                    target = targetNodes[j];
                    break;
                }
            }
            if (!target) {
                target = node;
            }
            if (inputContainer && inputContainer.contains(target)) continue;
            if (isGeminiUserMessage(target)) continue;

            const mediaNodes = target.querySelectorAll('img, video, canvas, svg, figure, picture');
            if (mediaNodes.length > 0) sawMedia = true;

            // Use innerText from the live node to preserve provider-intended line breaks.
            // (textContent collapses <br>/<p>/<li> into a single squashed line.)
            const text = target.innerText || target.textContent;
            if (text && text.trim()) {
                const result = { text: text.trim() };
                if (options.withHtml) {
                    result.html = extractCleanHtmlFromNode(target);
                }
                return options.withMeta ? { ...result, meta: { provider: 'gemini' } } : result;
            }
        }

        if (sawMedia) {
            const placeholder =
                '[Gemini returned an image output; no text was captured. Proceeding with debate.]';
            return options.withMeta
                ? { text: placeholder, meta: { provider: 'gemini', sawMedia: true } }
                : { text: placeholder };
        }
        return options.withMeta ? { text: '', meta: { provider: 'gemini' } } : { text: '' };
    }

    function normalizeCaptureText(text) {
        const raw = String(text || '');
        if (!raw) return '';
        if (CaptureUtils && typeof CaptureUtils.normalizeWhitespace === 'function') {
            return CaptureUtils.normalizeWhitespace(raw);
        }
        return raw.replace(/\s+/g, ' ').trim();
    }

    function stableTextSignature(text) {
        const value = normalizeCaptureText(text);
        if (!value) return 'empty';
        let hash = 0;
        for (let i = 0; i < value.length; i += 1) {
            hash = (hash << 5) - hash + value.charCodeAt(i);
            hash |= 0;
        }
        return `${value.length}:${hash}`;
    }

    function looksLikePromptEcho(text) {
        const preview = normalizeCaptureText(captureState.promptPreview || '');
        if (!preview) return false;
        const candidate = normalizeCaptureText(text || '');
        if (!candidate) return false;
        if (candidate === preview) return true;

        const prefixLen = Math.min(preview.length, 120);
        if (prefixLen < 40) return false;
        const prefix = preview.slice(0, prefixLen);
        if (!candidate.startsWith(prefix)) return false;

        const previewWords = preview.split(/\s+/).filter(Boolean).length;
        const candidateWords = candidate.split(/\s+/).filter(Boolean).length;
        const extraWords = Math.max(0, candidateWords - previewWords);
        const extraChars = Math.max(0, candidate.length - preview.length);
        if (extraWords <= 6) return true;
        if (extraChars <= 40) return true;
        return false;
    }

    function normalizePromptScaffoldText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function isGrokPromptScaffoldLine(line) {
        const raw = String(line || '').trim();
        if (!raw) return false;
        if (CaptureUtils && typeof CaptureUtils.looksLikePromptScaffoldText === 'function') {
            if (CaptureUtils.looksLikePromptScaffoldText(raw, { provider: 'grok' })) {
                return true;
            }
        }

        const normalized = normalizePromptScaffoldText(raw);
        if (!normalized) return false;

        const scaffoldPatterns = [
            /^conversation so far:?$/,
            /^here'?s a new message from the user:?$/,
            /^please grok answer(?:\.+)?$/,
            /^user:?$/,
        ];
        if (scaffoldPatterns.some((pattern) => pattern.test(normalized))) return true;

        const previewNormalized = normalizePromptScaffoldText(captureState.promptPreview || '');
        if (!previewNormalized) return false;
        const previewPrefix = previewNormalized.slice(0, Math.min(220, previewNormalized.length));
        if (!previewPrefix || previewPrefix.length < 24) return false;
        if (normalized === previewPrefix) return true;
        if (previewPrefix.startsWith(normalized) && normalized.length >= 24) return true;
        return false;
    }

    function stripGrokUiFooterArtifacts(value) {
        let text = String(value || '').trim();
        if (!text) return '';

        const satisfactionTailRe =
            /(?:~?\d+(?:[.,]\d+)?\s*(?:ms|s)\s*)?(?:are you satisfied with|satisfied with|etes[-\s]?vous satisfait(?:e)?(?: de)?|êtes[-\s]?vous satisfait(?:e)?(?: de)?)[^?\n]*\?\s*$/i;
        const latencyTailRe = /(^|[^0-9A-Za-z])~?\d+(?:[.,]\d+)?\s*(?:ms|s)\s*$/i;

        let previous = '';
        while (text && text !== previous) {
            previous = text;
            text = text.replace(satisfactionTailRe, '').trim();
            text = text.replace(latencyTailRe, '$1').trim();
        }
        return text;
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractLatestUserMessageFromPromptPreview() {
        const previewRaw = String(captureState.promptPreview || '').trim();
        if (!previewRaw) return '';

        const fromMarkerMatch = previewRaw.match(
            /here'?s\s+a\s+new\s+message\s+from\s+the\s+user:\s*([\s\S]+)/i
        );
        if (fromMarkerMatch && fromMarkerMatch[1]) {
            let extracted = String(fromMarkerMatch[1] || '');
            const stopIdx = extracted.search(/(?:\n|\r|^)\s*please\s+grok\s+answer(?:\.+)?\s*/i);
            if (stopIdx >= 0) extracted = extracted.slice(0, stopIdx);
            extracted = extracted
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .join(' ')
                .trim();
            if (extracted) return extracted.slice(0, 500);
        }

        const lines = previewRaw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (!lines.length) return '';

        let stopAt = lines.findIndex((line) => /please\s+grok\s+answer/i.test(line));
        if (stopAt < 0) stopAt = lines.length;

        for (let i = stopAt - 1; i >= 0; i -= 1) {
            const line = lines[i];
            if (!line) continue;
            if (isGrokPromptScaffoldLine(line)) continue;
            if (/^(conversation so far:|new messages since your last turn:)/i.test(line)) continue;
            return line.slice(0, 500);
        }

        return '';
    }

    function stripLeadingGrokPromptArtifacts(value) {
        const original = String(value || '').trim();
        let text = original;
        if (!text) return '';

        const stripLeadingPunctuation = (input) =>
            String(input || '')
                .replace(/^[\s"'`([{<:;,.\-–—!?|\\/]+/u, '')
                .trim();

        const previewRaw = String(captureState.promptPreview || '').trim();
        const previewNormalized = normalizePromptScaffoldText(previewRaw);
        const previewHasDebateScaffold = Boolean(
            previewNormalized &&
            /(conversation so far:|new messages since your last turn:|here'?s a new message from the user:|please grok answer)/i.test(
                previewNormalized
            )
        );

        if (previewRaw) {
            const normalizedText = normalizePromptScaffoldText(text);
            if (previewNormalized && normalizedText.startsWith(previewNormalized)) {
                text = stripLeadingPunctuation(text.slice(previewRaw.length));
            }
        }

        if (previewHasDebateScaffold && text) {
            const leadingWindow = text.slice(0, 2600);
            const markerPatterns = [
                /conversation\s+so\s+far:/gi,
                /new\s+messages\s+since\s+your\s+last\s+turn:/gi,
                /here'?s\s+a\s+new\s+message\s+from\s+the\s+user:/gi,
                /please\s+grok\s+answer(?:\.+)?/gi,
            ];
            let cutoff = -1;
            let markerUsed = '';
            for (const re of markerPatterns) {
                let match;
                while ((match = re.exec(leadingWindow))) {
                    const candidateCutoff = match.index + match[0].length;
                    if (candidateCutoff > cutoff) {
                        cutoff = candidateCutoff;
                        markerUsed = match[0];
                    }
                }
            }
            if (cutoff > 0 && cutoff < text.length) {
                const stripped = stripLeadingPunctuation(text.slice(cutoff));
                if (stripped && stripped.length < text.length) {
                    captureDebug('Grok scaffold marker cut', {
                        marker: markerUsed,
                        cutoff,
                        beforeLen: text.length,
                        afterLen: stripped.length,
                    });
                    text = stripped;
                }
            }
        }

        const latestUserMessage = extractLatestUserMessageFromPromptPreview();
        if (latestUserMessage) {
            const prefixRe = new RegExp(
                `^${escapeRegExp(latestUserMessage).replace(/\s+/g, '\\s+')}`,
                'i'
            );
            const prefixMatch = text.match(prefixRe);
            if (prefixMatch && prefixMatch[0]) {
                const stripped = stripLeadingPunctuation(text.slice(prefixMatch[0].length));
                if (stripped && stripped.length < text.length) {
                    captureDebug('Grok leading user-echo stripped', {
                        removedLen: prefixMatch[0].length,
                        beforeLen: text.length,
                        afterLen: stripped.length,
                        userPreview: latestUserMessage.slice(0, 120),
                    });
                    text = stripped;
                }
            }
        }

        const scaffoldPrefixPatterns = [
            /^(?:conversation\s+so\s+far:?\s*)+/i,
            /^(?:new\s+messages\s+since\s+your\s+last\s+turn:?\s*)+/i,
            /^(?:here'?s\s+a\s+new\s+message\s+from\s+the\s+user:?\s*)+/i,
            /^(?:user:?\s*)+/i,
            /^(?:please\s+grok\s+answer(?:\.+)?\s*)+/i,
        ];
        let previous = '';
        while (text && text !== previous) {
            previous = text;
            for (const pattern of scaffoldPrefixPatterns) {
                text = text.replace(pattern, '');
            }
            text = stripLeadingPunctuation(text);
        }

        if (text && text !== original) {
            captureDebug('Grok leading prompt/scaffold stripped', {
                beforeLen: original.length,
                afterLen: text.length,
                preview: text.slice(0, 120),
            });
        }

        return text;
    }

    function sanitizeGrokTranscriptCandidate(text, { allowShort = false } = {}) {
        const raw = stripLeadingGrokPromptArtifacts(String(text || '').trim());
        if (!raw) return '';

        const lines = raw
            .split(/\r?\n/)
            .map((line) => stripGrokUiFooterArtifacts(line))
            .map((line, index) => (index === 0 ? stripLeadingGrokPromptArtifacts(line) : line))
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !isGrokControlOnlyText(line))
            .filter((line) => !isGrokPromptScaffoldLine(line));
        if (!lines.length) return '';

        const sanitized = stripLeadingGrokPromptArtifacts(
            stripGrokUiFooterArtifacts(lines.join('\n').trim())
        );
        if (!sanitized) return '';
        if (isGrokControlOnlyText(sanitized)) return '';
        if (looksLikePromptEcho(sanitized)) return '';

        if (!allowShort) {
            const wordCount = sanitized.split(/\s+/).filter(Boolean).length;
            if (wordCount < 6 && sanitized.length < 30) return '';
        }
        return sanitized;
    }

    function getGrokComparableLines(text) {
        return String(text || '')
            .split(/\r?\n/)
            .map((line) => stripGrokUiFooterArtifacts(line))
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !isGrokControlOnlyText(line))
            .filter((line) => !isGrokPromptScaffoldLine(line));
    }

    function stripLeadingGrokBaseline(fullText, baselineText) {
        const fullRaw = String(fullText || '').trim();
        const baselineRaw = String(baselineText || '').trim();
        if (!fullRaw || !baselineRaw) return '';
        if (fullRaw === baselineRaw) return '';

        if (fullRaw.startsWith(baselineRaw)) {
            return String(fullRaw.slice(baselineRaw.length) || '').trim();
        }

        const fullLines = getGrokComparableLines(fullRaw);
        const baselineLines = getGrokComparableLines(baselineRaw);
        if (!fullLines.length || !baselineLines.length) {
            return '';
        }

        const minRequiredPrefixLines =
            baselineLines.length <= 2
                ? baselineLines.length
                : Math.max(2, Math.floor(Math.min(baselineLines.length, 10) * 0.6));
        const maxStartOffset = Math.min(8, Math.max(0, fullLines.length - minRequiredPrefixLines));
        let bestStart = -1;
        let bestMatched = 0;
        for (let start = 0; start <= maxStartOffset; start += 1) {
            let matched = 0;
            while (start + matched < fullLines.length && matched < baselineLines.length) {
                const fullLineNorm = normalizeCaptureCandidateText(fullLines[start + matched]);
                const baselineLineNorm = normalizeCaptureCandidateText(baselineLines[matched]);
                if (!fullLineNorm || !baselineLineNorm || fullLineNorm !== baselineLineNorm) break;
                matched += 1;
            }
            if (matched > bestMatched) {
                bestMatched = matched;
                bestStart = start;
            }
            if (matched === baselineLines.length) break;
        }

        if (
            bestStart < 0 ||
            bestMatched < minRequiredPrefixLines ||
            fullLines.length <= bestStart + bestMatched
        ) {
            return '';
        }

        return fullLines
            .slice(bestStart + bestMatched)
            .join('\n')
            .trim();
    }

    function stripGrokTailOverlapDelta(fullText, baselineText) {
        const fullRaw = String(fullText || '').trim();
        const baselineRaw = String(baselineText || '').trim();
        if (!fullRaw || !baselineRaw || fullRaw === baselineRaw) return '';

        const maxRawOverlap = Math.min(fullRaw.length - 1, baselineRaw.length);
        const minRawOverlap =
            baselineRaw.length <= 80
                ? Math.min(baselineRaw.length, 24)
                : Math.max(24, Math.min(240, Math.floor(baselineRaw.length * 0.25)));

        for (let overlap = maxRawOverlap; overlap >= minRawOverlap; overlap -= 1) {
            if (baselineRaw.slice(baselineRaw.length - overlap) !== fullRaw.slice(0, overlap)) {
                continue;
            }
            return String(fullRaw.slice(overlap) || '').trim();
        }

        const fullLines = getGrokComparableLines(fullText);
        const baselineLines = getGrokComparableLines(baselineText);
        if (!fullLines.length || !baselineLines.length || fullLines.length < 2) return '';

        const maxOverlap = Math.min(fullLines.length - 1, baselineLines.length);
        if (maxOverlap < 1) return '';

        const minRequiredPrefixLines =
            baselineLines.length <= 2
                ? baselineLines.length
                : Math.max(2, Math.floor(Math.min(baselineLines.length, 10) * 0.6));

        for (let overlap = maxOverlap; overlap >= minRequiredPrefixLines; overlap -= 1) {
            let matched = 0;
            const baselineStart = baselineLines.length - overlap;
            while (matched < overlap) {
                const fullLineNorm = normalizeCaptureCandidateText(fullLines[matched]);
                const baselineLineNorm = normalizeCaptureCandidateText(
                    baselineLines[baselineStart + matched]
                );
                if (!fullLineNorm || !baselineLineNorm || fullLineNorm !== baselineLineNorm) {
                    break;
                }
                matched += 1;
            }
            if (matched === overlap) {
                return fullLines
                    .slice(overlap)
                    .join('\n')
                    .trim();
            }
        }

        return '';
    }

    function boundGrokTranscriptTail(fullTranscript, maxChars) {
        const raw = String(fullTranscript || '').trim();
        if (!raw) {
            return {
                text: '',
                truncated: false,
                droppedLeadingPartialLine: false,
            };
        }
        if (raw.length <= maxChars) {
            return {
                text: raw,
                truncated: false,
                droppedLeadingPartialLine: false,
            };
        }

        const start = raw.length - maxChars;
        let bounded = raw.slice(start);
        let droppedLeadingPartialLine = false;
        const prevChar = start > 0 ? raw.charAt(start - 1) : '';
        const startsMidLine = Boolean(start > 0 && prevChar !== '\n' && prevChar !== '\r');
        if (startsMidLine) {
            const newlineMatch = bounded.match(/\r?\n/);
            const newlineIndex = Number.isFinite(newlineMatch?.index) ? newlineMatch.index : -1;
            if (newlineIndex >= 0 && newlineIndex + newlineMatch[0].length < bounded.length) {
                bounded = bounded.slice(newlineIndex + newlineMatch[0].length);
                droppedLeadingPartialLine = true;
            }
        }

        return {
            text: bounded.trim(),
            truncated: true,
            droppedLeadingPartialLine,
        };
    }

    function extractGrokIncrementalTranscriptText(
        transcriptText,
        { allowFullWhenNoBaseline = false } = {}
    ) {
        const rawTranscript = String(transcriptText || '').trim();
        if (!rawTranscript) return '';

        const baselines = [
            String(captureState.grokBaselineTranscriptTail || '').trim(),
            String(captureState.baselineText || '').trim(),
        ].filter(Boolean);

        let bestDeltaText = '';
        let bestBaselineWeight = -1;
        for (const baseline of baselines) {
            const deltaRaw =
                stripLeadingGrokBaseline(rawTranscript, baseline) ||
                stripGrokTailOverlapDelta(rawTranscript, baseline);
            if (!deltaRaw) continue;
            const deltaSanitized = sanitizeGrokTranscriptCandidate(deltaRaw, { allowShort: true });
            if (!deltaSanitized) continue;
            const baselineWeight = normalizeCaptureCandidateText(baseline).length;
            if (baselineWeight > bestBaselineWeight) {
                bestBaselineWeight = baselineWeight;
                bestDeltaText = deltaSanitized;
            }
        }

        if (bestDeltaText) return bestDeltaText;
        if (baselines.length > 0) return '';
        if (!allowFullWhenNoBaseline) return '';
        return sanitizeGrokTranscriptCandidate(rawTranscript, { allowShort: false });
    }

    function maybeTrimGrokIncrementalCandidate(
        candidateText,
        { allowFullWhenNoBaseline = false } = {}
    ) {
        const raw = String(candidateText || '').trim();
        if (!raw) return { text: '', trimmed: false, reductionChars: 0 };

        const baselines = [
            String(captureState.grokBaselineTranscriptTail || '').trim(),
            String(captureState.baselineText || '').trim(),
        ].filter(Boolean);
        const hasBaseline = baselines.length > 0;

        const incremental = extractGrokIncrementalTranscriptText(raw, {
            allowFullWhenNoBaseline,
        });
        if (!incremental) {
            return { text: raw, trimmed: false, reductionChars: 0 };
        }

        const rawNorm = normalizeCaptureCandidateText(raw);
        const incNorm = normalizeCaptureCandidateText(incremental);
        if (!rawNorm || !incNorm || incNorm === rawNorm) {
            return { text: raw, trimmed: false, reductionChars: 0 };
        }

        const reductionChars = Math.max(0, rawNorm.length - incNorm.length);
        if (!hasBaseline) {
            return { text: raw, trimmed: false, reductionChars: 0 };
        }

        return { text: incremental, trimmed: true, reductionChars };
    }

    function isClaudeUserMessage(node) {
        if (!node) return false;
        const userSelectors = [
            '[data-testid*="user" i]',
            '[data-testid*="human" i]',
            '[data-role*="user" i]',
            '[data-author*="user" i]',
            '.user-message',
            '.human-message',
            '.message-user',
        ];
        for (const sel of userSelectors) {
            if (node.matches?.(sel) || node.closest?.(sel)) return true;
        }
        const aria = node.getAttribute?.('aria-label') || '';
        if (/\b(you|user)\b/i.test(aria)) return true;
        return false;
    }

    function isGrokUserMessage(node) {
        if (!node) return false;
        const userSelectors = [
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
        for (const sel of userSelectors) {
            if (node.matches?.(sel) || node.closest?.(sel)) return true;
        }
        const aria = node.getAttribute?.('aria-label') || '';
        if (/\b(you|user)\b/i.test(aria)) return true;
        return false;
    }

    function extractClaudeResponse(options = {}) {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? inputEl.closest('form') ||
              inputEl.closest('footer') ||
              inputEl.closest('[role="form"]') ||
              inputEl.parentElement
            : null;
        const roots = [
            document.querySelector('main'),
            document.querySelector('[role="main"]'),
            document.body,
        ].filter(Boolean);

        const rootSelectors = [
            '[data-testid="chat-message"]',
            '[data-testid*="chat-message" i]',
            '[data-testid*="assistant" i]',
            '[data-role*="assistant" i]',
            '[data-author*="assistant" i]',
            'article',
            '[role="article"]',
            '[class*="assistant" i]',
        ];

        const contentSelectors = [
            '[data-testid="chat-message-content"]',
            '[data-testid="message-content"]',
            '.markdown',
            '.prose',
            '[class*="prose" i]',
            '[class*="markdown" i]',
            '[data-testid*="citation" i]',
            '[data-testid*="reference" i]',
            '[data-testid*="source" i]',
            '[class*="citation" i]',
            '[class*="reference" i]',
            '[class*="source" i]',
        ];

        const candidates = [];
        const seenNodes = new Set();
        const seenText = new Set();
        let sawPromptEcho = false;

        const buildCandidateFromRoot = (node, selector) => {
            if (!node || seenNodes.has(node)) return;
            seenNodes.add(node);
            if (inputEl && (node === inputEl || node.contains(inputEl))) return;
            if (composerRoot && (composerRoot.contains(node) || node.contains(composerRoot)))
                return;
            if (isClaudeUserMessage(node)) return;

            const collected = collectSanitizedFragmentCandidate(node, contentSelectors, {
                withHtml: options.withHtml,
                provider: 'claude',
            });
            const finalText = collected.text;
            if (!finalText) return;
            if (looksLikePromptEcho(finalText)) {
                sawPromptEcho = true;
                return;
            }
            const normalizedCombined = normalizeCaptureCandidateText(finalText);
            if (!normalizedCombined || seenText.has(normalizedCombined)) return;
            seenText.add(normalizedCombined);
            const order = candidates.length;
            const combinedHtml = options.withHtml ? collected.html || '' : '';
            const signature = `${selector}:${stableTextSignature(finalText)}`;

            candidates.push({
                node,
                selector,
                text: finalText,
                html: combinedHtml,
                order,
                signature,
                partCount: collected.partCount,
                nodeCount: collected.nodeCount,
                usedRoot: collected.usedRoot,
            });
        };

        const collect = (root, selector, limit) => {
            let nodes = [];
            try {
                nodes = Array.from(root.querySelectorAll(selector));
            } catch (error) {
                nodes = [];
            }
            if (nodes.length > limit) {
                nodes = nodes.slice(nodes.length - limit);
            }
            nodes.forEach((node) => {
                buildCandidateFromRoot(node, selector);
            });
        };

        for (const root of roots) {
            for (const sel of rootSelectors) {
                collect(root, sel, 40);
            }
            if (candidates.length > 0) break;
        }

        if (candidates.length === 0) {
            for (const root of roots) {
                for (const sel of contentSelectors) {
                    collect(root, sel, 50);
                }
                if (candidates.length > 0) break;
            }
        }

        if (candidates.length === 0) {
            return options.withMeta ? { text: '', meta: null } : { text: '' };
        }

        const texts = candidates.map((candidate) => candidate.text);
        const ranking = CaptureUtils?.chooseBestTextCandidate
            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'claude' })
            : {
                  bestIndex: 0,
                  best: { index: 0, score: texts[0]?.length || 0, isReferenceList: false },
                  ranked: [],
              };

        const rankingBestIndex =
            Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0 ? ranking.bestIndex : 0;
        let chosenIndex = rankingBestIndex;

        const analysisByIndex = new Map();
        const referenceByIndex = new Map();
        if (Array.isArray(ranking.ranked)) {
            ranking.ranked.forEach((item) => {
                analysisByIndex.set(item.index, item.analysis || null);
                referenceByIndex.set(item.index, Boolean(item.isReferenceList));
            });
        }

        const getAnalysisForIndex = (index) => {
            if (analysisByIndex.has(index)) return analysisByIndex.get(index);
            if (CaptureUtils && typeof CaptureUtils.analyzeText === 'function') {
                try {
                    return CaptureUtils.analyzeText(texts[index]);
                } catch (error) {
                    // ignore
                }
            }
            const raw = String(texts[index] || '').trim();
            const lines = raw
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            const urlMatches = raw.match(/\bhttps?:\/\/\S+|\bwww\.\S+/gi) || [];
            const domainMatches =
                raw.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi) || [];
            return {
                raw,
                lines,
                lineCount: lines.length,
                wordCount: raw ? raw.split(/\s+/).filter(Boolean).length : 0,
                urlCount: urlMatches.length,
                domainCount: domainMatches.length,
                urlishLineCount: lines.filter((line) =>
                    /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/i.test(line)
                ).length,
                sentenceEndPunctCount: (raw.match(/[.!?](?:\s|$)/g) || []).length,
                codeFenceCount: (raw.match(/```/g) || []).length,
                startsWithSourcesHeading: /^(sources?|references?|citations?)\b[:\s-]*/i.test(
                    lines[0] || ''
                ),
            };
        };

        const getWordCount = (index) => {
            const analysis = getAnalysisForIndex(index) || {};
            const wordCount = Number.isFinite(analysis.wordCount) ? analysis.wordCount : 0;
            return wordCount;
        };

        const getUrlishRatio = (index) => {
            const analysis = getAnalysisForIndex(index) || {};
            const lineCount = Number.isFinite(analysis.lineCount) ? analysis.lineCount : 0;
            const urlishLineCount = Number.isFinite(analysis.urlishLineCount)
                ? analysis.urlishLineCount
                : 0;
            return lineCount ? urlishLineCount / Math.max(1, lineCount) : 0;
        };

        const isReferenceCandidate = (index) => {
            if (referenceByIndex.has(index)) return referenceByIndex.get(index);
            if (CaptureUtils && typeof CaptureUtils.looksLikeReferenceList === 'function') {
                return CaptureUtils.looksLikeReferenceList(texts[index], { provider: 'claude' });
            }
            return false;
        };

        let hasExplicitProgressedCandidates = false;
        const candidateRankingPool = (() => {
            if (!Array.isArray(ranking.ranked) || ranking.ranked.length === 0) return [];
            const baselineOrder = Number.isFinite(options.preferAfterOrder)
                ? options.preferAfterOrder
                : Number.isFinite(captureState.baselineBestOrder)
                  ? captureState.baselineBestOrder
                  : null;
            const baselineSignature =
                typeof options.preferAfterSignature === 'string' &&
                options.preferAfterSignature.trim()
                    ? options.preferAfterSignature.trim()
                    : typeof captureState.baselineBestSignature === 'string' &&
                        captureState.baselineBestSignature.trim()
                      ? captureState.baselineBestSignature.trim()
                      : '';
            if (!Number.isFinite(baselineOrder) && !baselineSignature) return ranking.ranked;
            const progressed = ranking.ranked.filter((item) => {
                const candidate = candidates[item.index];
                if (!candidate) return false;
                if (Number.isFinite(baselineOrder) && Number.isFinite(candidate.order)) {
                    if (candidate.order > baselineOrder) return true;
                }
                if (
                    baselineSignature &&
                    candidate.signature &&
                    candidate.signature !== baselineSignature
                ) {
                    if (!Number.isFinite(baselineOrder)) return true;
                    return Number.isFinite(candidate.order) && candidate.order >= baselineOrder;
                }
                return false;
            });
            const nonReferenceProgressed = progressed.filter(
                (item) => item && !item.isReferenceList
            );
            if (nonReferenceProgressed.length > 0) {
                hasExplicitProgressedCandidates = true;
                return nonReferenceProgressed;
            }
            if (progressed.length > 0) {
                hasExplicitProgressedCandidates = true;
                return progressed;
            }
            return ranking.ranked;
        })();

        const bestIsReference = isReferenceCandidate(chosenIndex);
        if (bestIsReference && candidateRankingPool.length > 0) {
            const alt = candidateRankingPool.find((item) => {
                if (item.index === chosenIndex) return false;
                if (item.isReferenceList) return false;
                const analysis = item.analysis || {};
                const wordCount = analysis.wordCount || 0;
                const sentenceEndPunctCount = analysis.sentenceEndPunctCount || 0;
                const codeFenceCount = analysis.codeFenceCount || 0;
                const lineCount = analysis.lineCount || 0;
                return (
                    wordCount >= 18 ||
                    sentenceEndPunctCount >= 2 ||
                    codeFenceCount >= 1 ||
                    lineCount >= 4
                );
            });
            if (alt && Number.isFinite(alt.index) && alt.index >= 0) {
                chosenIndex = alt.index;
            }
        }

        if (hasExplicitProgressedCandidates && candidateRankingPool.length > 0) {
            chosenIndex = candidateRankingPool[0].index;
        } else if (
            candidateRankingPool.length > 0 &&
            !candidateRankingPool.some((item) => item.index === chosenIndex)
        ) {
            chosenIndex = candidateRankingPool[0].index;
        }

        const chosenWordCount = getWordCount(chosenIndex);
        if (!hasExplicitProgressedCandidates && chosenWordCount > 0 && chosenWordCount < 12) {
            let bestAltIndex = chosenIndex;
            let bestAltWordCount = chosenWordCount;
            for (let i = 0; i < texts.length; i++) {
                if (i === chosenIndex) continue;
                const wc = getWordCount(i);
                if (wc <= bestAltWordCount + 10) continue;
                if (isReferenceCandidate(i) && !isReferenceCandidate(chosenIndex)) continue;
                const urlishRatio = getUrlishRatio(i);
                if (urlishRatio >= 0.95 && wc < 24) continue;
                bestAltIndex = i;
                bestAltWordCount = wc;
            }
            if (bestAltIndex !== chosenIndex) {
                chosenIndex = bestAltIndex;
            }
        }

        const bestIndex = chosenIndex;
        const bestCandidate =
            candidates[bestIndex] || candidates[rankingBestIndex] || candidates[0] || null;
        const bestText = bestCandidate?.text || '';

        const combined = (() => {
            if (!bestCandidate || !bestText) {
                return { text: bestText, html: bestCandidate?.html || '', supplementalIndices: [] };
            }

            const combinedTexts = [bestText];
            const combinedHtmlParts =
                options.withHtml && bestCandidate?.html ? [bestCandidate.html] : [];
            const supplementalIndices = [];
            const normalizedSet = new Set([normalizeCaptureCandidateText(bestText)]);
            const bestOrder = Number.isFinite(bestCandidate?.order)
                ? bestCandidate.order
                : -Infinity;

            const ordered = candidates
                .map((candidate, index) => ({
                    ...candidate,
                    index,
                }))
                .sort((a, b) => {
                    const aOrder = Number.isFinite(a.order) ? a.order : -Infinity;
                    const bOrder = Number.isFinite(b.order) ? b.order : -Infinity;
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return a.index - b.index;
                });

            for (const entry of ordered) {
                if (entry.index === bestIndex) continue;
                const entryOrder = Number.isFinite(entry.order) ? entry.order : -Infinity;
                if (entryOrder < bestOrder) continue;

                const normalized = normalizeCaptureCandidateText(entry.text || '');
                if (!normalized || normalizedSet.has(normalized)) continue;

                const analysis = getAnalysisForIndex(entry.index) || {};
                const urlishRatio = getUrlishRatio(entry.index);
                const isReference = isReferenceCandidate(entry.index);
                const urlCount = Number.isFinite(analysis.urlCount) ? analysis.urlCount : 0;
                const domainCount = Number.isFinite(analysis.domainCount)
                    ? analysis.domainCount
                    : 0;
                const hasLinks = urlCount > 0 || domainCount > 0 || urlishRatio >= 0.45;
                if (!isReference && !hasLinks) continue;

                combinedTexts.push(entry.text);
                if (options.withHtml && entry.html) combinedHtmlParts.push(entry.html);
                supplementalIndices.push(entry.index);
                normalizedSet.add(normalized);
            }

            const combinedText = combinedTexts.join('\n\n').trim();
            let combinedHtml = '';
            if (options.withHtml && combinedHtmlParts.length) {
                combinedHtml = combinedHtmlParts.join('\n<hr>\n').trim();
                const MAX_HTML_CHARS = 120000;
                if (combinedHtml.length > MAX_HTML_CHARS) combinedHtml = '';
            }
            return { text: combinedText, html: combinedHtml, supplementalIndices };
        })();

        const finalText = combined.text || bestText;
        const finalHtml = options.withHtml ? combined.html || bestCandidate?.html || '' : '';
        const bestLen = bestCandidate ? bestCandidate.text.length : null;

        const meta = {
            provider: 'claude',
            candidateCount: candidates.length,
            sawPromptEcho,
            bestSelector: bestCandidate?.selector || null,
            bestOrder: Number.isFinite(bestCandidate?.order) ? bestCandidate.order : null,
            bestSignature: bestCandidate?.signature || null,
            bestLen: Number.isFinite(bestLen) ? bestLen : null,
            bestIsReferenceList: isReferenceCandidate(bestIndex),
            supplementalIndices: combined.supplementalIndices || [],
            supplementalCount: combined.supplementalIndices
                ? combined.supplementalIndices.length
                : 0,
            finalWordCount: getCaptureWordCount(finalText),
            finalTextLength: finalText.length,
        };

        const result = { text: finalText };
        if (options.withHtml) {
            result.html = finalHtml;
        }
        return options.withMeta ? { ...result, meta } : result;
    }

    function extractGrokResponse(options = {}) {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? inputEl.closest('form') ||
              inputEl.closest('footer') ||
              inputEl.closest('[role="form"]') ||
              inputEl.parentElement
            : null;
        const roots = [
            document.querySelector('main'),
            document.querySelector('[role="main"]'),
            document.body,
        ].filter(Boolean);
        let composerTop = null;
        if (composerRoot) {
            try {
                const composerRect = composerRoot.getBoundingClientRect();
                composerTop = Number.isFinite(composerRect.top) ? composerRect.top : null;
            } catch (error) {
                composerTop = null;
            }
        }

        const rootSelectors = [
            '[data-testid*="assistant" i]',
            '[data-role*="assistant" i]',
            '[data-author*="assistant" i]',
            'article',
            '[role="article"]',
            '[class*="assistant" i]',
            '[class*="message" i]',
        ];

        const contentSelectors = [
            '[data-testid="message-content"]',
            '[data-testid*="message" i]',
            '[data-testid*="chat-message" i]',
            '[data-testid*="conversation" i] [data-testid*="message" i]',
            '.response-content-markdown',
            '[class*="response-content-markdown" i]',
            '.markdown',
            '.prose',
            '[class*="markdown" i]',
            '[class*="prose" i]',
        ];
        const responseContentSelectors = [
            '.response-content-markdown',
            '[class*="response-content-markdown" i]',
        ];
        const assistantRootSelector = [
            '[data-testid*="assistant" i]',
            '[data-role*="assistant" i]',
            '[data-author*="assistant" i]',
            '[data-message-author-role="assistant"]',
            'article',
            '[role="article"]',
            '[class*="assistant" i]',
            '[class*="message" i]',
            '[class*="response" i]',
        ].join(', ');

        const candidates = [];
        const seenNodes = new Set();
        const seenText = new Set();
        let sawPromptEcho = false;
        const rejectionCounts = {
            promptEcho: 0,
            controlOnly: 0,
            composerOverlap: 0,
            composerZoneOverlap: 0,
            userMessage: 0,
            empty: 0,
        };
        const responseContentSelectorList = responseContentSelectors.join(', ');

        const describeNode = (node) => {
            if (!node || !(node instanceof Element)) return 'unknown';
            const tag = String(node.tagName || '').toLowerCase();
            const id = node.id ? `#${node.id}` : '';
            const className = String(node.className || '')
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 4)
                .join('.');
            return `${tag}${id}${className ? `.${className}` : ''}`;
        };

        const isResponseContentNode = (node) => {
            if (!node || !(node instanceof Element)) return false;
            try {
                return node.matches(responseContentSelectorList);
            } catch (error) {
                return false;
            }
        };

        const overlapsComposerZone = (candidate) => {
            if (!composerRoot || !Number.isFinite(composerTop)) return false;
            if (!candidate || !(candidate instanceof Element)) return false;
            let rect = null;
            try {
                rect = candidate.getBoundingClientRect();
            } catch (error) {
                rect = null;
            }
            if (!rect || !Number.isFinite(rect.bottom)) return false;
            // Anything overlapping the composer lane is likely draft/editor UI, not assistant output.
            return rect.bottom >= composerTop - 4;
        };

        const collectScopedAssistantResponseCandidates = () => {
            const entries = [];
            const seen = new Set();
            for (const root of roots) {
                for (const selector of responseContentSelectors) {
                    let nodes = [];
                    try {
                        nodes = Array.from(root.querySelectorAll(selector));
                    } catch (error) {
                        nodes = [];
                    }
                    for (const node of nodes) {
                        if (!node || seen.has(node)) continue;
                        seen.add(node);
                        if (inputEl && (node === inputEl || inputEl.contains(node))) continue;
                        if (
                            composerRoot &&
                            (composerRoot.contains(node) || node.contains(composerRoot))
                        ) {
                            rejectionCounts.composerOverlap += 1;
                            captureDebug('Grok candidate rejected: composer_overlap', {
                                selector,
                                reason: 'inside_composer_scoped',
                            });
                            continue;
                        }

                        let assistantRoot = null;
                        try {
                            assistantRoot = node.closest(assistantRootSelector);
                        } catch (error) {
                            assistantRoot = null;
                        }
                        if (!assistantRoot) assistantRoot = node.parentElement;
                        if (!assistantRoot || isGrokUserMessage(assistantRoot)) {
                            rejectionCounts.userMessage += 1;
                            continue;
                        }
                        if (
                            composerRoot &&
                            (composerRoot.contains(assistantRoot) ||
                                assistantRoot.contains(composerRoot))
                        ) {
                            rejectionCounts.composerOverlap += 1;
                            captureDebug('Grok candidate rejected: composer_overlap', {
                                selector,
                                reason: 'assistant_root_overlaps_composer',
                            });
                            continue;
                        }

                        const rawText = (node.innerText || node.textContent || '').trim();
                        const text = sanitizeGrokTranscriptCandidate(rawText, { allowShort: true });
                        if (!text) {
                            rejectionCounts.empty += 1;
                            continue;
                        }
                        if (looksLikePromptEcho(text)) {
                            sawPromptEcho = true;
                            rejectionCounts.promptEcho += 1;
                            continue;
                        }
                        if (isGrokControlOnlyText(text)) {
                            rejectionCounts.controlOnly += 1;
                            continue;
                        }

                        const normalized = normalizeCaptureCandidateText(text);
                        if (!normalized || seenText.has(normalized)) continue;
                        seenText.add(normalized);

                        let rect = null;
                        try {
                            rect = assistantRoot.getBoundingClientRect();
                        } catch (error) {
                            rect = null;
                        }
                        const bottom = rect && Number.isFinite(rect.bottom) ? rect.bottom : 0;
                        entries.push({
                            node,
                            assistantRoot,
                            selector,
                            text,
                            html: options.withHtml ? extractCleanHtmlFromNode(node) : '',
                            bottom,
                            shapeSignature: `assistant_scoped|${Math.round(bottom)}|${text.length}`,
                        });
                    }
                }
            }

            entries.sort((a, b) => {
                const aBottom = Number.isFinite(a.bottom) ? a.bottom : -Infinity;
                const bBottom = Number.isFinite(b.bottom) ? b.bottom : -Infinity;
                if (aBottom !== bBottom) return aBottom - bBottom;
                if (a.node === b.node) return 0;
                if (a.node && b.node && a.node.compareDocumentPosition) {
                    const position = a.node.compareDocumentPosition(b.node);
                    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                }
                return 0;
            });
            return entries;
        };

        const scopedResponseCandidates = collectScopedAssistantResponseCandidates();
        if (scopedResponseCandidates.length) {
            const scopedBest = scopedResponseCandidates[scopedResponseCandidates.length - 1];
            const bestBottom = Number.isFinite(scopedBest.bottom)
                ? Math.round(scopedBest.bottom)
                : null;
            const bestLen = scopedBest.text ? scopedBest.text.length : null;
            captureDebug('Grok assistant root found', {
                root: describeNode(scopedBest.assistantRoot),
                rootBottom: bestBottom,
                candidateCount: scopedResponseCandidates.length,
            });
            captureDebug('Grok response-content-markdown node selected', {
                selector: scopedBest.selector,
                node: describeNode(scopedBest.node),
                textLen: bestLen,
            });
            captureDebug('Grok primary extraction length', {
                textLen: bestLen,
                source: 'assistant_response_markdown',
            });
            const scopedMeta = {
                provider: 'grok',
                source: 'assistant_response_markdown',
                candidateCount: scopedResponseCandidates.length,
                sawPromptEcho,
                bestSelector: scopedBest.selector,
                bestBottom,
                bestLen,
                bestShapeSignature: scopedBest.shapeSignature,
                rejectionCounts,
            };
            const scopedResult = { text: scopedBest.text || '' };
            if (options.withHtml) {
                scopedResult.html = scopedBest.html || '';
            }
            return options.withMeta ? { ...scopedResult, meta: scopedMeta } : scopedResult;
        }

        const buildCandidateFromRoot = (node, selector) => {
            if (!node || seenNodes.has(node)) return;
            seenNodes.add(node);
            if (inputEl && (node === inputEl || inputEl.contains(node))) {
                rejectionCounts.composerOverlap += 1;
                captureDebug('Grok candidate rejected: composer_overlap', {
                    selector,
                    reason: 'input_overlap',
                });
                return;
            }
            if (composerRoot && composerRoot.contains(node)) {
                rejectionCounts.composerOverlap += 1;
                captureDebug('Grok candidate rejected: composer_overlap', {
                    selector,
                    reason: 'inside_composer',
                });
                return;
            }
            if (isGrokUserMessage(node)) {
                rejectionCounts.userMessage += 1;
                return;
            }
            const wrapperContainsComposer = Boolean(
                composerRoot && node !== composerRoot && node.contains(composerRoot)
            );

            const contentNodes = [];
            for (const sel of contentSelectors) {
                try {
                    node.querySelectorAll(sel).forEach((child) => contentNodes.push(child));
                } catch (error) {
                    // ignore selector failures
                }
            }
            const topLevel = getTopLevelNodes(contentNodes);
            const nodes = topLevel.length ? topLevel : wrapperContainsComposer ? [] : [node];

            const parts = [];
            const htmlParts = [];
            const localSeen = new Set();

            for (const child of nodes) {
                if (!child || isGrokUserMessage(child)) continue;
                if (
                    composerRoot &&
                    (composerRoot.contains(child) || child.contains(composerRoot))
                ) {
                    rejectionCounts.composerOverlap += 1;
                    captureDebug('Grok candidate rejected: composer_overlap', {
                        selector,
                        reason: 'composer_overlap',
                    });
                    continue;
                }
                if (!isResponseContentNode(child) && overlapsComposerZone(child)) {
                    rejectionCounts.composerZoneOverlap += 1;
                    captureDebug('Grok candidate rejected: composer_zone_overlap', {
                        selector,
                        reason: 'composer_zone_overlap',
                    });
                    continue;
                }
                const text = (child.innerText || child.textContent || '').trim();
                if (!text) continue;
                if (isGrokControlOnlyText(text)) {
                    rejectionCounts.controlOnly += 1;
                    captureDebug('Grok candidate rejected: control_only', {
                        selector,
                        preview: String(text).slice(0, 140),
                    });
                    continue;
                }
                const sanitizedText = sanitizeGrokTranscriptCandidate(text, { allowShort: true });
                if (!sanitizedText) {
                    rejectionCounts.empty += 1;
                    captureDebug('Grok candidate rejected: sanitized_out', {
                        selector,
                        preview: String(text).slice(0, 140),
                    });
                    continue;
                }
                const normalized = normalizeCaptureCandidateText(sanitizedText);
                if (!normalized || localSeen.has(normalized)) continue;
                localSeen.add(normalized);
                parts.push(sanitizedText);
                if (options.withHtml) {
                    const html = extractCleanHtmlFromNode(child);
                    if (html) htmlParts.push(html);
                }
            }

            let combinedText = parts.join('\n\n').trim();
            combinedText = sanitizeGrokTranscriptCandidate(combinedText, { allowShort: true });
            if (!combinedText) {
                rejectionCounts.empty += 1;
                return;
            }
            if (looksLikePromptEcho(combinedText)) {
                sawPromptEcho = true;
                rejectionCounts.promptEcho += 1;
                captureDebug('Grok candidate rejected: prompt_echo', {
                    selector,
                    preview: String(combinedText).slice(0, 140),
                });
                return;
            }
            if (isGrokControlOnlyText(combinedText)) {
                rejectionCounts.controlOnly += 1;
                captureDebug('Grok candidate rejected: control_only_combined', {
                    selector,
                    preview: String(combinedText).slice(0, 140),
                });
                return;
            }

            const normalizedCombined = normalizeCaptureCandidateText(combinedText);
            if (!normalizedCombined || seenText.has(normalizedCombined)) return;
            seenText.add(normalizedCombined);

            let rect;
            try {
                rect = node.getBoundingClientRect();
            } catch (error) {
                rect = null;
            }
            const bottom = rect && Number.isFinite(rect.bottom) ? rect.bottom : 0;
            const shapeSignature = `${selector}|${Math.round(bottom)}|${parts.length}|${nodes.length}`;

            let combinedHtml = '';
            if (options.withHtml && htmlParts.length) {
                combinedHtml = htmlParts.join('\n').trim();
                const MAX_HTML_CHARS = 120000;
                if (combinedHtml.length > MAX_HTML_CHARS) combinedHtml = '';
            }

            candidates.push({
                node,
                selector,
                text: combinedText,
                html: combinedHtml,
                bottom,
                partCount: parts.length,
                nodeCount: nodes.length,
                shapeSignature,
            });
        };

        const collect = (root, selector, limit) => {
            let nodes = [];
            try {
                nodes = Array.from(root.querySelectorAll(selector));
            } catch (error) {
                nodes = [];
            }
            if (nodes.length > limit) nodes = nodes.slice(nodes.length - limit);
            nodes.forEach((node) => buildCandidateFromRoot(node, selector));
        };

        for (const root of roots) {
            for (const sel of rootSelectors) {
                collect(root, sel, 45);
            }
            if (candidates.length > 0) break;
        }

        if (candidates.length === 0) {
            for (const root of roots) {
                for (const sel of contentSelectors) {
                    collect(root, sel, 60);
                }
                if (candidates.length > 0) break;
            }
        }

        if (candidates.length === 0) {
            return options.withMeta
                ? {
                      text: '',
                      meta: {
                          provider: 'grok',
                          candidateCount: 0,
                          sawPromptEcho,
                          ...rejectionCounts,
                      },
                  }
                : { text: '' };
        }

        const orderedByBottom = candidates
            .map((candidate, index) => ({ ...candidate, index }))
            .sort((a, b) => {
                const aBottom = Number.isFinite(a.bottom) ? a.bottom : -Infinity;
                const bBottom = Number.isFinite(b.bottom) ? b.bottom : -Infinity;
                if (bBottom !== aBottom) return bBottom - aBottom;
                return b.index - a.index;
            });

        const topBottom = Number.isFinite(orderedByBottom[0]?.bottom)
            ? orderedByBottom[0].bottom
            : -Infinity;
        const recentWindowPx = 520;
        const recentCandidates = orderedByBottom
            .filter(
                (entry, index) =>
                    index < 12 ||
                    (Number.isFinite(entry.bottom) && topBottom - entry.bottom <= recentWindowPx)
            )
            .slice(0, 18);

        const rankingPool = recentCandidates.length
            ? recentCandidates
            : orderedByBottom.slice(0, 12);
        const texts = rankingPool.map((candidate) => candidate.text);
        const ranking = CaptureUtils?.chooseBestTextCandidate
            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'grok' })
            : {
                  bestIndex: 0,
                  best: { index: 0, isReferenceList: false, isUiControlText: false },
                  ranked: [],
              };

        const rankingBestIndex =
            Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0 ? ranking.bestIndex : 0;
        let bestPoolIndex = rankingBestIndex;

        const rankedByIndex = new Map();
        if (Array.isArray(ranking.ranked)) {
            ranking.ranked.forEach((item) => rankedByIndex.set(item.index, item));
        }

        const isControlRank = (poolIndex) => {
            const item = rankedByIndex.get(poolIndex);
            if (item && item.isUiControlText) return true;
            return isGrokControlOnlyText(texts[poolIndex] || '');
        };

        const isReferenceRank = (poolIndex) => {
            const item = rankedByIndex.get(poolIndex);
            return Boolean(item?.isReferenceList);
        };

        if (isControlRank(bestPoolIndex) && Array.isArray(ranking.ranked)) {
            const alternative = ranking.ranked.find(
                (item) => item.index !== bestPoolIndex && !item.isUiControlText
            );
            if (alternative && Number.isFinite(alternative.index) && alternative.index >= 0) {
                bestPoolIndex = alternative.index;
            }
        }

        let bestCandidate =
            rankingPool[bestPoolIndex] || rankingPool[rankingBestIndex] || rankingPool[0] || null;
        if (bestCandidate && isGrokControlOnlyText(bestCandidate.text || '')) {
            const nonControlRecent = rankingPool.find(
                (entry) => !isGrokControlOnlyText(entry.text || '')
            );
            if (nonControlRecent) bestCandidate = nonControlRecent;
        }
        if (!bestCandidate && orderedByBottom.length > 0) {
            bestCandidate =
                orderedByBottom.find((entry) => !isGrokControlOnlyText(entry.text || '')) ||
                orderedByBottom[0];
        }
        if (options.grokPreferLatestBottom) {
            const latestNonControl = orderedByBottom.find(
                (entry) => !isGrokControlOnlyText(entry.text || '')
            );
            if (latestNonControl) bestCandidate = latestNonControl;
        }

        const resolvedPoolIndex = rankingPool.findIndex((entry) => entry === bestCandidate);
        const bestBottom = bestCandidate ? bestCandidate.bottom : -Infinity;
        const bestLen = bestCandidate ? bestCandidate.text.length : null;
        const bestShapeSignature = bestCandidate?.shapeSignature || null;

        const meta = {
            provider: 'grok',
            candidateCount: candidates.length,
            recentCandidateCount: rankingPool.length,
            sawPromptEcho,
            bestSelector: bestCandidate?.selector || null,
            bestBottom: Number.isFinite(bestBottom) ? Math.round(bestBottom) : null,
            bestLen: Number.isFinite(bestLen) ? bestLen : null,
            bestIsReferenceList:
                resolvedPoolIndex >= 0 ? isReferenceRank(resolvedPoolIndex) : false,
            bestIsControlOnly:
                resolvedPoolIndex >= 0
                    ? isControlRank(resolvedPoolIndex)
                    : isGrokControlOnlyText(bestCandidate?.text || ''),
            bestShapeSignature,
            rejectionCounts,
        };
        captureDebug('extractGrokResponse', meta);

        const result = { text: bestCandidate?.text || '' };
        if (options.withHtml) {
            result.html =
                bestCandidate?.html ||
                (bestCandidate?.node ? extractCleanHtmlFromNode(bestCandidate.node) : '');
        }
        return options.withMeta ? { ...result, meta } : result;
    }

    function extractGrokTranscriptTailText(options = {}) {
        const root =
            document.querySelector('main') ||
            document.querySelector('[role="main"]') ||
            document.body;
        if (!root) {
            return options.withMeta
                ? {
                      text: '',
                      meta: { provider: 'grok', source: 'transcript_tail', reason: 'no_root' },
                  }
                : '';
        }

        const clone = root.cloneNode(true);
        const removeSelectors = [
            'script',
            'style',
            'noscript',
            'button',
            'input',
            'textarea',
            'select',
            'option',
            'svg',
            'canvas',
            'picture',
            'video',
            'audio',
        ];
        try {
            clone.querySelectorAll(removeSelectors.join(',')).forEach((node) => node.remove());
        } catch (error) {
            // ignore
        }

        // Remove obvious composer-like sections in the cloned tree to avoid recapturing draft input.
        try {
            clone
                .querySelectorAll(
                    'footer, [role="form"], form, [role="textbox"], [contenteditable="true"], .tiptap.ProseMirror'
                )
                .forEach((node) => node.remove());
        } catch (error) {
            // ignore
        }

        let rawText = '';
        try {
            rawText = (clone.innerText || clone.textContent || '').trim();
        } catch (error) {
            rawText = '';
        }
        if (!rawText) {
            return options.withMeta
                ? {
                      text: '',
                      meta: {
                          provider: 'grok',
                          source: 'transcript_tail',
                          reason: 'empty_after_clone',
                      },
                  }
                : '';
        }

        const rawLines = rawText.split(/\r?\n/);
        const lines = rawLines
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !isGrokControlOnlyText(line))
            .filter((line) => !isGrokPromptScaffoldLine(line));
        if (!lines.length) {
            return options.withMeta
                ? {
                      text: '',
                      meta: {
                          provider: 'grok',
                          source: 'transcript_tail',
                          reason: 'only_controls_or_scaffold',
                      },
                  }
                : '';
        }

        const fullTranscript = sanitizeGrokTranscriptCandidate(lines.join('\n').trim(), {
            allowShort: false,
        });
        if (!fullTranscript) {
            return options.withMeta
                ? {
                      text: '',
                      meta: {
                          provider: 'grok',
                          source: 'transcript_tail',
                          reason: 'filtered_or_low_quality',
                          lineCount: lines.length,
                          chunkCount: 0,
                      },
                  }
                : '';
        }

        const MAX_CHARS = 20000;
        const boundedResult = boundGrokTranscriptTail(fullTranscript, MAX_CHARS);
        const bounded = boundedResult.text;
        const finalText = sanitizeGrokTranscriptCandidate(bounded, { allowShort: false });
        if (!finalText) {
            return options.withMeta
                ? {
                      text: '',
                      meta: {
                          provider: 'grok',
                          source: 'transcript_tail',
                          reason: 'low_quality_after_bound',
                          lineCount: lines.length,
                          chunkCount: 0,
                      },
                  }
                : '';
        }

        if (options.withMeta) {
            return {
                text: finalText,
                meta: {
                    provider: 'grok',
                    source: 'transcript_tail',
                    lineCount: lines.length,
                    chunkCount: 0,
                    usedChunk: boundedResult.truncated,
                    fullLen: fullTranscript.length,
                    truncated: boundedResult.truncated,
                    droppedLeadingPartialLine: boundedResult.droppedLeadingPartialLine,
                },
            };
        }
        return finalText;
    }

    function extractLatestResponse(options = {}) {
        if (isChatGPT) return extractChatGPTResponse(options);
        if (isGemini) return extractGeminiResponse(options);
        if (isClaude) return extractClaudeResponse(options);
        return extractGrokResponse(options);
    }

    function _extractLatestResponseText() {
        return extractLatestResponse({ withMeta: false }).text || '';
    }

    function normalizeInlineText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function sanitizeModelLabel(rawLabel) {
        const normalized = normalizeInlineText(rawLabel)
            .replace(/^Model:\s*/i, '')
            .trim();
        if (!normalized) return '';

        // Guardrails: model labels should be short and single-line.
        const maxLen = 80;
        if (normalized.length > maxLen) return '';

        const words = normalized.split(' ').filter(Boolean);
        if (words.length > 12) return '';

        // Avoid accidentally capturing page/chat text.
        const suspicious = [
            /iteration\s*\d/i,
            /user (query|message)/i,
            /\bnow respond\b/i,
            /\bmulti[-\s]llm\b/i,
            /\bmulti[-\s]agent\b/i,
            /\bdebate\b/i,
            /\bhere is\b/i,
            /\bchatgpt\b.*\banswer\b/i,
            /\bgemini\b.*\banswer\b/i,
        ];
        if (suspicious.some((re) => re.test(normalized))) return '';

        return normalized;
    }

    function detectChatGPTModelLabel() {
        const selectors = [
            'button[data-testid="model-switcher-button"]',
            '[data-testid="model-switcher"] button',
            'button[aria-haspopup="menu"][aria-label*="Model" i]',
            'button[aria-label*="model" i]',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const aria = normalizeInlineText(el.getAttribute('aria-label') || '');
            const text = normalizeInlineText(el.textContent || '');
            for (const candidate of [text, aria]) {
                const label = sanitizeModelLabel(candidate);
                if (label) return label;
            }
        }
        return '';
    }

    function detectGeminiModelLabel() {
        const selectors = [
            'button[aria-label*="Model" i]',
            'button[aria-label*="Gemini" i]',
            'mat-select[aria-label*="Model" i] .mat-select-value-text',
            'mat-select .mat-select-value-text',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const aria = normalizeInlineText(el.getAttribute('aria-label') || '');
            const text = normalizeInlineText(el.textContent || '');
            for (const candidate of [text, aria]) {
                const label = sanitizeModelLabel(candidate);
                if (label) return label;
            }
        }
        return '';
    }

    function detectClaudeModelLabel() {
        const selectors = [
            'button[aria-label*="Model" i]',
            'button[aria-label*="Claude" i]',
            '[data-testid*="model" i]',
            '[data-testid*="model" i] button',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const aria = normalizeInlineText(el.getAttribute('aria-label') || '');
            const text = normalizeInlineText(el.textContent || '');
            for (const candidate of [text, aria]) {
                const label = sanitizeModelLabel(candidate);
                if (label) return label;
            }
        }
        return '';
    }

    function detectGrokModelLabel() {
        const selectors = [
            'button[aria-label*="Model" i]',
            'button[aria-label*="Grok" i]',
            'button[title*="Model" i]',
            '[data-testid*="model" i]',
            '[data-testid*="model" i] button',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const aria = normalizeInlineText(el.getAttribute('aria-label') || '');
            const text = normalizeInlineText(el.textContent || '');
            for (const candidate of [text, aria]) {
                const label = sanitizeModelLabel(candidate);
                if (label) return label;
            }
        }
        return '';
    }

    function detectModelLabel() {
        if (isChatGPT) return detectChatGPTModelLabel();
        if (isGemini) return detectGeminiModelLabel();
        if (isClaude) return detectClaudeModelLabel();
        return detectGrokModelLabel();
    }

    function shouldConfirmModelLabel(label) {
        const words = label.split(' ').filter(Boolean);
        return label.length > 30 || words.length > 4;
    }

    let lastModelLabel = '';
    let pendingModelLabel = '';
    let pendingModelHits = 0;
    function sendModelInfoIfChanged() {
        const label = sanitizeModelLabel(detectModelLabel());
        if (!label) {
            pendingModelLabel = '';
            pendingModelHits = 0;
            return;
        }
        if (label === lastModelLabel) {
            pendingModelLabel = '';
            pendingModelHits = 0;
            return;
        }

        if (shouldConfirmModelLabel(label)) {
            if (label === pendingModelLabel) {
                pendingModelHits += 1;
            } else {
                pendingModelLabel = label;
                pendingModelHits = 1;
            }
            if (pendingModelHits < 2) return;
            pendingModelLabel = '';
            pendingModelHits = 0;
        }

        lastModelLabel = label;
        chrome.runtime.sendMessage(
            {
                type: 'PROVIDER_MODEL_INFO',
                provider: currentLLM,
                modelLabel: label,
            },
            () => {
                if (chrome.runtime.lastError) {
                    // ignore
                }
            }
        );
    }

    function sendCapturedResponse(extraction) {
        const text =
            typeof extraction === 'string'
                ? extraction
                : extraction?.text || extraction?.content || '';
        const contentHtml =
            typeof extraction === 'object' && extraction
                ? extraction.html || extraction.contentHtml || ''
                : '';

        const responsePayload = {
            content: text,
            contentHtml,
            promptId: captureState.promptId,
            turnAttemptId: captureState.turnAttemptId,
            sessionId: captureState.sessionId,
            agentId: captureState.agentId,
            sourceLLM: currentLLM,
            turnIndex: captureState.turnIndex,
            timestamp: Date.now(),
            responseDelay: captureState.startedAt ? Date.now() - captureState.startedAt : null,
        };

        const messageType = captureState.sessionId
            ? 'MLC_RESPONSE_CAPTURED'
            : currentLLM === 'chatgpt'
              ? 'CHATGPT_RESPONSE_CAPTURED'
              : currentLLM === 'gemini'
                ? 'GEMINI_RESPONSE_CAPTURED'
                : currentLLM === 'claude'
                  ? 'CLAUDE_RESPONSE_CAPTURED'
                  : 'GROK_RESPONSE_CAPTURED';

        chrome.runtime.sendMessage({ type: messageType, ...responsePayload }, () => {
            if (chrome.runtime.lastError) {
                console.error(
                    `[MLC Capture - ${currentLLM}] Failed to send response:`,
                    chrome.runtime.lastError
                );
                captureState.active = true;
                return;
            }
            captureState.active = false;
            captureState.lastEmitAt = Date.now();
            console.log(
                `[MLC Capture - ${currentLLM}] Response captured for prompt ${captureState.promptId}`
            );
        });
    }

    function emitCaptureFromResolvedExtraction(reason, extraction) {
        const baseExtraction =
            typeof extraction === 'object' && extraction
                ? extraction
                : { text: String(extraction || '') };
        let resolved = { ...baseExtraction };
        let text = String(resolved?.text || resolved?.content || '').trim();
        let source = resolved?.meta?.source || 'primary';

        if (!text && isGrok) {
            const fallback = extractGrokTranscriptTailText({ withMeta: true });
            const fallbackText = extractGrokIncrementalTranscriptText(fallback?.text || '', {
                allowFullWhenNoBaseline: true,
            });
            if (fallbackText) {
                resolved = {
                    text: fallbackText,
                    meta: {
                        ...(fallback?.meta || {}),
                        source: 'transcript_tail_emit_fallback',
                    },
                };
                text = fallbackText;
                source = 'transcript_tail_emit_fallback';
            }
        }

        if (isGrok) {
            const alreadyIncrementalTailDelta =
                source.startsWith('transcript_tail') ||
                source === 'reused_last_incremental_candidate';
            if (!alreadyIncrementalTailDelta) {
                const trimmedPrimary = maybeTrimGrokIncrementalCandidate(text, {
                    allowFullWhenNoBaseline: false,
                });
                if (trimmedPrimary.trimmed) {
                    text = trimmedPrimary.text;
                    resolved.text = text;
                    const currentSource = source || 'primary';
                    source = currentSource.includes('incremental')
                        ? currentSource
                        : `${currentSource}_incremental_trim`;
                    resolved.meta = {
                        ...(resolved.meta || {}),
                        source,
                        incrementalTrimmed: true,
                        incrementalTrimReductionChars: trimmedPrimary.reductionChars,
                    };
                    captureDebug('Grok primary capture trimmed to incremental answer', {
                        llm: currentLLM,
                        reason,
                        source,
                        reductionChars: trimmedPrimary.reductionChars,
                        textLen: text.length,
                    });
                }
            }
            const shouldUseStrictTailGate = source.startsWith('transcript_tail');
            if (shouldUseStrictTailGate) {
                const sanitizedTail = sanitizeGrokTranscriptCandidate(text, { allowShort: false });
                if (!sanitizedTail) {
                    captureDebug('Capture emit skipped (grok tail rejected)', {
                        llm: currentLLM,
                        reason,
                        source,
                        textLen: String(text || '').length,
                    });
                    return false;
                }
                text = sanitizedTail;
            }
            if (isGrokControlOnlyText(text)) {
                captureDebug('Capture emit skipped (control_only)', {
                    llm: currentLLM,
                    reason,
                    source,
                    textLen: String(text || '').length,
                });
                return false;
            }
        }

        const normalizedText = normalizeCaptureCandidateText(text);
        if (!normalizedText) {
            captureDebug('Capture emit skipped (empty)', {
                llm: currentLLM,
                reason,
                source,
                textLen: String(text || '').length,
            });
            return false;
        }

        if (looksLikePromptEcho(text)) {
            captureDebug('Capture emit skipped (prompt_echo)', {
                llm: currentLLM,
                reason,
                source,
                textLen: String(text || '').length,
            });
            return false;
        }

        if (isGrok) {
            text = stripGrokUiFooterArtifacts(text);
            if (!normalizeCaptureCandidateText(text)) {
                captureDebug('Capture emit skipped (grok footer-only)', {
                    llm: currentLLM,
                    reason,
                    source,
                });
                return false;
            }
            // Grok rich HTML frequently includes UI footer widgets; render as plain text only.
            resolved.html = '';
            resolved.contentHtml = '';
            captureDebug('Grok full text length before emit', {
                llm: currentLLM,
                reason,
                source,
                textLen: text.length,
                usesTranscriptTail: source.startsWith('transcript_tail'),
            });
        }
        resolved.text = text;
        captureDebug('Capture emit', {
            llm: currentLLM,
            reason,
            textLen: text.length,
            source,
            bestSelector: resolved?.meta?.bestSelector || null,
            bestBottom: Number.isFinite(resolved?.meta?.bestBottom)
                ? resolved.meta.bestBottom
                : null,
        });
        sendCapturedResponse(resolved);
        return true;
    }

    let scheduledEvaluateHandle = null;
    function scheduleEvaluateCapture(delayMs = 0) {
        if (!captureState.active) return;
        if (scheduledEvaluateHandle) return;
        const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
        scheduledEvaluateHandle = setTimeout(() => {
            scheduledEvaluateHandle = null;
            evaluateCapture();
        }, delay);
    }

    function evaluateCapture() {
        if (!captureState.active) return;
        const now = Date.now();
        const minDelayMs = isChatGPT ? 1200 : 800;
        if (now - captureState.startedAt < minDelayMs) return;

        let extraction = extractLatestResponse({ withMeta: true, withHtml: true });
        let text = extraction.text || '';
        captureState.lastExtractionMeta = extraction.meta || null;
        let meta = captureState.lastExtractionMeta || {};

        const grokControl = isGrok ? getGrokControlState() : null;
        if (isGrok && grokControl?.stopVisible) captureState.grokSawStopControl = true;
        if (isGrok && captureState.grokSawStopControl && grokControl?.voiceVisible) {
            captureState.grokSawVoiceAfterStop = true;
        }
        const grokCompletedByControls = Boolean(
            isGrok &&
            captureState.grokSawStopControl &&
            !grokControl?.stopVisible &&
            (grokControl?.voiceVisible ||
                grokControl?.sendVisible ||
                captureState.grokSawVoiceAfterStop)
        );
        const grokLooksComplete = Boolean(
            isGrok &&
            !grokControl?.stopVisible &&
            (grokControl?.voiceVisible || grokControl?.sendVisible)
        );

        let currentGrokBestBottom =
            isGrok && Number.isFinite(meta.bestBottom) ? meta.bestBottom : null;
        let currentGrokCandidateCount =
            isGrok && Number.isFinite(meta.candidateCount) ? meta.candidateCount : null;
        let currentGrokShapeSignature =
            isGrok && typeof meta.bestShapeSignature === 'string' ? meta.bestShapeSignature : '';
        const baselineGrokBestBottom =
            isGrok && Number.isFinite(captureState.grokBaselineBestBottom)
                ? captureState.grokBaselineBestBottom
                : null;
        const baselineGrokCandidateCount =
            isGrok && Number.isFinite(captureState.grokBaselineCandidateCount)
                ? captureState.grokBaselineCandidateCount
                : null;

        if (isGrok && text) {
            const trimmedPrimary = maybeTrimGrokIncrementalCandidate(text, {
                allowFullWhenNoBaseline: false,
            });
            if (trimmedPrimary.trimmed) {
                text = trimmedPrimary.text;
                extraction = {
                    ...extraction,
                    text,
                    meta: {
                        ...(extraction.meta || {}),
                        source: `${(extraction.meta && extraction.meta.source) || 'primary'}_incremental_trim`,
                        incrementalTrimmed: true,
                        incrementalTrimReductionChars: trimmedPrimary.reductionChars,
                    },
                };
                captureState.lastExtractionMeta = extraction.meta || null;
                meta = captureState.lastExtractionMeta || {};
                currentGrokBestBottom = Number.isFinite(meta.bestBottom)
                    ? meta.bestBottom
                    : currentGrokBestBottom;
                currentGrokCandidateCount = Number.isFinite(meta.candidateCount)
                    ? meta.candidateCount
                    : currentGrokCandidateCount;
                currentGrokShapeSignature =
                    typeof meta.bestShapeSignature === 'string'
                        ? meta.bestShapeSignature
                        : currentGrokShapeSignature;
                captureDebug('Grok primary extraction trimmed to incremental answer', {
                    reductionChars: trimmedPrimary.reductionChars,
                    textLen: text.length,
                    source: extraction.meta?.source || 'primary_incremental_trim',
                });
            }
        }

        const tryGrokFallbackExtraction = (reason) => {
            if (!isGrok) return false;
            const fallback = extractGrokTranscriptTailText({ withMeta: true });
            const fallbackText = String(fallback?.text || '').trim();
            if (!fallbackText) return false;
            if (isGrokControlOnlyText(fallbackText)) return false;
            const incrementalFallbackText = extractGrokIncrementalTranscriptText(fallbackText, {
                allowFullWhenNoBaseline: true,
            });
            if (!incrementalFallbackText) {
                captureDebug('Grok fallback rejected: no incremental transcript delta', {
                    reason,
                    fallbackTextLen: fallbackText.length,
                    baselineTailLen: String(captureState.grokBaselineTranscriptTail || '').length,
                    baselinePrimaryLen: String(captureState.baselineText || '').length,
                });
                return false;
            }
            const incrementalNormalized = normalizeCaptureCandidateText(incrementalFallbackText);
            if (!incrementalNormalized) return false;

            extraction = {
                text: incrementalFallbackText,
                meta: {
                    ...(fallback?.meta || {}),
                    bestBottom: Number.isFinite(currentGrokBestBottom)
                        ? currentGrokBestBottom
                        : Number.isFinite(baselineGrokBestBottom)
                          ? baselineGrokBestBottom + 8
                          : null,
                    candidateCount: Number.isFinite(currentGrokCandidateCount)
                        ? currentGrokCandidateCount
                        : Number.isFinite(baselineGrokCandidateCount)
                          ? baselineGrokCandidateCount + 1
                          : 1,
                    bestShapeSignature: `fallback:${stableTextSignature(incrementalFallbackText)}`,
                    fallbackReason: reason,
                },
            };
            text = extraction.text;
            captureState.lastExtractionMeta = extraction.meta || null;
            meta = captureState.lastExtractionMeta || {};
            currentGrokBestBottom = Number.isFinite(meta.bestBottom)
                ? meta.bestBottom
                : currentGrokBestBottom;
            currentGrokCandidateCount = Number.isFinite(meta.candidateCount)
                ? meta.candidateCount
                : currentGrokCandidateCount;
            currentGrokShapeSignature =
                typeof meta.bestShapeSignature === 'string'
                    ? meta.bestShapeSignature
                    : currentGrokShapeSignature;
            captureDebug('Grok transcript-tail fallback selected', {
                reason,
                lineCount: fallback?.meta?.lineCount ?? null,
                chunkCount: fallback?.meta?.chunkCount ?? null,
                usedChunk: fallback?.meta?.usedChunk ?? null,
            });
            return true;
        };

        if (!captureState.hasNewText) {
            if (!text) {
                if (
                    !(grokCompletedByControls || grokLooksComplete) ||
                    !tryGrokFallbackExtraction('empty_primary')
                ) {
                    return;
                }
            }

            if (isChatGPT) {
                const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
                    ? captureState.baselineAssistantCount
                    : null;
                const baselineAssistantIndex = Number.isFinite(captureState.baselineAssistantIndex)
                    ? captureState.baselineAssistantIndex
                    : null;
                const bestAssistantIndex = Number.isFinite(
                    captureState.lastExtractionMeta?.bestAssistantIndex
                )
                    ? captureState.lastExtractionMeta.bestAssistantIndex
                    : null;
                const baselineNormalized = normalizeCaptureCandidateText(
                    captureState.baselineText || ''
                );
                const textNormalized = normalizeCaptureCandidateText(text);
                const textChangedFromBaseline = Boolean(
                    textNormalized && (!baselineNormalized || textNormalized !== baselineNormalized)
                );

                // Prevent capturing a pre-turn assistant message (common in Pro mode due to side panels/rerenders).
                if (baselineCount !== null) {
                    const missingNewAssistantTurn =
                        bestAssistantIndex === null || bestAssistantIndex < baselineCount;
                    if (missingNewAssistantTurn) {
                        const allowSameAssistantUpdate =
                            textChangedFromBaseline &&
                            baselineAssistantIndex !== null &&
                            bestAssistantIndex !== null &&
                            bestAssistantIndex === baselineAssistantIndex &&
                            (captureState.sawGenerating || now - captureState.startedAt >= 8000);
                        if (!allowSameAssistantUpdate) return;
                        captureDebug('ChatGPT accepted same-assistant update', {
                            baselineCount,
                            baselineAssistantIndex,
                            bestAssistantIndex,
                            sawGenerating: captureState.sawGenerating,
                            elapsedMs: now - captureState.startedAt,
                            textLen: text.length,
                        });
                    }
                }
                if (baselineNormalized && textNormalized && textNormalized === baselineNormalized)
                    return;
            } else if (isGrok) {
                const baselineNormalized = normalizeCaptureCandidateText(
                    captureState.baselineText || ''
                );
                const textNormalized = normalizeCaptureCandidateText(text);
                const sameAsBaseline = Boolean(
                    baselineNormalized && textNormalized && textNormalized === baselineNormalized
                );
                const shapeSuggestsNewTurn = Boolean(
                    (baselineGrokBestBottom !== null &&
                        currentGrokBestBottom !== null &&
                        currentGrokBestBottom > baselineGrokBestBottom + 6) ||
                    (baselineGrokCandidateCount !== null &&
                        currentGrokCandidateCount !== null &&
                        currentGrokCandidateCount > baselineGrokCandidateCount)
                );
                if (sameAsBaseline && !shapeSuggestsNewTurn) {
                    if (!grokCompletedByControls && !grokLooksComplete) return;
                    const latestExtraction = extractLatestResponse({
                        withMeta: true,
                        withHtml: true,
                        grokPreferLatestBottom: true,
                    });
                    const latestText = latestExtraction.text || '';
                    const latestNormalized = normalizeCaptureCandidateText(latestText);
                    const latestSameAsBaseline = Boolean(
                        baselineNormalized &&
                        latestNormalized &&
                        latestNormalized === baselineNormalized
                    );
                    if (!latestText || latestSameAsBaseline || isGrokControlOnlyText(latestText)) {
                        if (!tryGrokFallbackExtraction('same_as_baseline_after_latest')) {
                            return;
                        }
                    } else {
                        extraction = latestExtraction;
                        text = latestText;
                        captureState.lastExtractionMeta = latestExtraction.meta || null;
                        meta = captureState.lastExtractionMeta || {};
                        currentGrokBestBottom = Number.isFinite(meta.bestBottom)
                            ? meta.bestBottom
                            : null;
                        currentGrokCandidateCount = Number.isFinite(meta.candidateCount)
                            ? meta.candidateCount
                            : null;
                        currentGrokShapeSignature =
                            typeof meta.bestShapeSignature === 'string'
                                ? meta.bestShapeSignature
                                : '';
                        captureDebug(
                            'Grok switched to latest-bottom candidate after control completion',
                            {
                                baselineBottom: baselineGrokBestBottom,
                                selectedBottom: currentGrokBestBottom,
                                selectedShape: currentGrokShapeSignature,
                            }
                        );
                    }
                }
                if (sameAsBaseline && shapeSuggestsNewTurn) {
                    captureDebug('Grok new text inferred by shape', {
                        baselineBottom: baselineGrokBestBottom,
                        currentBottom: currentGrokBestBottom,
                        baselineCandidateCount: baselineGrokCandidateCount,
                        currentCandidateCount: currentGrokCandidateCount,
                    });
                }
            } else if (isClaude) {
                const baselineNormalized = normalizeCaptureCandidateText(
                    captureState.baselineText || ''
                );
                const textNormalized = normalizeCaptureCandidateText(text);
                const sameAsBaseline = Boolean(
                    baselineNormalized && textNormalized && textNormalized === baselineNormalized
                );
                if (sameAsBaseline) {
                    const baselineOrder = Number.isFinite(captureState.baselineBestOrder)
                        ? captureState.baselineBestOrder
                        : null;
                    const baselineSignature =
                        typeof captureState.baselineBestSignature === 'string' &&
                        captureState.baselineBestSignature.trim()
                            ? captureState.baselineBestSignature.trim()
                            : '';
                    const elapsedMs = now - captureState.startedAt;
                    const shouldRetryLatest =
                        (Number.isFinite(baselineOrder) || baselineSignature) && elapsedMs >= 6000;
                    if (!shouldRetryLatest) return;
                    const latestExtraction = extractLatestResponse({
                        withMeta: true,
                        withHtml: true,
                        preferAfterOrder: baselineOrder,
                        preferAfterSignature: baselineSignature,
                    });
                    const latestText = latestExtraction.text || '';
                    const latestNormalized = normalizeCaptureCandidateText(latestText);
                    const latestSameAsBaseline = Boolean(
                        baselineNormalized &&
                        latestNormalized &&
                        latestNormalized === baselineNormalized
                    );
                    if (!latestText || latestSameAsBaseline) {
                        captureDebug('Claude no-progress fallback still matched baseline', {
                            baselineOrder,
                            baselineSignature,
                            elapsedMs,
                            latestLen: latestText.length,
                            latestMeta: latestExtraction.meta || null,
                        });
                        return;
                    }
                    extraction = latestExtraction;
                    text = latestText;
                    captureState.lastExtractionMeta = latestExtraction.meta || null;
                    meta = captureState.lastExtractionMeta || {};
                    captureDebug('Claude switched to progressed candidate after baseline stall', {
                        baselineOrder,
                        baselineSignature,
                        elapsedMs,
                        latestMeta: latestExtraction.meta || null,
                    });
                }
            } else {
                if (text === captureState.baselineText) return;
            }
            captureState.hasNewText = true;
            captureState.lastText = text;
            captureState.lastTextChangeAt = now;
        }

        if (!text) {
            if (
                !(grokCompletedByControls || grokLooksComplete) ||
                !tryGrokFallbackExtraction('post_has_new_empty')
            ) {
                return;
            }
        }

        if (isGrok && captureState.hasNewText) {
            const baselineNormalized = normalizeCaptureCandidateText(captureState.baselineText || '');
            const textNormalized = normalizeCaptureCandidateText(text);
            const lastIncrementalText = String(captureState.lastText || '').trim();
            const lastIncrementalNormalized = normalizeCaptureCandidateText(lastIncrementalText);
            const currentLooksRegressed = Boolean(
                lastIncrementalNormalized &&
                    (!baselineNormalized || lastIncrementalNormalized !== baselineNormalized) &&
                    (!textNormalized ||
                        isGrokControlOnlyText(text) ||
                        (baselineNormalized && textNormalized === baselineNormalized))
            );
            if (currentLooksRegressed && (grokCompletedByControls || grokLooksComplete)) {
                const recovered = tryGrokFallbackExtraction('regressed_after_new_text');
                if (!recovered) {
                    text = lastIncrementalText;
                    extraction = {
                        ...extraction,
                        text,
                        meta: {
                            ...(extraction.meta || {}),
                            source: 'reused_last_incremental_candidate',
                            reusedLastIncrementalCandidate: true,
                        },
                    };
                    captureState.lastExtractionMeta = extraction.meta || null;
                    meta = captureState.lastExtractionMeta || {};
                }
            }
        }

        const textChanged = text !== captureState.lastText;
        const grokShapeChanged =
            isGrok &&
            Boolean(
                (Number.isFinite(captureState.grokLastBestBottom) &&
                    currentGrokBestBottom !== null &&
                    Math.abs(currentGrokBestBottom - captureState.grokLastBestBottom) >= 4) ||
                (captureState.grokLastShapeSignature &&
                    currentGrokShapeSignature &&
                    currentGrokShapeSignature !== captureState.grokLastShapeSignature)
            );

        if (textChanged || grokShapeChanged) {
            captureState.lastText = text;
            captureState.lastTextChangeAt = now;
            if (isGrok && grokShapeChanged) {
                captureDebug('Grok shape progressed', {
                    previousBottom: captureState.grokLastBestBottom,
                    currentBottom: currentGrokBestBottom,
                    previousShape: captureState.grokLastShapeSignature,
                    currentShape: currentGrokShapeSignature,
                });
            }
        }
        if (isGrok) {
            if (currentGrokBestBottom !== null)
                captureState.grokLastBestBottom = currentGrokBestBottom;
            if (currentGrokShapeSignature)
                captureState.grokLastShapeSignature = currentGrokShapeSignature;
        }

        const generatingRaw = isGenerating();
        const generating = isGrok && grokLooksComplete ? false : generatingRaw;
        if (generating) captureState.sawGenerating = true;
        const stableForMs = now - captureState.lastTextChangeAt;
        const totalForMs = now - captureState.startedAt;
        const metaWordCount = Number.isFinite(captureState.lastExtractionMeta?.finalWordCount)
            ? captureState.lastExtractionMeta.finalWordCount
            : isChatGPT && Number.isFinite(captureState.lastExtractionMeta?.bestWordCount)
              ? captureState.lastExtractionMeta.bestWordCount
              : null;
        const wordCount =
            metaWordCount !== null
                ? metaWordCount
                : String(text || '')
                      .trim()
                      .split(/\s+/)
                      .filter(Boolean).length;

        const looksUrlishOnly = isChatGPT
            ? wordCount > 0 &&
              wordCount <= 10 &&
              !/[.!?](?:\s|$)/.test(text) &&
              /(?:\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b)/i.test(text)
            : false;

        const configuredForceCaptureMs = Number.isFinite(
            providerCaptureProfile?.forceCaptureStableMs
        )
            ? providerCaptureProfile.forceCaptureStableMs
            : null;
        const baseForceCaptureMs =
            configuredForceCaptureMs !== null
                ? configuredForceCaptureMs
                : isChatGPT
                  ? 45000
                  : isGrok
                    ? 20000
                    : 15000;
        const isLikelyReferenceOnly = isChatGPT
            ? Boolean(
                  captureState.lastExtractionMeta?.bestIsReferenceList ||
                  looksLikeChatGPTSourcesOnly(text) ||
                  looksUrlishOnly
              )
            : false;
        const forceCaptureMs = isLikelyReferenceOnly
            ? Math.max(baseForceCaptureMs, 60000)
            : baseForceCaptureMs;
        const minTextLen = 5;
        let stableCaptureMs = isLikelyReferenceOnly
            ? isChatGPT
                ? 9000
                : 3000
            : isChatGPT
              ? 3000
              : 1200;
        const maxWaitMs = isChatGPT ? 180000 : isGrok ? 150000 : 120000;

        if (isChatGPT && !isLikelyReferenceOnly && wordCount > 0 && wordCount < 12) {
            stableCaptureMs = Math.max(stableCaptureMs, 4500);
        }

        if (isGrok) {
            stableCaptureMs = Math.max(stableCaptureMs, 2400);
            if (!captureState.sawGenerating) {
                stableCaptureMs = Math.max(stableCaptureMs, 3500);
            }
            if (wordCount > 0 && wordCount < 10) {
                stableCaptureMs = Math.max(stableCaptureMs, 4200);
            }
        }

        const nonEmptyLineCount = String(text || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean).length;

        // If we never observed ChatGPT's "generating" UI, be more conservative to avoid
        // prematurely capturing small fragments during UI pauses.
        if (isChatGPT && !captureState.sawGenerating) {
            stableCaptureMs = Math.max(stableCaptureMs, 6000);
        }

        if (isChatGPT && !isLikelyReferenceOnly && !captureState.sawGenerating) {
            const looksLikeEarlyFragment =
                wordCount > 0 &&
                wordCount < 8 &&
                nonEmptyLineCount <= 1 &&
                text.length < 40 &&
                !/[.!?](?:\s|$)/.test(text);

            if (looksLikeEarlyFragment) {
                stableCaptureMs = Math.max(stableCaptureMs, 12000);
            }
        }

        const tabHidden = document.visibilityState !== 'visible';
        const visibilityMultiplier = tabHidden ? 2 : 1;
        if (tabHidden) {
            const hiddenStableMin = isChatGPT ? 6000 : isGrok ? 4500 : 3000;
            stableCaptureMs = Math.max(stableCaptureMs, hiddenStableMin);
        }
        const finalForceCaptureMs = forceCaptureMs * visibilityMultiplier;
        const finalMaxWaitMs = maxWaitMs * visibilityMultiplier;
        const minStableForTimeoutMs = tabHidden
            ? isChatGPT
                ? 8000
                : 5000
            : isChatGPT
              ? 6000
              : isGrok
                ? 5000
                : 4000;

        if (generating) {
            // ChatGPT can sit on a stable partial answer for tens of seconds while the turn is
            // still running, so text stability alone is not a safe completion signal there.
            const allowForceCaptureWhileGenerating = !isChatGPT;
            if (
                allowForceCaptureWhileGenerating &&
                stableForMs >= finalForceCaptureMs &&
                text.length >= minTextLen
            ) {
                if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;
                captureDebug('Force capture', {
                    llm: currentLLM,
                    sawGenerating: captureState.sawGenerating,
                    stableForMs,
                    forceCaptureMs: finalForceCaptureMs,
                    isLikelyReferenceOnly,
                    textLen: text.length,
                    meta: captureState.lastExtractionMeta,
                });
                emitCaptureFromResolvedExtraction('force_capture', extraction);
            }
            return;
        }

        const grokFinalizedByControlTransition = grokCompletedByControls || grokLooksComplete;
        if (grokFinalizedByControlTransition && text.length >= minTextLen && stableForMs >= 800) {
            if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;
            captureDebug('Stable capture (grok stop->voice/idle)', {
                llm: currentLLM,
                stableForMs,
                sawStop: captureState.grokSawStopControl,
                sawVoiceAfterStop: captureState.grokSawVoiceAfterStop,
                control: grokControl,
                meta: captureState.lastExtractionMeta,
            });
            emitCaptureFromResolvedExtraction('grok_stop_voice_idle', extraction);
            return;
        }

        if (text.length < minTextLen) return;
        const canStableCapture = stableForMs >= stableCaptureMs;
        const canTimeoutCapture =
            totalForMs >= finalMaxWaitMs && stableForMs >= minStableForTimeoutMs;
        if (!canStableCapture && !canTimeoutCapture) return;
        if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;

        const reason =
            canTimeoutCapture && !canStableCapture
                ? 'Timeout capture'
                : isLikelyReferenceOnly && stableCaptureMs > 3000
                  ? 'Stable capture (delayed; reference-like)'
                  : 'Stable capture';
        captureDebug(reason, {
            llm: currentLLM,
            sawGenerating: captureState.sawGenerating,
            stableForMs,
            stableCaptureMs,
            totalForMs,
            maxWaitMs: finalMaxWaitMs,
            minStableForTimeoutMs,
            isLikelyReferenceOnly,
            generating,
            generatingRaw: isGrok ? generatingRaw : undefined,
            grokLooksComplete: isGrok ? grokLooksComplete : undefined,
            textLen: text.length,
            meta: captureState.lastExtractionMeta,
        });
        emitCaptureFromResolvedExtraction(
            canTimeoutCapture && !canStableCapture ? 'timeout_capture' : 'stable_capture',
            extraction
        );
    }

    function startCaptureObservers() {
        const observer = new MutationObserver(() => {
            scheduleEvaluateCapture(150);
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        const interval = setInterval(() => scheduleEvaluateCapture(0), 2500);

        window.addEventListener('beforeunload', () => {
            observer.disconnect();
            clearInterval(interval);
            if (scheduledEvaluateHandle) {
                clearTimeout(scheduledEvaluateHandle);
                scheduledEvaluateHandle = null;
            }
        });
    }

    if (CAPTURE_TEST_MODE) {
        globalThis.__MLC_CAPTURE_TEST_HOOKS__ = {
            extractLatestResponse,
            armCapture,
            evaluateCapture,
            captureState,
            emitCaptureFromResolvedExtraction,
            probeProviderReadiness,
        };
        return;
    }

    startCaptureObservers();

    setInterval(sendModelInfoIfChanged, 8000);
    setTimeout(sendModelInfoIfChanged, 2500);
})();
