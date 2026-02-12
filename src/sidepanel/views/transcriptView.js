(function transcriptViewModule(globalScope) {
    'use strict';

    function isSafeLinkHref(href) {
        if (!href) return false;
        const value = String(href).trim();
        if (!value) return false;
        if (value.startsWith('#')) return true;
        if (value.startsWith('/')) return true;
        if (value.startsWith('./') || value.startsWith('../')) return true;
        return /^https?:\/\//i.test(value) || /^mailto:/i.test(value);
    }

    function sanitizeRichHtmlToFragment(html, doc = document) {
        const template = doc.createElement('template');
        template.innerHTML = String(html || '');

        const htmlTags = new Set([
            'a',
            'b',
            'blockquote',
            'br',
            'caption',
            'code',
            'dd',
            'del',
            'details',
            'div',
            'dl',
            'dt',
            'em',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'hr',
            'i',
            'ins',
            'kbd',
            'li',
            'ol',
            'p',
            'pre',
            's',
            'section',
            'small',
            'span',
            'strong',
            'sub',
            'summary',
            'sup',
            'table',
            'tbody',
            'td',
            'tfoot',
            'th',
            'thead',
            'tr',
            'u',
            'ul',
        ]);

        const mathMlTags = new Set([
            'annotation',
            'maction',
            'math',
            'menclose',
            'merror',
            'mfenced',
            'mfrac',
            'mi',
            'mlabeledtr',
            'mmultiscripts',
            'mn',
            'mo',
            'mover',
            'mpadded',
            'mphantom',
            'mroot',
            'mrow',
            'ms',
            'mspace',
            'msqrt',
            'mstyle',
            'msub',
            'msubsup',
            'msup',
            'mtable',
            'mtd',
            'mtext',
            'mtr',
            'munder',
            'munderover',
            'semantics',
        ]);

        const dropTags = new Set([
            'audio',
            'button',
            'canvas',
            'embed',
            'form',
            'iframe',
            'img',
            'input',
            'link',
            'meta',
            'noscript',
            'object',
            'option',
            'script',
            'select',
            'style',
            'svg',
            'textarea',
            'video',
        ]);

        const mathNs = 'http://www.w3.org/1998/Math/MathML';

        const sanitizeNode = (node) => {
            if (!node) return null;
            if (node.nodeType === Node.TEXT_NODE) {
                return doc.createTextNode(node.nodeValue || '');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return null;
            }

            const tag = String(node.tagName || '').toLowerCase();
            if (!tag) return null;
            if (dropTags.has(tag)) return null;

            const classAttr = node.getAttribute('class') || '';
            if (/\bkatex-html\b/i.test(classAttr)) return null;

            const isMath = mathMlTags.has(tag);
            const isHtml = htmlTags.has(tag);
            if (!isMath && !isHtml) {
                const fragment = doc.createDocumentFragment();
                Array.from(node.childNodes).forEach((child) => {
                    const sanitizedChild = sanitizeNode(child);
                    if (sanitizedChild) fragment.appendChild(sanitizedChild);
                });
                return fragment;
            }

            const el = isMath ? doc.createElementNS(mathNs, tag) : doc.createElement(tag);

            if (tag === 'a') {
                const href = node.getAttribute('href') || '';
                if (isSafeLinkHref(href)) {
                    el.setAttribute('href', href);
                    el.setAttribute('target', '_blank');
                    el.setAttribute('rel', 'noopener noreferrer');
                    const title = node.getAttribute('title');
                    if (title) el.setAttribute('title', title);
                }
            } else if (tag === 'td' || tag === 'th') {
                const colspan = node.getAttribute('colspan');
                const rowspan = node.getAttribute('rowspan');
                if (colspan && /^[0-9]+$/.test(colspan)) el.setAttribute('colspan', colspan);
                if (rowspan && /^[0-9]+$/.test(rowspan)) el.setAttribute('rowspan', rowspan);
            } else if (isMath) {
                const display = node.getAttribute('display');
                if (display) el.setAttribute('display', display);
                const xmlns = node.getAttribute('xmlns');
                if (xmlns) el.setAttribute('xmlns', xmlns);
                const encoding = node.getAttribute('encoding');
                if (encoding && tag === 'annotation') el.setAttribute('encoding', encoding);
            }

            const ariaLabel = node.getAttribute('aria-label');
            if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
            const ariaHidden = node.getAttribute('aria-hidden');
            if (ariaHidden) el.setAttribute('aria-hidden', ariaHidden);

            Array.from(node.childNodes).forEach((child) => {
                const sanitizedChild = sanitizeNode(child);
                if (sanitizedChild) el.appendChild(sanitizedChild);
            });

            return el;
        };

        const fragment = doc.createDocumentFragment();
        Array.from(template.content.childNodes).forEach((child) => {
            const sanitized = sanitizeNode(child);
            if (sanitized) fragment.appendChild(sanitized);
        });
        return fragment;
    }

    function postProcessRichContent(rootEl, doc = document) {
        if (!rootEl) return;
        rootEl.querySelectorAll('table').forEach((table) => {
            const parent = table.parentElement;
            if (parent && parent.classList.contains('table-wrap')) return;
            const wrap = doc.createElement('div');
            wrap.className = 'table-wrap';
            table.replaceWith(wrap);
            wrap.appendChild(table);
        });
    }

    function buildMessageElement(message, options = {}) {
        const doc = options.document || document;
        const formatRoleLabel =
            typeof options.formatRoleLabel === 'function'
                ? options.formatRoleLabel
                : (role) => String(role || 'System');
        const normalizeInlineText =
            typeof options.normalizeInlineText === 'function'
                ? options.normalizeInlineText
                : (value) =>
                      String(value || '')
                          .replace(/\s+/g, ' ')
                          .trim();

        const roleKey = String(message.role || message.llm || 'system')
            .trim()
            .toLowerCase();
        const container = doc.createElement('div');
        container.className = `message ${roleKey || 'system'}`;
        container.dataset.provider = roleKey || 'system';
        if (roleKey && roleKey !== 'user' && roleKey !== 'system') {
            container.classList.add('assistant');
        }

        const meta = doc.createElement('div');
        meta.className = 'message-meta';

        const role = doc.createElement('span');
        role.className = 'message-role';
        role.textContent = formatRoleLabel(message.role || message.llm || 'system');

        const label = doc.createElement('span');
        label.className = 'message-label';
        const agent = normalizeInlineText(message.agentLabel || '');
        const round = message.roundIndex ? `Round ${message.roundIndex}` : null;
        const turn = message.turnIndex ? `Turn ${message.turnIndex}` : null;
        label.textContent = [agent || null, round, turn].filter(Boolean).join(' | ');

        meta.appendChild(role);
        meta.appendChild(label);

        const content = doc.createElement('div');
        content.className = 'message-content';
        const richHtml = typeof message.contentHtml === 'string' ? message.contentHtml : '';
        if (richHtml && richHtml.trim()) {
            container.classList.add('rich');
            content.classList.add('rich');
            content.replaceChildren(sanitizeRichHtmlToFragment(richHtml, doc));
            postProcessRichContent(content, doc);
        } else {
            content.textContent = message.content || '';
        }

        container.appendChild(meta);
        container.appendChild(content);
        return container;
    }

    globalScope.MLCTranscriptView = {
        isSafeLinkHref,
        sanitizeRichHtmlToFragment,
        postProcessRichContent,
        buildMessageElement,
    };
})(typeof self !== 'undefined' ? self : window);
