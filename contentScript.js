(function() {
    const host = location.hostname;
    const isChatGPT = host.includes('openai.com') || host.includes('chatgpt.com');
    const isGemini = host.includes('gemini.google.com');
    if (!isChatGPT && !isGemini) return;

    let forwardEnabled = false;
	    const forwardTo = isChatGPT ? 'gemini' : 'chatgpt';
	    const currentLLM = isChatGPT ? 'chatgpt' : 'gemini';

	    console.log(`[MLC ContentScript] Initializing for ${currentLLM}. Forwarding to ${forwardTo}.`);

	    const CaptureUtils = globalThis.MLCCaptureUtils || null;

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
	        sessionId: null,
	        turnIndex: null,
	        startedAt: 0,
	        lastText: '',
	        baselineText: '',
	        baselineAssistantCount: null,
	        hasNewText: false,
	        lastTextChangeAt: 0,
	        stableTicks: 0,
	        lastEmitAt: 0,
	        lastExtractionMeta: null
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
        ] : [ 
            'div.ql-editor[role="textbox"]', 
            '.ql-editor.textarea',
            'div[contenteditable="true"][aria-label*="prompt"]', 
            'textarea[placeholder*="Enter a prompt"]',
            'textarea[placeholder*="Ask"]',
            'textarea',
            '[contenteditable="true"]'
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

    function findSendButton() {
        const selectors = isChatGPT ? [
            'button[data-testid="send-button"]',
            'button[data-testid="fruitjuice-send-button"]',
            'button[aria-label="Send message"]', // More specific
            'form button[type="submit"]'
        ] : [ 
            'button[aria-label="Send message"]', 
            'button[data-testid="send-button"]', 
            'button.send-button' 
        ];
        
        const genericSelectors = [
            'button[aria-label*="Send"]', // General send
            'button[type="submit"]',
            'button:has(svg[class*="send"])', // Button with a send-like SVG
            'button:has(span[class*="send"])', // Button with a send-like SPAN
            // 'button:last-of-type' // Too risky, remove for now
        ];

        const allSelectors = [...selectors, ...genericSelectors];

        for (const sel of allSelectors) {
            const btns = document.querySelectorAll(sel);
            for (const btn of btns) {
                const style = window.getComputedStyle(btn);
                if (
                    btn &&
                    btn.id !== 'mlc-forward-toggle' && 
                    !btn.disabled &&
                    btn.offsetParent !== null &&      
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    (btn.offsetHeight > 0 && btn.offsetWidth > 0) // Check if actually visible
                ) {
                    // console.log(`[MLC ContentScript - ${currentLLM}] Found send button with selector:`, sel, btn);
                    return btn;
                }
            }
        }
        console.warn(`[MLC ContentScript - ${currentLLM}] Send button NOT found (might rely on Enter key).`);
        return null;
    }

    function getPromptText(inputElement) {
        if (!inputElement) return '';
        if (inputElement.isContentEditable || inputElement.contentEditable === 'true') {
            return inputElement.innerText || inputElement.textContent || '';
        }
        return inputElement.value || '';
    }

    function attachListeners() {
        const input = findInput();
        const sendBtn = findSendButton();

        if (input && !input.dataset.mlcForwardKey) {
            input.addEventListener('keydown', evt => {
                if (!evt.isTrusted) return; 
                if (evt.key === 'Enter' && !evt.shiftKey && !evt.metaKey && !evt.ctrlKey) {
                    if (forwardEnabled) {
                        const currentInput = findInput(); 
                        const prompt = getPromptText(currentInput).trim();
                        console.log(`[MLC ContentScript - ${currentLLM}] Enter detected, forwardEnabled. Prompt: "${prompt.substring(0,50)}..."`);
                        if (prompt) {
                            chrome.runtime.sendMessage({
                                type: 'FORWARD_PROMPT',
                                from: currentLLM,
                                prompt
                            });
                        }
                    }
                }
            });
            input.dataset.mlcForwardKey = 'true';
            // console.log(`[MLC ContentScript - ${currentLLM}] Keydown listener attached to input.`);
        }

        if (sendBtn && !sendBtn.dataset.mlcForwardClick) {
            sendBtn.addEventListener('click', (evt) => {
                if (!sendBtn.contains(evt.target) && evt.target !== sendBtn) return;
                if (!forwardEnabled) return;
                if (evt.target.id === 'mlc-forward-toggle') return;

                const srcInput = findInput(); 
                const prompt = getPromptText(srcInput).trim();
                console.log(`[MLC ContentScript - ${currentLLM}] Send button clicked, forwardEnabled. Prompt: "${prompt.substring(0,50)}..."`);
                if (prompt) {
                    chrome.runtime.sendMessage({
                        type: 'FORWARD_PROMPT',
                        from: currentLLM,
                        prompt
                    });
                }
            }, true); 
            sendBtn.dataset.mlcForwardClick = 'true';
            // console.log(`[MLC ContentScript - ${currentLLM}] Click listener attached to send button.`);
        }
    }

    function addToggleButton() {
        const existingButton = document.getElementById('mlc-forward-toggle');
        if (existingButton && existingButton.dataset.mlcManaged === 'true') {
            // If new button exists, just update its style based on forwardEnabled
            existingButton.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
            existingButton.style.borderColor = forwardEnabled ? '#4CAF50' : '#555';
            return;
        } else if (existingButton) {
            // If an old button (not marked as mlcManaged) exists, remove it
            console.log(`[MLC ContentScript - ${currentLLM}] Removing old (unmanaged) toggle button.`);
            existingButton.remove();
        }

        let parentElement = null;
        const inputEl = findInput();
        const sendBtnEl = findSendButton();

        if (isChatGPT) {
            // ChatGPT: Try to place it near the send button or within its container.
            // The send button is usually inside a div, which is a sibling of the textarea's parent div, or part of a larger form structure.
            if (sendBtnEl) {
                parentElement = sendBtnEl.parentElement; // Direct parent of send button
                // If send button's parent is a flex container, good.
                // Or find a more specific container for buttons.
                const buttonContainer = sendBtnEl.closest('div[class*="stretch"] > div[class*="flex"], div[class*="absolute"] > div[class*="flex"]'); // Common pattern for button groups in CPT
                if (buttonContainer) {
                    parentElement = buttonContainer;
                } else if (parentElement && parentElement.tagName === 'FORM') { 
                    // If parent is form, try to find a div inside it that holds buttons
                    const formButtonDiv = parentElement.querySelector('div > button[data-testid*="send"]')?.parentElement;
                    if (formButtonDiv) parentElement = formButtonDiv;
                }
            }
            if (!parentElement && inputEl) { // Fallback to input area if send button area not ideal
                 parentElement = inputEl.parentElement; // Parent of textarea
                 if (parentElement && parentElement.parentElement && parentElement.parentElement.querySelector('button[data-testid*="send"]')) {
                    // If the grandparent of textarea also contains the send button, this might be a better container
                    parentElement = parentElement.parentElement;
                 }
            }
        } else { // Gemini
            let geminiInputContainer = inputEl?.closest('.input-area-container, .composer-collapsed-view, .input-container, .input-area, .input-row');
            if (geminiInputContainer) {
                // Gemini often has a specific div for actions/buttons within the input area
                parentElement = geminiInputContainer.querySelector('div[class*="actions"], div[style*="display: flex"], .button-row') || geminiInputContainer;
            } else if (inputEl) {
                parentElement = inputEl.parentElement;
            }
        }
        
        if (!parentElement) {
            parentElement = document.querySelector('form') || inputEl?.closest('form');
            if (!parentElement) {
                parentElement = document.body; // Absolute last resort
                console.warn(`[MLC ContentScript - ${currentLLM}] Could not find specific parent for toggle button, using fallback: ${parentElement.tagName}`);
            }
        }

        const btn = document.createElement('button');
        btn.id = 'mlc-forward-toggle';
        btn.dataset.mlcManaged = 'true'; // Mark as new, managed button
        btn.type = 'button';
        btn.textContent = isChatGPT ? `⇄ Gemini` : `⇄ ChatGPT`;
        
        // Consistent styling
        btn.style.marginLeft = '8px';
        btn.style.marginRight = '8px';
        btn.style.padding = '6px 10px';
        btn.style.fontSize = '12px';
        btn.style.border = '1px solid #555';
        btn.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
        btn.style.borderColor = forwardEnabled ? '#4CAF50' : '#555';
        btn.style.color = '#e0e0e0';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.zIndex = '10000'; 
        btn.style.whiteSpace = 'nowrap'; // Prevent text wrapping

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            forwardEnabled = !forwardEnabled;
            btn.style.background = forwardEnabled ? '#4CAF50' : '#3a3a3a';
            btn.style.borderColor = forwardEnabled ? '#4CAF50' : '#555';
            console.log(`[MLC ContentScript - ${currentLLM}] Forwarding to ${forwardTo} ${forwardEnabled ? 'ENABLED' : 'DISABLED'}.`);
        });

        // Insertion logic: Try to insert before the native send button if possible and sensible
        if (sendBtnEl && parentElement && parentElement.contains(sendBtnEl) && parentElement !== sendBtnEl) {
            // If the parentElement contains the send button, insert our button before the send button
            parentElement.insertBefore(btn, sendBtnEl);
        } else if (parentElement) {
            // Otherwise, append to the determined parent element
            parentElement.appendChild(btn);
        } else {
            console.error(`[MLC ContentScript - ${currentLLM}] Final parentElement is null, cannot add button.`);
            return; // Exit if no parent to append to
        }
        
        console.log(`[MLC ContentScript - ${currentLLM}] Toggle button added/updated. Parent:`, parentElement);
    }

    const observer = new MutationObserver((mutationsList, observer) => {
        let relevantChange = false;
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
                const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
                if (changedNodes.some(node => node.nodeType === Node.ELEMENT_NODE && (
                    (currentLLM === 'chatgpt' && (node.id === 'prompt-textarea' || node.querySelector('#prompt-textarea') || node.matches('button[data-testid*="send"]'))) ||
                    (currentLLM === 'gemini' && (node.matches?.('div.ql-editor[role="textbox"]') || node.querySelector('div.ql-editor[role="textbox"]') || node.matches('button[aria-label="Send message"]'))) ||
                    node.matches('textarea, button, form, div[contenteditable="true"]') || // General catch-all
                    (node.querySelector && node.querySelector('textarea, button, form, div[contenteditable="true"]'))
                ))) {
                    relevantChange = true;
                    break;
                }
            }
            if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE && 
                (mutation.target.id === 'prompt-textarea' || mutation.target.matches?.('button') || mutation.target.matches?.('div.ql-editor'))) {
                relevantChange = true;
            }
        }

        if (relevantChange) {
            // console.log(`[MLC ContentScript - ${currentLLM}] DOM changed, re-evaluating elements.`);
            addToggleButton(); 
            attachListeners(); 
        }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });

    setTimeout(() => {
        // console.log(`[MLC ContentScript - ${currentLLM}] Delayed initial setup.`);
        addToggleButton();
        attachListeners();
    }, 2500); // Slightly increased delay

	    function armCapture(message) {
	        if (!message || !message.promptId) return;
	        captureState.active = true;
	        captureState.promptId = message.promptId;
	        captureState.sessionId = message.sessionId || null;
	        captureState.turnIndex = message.turnIndex || null;
	        captureState.startedAt = message.timestamp || Date.now();
	        captureState.lastText = '';
	        captureState.baselineAssistantCount = isChatGPT
	            ? document.querySelectorAll('[data-message-author-role="assistant"]').length
	            : null;
	        captureState.baselineText = extractLatestResponseText() || '';
	        captureState.hasNewText = false;
	        captureState.lastTextChangeAt = captureState.startedAt;
	        captureState.stableTicks = 0;
	        captureState.lastEmitAt = 0;
	        captureState.lastExtractionMeta = null;
	        console.log(`[MLC Capture - ${currentLLM}] Armed for prompt ${message.promptId}`);
	        captureDebug('Armed', {
	            llm: currentLLM,
	            promptId: message.promptId,
	            sessionId: captureState.sessionId,
	            turnIndex: captureState.turnIndex,
	            baselineAssistantCount: captureState.baselineAssistantCount,
	            baselinePreview: String(captureState.baselineText || '').slice(0, 160)
	        });
	        setTimeout(evaluateCapture, 1200);
	    }

    function isChatGPTGenerating() {
        const stopButton = document.querySelector('button[data-testid=\"stop-button\"], button[aria-label*=\"Stop\" i]');
        return !!(stopButton && stopButton.offsetParent !== null);
    }

    function isGeminiGenerating() {
        const stopIcon = document.querySelector('mat-icon[fonticon=\"stop\"]');
        if (stopIcon && stopIcon.offsetParent !== null) return true;
        const stopButton = document.querySelector('button[aria-label*=\"Stop\" i], button[aria-label*=\"Cancel\" i]');
        if (stopButton && stopButton.offsetParent !== null) return true;
        const spinner = document.querySelector('mat-progress-spinner, mat-spinner, [role=\"progressbar\"], .loading, .spinner');
        if (spinner && spinner.offsetParent !== null) return true;
        const sendButton = document.querySelector('button[aria-label*=\"Send\" i], button[data-testid=\"send-button\"]');
        if (sendButton && sendButton.offsetParent !== null && !sendButton.disabled) return false;
        return false;
    }

    function isGenerating() {
        return isChatGPT ? isChatGPTGenerating() : isGeminiGenerating();
    }

	    function getTrimmedText(node) {
	        if (!node) return '';
	        const text = node.innerText || node.textContent || '';
	        return (text || '').trim();
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

	    function extractChatGPTResponse(options = {}) {
	        const assistantNodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
	        const baselineCount = Number.isFinite(captureState.baselineAssistantCount)
	            ? captureState.baselineAssistantCount
	            : null;

	        const preferredStart = baselineCount !== null
	            ? Math.min(baselineCount, Math.max(0, assistantNodes.length - 1))
	            : 0;

	        let messageRoot = null;
	        for (let i = assistantNodes.length - 1; i >= preferredStart; i--) {
	            const node = assistantNodes[i];
	            if (!node) continue;
	            if (node.querySelector('[data-testid="message-content"], .markdown, .prose')) {
	                messageRoot = node;
	                break;
	            }
	            if (getTrimmedText(node)) {
	                messageRoot = node;
	                break;
	            }
	        }
	        if (!messageRoot) {
	            for (let i = assistantNodes.length - 1; i >= 0; i--) {
	                const node = assistantNodes[i];
	                if (!node) continue;
	                if (node.querySelector('[data-testid="message-content"], .markdown, .prose')) {
	                    messageRoot = node;
	                    break;
	                }
	                if (getTrimmedText(node)) {
	                    messageRoot = node;
	                    break;
	                }
	            }
	        }

	        const candidateNodes = [];
	        if (messageRoot) {
	            const selectors = [
	                '[data-testid="message-content"]',
	                '.prose',
	                '.markdown'
	            ];
	            for (const sel of selectors) {
	                messageRoot.querySelectorAll(sel).forEach(node => candidateNodes.push(node));
	            }
	            candidateNodes.push(messageRoot);
	        }

	        // Fallback: scan for content nodes outside of the assistant root.
	        if (candidateNodes.length === 0) {
	            document.querySelectorAll('[data-testid="message-content"], .markdown, .prose').forEach(node => candidateNodes.push(node));
	        }

	        const seenNodes = new Set();
	        const seenText = new Set();
	        const candidates = [];
	        for (const node of candidateNodes) {
	            if (!node || seenNodes.has(node)) continue;
	            seenNodes.add(node);
	            const isUser = node.closest?.('[data-message-author-role="user"], .user-message');
	            if (isUser) continue;
	            const text = getTrimmedText(node);
	            if (!text) continue;
	            const normalized = CaptureUtils?.normalizeWhitespace
	                ? CaptureUtils.normalizeWhitespace(text)
	                : String(text).replace(/\s+/g, ' ').trim();
	            if (!normalized) continue;
	            if (seenText.has(normalized)) continue;
	            seenText.add(normalized);
	            candidates.push({ node, text });
	        }

	        if (candidates.length === 0) {
	            return options.withMeta ? { text: '', meta: null } : { text: '' };
	        }

	        const texts = candidates.map(candidate => candidate.text);
	        const ranking = CaptureUtils?.chooseBestTextCandidate
	            ? CaptureUtils.chooseBestTextCandidate(texts, { provider: 'chatgpt' })
	            : { bestIndex: 0, best: { index: 0, score: texts[0].length, isReferenceList: looksLikeChatGPTSourcesOnly(texts[0]) }, ranked: [] };

	        const bestIndex = Number.isFinite(ranking.bestIndex) && ranking.bestIndex >= 0
	            ? ranking.bestIndex
	            : 0;
	        const bestText = texts[bestIndex] || texts[0] || '';

	        const meta = {
	            provider: 'chatgpt',
	            assistantCount: assistantNodes.length,
	            baselineAssistantCount: captureState.baselineAssistantCount,
	            candidateCount: texts.length,
	            bestIndex: bestIndex,
	            bestScore: ranking.best?.score ?? null,
	            bestIsReferenceList: ranking.best?.isReferenceList ?? null,
	            rankingTop: Array.isArray(ranking.ranked)
	                ? ranking.ranked.slice(0, 6).map(r => ({
	                    index: r.index,
	                    score: r.score,
	                    isReferenceList: r.isReferenceList,
	                    wordCount: r.analysis?.wordCount,
	                    lineCount: r.analysis?.lineCount
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

	        return options.withMeta ? { text: bestText, meta } : { text: bestText };
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

    function extractGeminiResponseText() {
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

            const clone = target.cloneNode(true);
            const mediaNodes = clone.querySelectorAll('img, video, canvas, svg, figure, picture');
            if (mediaNodes.length > 0) sawMedia = true;
            mediaNodes.forEach(el => el.remove());

            const text = clone.innerText || clone.textContent;
            if (text && text.trim()) return text.trim();
        }

        if (sawMedia) {
            return '[Gemini returned an image output; no text was captured. Proceeding with debate.]';
	        }
	        return '';
	    }

	    function extractLatestResponse(options = {}) {
	        if (isChatGPT) return extractChatGPTResponse(options);
	        const text = extractGeminiResponseText();
	        return options.withMeta ? { text, meta: { provider: 'gemini' } } : { text };
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

    function detectModelLabel() {
        return isChatGPT ? detectChatGPTModelLabel() : detectGeminiModelLabel();
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

    function sendCapturedResponse(text) {
        const responsePayload = {
            content: text,
            promptId: captureState.promptId,
            sessionId: captureState.sessionId,
            sourceLLM: currentLLM,
            turnIndex: captureState.turnIndex,
            timestamp: Date.now(),
            responseDelay: captureState.startedAt ? (Date.now() - captureState.startedAt) : null
        };

        const messageType = captureState.sessionId
            ? 'MLC_RESPONSE_CAPTURED'
            : (currentLLM === 'chatgpt' ? 'CHATGPT_RESPONSE_CAPTURED' : 'GEMINI_RESPONSE_CAPTURED');

        chrome.runtime.sendMessage({ type: messageType, ...responsePayload }, () => {
            if (chrome.runtime.lastError) {
                console.error(`[MLC Capture - ${currentLLM}] Failed to send response:`, chrome.runtime.lastError);
                captureState.active = true;
                captureState.stableTicks = 0;
                return;
            }
            captureState.active = false;
            captureState.lastEmitAt = Date.now();
            console.log(`[MLC Capture - ${currentLLM}] Response captured for prompt ${captureState.promptId}`);
        });
    }

	    function evaluateCapture() {
	        if (!captureState.active) return;
	        const now = Date.now();
	        const minDelayMs = 800;
	        if (now - captureState.startedAt < minDelayMs) return;

	        const extraction = extractLatestResponse({ withMeta: true });
	        const text = extraction.text || '';
	        captureState.lastExtractionMeta = extraction.meta || null;

	        if (!captureState.hasNewText) {
	            if (!text || text === captureState.baselineText) return;
	            captureState.hasNewText = true;
	            captureState.lastText = text;
            captureState.lastTextChangeAt = now;
            captureState.stableTicks = 0;
        }

        if (!text) return;

        const textChanged = text !== captureState.lastText;
        if (textChanged) {
            captureState.lastText = text;
            captureState.lastTextChangeAt = now;
            captureState.stableTicks = 0;
        } else {
            captureState.stableTicks += 1;
        }

	        const generating = isGenerating();
	        const stableForMs = now - captureState.lastTextChangeAt;
	        const baseForceCaptureMs = isChatGPT ? 20000 : 15000;
	        const isLikelyReferenceOnly = isChatGPT
	            ? Boolean(captureState.lastExtractionMeta?.bestIsReferenceList || looksLikeChatGPTSourcesOnly(text))
	            : false;
	        const forceCaptureMs = isLikelyReferenceOnly ? Math.max(baseForceCaptureMs, 45000) : baseForceCaptureMs;
	        const minTextLen = 5;

	        if (generating) {
	            if (stableForMs >= forceCaptureMs && text.length >= minTextLen) {
	                if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;
	                captureDebug('Force capture', {
	                    llm: currentLLM,
	                    stableForMs,
	                    forceCaptureMs,
	                    isLikelyReferenceOnly,
	                    textLen: text.length,
	                    meta: captureState.lastExtractionMeta
	                });
	                sendCapturedResponse(text);
	            }
	            return;
	        }

	        if (captureState.stableTicks >= 3) {
	            if (captureState.lastEmitAt && now - captureState.lastEmitAt < 1500) return;
	            captureDebug('Stable capture', {
	                llm: currentLLM,
	                stableTicks: captureState.stableTicks,
	                stableForMs,
	                textLen: text.length,
	                meta: captureState.lastExtractionMeta
	            });
	            sendCapturedResponse(text);
	        }
	    }

    function startCaptureObservers() {
        const observer = new MutationObserver(() => {
            evaluateCapture();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        const interval = setInterval(evaluateCapture, 3000);

        window.addEventListener('beforeunload', () => {
            observer.disconnect();
            clearInterval(interval);
        });
    }

    startCaptureObservers();

    setInterval(sendModelInfoIfChanged, 8000);
    setTimeout(sendModelInfoIfChanged, 2500);

})();
