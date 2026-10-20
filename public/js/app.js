// ============================================================
// Antigravity Mobile & Desktop - Core Client Application
// ============================================================

// --- DOM Elements ---
const sidebar = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const sidebarConvoList = document.getElementById('sidebarConvoList');
const sidebarSearchInput = document.getElementById('sidebarSearchInput');
const sidebarSearchClear = document.getElementById('sidebarSearchClear');
const sidebarNewChatBtn = document.getElementById('sidebarNewChatBtn');
const sidebarUsageBtn = document.getElementById('sidebarUsageBtn');
const sidebarSyncBtn = document.getElementById('sidebarSyncBtn');

const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const headerSessionTitle = document.getElementById('headerSessionTitle');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const statsText = document.getElementById('statsText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');

const modeBtn = document.getElementById('modeBtn');
const modeText = document.getElementById('modeText');
const modelBtn = document.getElementById('modelBtn');
const modelText = document.getElementById('modelText');
const usageBtn = document.getElementById('usageBtn');

// Modals
const modelModalOverlay = document.getElementById('modelModalOverlay');
const closeModelModalBtn = document.getElementById('closeModelModalBtn');
const cancelModelModalBtn = document.getElementById('cancelModelModalBtn');
const modelCardsGrid = document.getElementById('modelCardsGrid');

const usageModalOverlay = document.getElementById('usageModalOverlay');
const closeUsageModalBtn = document.getElementById('closeUsageModalBtn');
const confirmUsageModalBtn = document.getElementById('confirmUsageModalBtn');
const refreshUsageBtn = document.getElementById('refreshUsageBtn');
const usageModalBody = document.getElementById('usageModalBody');

const modeModalOverlay = document.getElementById('modeModalOverlay');
const closeModeModalBtn = document.getElementById('closeModeModalBtn');
const cancelModeModalBtn = document.getElementById('cancelModeModalBtn');
const modeOptionsList = document.getElementById('modeOptionsList');

const supportOverlay = document.getElementById('supportOverlay');
const closeSupportBtn = document.getElementById('closeSupportBtn');
const enableHttpsBtn = document.getElementById('enableHttpsBtn');
const sslBanner = document.getElementById('sslBanner');
const quickActionChips = document.querySelectorAll('.action-chip');
const steerStatusBanner = document.getElementById('steerStatusBanner');
const sendBtnIcon = document.getElementById('sendBtnIcon');
const sendBtnLabel = document.getElementById('sendBtnLabel');
const inputCard = document.getElementById('inputCard');

// --- State Variables ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0;
let ws = null;
let idleTimer = null;
let currentMode = 'Turbo';
let currentModel = 'Gemini 3.8 Flash High';
let isSending = false;
let authRedirecting = false;
let isAgentBusy = false;
let rawConversations = [];
let availableModels = [];

const USER_SCROLL_LOCK_DURATION = 3000;

// --- Send Button Visual State (Codex style empty vs has-text) ---
function updateSendButtonState() {
    if (!sendBtn) return;
    const hasText = !!(messageInput && messageInput.value.trim().length > 0);
    if (hasText) {
        sendBtn.classList.add('has-text');
    } else {
        sendBtn.classList.remove('has-text');
    }
}

// --- Steer / Interjection Mode Management ---
function setSteerMode(isBusy) {
    isAgentBusy = !!isBusy;
    if (isAgentBusy) {
        if (steerStatusBanner) steerStatusBanner.style.display = 'flex';
        sendBtn.classList.add('steer-mode');
        sendBtn.title = '当前智能体正在执行，点击可直接「插话」实时干预引导';
        if (sendBtnIcon) {
            sendBtnIcon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`;
        }
        if (sendBtnLabel) sendBtnLabel.textContent = '插话';
        messageInput.placeholder = '输入插话指令... (智能体将实时介入引导)';
    } else {
        if (steerStatusBanner) steerStatusBanner.style.display = 'none';
        sendBtn.classList.remove('steer-mode');
        sendBtn.title = '发送 (Enter)';
        if (sendBtnIcon) {
            sendBtnIcon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
        }
        if (sendBtnLabel) sendBtnLabel.textContent = '';
        messageInput.placeholder = '给 Antigravity 发送消息... (Shift+Enter 换行)';
        if (inputCard) inputCard.classList.remove('steer-focused');
    }
    updateSendButtonState();
}

// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    const { timeoutMs = 15000, signal, ...requestOptions } = options;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    const headers = new Headers(requestOptions.headers);
    headers.set('ngrok-skip-browser-warning', 'true');
    headers.set('Accept', 'application/json');
    try {
        const res = await fetch(url, { ...requestOptions, headers, cache: 'no-store', signal: controller.signal });
        if (res.status === 401 || (res.redirected && new URL(res.url).pathname === '/login.html')) {
            authRedirecting = true;
            window.location.href = '/login.html';
            throw new Error('登录已过期，请重新登录');
        }
        // Include body transfer in the timeout (mobile connections can stall
        // after receiving HTTP headers). Consumers still use res.json().
        const body = await res.text();
        return new Response([204, 205, 304].includes(res.status) ? null : body, {
            status: res.status, statusText: res.statusText, headers: res.headers
        });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}

function readSession(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
}
function saveSession(key, value) {
    try {
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
    } catch { /* Storage can be unavailable in private browsing. */ }
}
let pendingSend = null;
try { pendingSend = JSON.parse(readSession('ag_pending_send')); } catch { /* Ignore old data. */ }
if (!pendingSend || typeof pendingSend.message !== 'string' || typeof pendingSend.requestId !== 'string') pendingSend = null;
const restoredDraft = readSession('ag_message_draft') || pendingSend?.message;
if (restoredDraft) messageInput.value = restoredDraft;

// --- Global Toast Notification ---
function showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast-msg toast-${type}`;

    let iconSvg = '';
    if (type === 'warning') {
        iconSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
    } else if (type === 'error') {
        iconSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else if (type === 'success') {
        iconSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else {
        iconSvg = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `
        <span class="toast-icon">${iconSvg}</span>
        <span class="toast-text">${message}</span>
        <button class="toast-close" aria-label="关闭">×</button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    const dismiss = () => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 260);
    };

    closeBtn.addEventListener('click', dismiss);
    if (duration > 0) {
        setTimeout(dismiss, duration);
    }

    container.appendChild(toast);
}

// --- Responsive Sidebar Controller ---
function isDesktop() {
    return window.innerWidth >= 768;
}

function initSidebarState() {
    if (isDesktop()) {
        let savedCollapsed = false;
        try { savedCollapsed = localStorage.getItem('ag_sidebar_collapsed') === 'true'; } catch { /* Use default layout. */ }
        if (savedCollapsed) {
            sidebar.classList.add('collapsed');
        } else {
            sidebar.classList.remove('collapsed');
        }
        sidebar.classList.remove('open');
        sidebarBackdrop.classList.remove('show');
    } else {
        sidebar.classList.remove('collapsed');
        sidebar.classList.remove('open');
        sidebarBackdrop.classList.remove('show');
    }
}

function toggleSidebar() {
    if (isDesktop()) {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        try { localStorage.setItem('ag_sidebar_collapsed', isCollapsed ? 'true' : 'false'); } catch { /* Keep this session usable. */ }
    } else {
        const isOpen = sidebar.classList.toggle('open');
        sidebarBackdrop.classList.toggle('show', isOpen);
    }
}

function closeMobileSidebar() {
    if (!isDesktop()) {
        sidebar.classList.remove('open');
        sidebarBackdrop.classList.remove('show');
    }
}

sidebarToggleBtn.addEventListener('click', toggleSidebar);
sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
sidebarBackdrop.addEventListener('click', closeMobileSidebar);

window.addEventListener('resize', () => {
    if (isDesktop() && sidebar.classList.contains('open')) {
        closeMobileSidebar();
    }
});

// --- App State & Desktop Sync ---
let appStateLoading = false;
async function fetchAppState() {
    if (appStateLoading) return;
    appStateLoading = true;
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        if (data.mode && data.mode !== 'Unknown') {
            currentMode = data.mode;
            modeText.textContent = data.mode;
        }

        if (data.model && data.model !== 'Unknown') {
            currentModel = data.model;
            modelText.textContent = data.model;
        }

        if (data.isBusy !== undefined) {
            setSteerMode(data.isBusy);
        }
    } catch (e) {
        console.warn('[SYNC] Failed to sync app state:', e.message);
    } finally {
        appStateLoading = false;
    }
}
const syncAppState = fetchAppState;

// --- WebSocket Connection ---
let reconnectTimeout = null;
let reconnectAttempt = 0;

function scheduleReconnect() {
    if (reconnectTimeout || authRedirecting || navigator.onLine === false) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5)) + Math.random() * 500;
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connectWebSocket();
    }, delay);
}

function connectWebSocket(force = false) {
    if (authRedirecting || navigator.onLine === false) return;
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (!force && ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    if (ws) { ws.dispose?.(); ws.close(); ws = null; }
    updateStatus(false);
    let socket;
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${window.location.host}`);
        ws = socket;
    } catch (error) {
        scheduleReconnect();
        return;
    }
    let connectTimer;
    let heartbeat;
    let pongTimer;
    let snapshotDebounce;
    const cleanup = () => {
        clearTimeout(connectTimer);
        clearTimeout(pongTimer);
        clearTimeout(snapshotDebounce);
        clearInterval(heartbeat);
    };
    socket.dispose = cleanup;
    const reconnect = () => {
        cleanup();
        if (ws !== socket) return;
        ws = null;
        socket.close();
        updateStatus(false);
        scheduleReconnect();
    };
    const ping = () => {
        if (ws !== socket || socket.readyState !== WebSocket.OPEN || pongTimer) return;
        try {
            socket.send(JSON.stringify({ type: 'ping' }));
            pongTimer = setTimeout(reconnect, 10000);
        } catch { reconnect(); }
    };
    connectTimer = setTimeout(reconnect, 10000);
    socket.onopen = () => {
        if (ws !== socket) return;
        clearTimeout(connectTimer);
        ping();
        heartbeat = setInterval(ping, 15000);
        loadSnapshot();
        loadSidebarHistory();
        fetchAppState();
    };
    socket.onmessage = event => {
        if (ws !== socket) return;
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'error' && data.message === 'Unauthorized') {
                authRedirecting = true;
                cleanup();
                window.location.href = '/login.html';
                return;
            }
            if (data.type === 'pong') {
                clearTimeout(pongTimer);
                pongTimer = null;
                reconnectAttempt = 0;
                updateStatus(true, data.cdpConnected);
            }
            if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
                clearTimeout(snapshotDebounce);
                snapshotDebounce = setTimeout(() => loadSnapshot(false), 80);
            }
        } catch { /* Ignore malformed server messages. */ }
    };
    socket.onclose = reconnect;
    socket.onerror = reconnect;
}

function resumeConnection() {
    if (document.visibilityState === 'visible') connectWebSocket(true);
}
document.addEventListener('visibilitychange', resumeConnection);
window.addEventListener('pageshow', resumeConnection);
window.addEventListener('online', () => connectWebSocket(true));
window.addEventListener('offline', () => {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    const old = ws;
    ws = null;
    old?.dispose?.();
    old?.close();
    updateStatus(false);
});

function updateStatus(connected, desktopConnected = true) {
    const healthy = connected && desktopConnected;
    statusDot.classList.toggle('connected', healthy);
    statusDot.classList.toggle('disconnected', !healthy);
    statusText.textContent = navigator.onLine === false ? '网络离线' :
        !connected ? '重连中...' : !desktopConnected ? '桌面重连中...' : '实时在线';
}

// --- DOM Morphing for Flicker-Free Rendering ---
function morphDOM(oldRoot, newRoot) {
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

    const oldChildren = Array.from(oldRoot.childNodes).filter(
        n => !(n.nodeType === Node.ELEMENT_NODE && n.classList.contains('mobile-copy-btn'))
    );
    const newChildren = Array.from(newRoot.childNodes);

    const maxLen = Math.max(oldChildren.length, newChildren.length);
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

// --- Load and Render Chat Snapshot ---
let snapshotLoading = false;
let snapshotReload = false;
async function loadSnapshot(isManual = false) {
    if (snapshotLoading) { snapshotReload = true; return; }
    snapshotLoading = true;
    try {
        if (isManual) {
            const icon = refreshBtn.querySelector('svg');
            if (icon) {
                icon.classList.remove('spin-anim');
                void icon.offsetWidth;
                icon.classList.add('spin-anim');
            }
        }

        const res = await fetchWithAuth('/snapshot');
        if (!res.ok) {
            if (res.status === 503) {
                const error = await res.json();
                if (error.error === 'cdp_disconnected') updateStatus(true, false);
                // A missing snapshot is temporary; preserve the current chat.
                // Never create a new conversation merely because sync is delayed.
                return;
            }
            throw new Error('Failed to load snapshot');
        }

        const data = await res.json();

        // Scroll state preservation
        const scrollPos = chatContainer.scrollTop;
        const scrollHeight = chatContainer.scrollHeight;
        const clientHeight = chatContainer.clientHeight;
        const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
        const isUserScrollLocked = Date.now() < userScrollLockUntil;

        // Stats update
        if (data.stats) {
            const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
            const nodes = data.stats.nodes;
            if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
        }

        // CSS Injection (Cached)
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        const darkModeOverrides = `/* --- BASE SNAPSHOT CSS --- */
${data.css}

/* --- FORCE DARK MODE & CODEX OBSIDIAN OVERRIDES --- */
:root, body, #chatContent, #conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"] {
    --bg-app: #0d0d0d !important;
    --text-main: #ececec !important;
    --text-muted: #8e8e8e !important;
    --border-color: rgba(255, 255, 255, 0.08) !important;
    --background: #0d0d0d !important;
    --foreground: #ececec !important;
    --card: #1e1e1e !important;
    --card-foreground: #ececec !important;
    --card-border: rgba(255, 255, 255, 0.08) !important;
    --secondary: #262626 !important;
    --secondary-foreground: #ececec !important;
    --muted: #1e1e1e !important;
    --muted-foreground: #8e8e8e !important;
    --border: rgba(255, 255, 255, 0.08) !important;
    --primary: #10a37f !important;
    --primary-foreground: #ffffff !important;
    --accent: #10a37f !important;
    --accent-foreground: #ffffff !important;
    --popover: #1e1e1e !important;
    --popover-foreground: #ececec !important;
    --max-conversation-width: 100% !important;
    color: #ececec !important;
}

#conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"], #chatContent, #conversation * {
    container-type: normal !important;
}

#conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"] {
    background-color: transparent !important;
    color: #ececec !important;
    font-family: 'Inter', system-ui, -apple-system, sans-serif !important;
    position: relative !important;
    height: auto !important;
    min-height: 100% !important;
    width: 100% !important;
    overflow: visible !important;
    display: block !important;
    padding-right: 0px !important;
}

#conversation p, #conversation h1, #conversation h2, #conversation h3, #conversation h4, #conversation li, #conversation td, #conversation th {
    color: #ececec !important;
    font-size: 15px;
    line-height: 1.68;
}

#conversation h1, #conversation h2, #conversation h3 {
    color: #ffffff !important;
    font-weight: 600;
    margin-top: 18px;
    margin-bottom: 8px;
}

/* User Message Bubble - Codex Prompt Card */
#conversation div[class*="group/user-input-step"],
#conversation div[class*="bg-background"],
#conversation [class*="md-sticky-message-bleed"] {
    background: #262626 !important;
    color: #f5f5f5 !important;
    border-radius: 18px !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    padding: 12px 18px !important;
    margin: 14px 0 !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25) !important;
    max-width: 88% !important;
    margin-left: auto !important;
}

#conversation [class*="md-sticky-message-bleed"]::after {
    display: none !important;
}

/* Thinking & Reasoning blocks - Codex collapsible thought */
#conversation [data-testid="worked-for-collapsible"], 
#conversation button[class*="tabular-nums"], 
#conversation button:has(svg):has(span) {
    background: rgba(255, 255, 255, 0.03) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 8px !important;
    color: #8e8e8e !important;
    padding: 6px 12px !important;
    margin: 8px 0 !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    cursor: pointer !important;
    font-size: 12.5px !important;
    transition: all 0.15s ease !important;
}

#conversation [data-testid="worked-for-collapsible"]:hover,
#conversation button[class*="tabular-nums"]:hover,
#conversation button:has(svg):has(span):hover {
    background: rgba(255, 255, 255, 0.06) !important;
    border-color: rgba(255, 255, 255, 0.14) !important;
    color: #ececec !important;
}

/* Code Blocks - Codex Signature Code Box */
pre, code, .monaco-editor-background, [class*="terminal"] {
    background-color: #141414 !important;
    color: #e5e5e5 !important;
    font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace !important;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.08);
}

pre {
    position: relative !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
    padding: 14px 16px !important;
    margin: 12px 0 !important;
    width: 100% !important;
    border-radius: 10px !important;
    line-height: 1.52 !important;
}

.mobile-copy-btn {
    position: absolute !important;
    top: 8px !important;
    right: 8px !important;
    background: rgba(255, 255, 255, 0.06) !important;
    color: #8e8e8e !important;
    border: 1px solid rgba(255, 255, 255, 0.1) !important;
    width: 28px !important;
    height: 28px !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 6px !important;
    z-index: 10 !important;
    transition: all 0.15s ease !important;
}

.mobile-copy-btn:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
    border-color: rgba(255, 255, 255, 0.18) !important;
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

        addMobileCopyButtons();

        // Update steer mode from snapshot stats or flags
        if (typeof data.isBusy === 'boolean' || (data.stats && typeof data.stats.isBusy === 'boolean')) {
            setSteerMode(!!(data.isBusy || (data.stats && data.stats.isBusy)));
        }

        // Scroll positioning
        const newScrollHeight = chatContainer.scrollHeight;
        if (isUserScrollLocked) {
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            chatContainer.scrollTop = newScrollHeight * scrollPercent;
        } else if (isNearBottom || scrollPos === 0) {
            if (newScrollHeight > scrollHeight || scrollPos === 0) {
                chatContainer.scrollTop = newScrollHeight;
            }
        } else {
            chatContainer.scrollTop = scrollPos;
        }
    } catch (err) {
        console.error('loadSnapshot error:', err);
    } finally {
        snapshotLoading = false;
        if (snapshotReload) {
            snapshotReload = false;
            queueMicrotask(() => loadSnapshot());
        }
    }
}

// --- Code Copy Buttons ---
function addMobileCopyButtons() {
    const codeBlocks = chatContent.querySelectorAll('pre');
    codeBlocks.forEach((pre, index) => {
        if (pre.querySelector('.mobile-copy-btn')) return;

        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();
        if (!/\n/.test(textToCopy)) return;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('aria-label', '复制代码');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
        `;

        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = await copyToClipboard(textToCopy);
            if (ok) {
                copyBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="#10b981" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    `;
                }, 2000);
            }
        });

        pre.appendChild(copyBtn);
    });
}

async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {}
    }
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        return success;
    } catch (err) {
        return false;
    }
}

// --- Empty State View ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--accent); margin-bottom:16px;">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                <line x1="9" y1="10" x2="15" y2="10"></line>
            </svg>
            <h2 style="font-size:17px; font-weight:600; color:var(--text-main); margin-bottom:6px;">未打开任何会话</h2>
            <p style="font-size:13px; color:var(--text-muted); max-width:280px; line-height:1.5; margin-bottom:20px;">
                从左侧历史会话列表中选择一个，或点击下方按钮发起新对话。
            </p>
            <button class="modal-btn-primary" id="newChatFromEmptyBtn">开始新会话</button>
        </div>
    `;
    const emptyBtn = document.getElementById('newChatFromEmptyBtn');
    if (emptyBtn) emptyBtn.addEventListener('click', startNewChat);
}

// --- Sidebar Conversation History ---
let historyLoading = false;
async function loadSidebarHistory() {
    if (historyLoading || isSending) return;
    historyLoading = true;
    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'History unavailable');
        rawConversations = data.chats || [];

        renderSidebarConversations(rawConversations);

        // Update header active session title
        const activeChat = rawConversations.find(c => c.isActive);
        if (activeChat) {
            headerSessionTitle.textContent = activeChat.title;
        }
    } catch (e) {
        if (rawConversations.length) return;
        sidebarConvoList.innerHTML = `
            <div class="sidebar-state-empty">
                <span>⚠️ 加载历史失败</span>
            </div>
        `;
    } finally {
        historyLoading = false;
    }
}

function renderSidebarConversations(chats) {
    if (chats.length === 0) {
        sidebarConvoList.innerHTML = `
            <div class="sidebar-state-empty">
                <span>暂无历史会话</span>
            </div>
        `;
        return;
    }

    const pinnedChats = [];
    const projectChatsMap = new Map();
    const conversationChats = [];

    chats.forEach(chat => {
        if (chat.isPinned || chat.group === 'Pinned') {
            pinnedChats.push(chat);
        } else if (chat.group === 'Projects' || (chat.workspace && chat.workspace.trim().length > 0)) {
            const ws = chat.workspace ? chat.workspace.trim() : 'Project';
            if (!projectChatsMap.has(ws)) projectChatsMap.set(ws, []);
            projectChatsMap.get(ws).push(chat);
        } else {
            conversationChats.push(chat);
        }
    });

    const renderCard = (chat) => {
        const safeTitle = escapeHtml(chat.title);
        const safeWorkspace = escapeHtml(chat.workspace || '');
        return `
            <div class="sidebar-card ${chat.isActive ? 'active' : ''}" data-title="${safeTitle}" data-workspace="${safeWorkspace}">
                <div class="sidebar-card-icon">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                </div>
                <div class="sidebar-card-content">
                    <span class="sidebar-card-title">${safeTitle}</span>
                    <div class="sidebar-card-meta">
                        ${chat.workspace ? `<span class="sidebar-card-workspace">📁 ${safeWorkspace}</span>` : ''}
                        ${chat.isActive ? '<span class="sidebar-active-badge">当前</span>' : ''}
                    </div>
                </div>
                ${chat.timestamp ? `<span class="sidebar-card-time">${escapeHtml(chat.timestamp)}</span>` : ''}
            </div>
        `;
    };

    let html = '';

    // 1. PINNED
    if (pinnedChats.length > 0) {
        html += `
            <div class="sidebar-section" data-section="pinned">
                <div class="sidebar-section-header">
                    <span class="sidebar-section-title">
                        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
                            <line x1="12" y1="17" x2="12" y2="22"></line>
                            <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
                        </svg>
                        置顶会话
                    </span>
                    <span class="sidebar-section-count">${pinnedChats.length}</span>
                </div>
                <div class="sidebar-section-items" style="display:flex; flex-direction:column; gap:2px;">
                    ${pinnedChats.map(renderCard).join('')}
                </div>
            </div>
        `;
    }

    // 2. PROJECTS
    if (projectChatsMap.size > 0) {
        let totalProjects = 0;
        projectChatsMap.forEach(arr => totalProjects += arr.length);

        html += `
            <div class="sidebar-section" data-section="projects">
                <div class="sidebar-section-header">
                    <span class="sidebar-section-title">
                        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                        </svg>
                        工作区项目
                    </span>
                    <span class="sidebar-section-count">${totalProjects}</span>
                </div>
        `;

        for (const [workspaceName, pChats] of projectChatsMap.entries()) {
            html += `
                <div class="sidebar-project-group" data-project="${escapeHtml(workspaceName)}">
                    <div class="sidebar-project-header">
                        <div class="sidebar-project-title">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                            </svg>
                            <span>${escapeHtml(workspaceName)}</span>
                        </div>
                        <div class="sidebar-project-meta">
                            <span class="sidebar-project-badge">${pChats.length}</span>
                            <div class="sidebar-project-toggle">
                                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
                                    <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                            </div>
                        </div>
                    </div>
                    <div class="sidebar-project-items">
                        ${pChats.map(renderCard).join('')}
                    </div>
                </div>
            `;
        }

        html += `</div>`;
    }

    // 3. CONVERSATIONS
    if (conversationChats.length > 0) {
        html += `
            <div class="sidebar-section" data-section="conversations">
                <div class="sidebar-section-header">
                    <span class="sidebar-section-title">
                        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                        </svg>
                        常规会话
                    </span>
                    <span class="sidebar-section-count">${conversationChats.length}</span>
                </div>
                <div class="sidebar-section-items" style="display:flex; flex-direction:column; gap:2px;">
                    ${conversationChats.map(renderCard).join('')}
                </div>
            </div>
        `;
    }

    sidebarConvoList.innerHTML = html;
}

// Sidebar Search Filter
sidebarSearchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim().toLowerCase();
    sidebarSearchClear.style.display = query ? 'block' : 'none';

    const cards = sidebarConvoList.querySelectorAll('.sidebar-card');
    cards.forEach(card => {
        const title = (card.getAttribute('data-title') || '').toLowerCase();
        const ws = (card.getAttribute('data-workspace') || '').toLowerCase();
        const matches = title.includes(query) || ws.includes(query);
        card.style.display = matches ? 'flex' : 'none';
    });

    // Check project groups
    const projectGroups = sidebarConvoList.querySelectorAll('.sidebar-project-group');
    projectGroups.forEach(group => {
        const visible = group.querySelectorAll('.sidebar-card:not([style*="display: none"])').length;
        group.style.display = visible > 0 ? 'block' : 'none';
        if (query && visible > 0) group.classList.remove('collapsed');
    });

    // Check sections
    const sections = sidebarConvoList.querySelectorAll('.sidebar-section');
    sections.forEach(sec => {
        const visible = sec.querySelectorAll('.sidebar-card:not([style*="display: none"])').length;
        sec.style.display = visible > 0 ? 'block' : 'none';
    });
});

sidebarSearchClear.addEventListener('click', () => {
    sidebarSearchInput.value = '';
    sidebarSearchClear.style.display = 'none';
    sidebarSearchInput.dispatchEvent(new Event('input'));
});

// Sidebar Event Delegation
sidebarConvoList.addEventListener('click', async (e) => {
    const projectHeader = e.target.closest('.sidebar-project-header');
    if (projectHeader) {
        const group = projectHeader.closest('.sidebar-project-group');
        if (group) group.classList.toggle('collapsed');
        return;
    }

    const card = e.target.closest('.sidebar-card');
    if (card) {
        const title = card.getAttribute('data-title');
        closeMobileSidebar();
        selectChat(title);
    }
});

// --- Select / Switch Conversation ---
async function selectChat(title) {
    if (!title) return;
    if (isSending) { showToast('消息正在提交，请稍后切换会话', 'info'); return; }

    headerSessionTitle.textContent = title;
    chatContent.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <p style="font-size:15px; font-weight:600; color:var(--text-main);">正在切换会话...</p>
            <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">${escapeHtml(title)}</p>
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
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(loadSnapshot, 1600);
            setTimeout(loadSidebarHistory, 1200);
        } else {
            console.error('Failed to select chat:', data.error);
            loadSnapshot();
        }
    } catch (e) {
        console.error('Select chat error:', e);
        loadSnapshot();
    }
}

// --- Start New Chat ---
async function startNewChat() {
    if (isSending) { showToast('消息正在提交，请稍后新建会话', 'info'); return false; }
    sidebarNewChatBtn.style.opacity = '0.5';
    closeMobileSidebar();

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            headerSessionTitle.textContent = '新会话';
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1200);
            setTimeout(loadSidebarHistory, 1500);
        }
    } catch (e) {
        console.error('New chat error:', e);
    } finally {
        setTimeout(() => sidebarNewChatBtn.style.opacity = '1', 500);
    }
}

sidebarNewChatBtn.addEventListener('click', startNewChat);

// --- Model Switcher Logic ---
async function openModelModal() {
    modelCardsGrid.innerHTML = `
        <div class="loading-state" style="padding:20px;">
            <div class="loading-spinner"></div>
            <p>正在拉取可用模型列表...</p>
        </div>
    `;
    modelModalOverlay.classList.add('show');

    try {
        const res = await fetchWithAuth('/models');
        const data = await res.json();
        availableModels = data.models || [];

        renderModelCards(availableModels);
    } catch (e) {
        modelCardsGrid.innerHTML = `
            <div style="padding:20px; text-align:center; color:var(--error);">
                获取模型列表失败，请重试
            </div>
        `;
    }
}

function renderModelCards(models) {
    if (!models || models.length === 0) {
        models = [
            { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash High", displayName: "Gemini 3.8 Flash", family: "Google", badge: "默认 · 极速", desc: "极速长上下文与强逻辑推理，日常工程首选", contextWindow: "1,000,000" },
            { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro (High)", displayName: "Gemini 3.1 Pro", family: "Google", badge: "深度推理", desc: "复杂代码重构、跨模块系统分析与算法攻关", contextWindow: "2,000,000" },
            { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6 (Thinking)", displayName: "Claude Sonnet 4.6", family: "Anthropic", badge: "深度思考", desc: "混合思考架构，复杂系统设计与精细代码修改", contextWindow: "200,000" },
            { id: "claude-opus-4.6", name: "Claude Opus 4.6 (Thinking)", displayName: "Claude Opus 4.6", family: "Anthropic", badge: "顶级推演", desc: "顶级学术与极高复杂度推演", contextWindow: "200,000" },
            { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)", displayName: "GPT-OSS 120B", family: "Open-Source", badge: "开源前沿", desc: "开源旗舰权重与通用编程推理", contextWindow: "128,000" }
        ];
    }

    const currentLower = currentModel.toLowerCase();

    modelCardsGrid.innerHTML = models.map(m => {
        const isCurrent = currentLower.includes(m.displayName.toLowerCase()) || 
                          m.name.toLowerCase().includes(currentLower);

        return `
            <div class="model-select-card ${isCurrent ? 'active' : ''}" data-model-name="${escapeHtml(m.name)}">
                <div class="model-card-icon">
                    ${m.family === 'Anthropic' ? '💡' : m.family === 'Open-Source' ? '🔬' : '✨'}
                </div>
                <div class="model-card-info">
                    <div class="model-card-header">
                        <span class="model-card-name">${escapeHtml(m.displayName || m.name)}</span>
                        ${m.badge ? `<span class="model-card-badge">${escapeHtml(m.badge)}</span>` : ''}
                    </div>
                    <div class="model-card-desc">${escapeHtml(m.desc || '')}</div>
                    <div class="model-card-meta">
                        <span>厂商: ${escapeHtml(m.family)}</span>
                        ${m.contextWindow ? `<span>上下文: ${escapeHtml(m.contextWindow)} Tokens</span>` : ''}
                    </div>
                </div>
                <div class="model-card-radio"></div>
            </div>
        `;
    }).join('');
}

modelCardsGrid.addEventListener('click', async (e) => {
    const card = e.target.closest('.model-select-card');
    if (!card) return;

    const chosenModel = card.getAttribute('data-model-name');
    modelText.textContent = chosenModel;
    closeModelModal();

    try {
        const res = await fetchWithAuth('/set-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: chosenModel })
        });
        const data = await res.json();
        if (data.success) {
            currentModel = chosenModel;
            modelText.textContent = chosenModel;
        } else {
            console.warn('Set model warning:', data.error);
        }
        setTimeout(fetchAppState, 800);
    } catch (e) {
        console.error('Set model error:', e);
    }
});

function closeModelModal() {
    modelModalOverlay.classList.remove('show');
}

modelBtn.addEventListener('click', openModelModal);
closeModelModalBtn.addEventListener('click', closeModelModal);
cancelModelModalBtn.addEventListener('click', closeModelModal);
modelModalOverlay.addEventListener('click', (e) => {
    if (e.target === modelModalOverlay) closeModelModal();
});

// --- Usage & Quota Viewer Logic ---
let usageRequestId = 0;
let usageController = null;
let usageLoading = false;
let nextUsageRefresh = 0;
let quotaClockOffsetMs = 0;

async function openUsageModal() {
    usageModalBody.innerHTML = '<div class="usage-loading"><div class="loading-spinner"></div><p>正在读取账户模型组配额...</p></div>';
    usageModalOverlay.classList.add('show');
    fetchUsageData();
}

async function fetchUsageData(forceRefresh = false) {
    const requestId = ++usageRequestId;
    usageController?.abort();
    usageController = new AbortController();
    usageLoading = true;
    refreshUsageBtn.disabled = true;
    try {
        const res = await fetchWithAuth(forceRefresh ? '/usage?refresh=1' : '/usage', { signal: usageController.signal });
        if (!res.ok) throw new Error('Usage unavailable');
        const data = await res.json();
        if (requestId !== usageRequestId || !usageModalOverlay.classList.contains('show')) return;
        renderUsageModal(data);
    } catch (error) {
        if (requestId !== usageRequestId || !usageModalOverlay.classList.contains('show')) return;
        usageModalBody.innerHTML = '<div class="quota-notice">获取账户用量失败，请刷新重试。</div>';
    } finally {
        if (requestId === usageRequestId) {
            usageLoading = false;
            refreshUsageBtn.disabled = false;
        }
    }
}

function formatQuotaPercent(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%` : '未提供';
}

function formatQuotaTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '未提供';
    return new Date(value).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    });
}

function formatQuotaCountdown(value, now = Date.now() + quotaClockOffsetMs) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return '未提供重置时间';
    const seconds = Math.max(0, Math.ceil((timestamp - now) / 1000));
    if (!seconds) return '已到重置时间，等待账户更新';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const rest = seconds % 60;
    return `${days ? `${days}天 ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')} 后补充`;
}

function renderQuotaWindow(bucket, windowType) {
    const title = { daily: '日限额', weekly: '周限额', five_hour: '5 小时限额' }[windowType] || bucket?.label || '其他额度';
    if (!bucket) return `<div class="quota-window quota-window-missing"><b>${escapeHtml(title)}</b><span>账户未提供</span></div>`;
    const exhausted = bucket.remainingPercent === 0 && !bucket.disabled;
    const known = typeof bucket.usedPercent === 'number' && Number.isFinite(bucket.usedPercent);
    const percent = known ? Math.max(0, Math.min(100, bucket.usedPercent)) : 0;
    return `
        <section class="quota-window ${exhausted ? 'quota-window-exhausted' : ''} ${bucket.disabled ? 'quota-window-disabled' : ''}">
            <div class="quota-window-heading"><b>${escapeHtml(title)}</b>
                ${bucket.disabled ? '<span class="quota-state">暂不适用</span>' : exhausted ? '<span class="quota-state quota-state-error">额度已用完</span>' : ''}
            </div>
            <div class="quota-window-metrics">
                <div><span>限额</span><strong>${bucket.disabled ? '暂不适用' : formatQuotaPercent(bucket.limitPercent)}</strong></div>
                <div><span>已用</span><strong>${bucket.disabled ? '—' : formatQuotaPercent(bucket.usedPercent)}</strong></div>
                <div><span>剩余</span><strong>${bucket.disabled ? '—' : formatQuotaPercent(bucket.remainingPercent)}</strong></div>
            </div>
            ${known && !bucket.disabled ? `<div class="usage-progress-bar" role="progressbar" aria-label="${escapeHtml(title)}已用" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="usage-progress-fill" style="width:${percent}%"></div></div>` : ''}
            <div class="quota-window-reset"><span>补充 / 重置时间</span><time>${bucket.disabled ? '本周期暂不适用' : escapeHtml(formatQuotaTime(bucket.resetAt))}</time>
                ${bucket.resetAt && !bucket.disabled ? `<span class="quota-countdown" data-quota-reset-at="${escapeHtml(bucket.resetAt)}">${escapeHtml(formatQuotaCountdown(bucket.resetAt))}</span>` : ''}
            </div>
            ${bucket.description ? `<p class="quota-window-description">${escapeHtml(bucket.description)}</p>` : ''}
        </section>`;
}

function renderQuotaGroups(quota, model) {
    if (!quota.available) return `<div class="quota-notice">${escapeHtml(quota.message || '暂未读取到账户配额，请刷新重试。')}</div>`;
    if (!quota.groups?.length) return '<div class="quota-notice">账户当前没有返回模型组配额。</div>';
    const modelFamily = (model || '').match(/gemini|claude|gpt/i)?.[0].toLowerCase();
    return `<div class="quota-groups">${quota.groups.map(group => {
        const buckets = group.buckets || [];
        const active = modelFamily && `${group.name} ${group.description}`.toLowerCase().includes(modelFamily);
        const rows = ['daily', 'weekly', 'five_hour'].map(windowType => {
            const matches = buckets.filter(bucket => bucket.window === windowType);
            if (windowType === 'five_hour' && !matches.length) return '';
            return matches.length ? matches.map(bucket => renderQuotaWindow(bucket, windowType)).join('') : renderQuotaWindow(null, windowType);
        }).join('') + buckets.filter(bucket => bucket.window === 'other').map(bucket => renderQuotaWindow(bucket, 'other')).join('');
        return `<article class="quota-group-card"><div class="quota-group-heading"><h4>${escapeHtml(group.name)}</h4>${active ? '<span class="limit-badge primary">当前模型组</span>' : ''}</div>
            ${group.description ? `<p class="quota-group-description">${escapeHtml(group.description)}</p>` : ''}${rows}</article>`;
    }).join('')}</div>`;
}

function renderUsageModal(data) {
    quotaClockOffsetMs = Number.isFinite(Date.parse(data.serverTime)) ? Date.parse(data.serverTime) - Date.now() : 0;
    const session = data.session || {};
    const system = data.system || {};
    const quota = data.quota || {};
    const tokens = Number(session.approxTokens || 0).toLocaleString();
    usageModalBody.innerHTML = `
        <div class="usage-section-title">各模型组限额与用量</div>
        <div class="quota-notice">组内模型共享额度。官方以百分比提供剩余额度，未提供请求数或 Token 总上限；未返回的周期标为“账户未提供”。时间按当前设备时区显示。</div>
        ${renderQuotaGroups(quota, data.model)}
        ${quota.available ? `<div class="quota-source">账户数据更新于 ${escapeHtml(formatQuotaTime(quota.capturedAt))}</div>` : ''}
        ${quota.description ? `<details class="quota-rules"><summary>账户额度规则</summary><p>${escapeHtml(quota.description)}</p></details>` : ''}
        <div class="usage-section-title">当前会话估算</div>
        <div class="usage-stats-grid">
            <div class="usage-stat-box"><div class="usage-stat-val">${Number(session.turns || 0)}</div><div class="usage-stat-lbl">估算对话轮次</div></div>
            <div class="usage-stat-box"><div class="usage-stat-val">~${tokens}</div><div class="usage-stat-lbl">当前页面估算 Tokens</div></div>
            <div class="usage-stat-box"><div class="usage-stat-val">${Number(session.payloadKb || 0)} KB</div><div class="usage-stat-lbl">页面数据量</div></div>
        </div>
        <p class="quota-source">会话估算仅基于当前同步的页面内容，账户配额以模型组数据为准。</p>
        <div class="usage-section-title">连接状态</div>
        <div class="system-status-pills">
            <div class="sys-pill">当前模型: <b>${escapeHtml(data.model || currentModel)}</b></div>
            <div class="sys-pill">执行模式: <b>${escapeHtml(data.mode || currentMode)}</b></div>
            <div class="sys-pill">桌面: <b>${system.cdpConnected ? '已连接' : '未连接'}</b></div>
            <div class="sys-pill">运行: <b>${escapeHtml(system.uptimeFormatted || '刚刚启动')}</b></div>
        </div>`;
    if (window.usageCountdownTimer) clearInterval(window.usageCountdownTimer);
    nextUsageRefresh = Date.now() + 30000;
    window.usageCountdownTimer = setInterval(() => {
        usageModalBody.querySelectorAll('[data-quota-reset-at]').forEach(element => {
            element.textContent = formatQuotaCountdown(element.getAttribute('data-quota-reset-at'));
        });
        if (!usageLoading && Date.now() >= nextUsageRefresh && usageModalOverlay.classList.contains('show')) {
            nextUsageRefresh = Date.now() + 30000;
            fetchUsageData();
        }
    }, 1000);
}

function closeUsageModal() {
    usageRequestId++;
    usageController?.abort();
    usageLoading = false;
    refreshUsageBtn.disabled = false;
    if (window.usageCountdownTimer) clearInterval(window.usageCountdownTimer);
    window.usageCountdownTimer = null;
    usageModalOverlay.classList.remove('show');
}

usageBtn.addEventListener('click', openUsageModal);
sidebarUsageBtn.addEventListener('click', () => { closeMobileSidebar(); openUsageModal(); });
closeUsageModalBtn.addEventListener('click', closeUsageModal);
confirmUsageModalBtn.addEventListener('click', closeUsageModal);
refreshUsageBtn.addEventListener('click', () => fetchUsageData(true));
usageModalOverlay.addEventListener('click', event => { if (event.target === usageModalOverlay) closeUsageModal(); });

// --- Mode Switcher Logic ---
const MODES = ['Turbo', 'Fast', 'Planning', 'Default', 'Request Review'];

function openModeModal() {
    modeOptionsList.innerHTML = MODES.map(m => `
        <div class="mode-option-item ${m === currentMode ? 'active' : ''}" data-mode="${m}">
            <div style="display:flex; flex-direction:column; gap:2px;">
                <span style="font-size:14px; font-weight:600; color:var(--text-main);">${m}</span>
                <span style="font-size:11.5px; color:var(--text-muted);">${getModeDescription(m)}</span>
            </div>
            ${m === currentMode ? '<span style="color:var(--warning); font-size:14px;">✓</span>' : ''}
        </div>
    `).join('');
    modeModalOverlay.classList.add('show');
}

function getModeDescription(mode) {
    switch (mode) {
        case 'Turbo': return '完全自动执行，无需手动确认，开发速度最快';
        case 'Fast': return '快速模式，适合常规敏捷编程任务';
        case 'Planning': return '先深度思考并列出计划，再分步实施';
        case 'Request Review': return '对代码修改和终端命令进行显式确认后执行';
        default: return '默认标准执行模式';
    }
}

modeOptionsList.addEventListener('click', async (e) => {
    const item = e.target.closest('.mode-option-item');
    if (!item) return;

    const chosenMode = item.getAttribute('data-mode');
    currentMode = chosenMode;
    modeText.textContent = chosenMode;
    closeModeModal();

    try {
        await fetchWithAuth('/set-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: chosenMode })
        });
        setTimeout(fetchAppState, 800);
    } catch (e) {}
});

function closeModeModal() {
    modeModalOverlay.classList.remove('show');
}

modeBtn.addEventListener('click', openModeModal);
closeModeModalBtn.addEventListener('click', closeModeModal);
cancelModeModalBtn.addEventListener('click', closeModeModal);
modeModalOverlay.addEventListener('click', (e) => {
    if (e.target === modeModalOverlay) closeModeModal();
});

// --- Sending Messages ---
async function sendMessage(overrideText = null) {
    if (isSending) return;
    const rawText = overrideText !== null ? overrideText : messageInput.value;
    const message = rawText ? rawText.trim() : '';
    if (!message) return;
    if (navigator.onLine === false) { showToast('网络离线，消息草稿已保留', 'error'); return; }
    const sameRequest = pendingSend?.message === message;
    if (!sameRequest) {
        pendingSend = {
            requestId: window.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            message, isSteer: isAgentBusy
        };
    }
    saveSession('ag_pending_send', JSON.stringify(pendingSend));
    if (overrideText === null) saveSession('ag_message_draft', rawText);
    isSending = true;
    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';
    try {
        let res;
        // Only a lost response retries, and always with the same receipt ID.
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                res = await fetchWithAuth('/send', {
                    method: 'POST', timeoutMs: 45000,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pendingSend)
                });
                break;
            } catch (error) {
                if (authRedirecting || attempt === 1 || navigator.onLine === false) throw error;
            }
        }
        const data = await res.json();
        if (!res.ok || data?.success !== true || data?.ok !== true) {
            if (!data?.uncertain) {
                pendingSend = null;
                saveSession('ag_pending_send', null);
            }
            if (overrideText !== null && !messageInput.value) {
                messageInput.value = message;
                saveSession('ag_message_draft', message);
            }
            showToast(data?.message || '消息发送失败，草稿已保留', 'error');
            return;
        }
        pendingSend = null;
        saveSession('ag_pending_send', null);
        // Keep any edits typed while this request was in progress.
        if (overrideText === null && messageInput.value === rawText) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
            saveSession('ag_message_draft', null);
            updateSendButtonState();
        }
        showToast(data.isSteer ? '⚡ 插话已提交' : '消息已发送', 'success', 1800);
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSidebarHistory, 1500);
    } catch (error) {
        console.error('Send message error:', error);
        if (overrideText !== null && !messageInput.value) messageInput.value = message;
        showToast(authRedirecting ? '登录已过期，草稿已保留' : '未收到发送结果，草稿已保留；重试会核对原请求', 'error');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        updateSendButtonState();
    }
}

// Send on click
sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sendMessage();
});

// Mobile touch handling: triggers instantly on touch release without waiting for blur
sendBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    sendMessage();
});

// Keyboard handling: Enter sends; Shift+Enter creates new line (with IME composition guard)
messageInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-grow textarea and update Codex send button state
messageInput.addEventListener('input', function () {
    saveSession('ag_message_draft', this.value);
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 180) + 'px';
    updateSendButtonState();
});

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    // Ctrl+B / Cmd+B toggles sidebar
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
    }
    // Ctrl+N / Cmd+N or Ctrl+Shift+L for new chat
    if ((e.ctrlKey || e.metaKey) && ((e.key === 'n' || e.key === 'N') || (e.shiftKey && (e.key === 'l' || e.key === 'L')))) {
        e.preventDefault();
        startNewChat();
    }
});

// --- Scroll & Viewport Handling ---
chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
    }, 4000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0;
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
});

// Virtual Keyboard compensation for mobile
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        if (!isDesktop()) {
            document.body.style.height = window.visualViewport.height + 'px';
            if (document.activeElement === messageInput) {
                setTimeout(() => {
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                }, 100);
            }
        }
    });
}

// --- Quick Actions & Conversation Guidance ---
function setupGuidanceChips() {
    const chips = document.querySelectorAll('.action-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.preventDefault();
            const text = chip.getAttribute('data-text') || chip.innerText.trim();
            const isDirect = chip.getAttribute('data-direct') === 'true';

            if (isDirect) {
                // Direct one-click send (e.g. "继续对话")
                sendMessage(text);
            } else {
                // Prepend or set into message input
                if (chip.getAttribute('data-action') === 'steer') {
                    messageInput.value = text + ' ';
                    if (inputCard) inputCard.classList.add('steer-focused');
                } else {
                    messageInput.value = text;
                }
                messageInput.focus();
                messageInput.style.height = 'auto';
                messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
            }
        });
    });
}
setupGuidanceChips();

// --- Stop & Refresh Buttons ---
stopBtn.addEventListener('click', async () => {
    stopBtn.style.opacity = '0.5';
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (data?.success) {
            showToast('已发送停止生成请求', 'info');
        } else {
            showToast(data?.error || '未检测到正在生成的任务', 'info');
        }
        setTimeout(loadSnapshot, 400);
    } catch (e) {
        showToast('停止请求失败', 'error');
    }
    setTimeout(() => stopBtn.style.opacity = '1', 500);
});

refreshBtn.addEventListener('click', () => {
    loadSnapshot(true);
    fetchAppState();
    loadSidebarHistory();
});

sidebarSyncBtn.addEventListener('click', () => {
    loadSnapshot(true);
    fetchAppState();
    loadSidebarHistory();
});

// --- Remote Click Handling (Thinking blocks, Run/Allow buttons) ---
chatContainer.addEventListener('click', async (e) => {
    const target = e.target.closest('div, span, p, summary, button, details');
    if (!target) return;

    const text = target.innerText || '';
    const isUiToggle = /Thought|Thinking|Worked for|Edited|\d+\s+file/i.test(text) && text.length < 500;

    if (isUiToggle) {
        target.style.opacity = '0.5';
        setTimeout(() => target.style.opacity = '1', 300);

        const firstLine = text.split('\n')[0].trim();
        const allElements = chatContainer.querySelectorAll(target.tagName.toLowerCase());
        let tapIndex = 0;
        for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i];
            const elFirstLine = (el.innerText || '').split('\n')[0].trim();
            if (/Thought|Thinking|Worked for|Edited|\d+\s+file/i.test(el.innerText || '') && elFirstLine === firstLine) {
                if (el === target || el.contains(target)) break;
                tapIndex++;
            }
        }

        try {
            await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: target.tagName.toLowerCase(),
                    index: tapIndex,
                    textContent: firstLine
                })
            });
            setTimeout(loadSnapshot, 400);
            setTimeout(loadSnapshot, 1000);
        } catch (e) {}
        return;
    }

    const btn = e.target.closest('button, [role="button"]');
    if (btn) {
        const btnText = (btn.innerText || '').trim().toLowerCase();
        const keywords = ['allow', 'review', 'confirm', 'accept', 'reject', 'run', 'yes', 'no'];
        const matched = keywords.find(k => btnText.includes(k));
        if (matched) {
            btn.style.opacity = '0.5';
            setTimeout(() => btn.style.opacity = '1', 300);
            const allButtons = Array.from(chatContainer.querySelectorAll('button, [role="button"]'));
            const matching = allButtons.filter(b => (b.innerText || '').toLowerCase().includes(matched));
            const idx = matching.indexOf(btn);

            try {
                await fetchWithAuth('/remote-click', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        selector: btn.tagName.toLowerCase() === 'button' ? 'button' : '[role="button"]',
                        index: idx >= 0 ? idx : 0,
                        textContent: matched
                    })
                });
                setTimeout(loadSnapshot, 400);
                setTimeout(loadSnapshot, 1000);
            } catch (err) {}
        }
    }
});

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- Support Modal ---
if (closeSupportBtn) {
    closeSupportBtn.addEventListener('click', () => {
        supportOverlay.classList.remove('show');
    });
}

// --- Init Application ---
initSidebarState();
connectWebSocket();
fetchAppState();
loadSidebarHistory();
setInterval(fetchAppState, 6000);
setInterval(loadSidebarHistory, 15000);
