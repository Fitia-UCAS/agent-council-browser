(function() {
    const host = location.hostname;
    const isChatGPT = host.includes('openai.com') || host.includes('chatgpt.com');
    const isGemini = host.includes('gemini.google.com');
    const isClaude = host.includes('claude.ai');
    const isGrok = host.includes('grok.com');
    if (!isChatGPT && !isGemini && !isClaude && !isGrok) return;

    const currentLLM = isChatGPT ? 'chatgpt' : (isGemini ? 'gemini' : (isClaude ? 'claude' : 'grok'));
    const CONTENT_SCRIPT_BUILD = 'grok-capture-r5-2026-02-08';

	    console.log(`[MLC ContentScript] Initializing for ${currentLLM} (build=${CONTENT_SCRIPT_BUILD}).`);

	    const CaptureUtils = globalThis.MLCCaptureUtils || null;

	    // Cleanup for legacy builds that injected cross-provider forwarding toggles.
	    document.querySelectorAll('#mlc-forward-toggle').forEach((node) => node.remove());
	    if (!document.getElementById('mlc-forward-toggle-style')) {
	        const style = document.createElement('style');
	        style.id = 'mlc-forward-toggle-style';
	        style.textContent = '#mlc-forward-toggle{display:none !important; visibility:hidden !important; pointer-events:none !important;}';
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
	            promptPreview: '',
		        sessionId: null,
		        turnIndex: null,
		        agentId: null,
		        startedAt: 0,
		        lastText: '',
		        baselineText: '',
		        baselineAssistantCount: null,
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
            grokBaselineTranscriptTail: ''
	    };

    // Global message listener for connection testing and capture arming
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'PING') {
            console.log(`[MLC ContentScript - ${currentLLM}] Received PING, responding with PONG`);
            sendResponse({ type: 'PONG', llm: currentLLM, status: 'ready' });
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
                timestamp: message.timestamp || Date.now()
            });
            sendResponse({ received: true });
            return true;
        }
        return false; // Don't handle other messages here
    });

    function findInput(options = {}) {
        const selectors = isChatGPT ? [
            '#prompt-textarea',
            'textarea[data-testid="prompt-textarea"]',
            'textarea[placeholder*="Message"]',
            'textarea',
            '[contenteditable="true"]'
        ] : (isGemini ? [ 
            'div.ql-editor[role="textbox"]', 
            '.ql-editor.textarea',
            'div[contenteditable="true"][aria-label*="prompt"]', 
            'textarea[placeholder*="Enter a prompt"]',
            'textarea[placeholder*="Ask"]',
            'textarea',
            '[contenteditable="true"]'
        ] : (isClaude ? [
            'textarea[placeholder*="Message" i]',
            'textarea[aria-label*="Message" i]',
            'textarea[placeholder*="Send" i]',
            'textarea',
            '.ProseMirror[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]',
            '[contenteditable="true"]',
            '[role="textbox"]'
        ] : [
            'textarea[aria-label*="message" i]',
            'textarea[placeholder*="message" i]',
            'textarea[placeholder*="ask" i]',
            'textarea[placeholder*="chat" i]',
            'textarea',
            'div[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]',
            '[role="textbox"]'
        ]));
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
	            captureState.promptPreview = typeof message.promptPreview === 'string' ? message.promptPreview : '';
		        captureState.sessionId = message.sessionId || null;
		        captureState.turnIndex = message.turnIndex || null;
		        captureState.agentId = typeof message.agentId === 'string' && message.agentId.trim() ? message.agentId.trim() : null;
		        captureState.startedAt = message.timestamp || Date.now();
		        captureState.lastText = '';
		        captureState.baselineAssistantCount = null;
		        const baselineExtraction = extractLatestResponse({ withMeta: true });
		        captureState.baselineText = baselineExtraction.text || '';
	        if (isChatGPT) {
	            const baselineIndex = Number.isFinite(baselineExtraction.meta?.bestAssistantIndex)
	                ? baselineExtraction.meta.bestAssistantIndex
	                : null;
	            captureState.baselineAssistantCount = baselineIndex !== null
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
            captureState.grokBaselineCandidateCount = Number.isFinite(baselineExtraction.meta?.candidateCount)
                ? baselineExtraction.meta.candidateCount
                : null;
            captureState.grokLastBestBottom = captureState.grokBaselineBestBottom;
            captureState.grokLastShapeSignature = typeof baselineExtraction.meta?.bestShapeSignature === 'string'
                ? baselineExtraction.meta.bestShapeSignature
                : '';
            captureState.grokSawStopControl = false;
            captureState.grokSawVoiceAfterStop = false;
            captureState.grokBaselineTranscriptTail = isGrok ? extractGrokTranscriptTailText() : '';
	        console.log(`[MLC Capture - ${currentLLM}] Armed for prompt ${message.promptId}`);
	        captureDebug('Armed', {
	            llm: currentLLM,
	            promptId: message.promptId,
	            sessionId: captureState.sessionId,
	            turnIndex: captureState.turnIndex,
	            baselineAssistantCount: captureState.baselineAssistantCount,
	            baselinePreview: String(captureState.baselineText || '').slice(0, 160)
	        });
	        setTimeout(() => scheduleEvaluateCapture(), 1200);
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
        if (!rect) return false;
        if (!(rect.width > 0 && rect.height > 0)) return false;

        return rect.bottom > 0
            && rect.right > 0
            && rect.top < window.innerHeight
            && rect.left < window.innerWidth;
    }

    function isChatGPTGenerating() {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? (inputEl.closest('form') || inputEl.closest('[role="form"]') || inputEl.parentElement)
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
            'button[title*="Annuler" i]'
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
        const stopButton = document.querySelector('button[aria-label*=\"Stop\" i], button[aria-label*=\"Cancel\" i]');
        if (stopButton && isElementVisible(stopButton)) return true;
        const spinner = document.querySelector('mat-progress-spinner, mat-spinner, [role=\"progressbar\"], .loading, .spinner');
        if (spinner && isElementVisible(spinner)) return true;
        const sendButton = document.querySelector('button[aria-label*=\"Send\" i], button[data-testid=\"send-button\"]');
        if (sendButton && isElementVisible(sendButton) && !sendButton.disabled) return false;
        return false;
    }

    function isClaudeGenerating() {
        const stopButton = document.querySelector(
            'button[aria-label*=\"Stop\" i], button[aria-label*=\"Cancel\" i], button[aria-label*=\"Annuler\" i], button[aria-label*=\"Arrêter\" i], button[title*=\"Stop\" i], button[title*=\"Cancel\" i], button[title*=\"Annuler\" i], button[title*=\"Arrêter\" i], button[data-testid*=\"stop\" i]'
        );
        if (stopButton && isElementVisible(stopButton)) return true;
        const spinner = document.querySelector('[role=\"progressbar\"], .loading, .spinner, .animate-spin');
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
            element.getAttribute?.('data-testid') || ''
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
            /\barreter la reponse du modele\b/i
        ];
        if (stopPatterns.some((re) => re.test(label))) return 'stop';

        const voicePatterns = [
            /\bpasser en mode vocal\b/i,
            /\bmode vocal\b/i,
            /\bvoice mode\b/i
        ];
        if (voicePatterns.some((re) => re.test(label))) return 'voice';

        const sendPatterns = [
            /\bsend\b/i,
            /\bsubmit\b/i,
            /\bsoumettre\b/i,
            /\benvoyer\b/i
        ];
        const typeAttr = normalizeGrokControlLabel(element.getAttribute?.('type') || '');
        if (sendPatterns.some((re) => re.test(label)) || typeAttr === 'submit') return 'send';
        return 'unknown';
    }

    function findGrokControlButton(role, { allowDisabled = true, includeDocument = true } = {}) {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? (inputEl.closest('form') || inputEl.closest('footer') || inputEl.closest('[role="form"]') || inputEl.parentElement)
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
                if (!allowDisabled && (button.disabled || String(button.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true')) continue;
                const currentRole = classifyGrokControlElement(button);
                if (currentRole === role) return button;
            }
        }
        return null;
    }

    function getGrokControlState() {
        const stopButton = findGrokControlButton('stop', { allowDisabled: true, includeDocument: true });
        const voiceButton = findGrokControlButton('voice', { allowDisabled: true, includeDocument: true });
        const sendButton = findGrokControlButton('send', { allowDisabled: true, includeDocument: true });
        return {
            stopVisible: Boolean(stopButton && isElementVisible(stopButton)),
            voiceVisible: Boolean(voiceButton && isElementVisible(voiceButton)),
            sendVisible: Boolean(sendButton && isElementVisible(sendButton)),
            sendDisabled: Boolean(sendButton && (sendButton.disabled || String(sendButton.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true'))
        };
    }

    function isGrokControlOnlyText(text) {
        if (!text || !String(text).trim()) return false;
        if (CaptureUtils && typeof CaptureUtils.looksLikeUiControlText === 'function') {
            return CaptureUtils.looksLikeUiControlText(text, { provider: 'grok' });
        }
        const normalized = normalizeGrokControlLabel(text);
        if (!normalized) return false;
        const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
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
            /\betes[-\s]?vous satisfait\b/i
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
        const spinner = document.querySelector('[role=\"progressbar\"], .loading, .spinner, .animate-spin');
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

        function extractCleanHtmlFromNode(node) {
            if (!node) return '';
            const clone = node.cloneNode(true);

            // Remove obvious non-content UI and media elements that can bloat messages.
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
                'picture'
            ];
            clone.querySelectorAll(removeSelectors.join(',')).forEach(el => el.remove());

            const html = clone.innerHTML || '';
            // Keep payloads bounded; if too large, fall back to plain text rendering in the UI.
            const MAX_HTML_CHARS = 120000;
            if (html.length > MAX_HTML_CHARS) return '';
            return html;
        }

	    function looksLikeChatGPTSourcesOnly(text) {
	        if (CaptureUtils && typeof CaptureUtils.looksLikeReferenceList === 'function') {
	            return CaptureUtils.looksLikeReferenceList(text, { provider: 'chatgpt' });
	        }

	        const raw = (text || '').trim();
	        if (!raw) return false;

	        const lines = raw
	            .split('\n')
	            .map(line => line.trim())
	            .filter(Boolean);

	        if (lines.length < 4) return false;

	        // Legacy fallback: list of titles plus "+N" lines.
	        const plusLines = lines.filter(line => /^\+\d+$/.test(line)).length;
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
	                getElementAttributeValue(current, 'data-role')
	            ].join(' ');
	            if (keywords.some(keyword => combined.includes(keyword))) {
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
	            '[data-testid="chat-app"]'
	        ];
	        const preferred = [];
	        for (const selector of preferredSelectors) {
	            try {
	                const el = document.querySelector(selector);
	                if (el && !preferred.includes(el)) preferred.push(el);
	            } catch (error) {
	            }
	        }
	        if (preferred.length) return preferred;

	        const fallbackSelectors = ['main', '[role="main"]'];
	        const roots = [];
	        for (const selector of fallbackSelectors) {
	            try {
	                const el = document.querySelector(selector);
	                if (el && !roots.includes(el)) roots.push(el);
	            } catch (error) {
	            }
	        }
	        return roots.length ? roots : [document.body];
	    }

	    function isChatGPTConversationNode(node, roots) {
	        if (!node) return false;
	        if (hasChatGPTReflectionAncestor(node)) return false;
	        if (!roots || !roots.length) return true;
	        return roots.some(root => root.contains(node));
	    }

	    function getChatGPTConversationAssistantNodes() {
	        const rawAssistantNodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
	        if (!rawAssistantNodes.length) return [];

	        const turnScoped = rawAssistantNodes.filter(node => node.closest?.('[data-testid="conversation-turn"]'));
	        const baseNodes = turnScoped.length ? turnScoped : rawAssistantNodes;

	        const roots = findChatGPTConversationRoots();
	        const scoped = baseNodes.filter(node => isChatGPTConversationNode(node, roots));
	        if (scoped.length) return scoped;

	        const noReflection = baseNodes.filter(node => !hasChatGPTReflectionAncestor(node));
	        return noReflection.length ? noReflection : baseNodes;
	    }

        function normalizeCaptureCandidateText(text) {
            const normalized = CaptureUtils?.normalizeWhitespace
                ? CaptureUtils.normalizeWhitespace(text)
                : String(text).replace(/\s+/g, ' ').trim();
            return normalized;
        }

        function getTopLevelNodes(nodes) {
            const arr = Array.from(nodes || []).filter(Boolean);
            if (arr.length <= 1) return arr;
            return arr.filter(node => !arr.some(other => other !== node && other.contains(node)));
        }

        function buildChatGPTAssistantCandidate(messageRoot, assistantIndex, options = {}) {
            if (!messageRoot) {
                return {
                    text: '',
                    html: '',
                    assistantIndex,
                    origin: null,
                    partCount: 0,
                    nodeCount: 0
                };
            }

            const contentNodes = (() => {
                const primary = getTopLevelNodes(messageRoot.querySelectorAll('[data-testid="message-content"]'));
                if (primary.length) return primary;

                const secondary = getTopLevelNodes(messageRoot.querySelectorAll('.markdown, .prose'));
                if (secondary.length) return secondary;

                return [messageRoot];
            })();

            const seenText = new Set();
            const parts = [];
            const htmlParts = [];
            for (const node of contentNodes) {
                const text = getTrimmedText(node);
                if (!text) continue;
                const normalized = normalizeCaptureCandidateText(text);
                if (!normalized) continue;
                if (seenText.has(normalized)) continue;
                seenText.add(normalized);
                parts.push(text);
                if (options.withHtml) {
                    const html = extractCleanHtmlFromNode(node);
                    if (html) htmlParts.push(html);
                }
            }

            const combinedText = parts.join('\n\n').trim();
            let combinedHtml = '';
            if (options.withHtml) {
                combinedHtml = htmlParts.join('\n').trim();
                const MAX_HTML_CHARS = 120000;
                if (combinedHtml.length > MAX_HTML_CHARS) combinedHtml = '';
            }

            const origin = Number.isFinite(assistantIndex)
                ? `assistant[${assistantIndex}] aggregated(${parts.length}/${contentNodes.length})`
                : 'assistant aggregated';

            return {
                text: combinedText,
                html: combinedHtml,
                assistantIndex,
                origin,
                partCount: parts.length,
                nodeCount: contentNodes.length
            };
        }

	    function extractChatGPTResponse(options = {}) {
	        const conversationRoots = findChatGPTConversationRoots();
	        const assistantNodes = getChatGPTConversationAssistantNodes();
	        const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
	            ? captureState.baselineAssistantCount
	            : null;

	        const preferredStart = baselineCount !== null
	            ? Math.min(baselineCount, Math.max(0, assistantNodes.length - 1))
	            : 0;

            const roots = [];
            const startIndex = Math.max(0, Math.max(preferredStart, assistantNodes.length - 4));
            for (let i = startIndex; i < assistantNodes.length; i++) {
                const node = assistantNodes[i];
                if (!node) continue;
                if (node.querySelector('[data-testid="message-content"], .markdown, .prose') || getTrimmedText(node)) {
                    roots.push({ node, assistantIndex: i });
                }
            }
            if (roots.length === 0) {
                for (let i = assistantNodes.length - 1; i >= 0; i--) {
                    const node = assistantNodes[i];
                    if (!node) continue;
                    if (node.querySelector('[data-testid="message-content"], .markdown, .prose') || getTrimmedText(node)) {
                        roots.unshift({ node, assistantIndex: i });
                    }
                    if (roots.length >= 4) break;
                }
            }

            const seenText = new Set();
	        const candidates = [];
            for (const rootEntry of roots) {
                const candidate = buildChatGPTAssistantCandidate(rootEntry.node, rootEntry.assistantIndex, options);
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
                const searchRoot = conversationRoots && conversationRoots.length ? conversationRoots[0] : document;
                const nodes = Array.from(searchRoot.querySelectorAll(selector)).filter(node => !hasChatGPTReflectionAncestor(node));
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
                        nodeCount: 1
                    });
                }
            }

	        if (candidates.length === 0) {
	            return options.withMeta ? { text: '', meta: null } : { text: '' };
	        }

	        const texts = candidates.map(candidate => candidate.text);
	        const ranking = CaptureUtils?.chooseBestTextCandidate
	            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'chatgpt' })
	            : { bestIndex: 0, best: { index: 0, score: texts[0].length, isReferenceList: looksLikeChatGPTSourcesOnly(texts[0]) }, ranked: [] };

	        const rankingBestIndex = Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0
	            ? ranking.bestIndex
	            : 0;
            let chosenIndex = rankingBestIndex;

            const analysisByIndex = new Map();
            const referenceByIndex = new Map();
            if (Array.isArray(ranking.ranked)) {
                ranking.ranked.forEach(item => {
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
                const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                const urlMatches = raw.match(/\bhttps?:\/\/\S+|\bwww\.\S+/gi) || [];
                const domainMatches = raw.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi) || [];
                return {
                    raw,
                    lines,
                    lineCount: lines.length,
                    wordCount: raw ? raw.split(/\s+/).filter(Boolean).length : 0,
                    urlCount: urlMatches.length,
                    domainCount: domainMatches.length,
                    urlishLineCount: lines.filter(line => /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/i.test(line)).length,
                    sentenceEndPunctCount: (raw.match(/[.!?](?:\s|$)/g) || []).length,
                    codeFenceCount: (raw.match(/```/g) || []).length,
                    startsWithSourcesHeading: /^(sources?|references?|citations?)\b[:\s-]*/i.test(lines[0] || '')
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
                const urlishLineCount = Number.isFinite(analysis.urlishLineCount) ? analysis.urlishLineCount : 0;
                return lineCount ? (urlishLineCount / Math.max(1, lineCount)) : 0;
            };

            const isReferenceCandidate = (index) => {
                if (referenceByIndex.has(index)) return referenceByIndex.get(index);
                return looksLikeChatGPTSourcesOnly(texts[index]);
            };

            // Guardrail: avoid selecting sources-only blocks when a real answer exists.
            const bestIsReference = isReferenceCandidate(chosenIndex);
            if (bestIsReference && Array.isArray(ranking.ranked)) {
                const alt = ranking.ranked.find(item => {
                    if (item.index === chosenIndex) return false;
                    if (item.isReferenceList) return false;
                    const analysis = item.analysis || {};
                    const wordCount = analysis.wordCount || 0;
                    const sentenceEndPunctCount = analysis.sentenceEndPunctCount || 0;
                    const codeFenceCount = analysis.codeFenceCount || 0;
                    const lineCount = analysis.lineCount || 0;
                    return wordCount >= 18 || sentenceEndPunctCount >= 2 || codeFenceCount >= 1 || lineCount >= 4;
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
            const bestCandidate = candidates[bestIndex] || candidates[rankingBestIndex] || candidates[0] || null;
	        const bestText = bestCandidate?.text || '';
            const combined = (() => {
                if (!bestCandidate || !bestText) {
                    return { text: bestText, html: bestCandidate?.html || '', supplementalIndices: [] };
                }

                const combinedTexts = [bestText];
                const combinedHtmlParts = options.withHtml && bestCandidate?.html ? [bestCandidate.html] : [];
                const supplementalIndices = [];
                const normalizedSet = new Set([normalizeCaptureCandidateText(bestText)]);
                const bestAssistantIndex = Number.isFinite(bestCandidate.assistantIndex) ? bestCandidate.assistantIndex : null;
                const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
                    ? captureState.baselineAssistantCount
                    : null;

                const ordered = candidates.map((candidate, index) => ({
                    ...candidate,
                    index,
                    assistantIndex: Number.isFinite(candidate.assistantIndex) ? candidate.assistantIndex : null
                })).sort((a, b) => {
                    const aIdx = a.assistantIndex !== null ? a.assistantIndex : Number.POSITIVE_INFINITY;
                    const bIdx = b.assistantIndex !== null ? b.assistantIndex : Number.POSITIVE_INFINITY;
                    if (aIdx !== bIdx) return aIdx - bIdx;
                    return a.index - b.index;
                });

                for (const entry of ordered) {
                    if (entry.index === bestIndex) continue;
                    if (bestAssistantIndex !== null && entry.assistantIndex !== null && entry.assistantIndex < bestAssistantIndex) {
                        continue;
                    }
                    if (baselineCount !== null && entry.assistantIndex !== null && entry.assistantIndex < baselineCount) {
                        continue;
                    }

                    const normalized = normalizeCaptureCandidateText(entry.text || '');
                    if (!normalized || normalizedSet.has(normalized)) continue;

                    const analysis = getAnalysisForIndex(entry.index) || {};
                    const urlishRatio = getUrlishRatio(entry.index);
                    const isReference = isReferenceCandidate(entry.index);
                    const urlCount = Number.isFinite(analysis.urlCount) ? analysis.urlCount : 0;
                    const domainCount = Number.isFinite(analysis.domainCount) ? analysis.domainCount : 0;
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
            const finalHtml = options.withHtml ? (combined.html || bestCandidate?.html || '') : '';

	        const meta = {
	            provider: 'chatgpt',
	            assistantCount: assistantNodes.length,
	            baselineAssistantCount: captureState.baselineAssistantCount,
                rootsScanned: roots.map(root => root.assistantIndex),
	            candidateCount: texts.length,
	            bestIndex: bestIndex,
                rankingBestIndex: rankingBestIndex,
                rankingBestIsReferenceList: ranking.best?.isReferenceList ?? null,
                didOverrideReferenceBest: bestIndex !== rankingBestIndex,
                bestOrigin: bestCandidate?.origin || null,
                bestAssistantIndex: Number.isFinite(bestCandidate?.assistantIndex) ? bestCandidate.assistantIndex : null,
                bestWordCount: Number.isFinite(getAnalysisForIndex(bestIndex)?.wordCount) ? getAnalysisForIndex(bestIndex).wordCount : null,
	            bestScore: Array.isArray(ranking.ranked)
                    ? (ranking.ranked.find(r => r.index === bestIndex)?.score ?? null)
                    : (ranking.best?.score ?? null),
	            bestIsReferenceList: Array.isArray(ranking.ranked)
                    ? (ranking.ranked.find(r => r.index === bestIndex)?.isReferenceList ?? null)
                    : (ranking.best?.isReferenceList ?? null),
                supplementalIndices: combined.supplementalIndices || [],
                supplementalCount: combined.supplementalIndices ? combined.supplementalIndices.length : 0,
	            rankingTop: Array.isArray(ranking.ranked)
	                ? ranking.ranked.slice(0, 6).map(r => ({
	                    index: r.index,
	                    score: r.score,
	                    isReferenceList: r.isReferenceList,
	                    wordCount: r.analysis?.wordCount,
	                    lineCount: r.analysis?.lineCount,
                        urlishLineCount: r.analysis?.urlishLineCount,
                        sentenceEndPunctCount: r.analysis?.sentenceEndPunctCount,
                        codeFenceCount: r.analysis?.codeFenceCount,
                        startsWithSourcesHeading: r.analysis?.startsWithSourcesHeading,
                        origin: candidates[r.index]?.origin || null
	                }))
	                : []
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
                text: finalText
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
            '[data-author-is-user=\"true\"]'
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
            ? inputEl.closest('form, .input-area-container, .input-area, .input-row, .composer, .prompt-container')
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
            '[role=\"article\"]'
        ];

        const candidates = [];
        for (const root of roots) {
            for (const sel of selectors) {
                root.querySelectorAll(sel).forEach(node => candidates.push(node));
            }
            if (candidates.length) break;
        }

        const seen = new Set();
        const uniqueCandidates = candidates.filter(node => {
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

            const targetSelectors = '.markdown, .markdown-content, [data-testid=\"markdown-content\"], .response-content, .model-response, .model-response-text';
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
            const placeholder = '[Gemini returned an image output; no text was captured. Proceeding with debate.]';
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
            hash = ((hash << 5) - hash) + value.charCodeAt(i);
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
            /^user:?$/
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

        const satisfactionTailRe = /(?:~?\d+(?:[.,]\d+)?\s*(?:ms|s)\s*)?(?:are you satisfied with|satisfied with|etes[-\s]?vous satisfait(?:e)?(?: de)?|êtes[-\s]?vous satisfait(?:e)?(?: de)?)[^?\n]*\?\s*$/i;
        const latencyTailRe = /(^|[^0-9A-Za-z])~?\d+(?:[.,]\d+)?\s*(?:ms|s)\s*$/i;

        let previous = '';
        while (text && text !== previous) {
            previous = text;
            text = text.replace(satisfactionTailRe, '').trim();
            text = text.replace(latencyTailRe, '$1').trim();
        }
        return text;
    }

    function sanitizeGrokTranscriptCandidate(text, { allowShort = false } = {}) {
        const raw = String(text || '').trim();
        if (!raw) return '';

        const lines = raw
            .split(/\r?\n/)
            .map((line) => stripGrokUiFooterArtifacts(line))
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !isGrokControlOnlyText(line))
            .filter((line) => !isGrokPromptScaffoldLine(line));
        if (!lines.length) return '';

        const sanitized = stripGrokUiFooterArtifacts(lines.join('\n').trim());
        if (!sanitized) return '';
        if (isGrokControlOnlyText(sanitized)) return '';
        if (looksLikePromptEcho(sanitized)) return '';

        if (!allowShort) {
            const wordCount = sanitized.split(/\s+/).filter(Boolean).length;
            if (wordCount < 6 && sanitized.length < 30) return '';
        }
        return sanitized;
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
            '.message-user'
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
            '.from-user'
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
            ? (inputEl.closest('form') || inputEl.closest('footer') || inputEl.closest('[role="form"]') || inputEl.parentElement)
            : null;
        const roots = [document.querySelector('main'), document.querySelector('[role="main"]'), document.body].filter(Boolean);

        const rootSelectors = [
            '[data-testid="chat-message"]',
            '[data-testid*="chat-message" i]',
            '[data-testid*="assistant" i]',
            '[data-role*="assistant" i]',
            '[data-author*="assistant" i]',
            'article',
            '[role="article"]',
            '[class*="assistant" i]'
        ];

        const contentSelectors = [
            '[data-testid="chat-message-content"]',
            '[data-testid="message-content"]',
            '.markdown',
            '.prose',
            '[class*="prose" i]',
            '[class*="markdown" i]'
        ];

        const candidates = [];
        const seenNodes = new Set();
        const seenText = new Set();
        let sawPromptEcho = false;

        const buildCandidateFromRoot = (node, selector) => {
            if (!node || seenNodes.has(node)) return;
            seenNodes.add(node);
            if (inputEl && (node === inputEl || node.contains(inputEl))) return;
            if (composerRoot && (composerRoot.contains(node) || node.contains(composerRoot))) return;
            if (isClaudeUserMessage(node)) return;

            const contentNodes = [];
            for (const sel of contentSelectors) {
                try {
                    node.querySelectorAll(sel).forEach(child => contentNodes.push(child));
                } catch (error) {
                    // ignore selector errors
                }
            }
            const topLevel = getTopLevelNodes(contentNodes);
            const nodes = topLevel.length ? topLevel : [node];

            const parts = [];
            const htmlParts = [];
            const localSeen = new Set();
            for (const child of nodes) {
                if (!child || isClaudeUserMessage(child)) continue;
                const text = (child.innerText || child.textContent || '').trim();
                if (!text) continue;
                const normalized = normalizeCaptureCandidateText(text);
                if (!normalized || localSeen.has(normalized)) continue;
                localSeen.add(normalized);
                parts.push(text);
                if (options.withHtml) {
                    const html = extractCleanHtmlFromNode(child);
                    if (html) htmlParts.push(html);
                }
            }

            const combinedText = parts.join('\n\n').trim();
            if (!combinedText) return;
            if (looksLikePromptEcho(combinedText)) {
                sawPromptEcho = true;
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
                nodeCount: nodes.length
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

        const texts = candidates.map(candidate => candidate.text);
        const ranking = CaptureUtils?.chooseBestTextCandidate
            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'claude' })
            : { bestIndex: 0, best: { index: 0, score: texts[0]?.length || 0, isReferenceList: false }, ranked: [] };

        const rankingBestIndex = Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0
            ? ranking.bestIndex
            : 0;
        let chosenIndex = rankingBestIndex;

        const analysisByIndex = new Map();
        const referenceByIndex = new Map();
        if (Array.isArray(ranking.ranked)) {
            ranking.ranked.forEach(item => {
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
            const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const urlMatches = raw.match(/\bhttps?:\/\/\S+|\bwww\.\S+/gi) || [];
            const domainMatches = raw.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi) || [];
            return {
                raw,
                lines,
                lineCount: lines.length,
                wordCount: raw ? raw.split(/\s+/).filter(Boolean).length : 0,
                urlCount: urlMatches.length,
                domainCount: domainMatches.length,
                urlishLineCount: lines.filter(line => /\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b/i.test(line)).length,
                sentenceEndPunctCount: (raw.match(/[.!?](?:\s|$)/g) || []).length,
                codeFenceCount: (raw.match(/```/g) || []).length,
                startsWithSourcesHeading: /^(sources?|references?|citations?)\b[:\s-]*/i.test(lines[0] || '')
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
            const urlishLineCount = Number.isFinite(analysis.urlishLineCount) ? analysis.urlishLineCount : 0;
            return lineCount ? (urlishLineCount / Math.max(1, lineCount)) : 0;
        };

        const isReferenceCandidate = (index) => {
            if (referenceByIndex.has(index)) return referenceByIndex.get(index);
            if (CaptureUtils && typeof CaptureUtils.looksLikeReferenceList === 'function') {
                return CaptureUtils.looksLikeReferenceList(texts[index], { provider: 'claude' });
            }
            return false;
        };

        const bestIsReference = isReferenceCandidate(chosenIndex);
        if (bestIsReference && Array.isArray(ranking.ranked)) {
            const alt = ranking.ranked.find(item => {
                if (item.index === chosenIndex) return false;
                if (item.isReferenceList) return false;
                const analysis = item.analysis || {};
                const wordCount = analysis.wordCount || 0;
                const sentenceEndPunctCount = analysis.sentenceEndPunctCount || 0;
                const codeFenceCount = analysis.codeFenceCount || 0;
                const lineCount = analysis.lineCount || 0;
                return wordCount >= 18 || sentenceEndPunctCount >= 2 || codeFenceCount >= 1 || lineCount >= 4;
            });
            if (alt && Number.isFinite(alt.index) && alt.index >= 0) {
                chosenIndex = alt.index;
            }
        }

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

        const bestIndex = chosenIndex;
        const bestCandidate = candidates[bestIndex] || candidates[rankingBestIndex] || candidates[0] || null;
        const bestText = bestCandidate?.text || '';

        const combined = (() => {
            if (!bestCandidate || !bestText) {
                return { text: bestText, html: bestCandidate?.html || '', supplementalIndices: [] };
            }

            const combinedTexts = [bestText];
            const combinedHtmlParts = options.withHtml && bestCandidate?.html ? [bestCandidate.html] : [];
            const supplementalIndices = [];
            const normalizedSet = new Set([normalizeCaptureCandidateText(bestText)]);
            const bestBottom = Number.isFinite(bestCandidate?.bottom) ? bestCandidate.bottom : -Infinity;

            const ordered = candidates.map((candidate, index) => ({
                ...candidate,
                index
            })).sort((a, b) => {
                const aBottom = Number.isFinite(a.bottom) ? a.bottom : -Infinity;
                const bBottom = Number.isFinite(b.bottom) ? b.bottom : -Infinity;
                if (aBottom !== bBottom) return aBottom - bBottom;
                return a.index - b.index;
            });

            for (const entry of ordered) {
                if (entry.index === bestIndex) continue;
                const entryBottom = Number.isFinite(entry.bottom) ? entry.bottom : -Infinity;
                if (entryBottom < bestBottom) continue;

                const normalized = normalizeCaptureCandidateText(entry.text || '');
                if (!normalized || normalizedSet.has(normalized)) continue;

                const analysis = getAnalysisForIndex(entry.index) || {};
                const urlishRatio = getUrlishRatio(entry.index);
                const isReference = isReferenceCandidate(entry.index);
                const urlCount = Number.isFinite(analysis.urlCount) ? analysis.urlCount : 0;
                const domainCount = Number.isFinite(analysis.domainCount) ? analysis.domainCount : 0;
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
        const finalHtml = options.withHtml ? (combined.html || bestCandidate?.html || '') : '';

        const bestBottom = bestCandidate ? bestCandidate.bottom : -Infinity;
        const bestLen = bestCandidate ? bestCandidate.text.length : null;

        const meta = {
            provider: 'claude',
            candidateCount: candidates.length,
            sawPromptEcho,
            bestSelector: bestCandidate?.selector || null,
            bestBottom: Number.isFinite(bestBottom) ? Math.round(bestBottom) : null,
            bestLen: Number.isFinite(bestLen) ? bestLen : null,
            bestIsReferenceList: isReferenceCandidate(bestIndex),
            supplementalIndices: combined.supplementalIndices || [],
            supplementalCount: combined.supplementalIndices ? combined.supplementalIndices.length : 0
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
            ? (inputEl.closest('form') || inputEl.closest('footer') || inputEl.closest('[role="form"]') || inputEl.parentElement)
            : null;
        const roots = [document.querySelector('main'), document.querySelector('[role="main"]'), document.body].filter(Boolean);
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
            '[class*="message" i]'
        ];

        const contentSelectors = [
            '[data-testid="message-content"]',
            '[data-testid*="message" i]',
            '[data-testid*="chat-message" i]',
            '[data-testid*="conversation" i] [data-testid*="message" i]',
            '.markdown',
            '.prose',
            '[class*="markdown" i]',
            '[class*="prose" i]'
        ];

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
            empty: 0
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
            return rect.bottom >= (composerTop - 4);
        };

        const buildCandidateFromRoot = (node, selector) => {
            if (!node || seenNodes.has(node)) return;
            seenNodes.add(node);
            if (inputEl && (node === inputEl || inputEl.contains(node))) {
                rejectionCounts.composerOverlap += 1;
                captureDebug('Grok candidate rejected: composer_overlap', { selector, reason: 'input_overlap' });
                return;
            }
            if (composerRoot && composerRoot.contains(node)) {
                rejectionCounts.composerOverlap += 1;
                captureDebug('Grok candidate rejected: composer_overlap', { selector, reason: 'inside_composer' });
                return;
            }
            if (isGrokUserMessage(node)) {
                rejectionCounts.userMessage += 1;
                return;
            }
            const wrapperContainsComposer = Boolean(
                composerRoot
                && node !== composerRoot
                && node.contains(composerRoot)
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
            const nodes = topLevel.length
                ? topLevel
                : (wrapperContainsComposer ? [] : [node]);

            const parts = [];
            const htmlParts = [];
            const localSeen = new Set();

            for (const child of nodes) {
                if (!child || isGrokUserMessage(child)) continue;
                if (composerRoot && (composerRoot.contains(child) || child.contains(composerRoot))) {
                    rejectionCounts.composerOverlap += 1;
                    captureDebug('Grok candidate rejected: composer_overlap', { selector, reason: 'composer_overlap' });
                    continue;
                }
                if (overlapsComposerZone(child)) {
                    rejectionCounts.composerZoneOverlap += 1;
                    captureDebug('Grok candidate rejected: composer_zone_overlap', { selector, reason: 'composer_zone_overlap' });
                    continue;
                }
                const text = (child.innerText || child.textContent || '').trim();
                if (!text) continue;
                if (isGrokControlOnlyText(text)) {
                    rejectionCounts.controlOnly += 1;
                    captureDebug('Grok candidate rejected: control_only', { selector, preview: String(text).slice(0, 140) });
                    continue;
                }
                const sanitizedText = sanitizeGrokTranscriptCandidate(text, { allowShort: true });
                if (!sanitizedText) {
                    rejectionCounts.empty += 1;
                    captureDebug('Grok candidate rejected: sanitized_out', { selector, preview: String(text).slice(0, 140) });
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
                captureDebug('Grok candidate rejected: prompt_echo', { selector, preview: String(combinedText).slice(0, 140) });
                return;
            }
            if (isGrokControlOnlyText(combinedText)) {
                rejectionCounts.controlOnly += 1;
                captureDebug('Grok candidate rejected: control_only_combined', { selector, preview: String(combinedText).slice(0, 140) });
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
                shapeSignature
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
                ? { text: '', meta: { provider: 'grok', candidateCount: 0, sawPromptEcho, ...rejectionCounts } }
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
            .filter((entry, index) => index < 12 || (Number.isFinite(entry.bottom) && (topBottom - entry.bottom) <= recentWindowPx))
            .slice(0, 18);

        const rankingPool = recentCandidates.length ? recentCandidates : orderedByBottom.slice(0, 12);
        const texts = rankingPool.map((candidate) => candidate.text);
        const ranking = CaptureUtils?.chooseBestTextCandidate
            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'grok' })
            : { bestIndex: 0, best: { index: 0, isReferenceList: false, isUiControlText: false }, ranked: [] };

        const rankingBestIndex = Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0
            ? ranking.bestIndex
            : 0;
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
            const alternative = ranking.ranked.find((item) => item.index !== bestPoolIndex && !item.isUiControlText);
            if (alternative && Number.isFinite(alternative.index) && alternative.index >= 0) {
                bestPoolIndex = alternative.index;
            }
        }

        let bestCandidate = rankingPool[bestPoolIndex] || rankingPool[rankingBestIndex] || rankingPool[0] || null;
        if (bestCandidate && isGrokControlOnlyText(bestCandidate.text || '')) {
            const nonControlRecent = rankingPool.find((entry) => !isGrokControlOnlyText(entry.text || ''));
            if (nonControlRecent) bestCandidate = nonControlRecent;
        }
        if (!bestCandidate && orderedByBottom.length > 0) {
            bestCandidate = orderedByBottom.find((entry) => !isGrokControlOnlyText(entry.text || '')) || orderedByBottom[0];
        }
        if (options.grokPreferLatestBottom) {
            const latestNonControl = orderedByBottom.find((entry) => !isGrokControlOnlyText(entry.text || ''));
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
            bestIsReferenceList: resolvedPoolIndex >= 0 ? isReferenceRank(resolvedPoolIndex) : false,
            bestIsControlOnly: resolvedPoolIndex >= 0 ? isControlRank(resolvedPoolIndex) : isGrokControlOnlyText(bestCandidate?.text || ''),
            bestShapeSignature,
            rejectionCounts
        };
        captureDebug('extractGrokResponse', meta);

        const result = { text: bestCandidate?.text || '' };
        if (options.withHtml) {
            result.html = bestCandidate?.html || (bestCandidate?.node ? extractCleanHtmlFromNode(bestCandidate.node) : '');
        }
        return options.withMeta ? { ...result, meta } : result;
    }

    function extractGrokTranscriptTailText(options = {}) {
        const inputEl = findInput({ silent: true });
        const composerRoot = inputEl
            ? (inputEl.closest('form') || inputEl.closest('footer') || inputEl.closest('[role="form"]') || inputEl.parentElement)
            : null;
        const root = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
        if (!root) {
            return options.withMeta
                ? { text: '', meta: { provider: 'grok', source: 'transcript_tail', reason: 'no_root' } }
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
            'audio'
        ];
        try {
            clone.querySelectorAll(removeSelectors.join(',')).forEach((node) => node.remove());
        } catch (error) {
            // ignore
        }

        // Remove obvious composer-like sections in the cloned tree to avoid recapturing draft input.
        try {
            clone.querySelectorAll('footer, [role="form"], form, [role="textbox"], [contenteditable="true"], .tiptap.ProseMirror').forEach((node) => node.remove());
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
                ? { text: '', meta: { provider: 'grok', source: 'transcript_tail', reason: 'empty_after_clone' } }
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
                ? { text: '', meta: { provider: 'grok', source: 'transcript_tail', reason: 'only_controls_or_scaffold' } }
                : '';
        }

        const chunks = [];
        let current = [];
        for (const line of rawLines) {
            const trimmed = String(line || '').trim();
            if (!trimmed) {
                if (current.length) {
                    chunks.push(current.join('\n').trim());
                    current = [];
                }
                continue;
            }
            if (isGrokControlOnlyText(trimmed)) continue;
            if (isGrokPromptScaffoldLine(trimmed)) continue;
            current.push(trimmed);
        }
        if (current.length) chunks.push(current.join('\n').trim());

        let chosenChunk = '';
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
            const chunk = sanitizeGrokTranscriptCandidate(chunks[i], { allowShort: false });
            if (!chunk) continue;
            chosenChunk = chunk;
            break;
        }

        const fallbackLines = lines.slice(Math.max(0, lines.length - 140));
        const fallbackTail = sanitizeGrokTranscriptCandidate(fallbackLines.join('\n').trim(), { allowShort: false });
        const selected = chosenChunk || fallbackTail;
        if (!selected) {
            return options.withMeta
                ? {
                    text: '',
                    meta: {
                        provider: 'grok',
                        source: 'transcript_tail',
                        reason: 'filtered_or_low_quality',
                        lineCount: lines.length,
                        chunkCount: chunks.length
                    }
                }
                : '';
        }

        const bounded = selected.length > 20000 ? selected.slice(selected.length - 20000) : selected;
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
                        chunkCount: chunks.length
                    }
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
                    chunkCount: chunks.length,
                    usedChunk: Boolean(chosenChunk)
                }
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

	    function extractLatestResponseText() {
	        return extractLatestResponse({ withMeta: false }).text || '';
	    }

    function normalizeInlineText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function sanitizeModelLabel(rawLabel) {
        const normalized = normalizeInlineText(rawLabel).replace(/^Model:\s*/i, '').trim();
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
            /\bgemini\b.*\banswer\b/i
        ];
        if (suspicious.some(re => re.test(normalized))) return '';

        return normalized;
    }

    function detectChatGPTModelLabel() {
        const selectors = [
            'button[data-testid="model-switcher-button"]',
            '[data-testid="model-switcher"] button',
            'button[aria-haspopup="menu"][aria-label*="Model" i]',
            'button[aria-label*="model" i]'
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
            'mat-select .mat-select-value-text'
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
            '[data-testid*="model" i] button'
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
            '[data-testid*="model" i] button'
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
        chrome.runtime.sendMessage({
            type: 'PROVIDER_MODEL_INFO',
            provider: currentLLM,
            modelLabel: label
        }, () => {
            if (chrome.runtime.lastError) {
                // ignore
            }
        });
    }

    function sendCapturedResponse(extraction) {
        const text = typeof extraction === 'string'
            ? extraction
            : (extraction?.text || extraction?.content || '');
        const contentHtml = typeof extraction === 'object' && extraction
            ? (extraction.html || extraction.contentHtml || '')
            : '';

	        const responsePayload = {
	            content: text,
	            contentHtml,
	            promptId: captureState.promptId,
	            sessionId: captureState.sessionId,
	            agentId: captureState.agentId,
	            sourceLLM: currentLLM,
	            turnIndex: captureState.turnIndex,
	            timestamp: Date.now(),
	            responseDelay: captureState.startedAt ? (Date.now() - captureState.startedAt) : null
	        };

        const messageType = captureState.sessionId
            ? 'MLC_RESPONSE_CAPTURED'
            : (currentLLM === 'chatgpt'
                ? 'CHATGPT_RESPONSE_CAPTURED'
                : (currentLLM === 'gemini'
                    ? 'GEMINI_RESPONSE_CAPTURED'
                    : (currentLLM === 'claude' ? 'CLAUDE_RESPONSE_CAPTURED' : 'GROK_RESPONSE_CAPTURED')));

        chrome.runtime.sendMessage({ type: messageType, ...responsePayload }, () => {
            if (chrome.runtime.lastError) {
                console.error(`[MLC Capture - ${currentLLM}] Failed to send response:`, chrome.runtime.lastError);
                captureState.active = true;
                return;
            }
            captureState.active = false;
            captureState.lastEmitAt = Date.now();
            console.log(`[MLC Capture - ${currentLLM}] Response captured for prompt ${captureState.promptId}`);
        });
    }

    function emitCaptureFromResolvedExtraction(reason, extraction) {
        const baseExtraction = (typeof extraction === 'object' && extraction)
            ? extraction
            : { text: String(extraction || '') };
        let resolved = { ...baseExtraction };
        let text = String(resolved?.text || resolved?.content || '').trim();
        let source = resolved?.meta?.source || 'primary';

        if (!text && isGrok) {
            const fallback = extractGrokTranscriptTailText({ withMeta: true });
            const fallbackText = sanitizeGrokTranscriptCandidate(fallback?.text || '', { allowShort: false });
            if (fallbackText) {
                resolved = {
                    text: fallbackText,
                    meta: {
                        ...(fallback?.meta || {}),
                        source: 'transcript_tail_emit_fallback'
                    }
                };
                text = fallbackText;
                source = 'transcript_tail_emit_fallback';
            }
        }

        if (isGrok) {
            const shouldUseStrictTailGate = source.startsWith('transcript_tail');
            if (shouldUseStrictTailGate) {
                const sanitizedTail = sanitizeGrokTranscriptCandidate(text, { allowShort: false });
                if (!sanitizedTail) {
                    captureDebug('Capture emit skipped (grok tail rejected)', {
                        llm: currentLLM,
                        reason,
                        source,
                        textLen: String(text || '').length
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
                    textLen: String(text || '').length
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
                textLen: String(text || '').length
            });
            return false;
        }

        if (isGrok) {
            text = stripGrokUiFooterArtifacts(text);
            if (!normalizeCaptureCandidateText(text)) {
                captureDebug('Capture emit skipped (grok footer-only)', {
                    llm: currentLLM,
                    reason,
                    source
                });
                return false;
            }
            // Grok rich HTML frequently includes UI footer widgets; render as plain text only.
            resolved.html = '';
            resolved.contentHtml = '';
        }
        resolved.text = text;
        captureDebug('Capture emit', {
            llm: currentLLM,
            reason,
            textLen: text.length,
            source,
            bestSelector: resolved?.meta?.bestSelector || null,
            bestBottom: Number.isFinite(resolved?.meta?.bestBottom) ? resolved.meta.bestBottom : null
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
                isGrok
                && captureState.grokSawStopControl
                && !grokControl?.stopVisible
                && (grokControl?.voiceVisible || grokControl?.sendVisible || captureState.grokSawVoiceAfterStop)
            );
            const grokLooksComplete = Boolean(
                isGrok
                && !grokControl?.stopVisible
                && (grokControl?.voiceVisible || grokControl?.sendVisible)
            );

            let currentGrokBestBottom = isGrok && Number.isFinite(meta.bestBottom) ? meta.bestBottom : null;
            let currentGrokCandidateCount = isGrok && Number.isFinite(meta.candidateCount) ? meta.candidateCount : null;
            let currentGrokShapeSignature = isGrok && typeof meta.bestShapeSignature === 'string'
                ? meta.bestShapeSignature
                : '';
            const baselineGrokBestBottom = isGrok && Number.isFinite(captureState.grokBaselineBestBottom)
                ? captureState.grokBaselineBestBottom
                : null;
            const baselineGrokCandidateCount = isGrok && Number.isFinite(captureState.grokBaselineCandidateCount)
                ? captureState.grokBaselineCandidateCount
                : null;

            const tryGrokFallbackExtraction = (reason) => {
                if (!isGrok) return false;
                const fallback = extractGrokTranscriptTailText({ withMeta: true });
                const fallbackText = String(fallback?.text || '').trim();
                if (!fallbackText) return false;
                if (isGrokControlOnlyText(fallbackText)) return false;

                const fallbackNormalized = normalizeCaptureCandidateText(fallbackText);
                if (!fallbackNormalized) return false;

                const baselineTailNormalized = normalizeCaptureCandidateText(captureState.grokBaselineTranscriptTail || '');
                const baselinePrimaryNormalized = normalizeCaptureCandidateText(captureState.baselineText || '');
                const sameAsBaselineTail = Boolean(baselineTailNormalized && fallbackNormalized === baselineTailNormalized);
                const sameAsBaselinePrimary = Boolean(baselinePrimaryNormalized && fallbackNormalized === baselinePrimaryNormalized);
                const materiallyLongerThanTail = Boolean(
                    baselineTailNormalized
                    && fallbackNormalized.startsWith(baselineTailNormalized)
                    && fallbackNormalized.length > baselineTailNormalized.length + 120
                );
                if ((sameAsBaselineTail || sameAsBaselinePrimary) && !materiallyLongerThanTail) return false;

                extraction = {
                    text: fallbackText,
                    meta: {
                        ...(fallback?.meta || {}),
                        bestBottom: Number.isFinite(currentGrokBestBottom)
                            ? currentGrokBestBottom
                            : (Number.isFinite(baselineGrokBestBottom) ? baselineGrokBestBottom + 8 : null),
                        candidateCount: Number.isFinite(currentGrokCandidateCount)
                            ? currentGrokCandidateCount
                            : (Number.isFinite(baselineGrokCandidateCount) ? baselineGrokCandidateCount + 1 : 1),
                        bestShapeSignature: `fallback:${reason}:${stableTextSignature(fallbackText)}`
                    }
                };
                text = extraction.text;
                captureState.lastExtractionMeta = extraction.meta || null;
                meta = captureState.lastExtractionMeta || {};
                currentGrokBestBottom = Number.isFinite(meta.bestBottom) ? meta.bestBottom : currentGrokBestBottom;
                currentGrokCandidateCount = Number.isFinite(meta.candidateCount) ? meta.candidateCount : currentGrokCandidateCount;
                currentGrokShapeSignature = typeof meta.bestShapeSignature === 'string'
                    ? meta.bestShapeSignature
                    : currentGrokShapeSignature;
                captureDebug('Grok transcript-tail fallback selected', {
                    reason,
                    lineCount: fallback?.meta?.lineCount ?? null,
                    chunkCount: fallback?.meta?.chunkCount ?? null,
                    usedChunk: fallback?.meta?.usedChunk ?? null
                });
                return true;
            };

	        if (!captureState.hasNewText) {
	            if (!text) {
                    if (!(grokCompletedByControls || grokLooksComplete) || !tryGrokFallbackExtraction('empty_primary')) {
                        return;
                    }
                }

	            if (isChatGPT) {
	                const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
	                    ? captureState.baselineAssistantCount
	                    : null;
	                const bestAssistantIndex = Number.isFinite(captureState.lastExtractionMeta?.bestAssistantIndex)
	                    ? captureState.lastExtractionMeta.bestAssistantIndex
	                    : null;

	                // Prevent capturing a pre-turn assistant message (common in Pro mode due to side panels/rerenders).
	                if (baselineCount !== null) {
	                    if (bestAssistantIndex === null || bestAssistantIndex < baselineCount) return;
	                }

	                const baselineNormalized = normalizeCaptureCandidateText(captureState.baselineText || '');
	                const textNormalized = normalizeCaptureCandidateText(text);
	                if (baselineNormalized && textNormalized && textNormalized === baselineNormalized) return;
	            } else if (isGrok) {
                    const baselineNormalized = normalizeCaptureCandidateText(captureState.baselineText || '');
                    const textNormalized = normalizeCaptureCandidateText(text);
                    const sameAsBaseline = Boolean(baselineNormalized && textNormalized && textNormalized === baselineNormalized);
                    const shapeSuggestsNewTurn = Boolean(
                        (baselineGrokBestBottom !== null && currentGrokBestBottom !== null && currentGrokBestBottom > baselineGrokBestBottom + 6)
                        || (baselineGrokCandidateCount !== null && currentGrokCandidateCount !== null && currentGrokCandidateCount > baselineGrokCandidateCount)
                    );
                    if (sameAsBaseline && !shapeSuggestsNewTurn) {
                        if (!grokCompletedByControls && !grokLooksComplete) return;
                        const latestExtraction = extractLatestResponse({ withMeta: true, withHtml: true, grokPreferLatestBottom: true });
                        const latestText = latestExtraction.text || '';
                        const latestNormalized = normalizeCaptureCandidateText(latestText);
                        const latestSameAsBaseline = Boolean(
                            baselineNormalized
                            && latestNormalized
                            && latestNormalized === baselineNormalized
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
                            currentGrokBestBottom = Number.isFinite(meta.bestBottom) ? meta.bestBottom : null;
                            currentGrokCandidateCount = Number.isFinite(meta.candidateCount) ? meta.candidateCount : null;
                            currentGrokShapeSignature = typeof meta.bestShapeSignature === 'string'
                                ? meta.bestShapeSignature
                                : '';
                            captureDebug('Grok switched to latest-bottom candidate after control completion', {
                                baselineBottom: baselineGrokBestBottom,
                                selectedBottom: currentGrokBestBottom,
                                selectedShape: currentGrokShapeSignature
                            });
                        }
                    }
                    if (sameAsBaseline && shapeSuggestsNewTurn) {
                        captureDebug('Grok new text inferred by shape', {
                            baselineBottom: baselineGrokBestBottom,
                            currentBottom: currentGrokBestBottom,
                            baselineCandidateCount: baselineGrokCandidateCount,
                            currentCandidateCount: currentGrokCandidateCount
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
            if (!(grokCompletedByControls || grokLooksComplete) || !tryGrokFallbackExtraction('post_has_new_empty')) {
                return;
            }
        }

        const textChanged = text !== captureState.lastText;
        const grokShapeChanged = isGrok && Boolean(
            (Number.isFinite(captureState.grokLastBestBottom) && currentGrokBestBottom !== null && Math.abs(currentGrokBestBottom - captureState.grokLastBestBottom) >= 4)
            || (captureState.grokLastShapeSignature && currentGrokShapeSignature && currentGrokShapeSignature !== captureState.grokLastShapeSignature)
        );

        if (textChanged || grokShapeChanged) {
            captureState.lastText = text;
            captureState.lastTextChangeAt = now;
            if (isGrok && grokShapeChanged) {
                captureDebug('Grok shape progressed', {
                    previousBottom: captureState.grokLastBestBottom,
                    currentBottom: currentGrokBestBottom,
                    previousShape: captureState.grokLastShapeSignature,
                    currentShape: currentGrokShapeSignature
                });
            }
	        }
            if (isGrok) {
                if (currentGrokBestBottom !== null) captureState.grokLastBestBottom = currentGrokBestBottom;
                if (currentGrokShapeSignature) captureState.grokLastShapeSignature = currentGrokShapeSignature;
            }

	        const generatingRaw = isGenerating();
            const generating = (isGrok && grokLooksComplete) ? false : generatingRaw;
            if (generating) captureState.sawGenerating = true;
	        const stableForMs = now - captureState.lastTextChangeAt;
            const totalForMs = now - captureState.startedAt;
            const metaWordCount = isChatGPT && Number.isFinite(captureState.lastExtractionMeta?.bestWordCount)
                ? captureState.lastExtractionMeta.bestWordCount
                : null;
            const wordCount = metaWordCount !== null
                ? metaWordCount
                : String(text || '').trim().split(/\s+/).filter(Boolean).length;

            const looksUrlishOnly = isChatGPT
                ? (wordCount > 0 &&
                    wordCount <= 10 &&
                    !/[.!?](?:\s|$)/.test(text) &&
                    /(?:\bhttps?:\/\/\S+|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\b)/i.test(text))
                : false;

	        const baseForceCaptureMs = isChatGPT ? 45000 : (isGrok ? 20000 : 15000);
	        const isLikelyReferenceOnly = isChatGPT
	            ? Boolean(captureState.lastExtractionMeta?.bestIsReferenceList || looksLikeChatGPTSourcesOnly(text) || looksUrlishOnly)
	            : false;
	        const forceCaptureMs = isLikelyReferenceOnly ? Math.max(baseForceCaptureMs, 60000) : baseForceCaptureMs;
	        const minTextLen = 5;
            let stableCaptureMs = isLikelyReferenceOnly
                ? (isChatGPT ? 9000 : 3000)
                : (isChatGPT ? 3000 : 1200);
            const maxWaitMs = isChatGPT ? 180000 : (isGrok ? 150000 : 120000);

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
                .map(line => line.trim())
                .filter(Boolean).length;

            // If we never observed ChatGPT's "generating" UI, be more conservative to avoid
            // prematurely capturing small fragments during UI pauses.
            if (isChatGPT && !captureState.sawGenerating) {
                stableCaptureMs = Math.max(stableCaptureMs, 6000);
            }

            if (isChatGPT && !isLikelyReferenceOnly && !captureState.sawGenerating) {
                const looksLikeEarlyFragment = wordCount > 0
                    && wordCount < 8
                    && nonEmptyLineCount <= 1
                    && text.length < 40
                    && !/[.!?](?:\s|$)/.test(text);

                if (looksLikeEarlyFragment) {
                    stableCaptureMs = Math.max(stableCaptureMs, 12000);
                }
            }

            const tabHidden = document.visibilityState !== 'visible';
            const visibilityMultiplier = tabHidden ? 2 : 1;
            if (tabHidden) {
                const hiddenStableMin = isChatGPT ? 6000 : (isGrok ? 4500 : 3000);
                stableCaptureMs = Math.max(stableCaptureMs, hiddenStableMin);
            }
            const finalForceCaptureMs = forceCaptureMs * visibilityMultiplier;
            const finalMaxWaitMs = maxWaitMs * visibilityMultiplier;
            const minStableForTimeoutMs = tabHidden
                ? (isChatGPT ? 8000 : 5000)
                : (isChatGPT ? 6000 : (isGrok ? 5000 : 4000));

	        if (generating) {
	            if (stableForMs >= finalForceCaptureMs && text.length >= minTextLen) {
	                if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;
	                captureDebug('Force capture', {
	                    llm: currentLLM,
                        sawGenerating: captureState.sawGenerating,
	                    stableForMs,
	                    forceCaptureMs: finalForceCaptureMs,
	                    isLikelyReferenceOnly,
	                    textLen: text.length,
	                    meta: captureState.lastExtractionMeta
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
                    meta: captureState.lastExtractionMeta
                });
                emitCaptureFromResolvedExtraction('grok_stop_voice_idle', extraction);
                return;
            }

            if (text.length < minTextLen) return;
            const canStableCapture = stableForMs >= stableCaptureMs;
            const canTimeoutCapture = totalForMs >= finalMaxWaitMs && stableForMs >= minStableForTimeoutMs;
            if (!canStableCapture && !canTimeoutCapture) return;
            if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;

            const reason = canTimeoutCapture && !canStableCapture
                ? 'Timeout capture'
                : ((isLikelyReferenceOnly && stableCaptureMs > 3000)
                    ? 'Stable capture (delayed; reference-like)'
                    : 'Stable capture');
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
                meta: captureState.lastExtractionMeta
            });
            emitCaptureFromResolvedExtraction(canTimeoutCapture && !canStableCapture ? 'timeout_capture' : 'stable_capture', extraction);
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

    startCaptureObservers();

    setInterval(sendModelInfoIfChanged, 8000);
    setTimeout(sendModelInfoIfChanged, 2500);

})();
