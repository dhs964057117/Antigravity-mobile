// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalList = document.getElementById('modalList');
const modalTitle = document.getElementById('modalTitle');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

// New elements for event listeners
const enableHttpsBtn = document.getElementById('enableHttpsBtn');
const dismissSslBtn = document.querySelector('.dismiss-btn');
const closeModalBtn = document.getElementById('closeModalBtn');
const supportBtn = document.getElementById('supportBtn');
const supportOverlay = document.getElementById('supportOverlay');
const closeSupportBtn = document.getElementById('closeSupportBtn');
const backHistoryBtn = document.querySelector('.history-header .icon-btn');
const quickActionChips = document.querySelectorAll('.action-chip');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0; // Timestamp until which we respect user scroll
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true; // Track if a chat is currently open


// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    // Add ngrok skip warning header to all requests
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            return new Promise(() => { }); // Halt execution
        }
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 3000; // 3 seconds of scroll protection

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        // Mode Sync (Turbo/Default/Request Review/Fast/Planning) - Desktop is source of truth
        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Turbo' || data.mode === 'Planning');
            currentMode = data.mode;
        }

        // Model Sync - Desktop is source of truth
        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }

        console.log('[SYNC] State refreshed from Desktop:', data);
    } catch (e) { console.error('[SYNC] Failed to sync state', e); }
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    // Only show banner if currently on HTTP
    if (window.location.protocol === 'https:') return;

    // Check if user dismissed the banner before
    if (localStorage.getItem('sslBannerDismissed')) return;

    sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            sslBanner.innerHTML = `
                <span>✅ ${data.message}</span>
                <button id="sslReloadBtn">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
            
            // Add listener to the newly created button
            const reloadBtn = document.getElementById('sslReloadBtn');
            if (reloadBtn) reloadBtn.addEventListener('click', () => location.reload());
        } else {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Error - Retry';
        btn.disabled = false;
    }
}

function dismissSslBanner() {
    sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

// Check SSL on load
checkSslStatus();
// --- Models ---
const MODELS = [
    "Gemini 3.8 Flash High",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B (Medium)",
    "Gemini 3.1 Pro (High)",
    "Gemini 3 Flash"
];

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        loadSnapshot();
    };

    let snapshotDebounce = null;
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'error' && data.message === 'Unauthorized') {
            window.location.href = '/login.html';
            return;
        }
        if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
            if (snapshotDebounce) clearTimeout(snapshotDebounce);
            snapshotDebounce = setTimeout(() => {
                loadSnapshot(false);
            }, 80);
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
}

// --- High-Performance DOM Morphing (Zero-flicker reconciliation) ---
function morphDOM(oldRoot, newRoot) {
    // 1. Attribute syncing
    const oldAttrs = oldRoot.attributes;
    const newAttrs = newRoot.attributes;

    if (oldAttrs && newAttrs) {
        for (let i = oldAttrs.length - 1; i >= 0; i--) {
            const name = oldAttrs[i].name;
            if (!newRoot.hasAttribute(name) && !name.startsWith('data-client-')) {
                oldRoot.removeAttribute(name);
            }
        }
        for (let i = 0; i < newAttrs.length; i++) {
            const name = newAttrs[i].name;
            const val = newAttrs[i].value;
            if (oldRoot.getAttribute(name) !== val) {
                oldRoot.setAttribute(name, val);
            }
        }
    }

    // 2. Children syncing (preserving client-injected copy buttons)
    const oldChildren = Array.from(oldRoot.childNodes).filter(
        n => !(n.nodeType === Node.ELEMENT_NODE && n.classList.contains('mobile-copy-btn'))
    );
    const newChildren = Array.from(newRoot.childNodes);

    const oldLen = oldChildren.length;
    const newLen = newChildren.length;
    const maxLen = Math.max(oldLen, newLen);

    for (let i = 0; i < maxLen; i++) {
        const oldChild = oldChildren[i];
        const newChild = newChildren[i];

        if (!oldChild && newChild) {
            oldRoot.appendChild(newChild.cloneNode(true));
        } else if (oldChild && !newChild) {
            if (oldChild.parentNode === oldRoot) {
                oldRoot.removeChild(oldChild);
            }
        } else if (oldChild.nodeType === Node.TEXT_NODE && newChild.nodeType === Node.TEXT_NODE) {
            if (oldChild.nodeValue !== newChild.nodeValue) {
                oldChild.nodeValue = newChild.nodeValue;
            }
        } else if (
            oldChild.nodeType === Node.ELEMENT_NODE &&
            newChild.nodeType === Node.ELEMENT_NODE &&
            oldChild.tagName === newChild.tagName
        ) {
            morphDOM(oldChild, newChild);
        } else {
            if (oldChild.parentNode === oldRoot) {
                oldRoot.replaceChild(newChild.cloneNode(true), oldChild);
            }
        }
    }
}

// --- Rendering ---
async function loadSnapshot(isManual = false) {
    try {
        if (isManual) {
            const icon = refreshBtn.querySelector('svg');
            if (icon) {
                icon.classList.remove('spin-anim');
                void icon.offsetWidth; // trigger reflow
                icon.classList.add('spin-anim');
            }
        }

        const response = await fetchWithAuth('/snapshot');
        if (!response.ok) {
            if (response.status === 503) {
                // No snapshot available - likely no chat open
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        // Mark chat as open since we got a valid snapshot
        chatIsOpen = true;

        const data = await response.json();

        // Capture scroll state BEFORE updating content
        const scrollPos = chatContainer.scrollTop;
        const scrollHeight = chatContainer.scrollHeight;
        const clientHeight = chatContainer.clientHeight;
        const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
        const isUserScrollLocked = Date.now() < userScrollLockUntil;

        // --- UPDATE STATS ---
        if (data.stats) {
            const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
            const nodes = data.stats.nodes;
            const statsText = document.getElementById('statsText');
            if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
        }

        // --- CSS INJECTION (Cached) ---
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        const darkModeOverrides = `/* --- BASE SNAPSHOT CSS --- */
${data.css}

/* --- FORCE DARK MODE & HIGH-CONTRAST OVERRIDES --- */
:root, body, #chatContent, #conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"] {
    --bg-app: #090e17 !important;
    --text-main: #f8fafc !important;
    --text-muted: #94a3b8 !important;
    --border-color: #334155 !important;
    --background: #090e17 !important;
    --foreground: #f8fafc !important;
    --card: #131c2f !important;
    --card-foreground: #f8fafc !important;
    --card-border: #1e293b !important;
    --secondary: #1e293b !important;
    --secondary-foreground: #e2e8f0 !important;
    --muted: #131c2f !important;
    --muted-foreground: #94a3b8 !important;
    --border: rgba(255, 255, 255, 0.12) !important;
    --primary: #6366f1 !important;
    --primary-foreground: #ffffff !important;
    --accent: #6366f1 !important;
    --accent-foreground: #ffffff !important;
    --popover: #131c2f !important;
    --popover-foreground: #f8fafc !important;
    --max-conversation-width: 100% !important;
    color: #f8fafc !important;
}

/* Prevent 0px collapse from container queries & flex parents */
#conversation,
.antigravity-snapshot-root,
[data-testid="autoscroll-viewport"],
#chatContent,
#conversation * {
    container-type: normal !important;
}

#conversation,
.antigravity-snapshot-root,
[data-testid="autoscroll-viewport"] {
    background-color: transparent !important;
    color: #f8fafc !important;
    font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
    position: relative !important;
    height: auto !important;
    min-height: 100% !important;
    max-height: none !important;
    width: 100% !important;
    max-width: 100% !important;
    overflow: visible !important;
    display: block !important;
    padding-right: 0px !important;
}

#conversation > div,
.antigravity-snapshot-root > div {
    max-width: 100% !important;
    width: 100% !important;
    height: auto !important;
    min-height: 100% !important;
    overflow: visible !important;
    position: static !important;
}

/* Force high contrast text on all elements */
#conversation p,
#conversation h1, #conversation h2, #conversation h3, #conversation h4, #conversation h5,
#conversation li, #conversation td, #conversation th,
#conversation label, #conversation blockquote {
    color: #f8fafc !important;
    font-size: 15px;
    line-height: 1.6;
}

#conversation [class*="text-foreground"] {
    color: #f8fafc !important;
}

#conversation [class*="text-muted-foreground"] {
    color: #94a3b8 !important;
}

#conversation [class*="text-secondary-foreground"] {
    color: #cbd5e1 !important;
}

/* Force black / dark gray inline text to white */
[style*="color: rgb(0, 0, 0)"], [style*="color: black"],
[style*="color:#000"], [style*="color: #000"],
[style*="color: rgb(16, 16, 16)"] {
    color: #f8fafc !important;
}

#conversation a {
    color: #60a5fa !important;
    text-decoration: underline;
}

/* User Message styling (prompt sent by user) */
#conversation div[class*="bg-background"],
#conversation [class*="md-sticky-message-bleed"] {
    background: #1e293b !important;
    color: #f8fafc !important;
    border-radius: 12px !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    padding: 10px 14px !important;
    margin: 10px 0 !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2) !important;
}
#conversation div[class*="bg-background"]::after {
    display: none !important;
}

/* Assistant Message Area */
#conversation [role="article"] {
    background: transparent !important;
    color: #f8fafc !important;
    width: 100% !important;
}

/* Thought collapsible cards ("Worked for 13s", "Thinking...") */
#conversation [data-testid="worked-for-collapsible"],
#conversation button[class*="tabular-nums"],
#conversation button:has(svg):has(span) {
    background: rgba(255, 255, 255, 0.07) !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    border-radius: 8px !important;
    color: #f8fafc !important;
    padding: 8px 12px !important;
    margin: 6px 0 !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    cursor: pointer !important;
    font-size: 13px !important;
}
#conversation [data-testid="worked-for-collapsible"]:hover,
#conversation [data-testid="worked-for-collapsible"]:active {
    background: rgba(255, 255, 255, 0.14) !important;
}
#conversation [data-testid="worked-for-collapsible"] span,
#conversation button[class*="tabular-nums"] span {
    color: #cbd5e1 !important;
    font-weight: 500 !important;
}
#conversation [data-testid="worked-for-collapsible"] svg {
    color: #94a3b8 !important;
}

/* Action and Control buttons inside conversation */
#conversation button,
#conversation [role="button"] {
    color: #f8fafc !important;
    background: rgba(255, 255, 255, 0.08) !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    border-radius: 6px !important;
    padding: 6px 12px !important;
}
#conversation button:hover,
#conversation [role="button"]:hover {
    background: rgba(255, 255, 255, 0.15) !important;
}
#conversation button svg,
#conversation [role="button"] svg {
    color: #e2e8f0 !important;
    stroke: currentColor !important;
}

/* Action bar buttons: Allow, Confirm, Run, Deny */
#conversation button:where([class*="allow"], [class*="confirm"], [class*="run"]) {
    background: #2563eb !important;
    color: #ffffff !important;
    border: 1px solid #3b82f6 !important;
    font-weight: 600 !important;
}
#conversation button:where([class*="deny"], [class*="reject"]) {
    background: #dc2626 !important;
    color: #ffffff !important;
    border: 1px solid #ef4444 !important;
    font-weight: 600 !important;
}

/* Preserve absolute positioning needed for dropdowns, tooltips, popups */
[style*="position: absolute"], [style*="position: fixed"],
[data-headlessui-state], [id*="headlessui"] {
    position: absolute !important;
}

/* Hide broken local file icons */
img[src^="/c:"], img[src^="/C:"], img[src*="AppData"] {
    display: none !important;
}

img, svg {
    display: inline !important;
    vertical-align: middle !important;
}

/* Inline flex items like file mentions */
[class*="inline-flex"], [class*="inline-block"], [class*="items-center"]:has(img) {
    display: inline-flex !important;
    vertical-align: middle !important;
}

/* Code blocks */
:not(pre) > code {
    padding: 2px 6px !important;
    border-radius: 4px !important;
    background-color: rgba(255, 255, 255, 0.12) !important;
    color: #93c5fd !important;
    font-size: 0.88em !important;
    line-height: 1.2 !important;
    white-space: normal !important;
}

pre, code, .monaco-editor-background, [class*="terminal"] {
    background-color: #111827 !important;
    color: #e2e8f0 !important;
    font-family: 'JetBrains Mono', Consolas, monospace !important;
    border-radius: 6px;
    border: 1px solid #1f2937;
}

pre {
    position: relative !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
    padding: 8px 10px !important;
    margin: 6px 0 !important;
    display: block !important;
    width: 100% !important;
}

pre.has-copy-btn {
    padding-right: 32px !important;
}

pre.single-line-pre {
    display: inline-block !important;
    width: auto !important;
    max-width: 100% !important;
    padding: 2px 6px !important;
    margin: 0px !important;
    vertical-align: middle !important;
    background-color: #111827 !important;
    font-size: 0.88em !important;
}

pre.single-line-pre > code {
    display: inline !important;
    white-space: nowrap !important;
}

pre:not(.single-line-pre) > code {
    display: block !important;
    width: 100% !important;
    overflow-x: auto !important;
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
}

.mobile-copy-btn {
    position: absolute !important;
    top: 4px !important;
    right: 4px !important;
    background: rgba(30, 41, 59, 0.8) !important;
    color: #94a3b8 !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    width: 26px !important;
    height: 26px !important;
    padding: 0 !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 4px !important;
    z-index: 10 !important;
}

blockquote {
    border-left: 3px solid #3b82f6 !important;
    background: rgba(59, 130, 246, 0.1) !important;
    color: #cbd5e1 !important;
    padding: 8px 12px !important;
    margin: 8px 0 !important;
    border-radius: 0 6px 6px 0 !important;
}

table {
    border-collapse: collapse !important;
    width: 100% !important;
    border: 1px solid #334155 !important;
    margin: 8px 0 !important;
}
th, td {
    border: 1px solid #334155 !important;
    padding: 8px !important;
    color: #e2e8f0 !important;
}

::-webkit-scrollbar {
    width: 0 !important;
}

[style*="background-color: rgb(255, 255, 255)"],
[style*="background-color: white"],
[style*="background: white"] {
    background-color: transparent !important;
}`;
        if (styleTag.dataset.rawCss !== data.css) {
            styleTag.dataset.rawCss = data.css;
            styleTag.textContent = darkModeOverrides;
        }

        const wasEmpty = !chatContent.firstElementChild || 
                         chatContent.querySelector('.empty-state') || 
                         chatContent.querySelector('.loading-state');

        if (wasEmpty) {
            chatContent.innerHTML = data.html;
        } else {
            const temp = document.createElement('div');
            temp.innerHTML = data.html;
            morphDOM(chatContent, temp);
        }

        // Add mobile copy buttons to all code blocks
        addMobileCopyButtons();

        // Smart scroll behavior: prevent stuttering / flicker
        const newScrollHeight = chatContainer.scrollHeight;
        if (isUserScrollLocked) {
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            chatContainer.scrollTop = newScrollHeight * scrollPercent;
        } else if (isNearBottom || scrollPos === 0) {
            // Only auto-scroll down if content actually grew
            if (newScrollHeight > scrollHeight || scrollPos === 0) {
                chatContainer.scrollTop = newScrollHeight;
            }
        } else {
            // Preserve exact scroll position
            chatContainer.scrollTop = scrollPos;
        }

    } catch (err) {
        console.error(err);
    }
}

// --- Mobile Code Block Copy Functionality ---
function addMobileCopyButtons() {
    // Find all pre elements (code blocks) in the chat
    const codeBlocks = chatContent.querySelectorAll('pre');

    codeBlocks.forEach((pre, index) => {
        // Skip if already has our button
        if (pre.querySelector('.mobile-copy-btn')) return;

        // Get the code text
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();

        // Check if there's a newline character in the TRIMMED text
        // This ensures single-line blocks with trailing newlines don't get buttons
        const hasNewline = /\n/.test(textToCopy);

        // If it's a single line code block, don't add the copy button
        if (!hasNewline) {
            pre.classList.remove('has-copy-btn');
            pre.classList.add('single-line-pre');
            return;
        }

        // Add class for padding
        pre.classList.remove('single-line-pre');
        pre.classList.add('has-copy-btn');

        // Create the copy button (icon only)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('data-code-index', index);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            `;

        // Add click handler for copy
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const success = await copyToClipboard(textToCopy);

            if (success) {
                // Visual feedback - show checkmark
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            `;

                // Reset after 2 seconds
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            } else {
                // Show X icon briefly on error
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
            `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            }
        });

        // Insert button into pre element
        pre.appendChild(copyBtn);
    });
}

// --- Cross-platform Clipboard Copy ---
async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API (works on HTTPS or localhost)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[COPY] Success via Clipboard API');
            return true;
        } catch (err) {
            console.warn('[COPY] Clipboard API failed:', err);
        }
    }

    // Method 2: Fallback using execCommand (works on HTTP, older browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;

        // Avoid scrolling to bottom on iOS
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);

        // iOS specific handling
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            const range = document.createRange();
            range.selectNodeContents(textArea);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            textArea.setSelectionRange(0, text.length);
        } else {
            textArea.select();
        }

        const success = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (success) {
            console.log('[COPY] Success via execCommand fallback');
            return true;
        }
    } catch (err) {
        console.warn('[COPY] execCommand fallback failed:', err);
    }

    // Method 3: For Android WebView or restricted contexts
    // Show the text in a selectable modal if all else fails
    console.error('[COPY] All copy methods failed');
    return false;
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// --- Inputs ---
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    // Optimistic UI updates
    const previousValue = messageInput.value;
    messageInput.value = ''; // Clear immediately
    messageInput.style.height = 'auto'; // Reset height
    messageInput.blur(); // Close keyboard on mobile immediately

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        // If no chat is open, start a new one first
        if (!chatIsOpen) {
            const newChatRes = await fetchWithAuth('/new-chat', { method: 'POST' });
            const newChatData = await newChatRes.json();
            if (newChatData.success) {
                // Wait for the new chat to be ready
                await new Promise(r => setTimeout(r, 800));
                chatIsOpen = true;
            }
        }

        const res = await fetchWithAuth('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        // Always reload snapshot to check if message appeared
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 800);
        setTimeout(checkChatStatus, 1000);

        // Don't revert the input - if user sees the message in chat, it was sent
        // Only log errors for debugging, don't show alert popups
        if (!res.ok) {
            console.warn('Send response not ok, but message may have been sent:', await res.json().catch(() => ({})));
        }
    } catch (e) {
        // Network error - still try to refresh in case it went through
        console.error('Send error:', e);
        setTimeout(loadSnapshot, 500);
    } finally {
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
    }
}

// --- Event Listeners ---
sendBtn.addEventListener('click', sendMessage);

refreshBtn.addEventListener('click', () => {
    // Refresh both Chat and State (Mode/Model)
    loadSnapshot(true);
    fetchAppState(); // PRIORITY: Sync from Desktop
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// --- Support Modal Logic ---
if (supportBtn) {
    supportBtn.addEventListener('click', () => {
        if (supportOverlay) {
            supportOverlay.classList.add('show');
        }
    });
}

if (closeSupportBtn) {
    closeSupportBtn.addEventListener('click', () => {
        if (supportOverlay) {
            supportOverlay.classList.remove('show');
        }
    });
}

if (supportOverlay) {
    supportOverlay.addEventListener('click', (e) => {
        if (e.target === supportOverlay) {
            supportOverlay.classList.remove('show');
        }
    });
}

// --- Scroll Sync to Desktop ---
let scrollSyncTimeout = null;
let lastScrollSync = 0;
const SCROLL_SYNC_DEBOUNCE = 150; // ms between scroll syncs
let snapshotReloadPending = false;

async function syncScrollToDesktop() {
    const scrollPercent = chatContainer.scrollTop / (chatContainer.scrollHeight - chatContainer.clientHeight);
    try {
        await fetchWithAuth('/remote-scroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scrollPercent })
        });

        // After scrolling desktop, reload snapshot to get newly visible content
        // (Antigravity uses virtualized scrolling - only visible messages are in DOM)
        if (!snapshotReloadPending) {
            snapshotReloadPending = true;
            setTimeout(() => {
                loadSnapshot();
                snapshotReloadPending = false;
            }, 300);
        }
    } catch (e) {
        console.log('Scroll sync failed:', e.message);
    }
}

chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    // Set a lock to prevent auto-scroll jumping for a few seconds
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        // If user scrolled to bottom, clear the lock so auto-scroll works
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    // Debounced scroll sync to desktop
    const now = Date.now();
    if (now - lastScrollSync > SCROLL_SYNC_DEBOUNCE) {
        lastScrollSync = now;
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(syncScrollToDesktop, 100);
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
        autoRefreshEnabled = true;
    }, 5000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0; // Clear lock so auto-scroll works again
    scrollToBottom();
});

// --- Quick Actions ---
function quickAction(text) {
    messageInput.value = text;
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    messageInput.focus();
}

// --- Stop Logic ---
stopBtn.addEventListener('click', async () => {
    stopBtn.style.opacity = '0.5';
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // alert('Stopped');
        } else {
            // alert('Error: ' + data.error);
        }
    } catch (e) { }
    setTimeout(() => stopBtn.style.opacity = '1', 500);
});

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            // Reload snapshot to show new empty chat
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1000);
            setTimeout(checkChatStatus, 1500);
        } else {
            console.error('Failed to start new chat:', data.error);
        }
    } catch (e) {
        console.error('New chat error:', e);
    }

    setTimeout(() => {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
    }, 500);
}

newChatBtn.addEventListener('click', startNewChat);

// --- Chat History Logic ---
async function showChatHistory() {
    const historyLayer = document.getElementById('historyLayer');
    const historyList = document.getElementById('historyList');

    // Show loading state
    historyList.innerHTML = `
        <div class="history-state-container">
            <div class="history-spinner"></div>
            <div class="history-state-text">Loading History...</div>
        </div>
    `;
    historyLayer.classList.add('show');
    historyBtn.style.opacity = '1';

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();

        if (data.error) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon">⚠️</div>
                    <div class="history-state-title">Error loading history</div>
                    <div class="history-state-desc">${data.error}</div>
                    <button class="history-new-btn mt-4">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `;
            return;
        }

        const chats = data.chats || [];
        if (chats.length === 0) {
            historyList.innerHTML = `
                <div class="history-state-container">
                    <div class="history-state-icon">📝</div>
                    <div class="history-state-title">No recent chats found</div>
                    <div class="history-state-desc">Start a new conversation to see them here.</div>
                    <button class="history-new-btn mt-4">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Start New Conversation
                    </button>
                </div>
            `;
            return;
        }

        // Partition chats into groups matching desktop Antigravity
        const pinnedChats = [];
        const projectChatsMap = new Map(); // workspaceName -> [chats]
        const conversationChats = [];

        chats.forEach(chat => {
            if (chat.isPinned || chat.group === 'Pinned') {
                pinnedChats.push(chat);
            } else if (chat.group === 'Projects' || (chat.workspace && chat.workspace.trim().length > 0)) {
                const ws = chat.workspace ? chat.workspace.trim() : 'Project';
                if (!projectChatsMap.has(ws)) {
                    projectChatsMap.set(ws, []);
                }
                projectChatsMap.get(ws).push(chat);
            } else {
                conversationChats.push(chat);
            }
        });

        const renderCard = (chat) => {
            const safeTitle = chat.title.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            const safeWorkspace = (chat.workspace || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            return `
                <div class="history-card ${chat.isActive ? 'active' : ''}" data-title="${safeTitle}" data-workspace="${safeWorkspace}">
                    <div class="history-card-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </div>
                    <div class="history-card-content">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="history-card-title">${escapeHtml(chat.title)}</span>
                            ${chat.isActive ? '<span class="history-active-badge">当前</span>' : ''}
                        </div>
                        ${chat.workspace ? `<span class="history-card-workspace">📁 ${escapeHtml(chat.workspace)}</span>` : ''}
                    </div>
                    ${chat.timestamp ? `<span class="history-card-time">${escapeHtml(chat.timestamp)}</span>` : ''}
                    <div class="history-card-arrow">
                        <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                </div>
            `;
        };

        // Render chats
        let html = `
            <div class="history-action-container">
                <button class="history-new-btn">
                    <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    New Conversation
                </button>
            </div>
            <div class="history-search-bar">
                <div class="history-search-icon">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                </div>
                <input type="text" class="history-search-input" id="historySearchInput" placeholder="Search conversations (${chats.length})...">
            </div>
            <div class="history-list-group" id="historyListGroup">
        `;

        // 1. PINNED SECTION
        if (pinnedChats.length > 0) {
            html += `
                <div class="history-section" data-section="pinned">
                    <div class="history-section-header">
                        <span class="history-section-title">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="17" x2="12" y2="22"></line>
                                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
                            </svg>
                            Pinned
                        </span>
                        <span class="history-section-count">${pinnedChats.length}</span>
                    </div>
                    <div class="history-section-items" style="display:flex; flex-direction:column; gap:8px;">
                        ${pinnedChats.map(renderCard).join('')}
                    </div>
                </div>
            `;
        }

        // 2. PROJECTS SECTION (Grouped by workspace folders)
        if (projectChatsMap.size > 0) {
            let totalProjectChats = 0;
            projectChatsMap.forEach(arr => totalProjectChats += arr.length);

            html += `
                <div class="history-section" data-section="projects">
                    <div class="history-section-header">
                        <span class="history-section-title">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                            Projects
                        </span>
                        <span class="history-section-count">${totalProjectChats}</span>
                    </div>
            `;

            // Sort projects: project with active chat first, then alphabetical
            const sortedProjects = Array.from(projectChatsMap.entries()).sort((a, b) => {
                const aHasActive = a[1].some(c => c.isActive);
                const bHasActive = b[1].some(c => c.isActive);
                if (aHasActive && !bHasActive) return -1;
                if (!aHasActive && bHasActive) return 1;
                return a[0].localeCompare(b[0]);
            });

            for (const [workspaceName, pChats] of sortedProjects) {
                html += `
                    <div class="history-project-group" data-project="${escapeHtml(workspaceName)}">
                        <div class="history-project-header">
                            <div class="history-project-title-wrapper">
                                <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                                </svg>
                                <span>${escapeHtml(workspaceName)}</span>
                            </div>
                            <div class="history-project-meta">
                                <span class="history-project-badge">${pChats.length}</span>
                                <div class="history-project-toggle">
                                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                                        <polyline points="6 9 12 15 18 9"></polyline>
                                    </svg>
                                </div>
                            </div>
                        </div>
                        <div class="history-project-items">
                            ${pChats.map(renderCard).join('')}
                        </div>
                    </div>
                `;
            }

            html += `</div>`;
        }

        // 3. CONVERSATIONS SECTION (General / Standalone)
        if (conversationChats.length > 0) {
            html += `
                <div class="history-section" data-section="conversations">
                    <div class="history-section-header">
                        <span class="history-section-title">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                            </svg>
                            Conversations
                        </span>
                        <span class="history-section-count">${conversationChats.length}</span>
                    </div>
                    <div class="history-section-items" style="display:flex; flex-direction:column; gap:8px;">
                        ${conversationChats.map(renderCard).join('')}
                    </div>
                </div>
            `;
        }

        html += `<div class="history-empty-search" id="historyEmptySearch" style="display:none;">No matching conversations found</div>`;
        html += `</div>`;

        historyList.innerHTML = html;

        // Add client-side instant search filter
        const searchInput = document.getElementById('historySearchInput');
        const emptyNotice = document.getElementById('historyEmptySearch');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const query = e.target.value.trim().toLowerCase();
                let totalVisible = 0;

                const cards = document.querySelectorAll('.history-card');
                cards.forEach(card => {
                    const titleText = (card.getAttribute('data-title') || '').toLowerCase();
                    const wsText = (card.getAttribute('data-workspace') || '').toLowerCase();
                    const matches = titleText.includes(query) || wsText.includes(query);
                    card.style.display = matches ? 'flex' : 'none';
                    if (matches) totalVisible++;
                });

                // Update project groups visibility
                const projectGroups = document.querySelectorAll('.history-project-group');
                projectGroups.forEach(group => {
                    const visibleInGroup = group.querySelectorAll('.history-card:not([style*="display: none"])').length;
                    group.style.display = visibleInGroup > 0 ? 'flex' : 'none';
                    if (query.length > 0 && visibleInGroup > 0) {
                        group.classList.remove('collapsed');
                    }
                });

                // Update section headers visibility
                const sections = document.querySelectorAll('.history-section');
                sections.forEach(sec => {
                    const visibleInSec = sec.querySelectorAll('.history-card:not([style*="display: none"])').length;
                    sec.style.display = visibleInSec > 0 ? 'flex' : 'none';
                });

                if (emptyNotice) {
                    emptyNotice.style.display = (totalVisible === 0 && query.length > 0) ? 'block' : 'none';
                }
            });
        }

    } catch (e) {
        historyList.innerHTML = `
            <div class="history-state-container">
                <div class="history-state-icon">🔌</div>
                <div class="history-state-title">Connection Error</div>
                <div class="history-state-desc">Failed to reach the server.</div>
            </div>
        `;
    }
}


function hideChatHistory() {
    historyLayer.classList.remove('show');
}

historyBtn.addEventListener('click', showChatHistory);

// --- Select Chat from History ---
async function selectChat(title) {
    if (!title) return;
    
    // Visual reset while desktop switches conversation
    chatContent.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <p style="font-size:16px; font-weight:600; margin-top:12px; color:var(--text-main);">正在切换会话...</p>
            <p style="font-size:13px; color:var(--text-muted); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:4px;">${escapeHtml(title)}</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        const data = await res.json();

        if (data.success) {
            // Rapid polling to catch desktop navigation and render
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(loadSnapshot, 1600);
            setTimeout(loadSnapshot, 3000);
        } else {
            console.error('Failed to select chat:', data.error);
            alert(`切换会话失败: ${data.error || '未能定位到该会话'}`);
            loadSnapshot();
        }
    } catch (e) {
        console.error('Select chat error:', e);
        alert('切换会话请求失败，请检查网络连接');
        loadSnapshot();
    }
}

// --- Check Chat Status ---
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();

        chatIsOpen = data.hasChat || data.editorFound;

        if (!chatIsOpen) {
            showEmptyState();
        }
    } catch (e) {
        console.error('Chat status check failed:', e);
    }
}

// --- Empty State (No Chat Open) ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                <line x1="9" y1="10" x2="15" y2="10"></line>
            </svg>
            <h2>No Chat Open</h2>
            <p>Start a new conversation or select one from your history to begin chatting.</p>
            <button class="empty-state-btn" id="newChatFromEmptyBtn">
                Start New Conversation
            </button>
        </div>
    `;
}

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Settings Logic ---


function openModal(title, options, onSelect) {
    modalTitle.textContent = title;
    modalList.innerHTML = '';
    options.forEach(opt => {
        const div = document.createElement('div');
        div.className = 'modal-option';
        div.textContent = opt;
        div.addEventListener('click', () => {
            onSelect(opt);
            closeModal();
        });
        modalList.appendChild(div);
    });
    modalOverlay.classList.add('show');
}

function closeModal() {
    modalOverlay.classList.remove('show');
}

modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
};

modeBtn.addEventListener('click', () => {
    openModal('Select Mode', ['Turbo', 'Default', 'Request Review', 'Fast', 'Planning'], async (mode) => {
        modeText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode })
            });
            const data = await res.json();
            if (data.success) {
                currentMode = mode;
                modeText.textContent = mode;
                modeBtn.classList.toggle('active', mode === 'Turbo' || mode === 'Planning');
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modeText.textContent = currentMode;
            }
        } catch (e) {
            modeText.textContent = currentMode;
        }
    });
});

modelBtn.addEventListener('click', () => {
    openModal('Select Model', MODELS, async (model) => {
        const prev = modelText.textContent;
        modelText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model })
            });
            const data = await res.json();
            if (data.success) {
                modelText.textContent = model;
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modelText.textContent = prev;
            }
        } catch (e) {
            modelText.textContent = prev;
        }
    });
});

// --- Viewport / Keyboard Handling ---
// This fixes the issue where the keyboard hides the input or layout breaks
if (window.visualViewport) {
    function handleResize() {
        // Resize the body to match the visual viewport (screen minus keyboard)
        document.body.style.height = window.visualViewport.height + 'px';

        // Scroll to bottom if keyboard opened
        if (document.activeElement === messageInput) {
            setTimeout(scrollToBottom, 100);
        }
    }

    window.visualViewport.addEventListener('resize', handleResize);
    window.visualViewport.addEventListener('scroll', handleResize);
    handleResize(); // Init
} else {
    // Fallback for older browsers without visualViewport support
    window.addEventListener('resize', () => {
        document.body.style.height = window.innerHeight + 'px';
    });
    document.body.style.height = window.innerHeight + 'px'; // Init
}

// --- Remote Click Logic (Thinking/Thought) ---
chatContainer.addEventListener('click', async (e) => {
    // Strategy: Check if the clicked element OR its parent contains "Thought" or "Thinking" text.
    // This handles both opening (collapsed) and closing (expanded) states.

    // 1. Find the nearest container that might be the "Thought" block
    const target = e.target.closest('div, span, p, summary, button, details');
    if (!target) return;

    const text = target.innerText || '';

    // Check if this looks like a clickable UI toggle from Antigravity/Cascade
    // Includes: Thought blocks, Worked status, Edited files status, and File lists
    const isUiToggle = /Thought|Thinking|Worked for|Edited|\d+\s+file/i.test(text) && text.length < 500;

    if (isUiToggle) {
        // Visual feedback - briefly dim the clicked element
        target.style.opacity = '0.5';
        setTimeout(() => target.style.opacity = '1', 300);

        // Extract just the first line for matching
        const firstLine = text.split('\n')[0].trim();

        // Determine which occurrence of this text the user tapped
        // This handles multiple Thought blocks with identical labels
        const allElements = chatContainer.querySelectorAll(target.tagName.toLowerCase());
        let tapIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const elText = el.innerText || '';
            const elFirstLine = elText.split('\n')[0].trim();

            // Only count if it looks like a UI toggle and matches the first line exactly
            if (/Thought|Thinking|Worked for|Edited|\d+\s+file/i.test(elText) && elText.length < 500 && elFirstLine === firstLine) {
                // If this is our target (or contains it), we've found the correct index
                if (el === target || el.contains(target)) {
                    break;
                }
                tapIndex++;
            }
        }

        try {
            const response = await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: target.tagName.toLowerCase(),
                    index: tapIndex,
                    textContent: firstLine  // Use first line for more reliable matching
                })
            });

            // Reload snapshot multiple times to catch the UI change
            // Desktop animation takes time, so we poll a few times
            setTimeout(loadSnapshot, 400);   // Quick check
            setTimeout(loadSnapshot, 800);   // After animation starts
            setTimeout(loadSnapshot, 1500);  // After animation completes
        } catch (e) {
            console.error('Remote click failed:', e);
        }
        return;
    }

    // --- Command Action Buttons (Run, Reject, Allow, Deny, etc.) ---
    const btn = e.target.closest('button, [role="button"]');
    if (btn) {
        const btnText = (btn.innerText || '').trim();

        // Match various action keywords
        const actionKeywords = [
            'Allow this conversation', 'Always allow', 'Allow once',
            'Review changes', 'Review',
            'Confirm', 'Accept', 'Reject', 'Discard',
            'Allow', 'Deny', 'Apply', 'Save', 'Run',
            'Yes', 'No'
        ];

        const btnTextLower = btnText.toLowerCase();
        const matchedKeyword = actionKeywords.find(kw =>
            btnTextLower.includes(kw.toLowerCase())
        );
        if (matchedKeyword) {
            btn.style.opacity = '0.5';
            setTimeout(() => btn.style.opacity = '1', 300);

            // Determine which occurrence of this button text the user tapped
            const allButtons = Array.from(chatContainer.querySelectorAll('button, [role="button"]'));

            // Filter to only those that match our specific keyword
            const matchingButtons = allButtons.filter(b =>
                (b.innerText || '').toLowerCase().includes(matchedKeyword.toLowerCase())
            );
            const btnIndex = matchingButtons.indexOf(btn);

            try {
                await fetchWithAuth('/remote-click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selector: btn.tagName.toLowerCase() === 'button' ? 'button' : '[role="button"]',
                        index: btnIndex >= 0 ? btnIndex : 0,
                        textContent: matchedKeyword
                    })
                });

                // Rapidly poll for updates as actions usually trigger DOM changes
                setTimeout(loadSnapshot, 400);
                setTimeout(loadSnapshot, 1000);
                setTimeout(loadSnapshot, 2500);
            } catch (err) {
                console.error('Remote button click failed:', err);
            }
        }
    }
});

// --- Initial Event Listeners (Refactored from inline) ---
if (enableHttpsBtn) enableHttpsBtn.addEventListener('click', enableHttps);
if (dismissSslBtn) dismissSslBtn.addEventListener('click', dismissSslBanner);
if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
if (backHistoryBtn) backHistoryBtn.addEventListener('click', hideChatHistory);

quickActionChips.forEach(chip => {
    chip.addEventListener('click', () => {
        const actionText = chip.getAttribute('data-action') || chip.innerText.trim();
        // Handle specific cases if needed, otherwise just pass the text
        if (actionText.includes('Explain')) {
            quickAction('Explain this code in detailed and elaborate manner.');
        } else if (actionText.includes('Fix')) {
            quickAction('Please fix the bugs in this code...');
        } else if (actionText.includes('Create')) {
            quickAction('Please create or update documentation for this code.');
        } else {
            quickAction(actionText);
        }
    });
});

// Delegation for dynamic history items
if (historyList) {
    historyList.addEventListener('click', (e) => {
        const projectHeader = e.target.closest('.history-project-header');
        if (projectHeader) {
            const group = projectHeader.closest('.history-project-group');
            if (group) {
                group.classList.toggle('collapsed');
            }
            return;
        }

        const newBtn = e.target.closest('.history-new-btn');
        const card = e.target.closest('.history-card');
        
        if (newBtn) {
            hideChatHistory();
            startNewChat();
        } else if (card) {
            const title = card.getAttribute('data-title');
            hideChatHistory();
            selectChat(title);
        }
    });
}

// Delegation for empty state
chatContent.addEventListener('click', (e) => {
    if (e.target.closest('#newChatFromEmptyBtn')) {
        startNewChat();
    }
});

// --- Init ---
connectWebSocket();
// Sync state initially and every 5 seconds to keep phone in sync with desktop changes
fetchAppState();
setInterval(fetchAppState, 5000);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, 10000); // Check every 10 seconds
