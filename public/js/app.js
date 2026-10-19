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

// --- State Variables ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0;
let ws = null;
let idleTimer = null;
let currentMode = 'Turbo';
let currentModel = 'Gemini 3.8 Flash High';
let chatIsOpen = true;
let rawConversations = [];
let availableModels = [];

const USER_SCROLL_LOCK_DURATION = 3000;

// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            return new Promise(() => {});
        }
        return res;
    } catch (e) {
        throw e;
    }
}

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
        const savedCollapsed = localStorage.getItem('ag_sidebar_collapsed') === 'true';
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
        localStorage.setItem('ag_sidebar_collapsed', isCollapsed ? 'true' : 'false');
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
async function fetchAppState() {
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
    } catch (e) {
        console.warn('[SYNC] Failed to sync app state:', e.message);
    }
}
const syncAppState = fetchAppState;

// --- WebSocket Connection ---
let reconnectTimeout = null;

function scheduleReconnect(delay = 2000) {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        connectWebSocket();
    }, delay);
}

function connectWebSocket() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
        ws = new WebSocket(`${protocol}//${window.location.host}`);
    } catch (err) {
        console.warn('WebSocket init error:', err);
        scheduleReconnect(3000);
        return;
    }

    ws.onopen = () => {
        updateStatus(true);
        loadSnapshot();
        loadSidebarHistory();
        fetchAppState();
    };

    let snapshotDebounce = null;
    ws.onmessage = (event) => {
        try {
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
        } catch (e) {}
    };

    ws.onclose = () => {
        updateStatus(false);
        scheduleReconnect(2000);
    };

    ws.onerror = () => {
        updateStatus(false);
    };
}

// Auto-reconnect and refresh immediately when mobile screen turns on / tab gains focus
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            console.log('📱 Phone screen unlocked / tab active, reconnecting...');
            connectWebSocket();
        } else if (ws.readyState === WebSocket.OPEN) {
            // Screen unlocked: refresh snapshot & history to sync changes from desktop
            loadSnapshot(false);
            loadSidebarHistory();
            fetchAppState();
        }
    }
});

window.addEventListener('online', () => {
    console.log('🌐 Network online detected, reconnecting...');
    connectWebSocket();
});

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = '实时在线';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = '重连中...';
    }
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
async function loadSnapshot(isManual = false) {
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
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load snapshot');
        }

        chatIsOpen = true;
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

/* --- FORCE DARK MODE & HIGH-CONTRAST OVERRIDES --- */
:root, body, #chatContent, #conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"] {
    --bg-app: #080d16 !important;
    --text-main: #f8fafc !important;
    --text-muted: #94a3b8 !important;
    --border-color: #334155 !important;
    --background: #080d16 !important;
    --foreground: #f8fafc !important;
    --card: #121b30 !important;
    --card-foreground: #f8fafc !important;
    --card-border: #1a2640 !important;
    --secondary: #1a2640 !important;
    --secondary-foreground: #e2e8f0 !important;
    --muted: #121b30 !important;
    --muted-foreground: #94a3b8 !important;
    --border: rgba(255, 255, 255, 0.12) !important;
    --primary: #6366f1 !important;
    --primary-foreground: #ffffff !important;
    --accent: #6366f1 !important;
    --accent-foreground: #ffffff !important;
    --popover: #121b30 !important;
    --popover-foreground: #f8fafc !important;
    --max-conversation-width: 100% !important;
    color: #f8fafc !important;
}

#conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"], #chatContent, #conversation * {
    container-type: normal !important;
}

#conversation, .antigravity-snapshot-root, [data-testid="autoscroll-viewport"] {
    background-color: transparent !important;
    color: #f8fafc !important;
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
    color: #f8fafc !important;
    font-size: 15px;
    line-height: 1.6;
}

#conversation div[class*="bg-background"], #conversation [class*="md-sticky-message-bleed"] {
    background: #1a2640 !important;
    color: #f8fafc !important;
    border-radius: 12px !important;
    border: 1px solid rgba(255, 255, 255, 0.12) !important;
    padding: 12px 16px !important;
    margin: 12px 0 !important;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25) !important;
}

#conversation [data-testid="worked-for-collapsible"], #conversation button[class*="tabular-nums"], #conversation button:has(svg):has(span) {
    background: rgba(255, 255, 255, 0.06) !important;
    border: 1px solid rgba(255, 255, 255, 0.16) !important;
    border-radius: 8px !important;
    color: #f8fafc !important;
    padding: 8px 12px !important;
    margin: 8px 0 !important;
    display: flex !important;
    align-items: center !important;
    gap: 8px !important;
    cursor: pointer !important;
    font-size: 13px !important;
}

pre, code, .monaco-editor-background, [class*="terminal"] {
    background-color: #0f172a !important;
    color: #e2e8f0 !important;
    font-family: 'JetBrains Mono', Consolas, monospace !important;
    border-radius: 8px;
    border: 1px solid #1e293b;
}

pre {
    position: relative !important;
    white-space: pre-wrap !important;
    word-break: break-word !important;
    padding: 10px 12px !important;
    margin: 8px 0 !important;
    width: 100% !important;
}

.mobile-copy-btn {
    position: absolute !important;
    top: 6px !important;
    right: 6px !important;
    background: rgba(30, 41, 59, 0.9) !important;
    color: #94a3b8 !important;
    border: 1px solid rgba(255, 255, 255, 0.18) !important;
    width: 28px !important;
    height: 28px !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 6px !important;
    z-index: 10 !important;
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
async function loadSidebarHistory() {
    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        rawConversations = data.chats || [];

        renderSidebarConversations(rawConversations);

        // Update header active session title
        const activeChat = rawConversations.find(c => c.isActive);
        if (activeChat) {
            headerSessionTitle.textContent = activeChat.title;
        }
    } catch (e) {
        sidebarConvoList.innerHTML = `
            <div class="sidebar-state-empty">
                <span>⚠️ 加载历史失败</span>
            </div>
        `;
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
async function openUsageModal() {
    usageModalBody.innerHTML = `
        <div class="usage-loading">
            <div class="loading-spinner"></div>
            <p>正在计算当前会话 Token 消耗与配额状态...</p>
        </div>
    `;
    usageModalOverlay.classList.add('show');
    fetchUsageData();
}

async function fetchUsageData() {
    try {
        const res = await fetchWithAuth('/usage');
        const data = await res.json();
        renderUsageModal(data);
    } catch (e) {
        usageModalBody.innerHTML = `
            <div style="padding:20px; text-align:center; color:var(--error);">
                获取用量数据失败，请重试
            </div>
        `;
    }
}

function renderUsageModal(data) {
    const session = data.session || {};
    const system = data.system || {};
    const quota = data.quota || {};
    const matchedModel = data.matchedModel || {};
    const models = data.models || [];

    const turns = session.turns || 0;
    const tokens = (session.approxTokens || 0).toLocaleString();
    const maxTokens = (session.maxContextTokens || 1000000).toLocaleString();
    const percent = session.contextUsedPercent || 1;
    const nodes = session.nodes || 0;
    const payloadKb = session.payloadKb || 0;

    // Build models table rows
    const tableRows = models.map(m => {
        const isCurrent = (data.model && data.model.toLowerCase().includes(m.id)) || 
                          (m.name && m.name === data.model) ||
                          (m.id === matchedModel.id);
        const rowStyle = isCurrent ? 'background:rgba(99, 102, 241, 0.12); font-weight:600;' : '';
        const currentTag = isCurrent ? ' <span class="limit-badge primary">当前生效</span>' : '';
        return `
            <tr style="${rowStyle}">
                <td>
                    <b>${escapeHtml(m.displayName || m.name)}</b>${currentTag}
                    <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${escapeHtml(m.desc || '')}</div>
                </td>
                <td><b>${m.contextWindow || '1M'}</b></td>
                <td>${m.rpm || '标准'} / ${m.tpm || '高'}</td>
                <td>${m.rpd || '充裕'}</td>
                <td><span class="limit-badge success">${escapeHtml(m.dailyReset || '08:00 CST')}</span></td>
            </tr>
        `;
    }).join('');

    usageModalBody.innerHTML = `
        <!-- Section 1: 配额重置与限速刷新倒计时 -->
        <div class="usage-section-title">配额重置与速率刷新 (Quota & Recovery)</div>
        <div class="quota-reset-grid">
            <div class="quota-card">
                <div class="quota-card-header">
                    <span class="quota-card-title">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        每日配额总重置 (Daily RPD)
                    </span>
                    <span class="quota-card-badge">北京时间 08:00</span>
                </div>
                <div class="quota-countdown-val" id="dailyResetCountdownVal">${quota.dailyResetCountdown || '--:--:--'}</div>
                <div class="quota-card-desc">
                    ${quota.dailyResetRule || '每日 00:00 UTC (北京时间 08:00) 统一重置 RPD 配额'}
                </div>
            </div>

            <div class="quota-card sliding">
                <div class="quota-card-header">
                    <span class="quota-card-title">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
                        速率滑动窗口 (RPM / TPM)
                    </span>
                    <span class="quota-card-badge">60s 滑动窗口</span>
                </div>
                <div class="quota-countdown-val" id="slidingResetCountdownVal">${quota.slidingWindowSeconds || 60}s</div>
                <div class="quota-card-desc">
                    ${quota.slidingWindowRule || '突发超限 60 秒平滑恢复，无须等待次日'}
                </div>
            </div>
        </div>

        <!-- Section 2: 当前生效模型规格与速率配额 -->
        <div class="usage-section-title">当前模型用量规格与速率限制</div>
        <div class="active-model-card">
            <div class="active-model-header">
                <div class="active-model-name">
                    <span>${escapeHtml(matchedModel.name || data.model || currentModel)}</span>
                    <span class="limit-badge primary">${escapeHtml(matchedModel.badge || '活跃')}</span>
                </div>
                <span class="limit-badge success">${escapeHtml(matchedModel.rateLimit || '标准配额')}</span>
            </div>
            <div style="font-size:12px; color:var(--text-secondary); line-height:1.4;">
                ${escapeHtml(matchedModel.desc || '日常全能型工程助手')}
            </div>
            <div class="model-limits-grid" style="margin-top:10px;">
                <div class="model-limit-item">
                    <div class="model-limit-val">${matchedModel.contextWindow || '1M'}</div>
                    <div class="model-limit-lbl">上下文窗口</div>
                </div>
                <div class="model-limit-item">
                    <div class="model-limit-val">${matchedModel.maxOutput || '8,192'}</div>
                    <div class="model-limit-lbl">单次最大输出</div>
                </div>
                <div class="model-limit-item">
                    <div class="model-limit-val">${matchedModel.rpm || '15 ~ 360'}</div>
                    <div class="model-limit-lbl">分钟速率 (RPM)</div>
                </div>
                <div class="model-limit-item">
                    <div class="model-limit-val">${matchedModel.rpd || '1,500+'}</div>
                    <div class="model-limit-lbl">每日限额 (RPD)</div>
                </div>
            </div>
        </div>

        <!-- Section 3: 当前会话上下文占用与消耗 -->
        <div class="usage-section-title">当前会话统计 (Current Session)</div>
        <div class="usage-stats-grid">
            <div class="usage-stat-box">
                <div class="usage-stat-val">${turns}</div>
                <div class="usage-stat-lbl">对话轮次 (Turns)</div>
            </div>
            <div class="usage-stat-box">
                <div class="usage-stat-val">~${tokens}</div>
                <div class="usage-stat-lbl">估算 Tokens</div>
            </div>
            <div class="usage-stat-box">
                <div class="usage-stat-val">${percent}%</div>
                <div class="usage-stat-lbl">上下文已使用</div>
            </div>
        </div>

        <div class="usage-progress-card">
            <div class="usage-progress-header">
                <span>上下文窗口占用 (${tokens} / ${maxTokens} Tokens)</span>
                <span><b>${percent}%</b></span>
            </div>
            <div class="usage-progress-bar">
                <div class="usage-progress-fill" style="width: ${percent}%;"></div>
            </div>
            <div style="font-size:11px; color:var(--text-dim); margin-top:6px;">
                当前渲染节点: ${nodes} Nodes · 数据载荷: ${payloadKb} KB
            </div>
        </div>

        <!-- Section 4: 各模型配额限制与重置周期对比 -->
        <div class="usage-section-title">各模型配额限制与重置周期对比</div>
        <div style="background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-md); overflow-x:auto;">
            <table class="usage-table">
                <thead>
                    <tr>
                        <th style="min-width:140px;">模型名称</th>
                        <th>上下文</th>
                        <th>速率 (RPM/TPM)</th>
                        <th>每日上限 (RPD)</th>
                        <th>重置时间</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
        </div>

        <!-- Section 5: 系统通道与连接运行状态 -->
        <div class="usage-section-title">系统通道与连接运行状态</div>
        <div class="system-status-pills">
            <div class="sys-pill">当前模型: <b>${escapeHtml(data.model || currentModel)}</b></div>
            <div class="sys-pill">执行模式: <b>${escapeHtml(data.mode || currentMode)}</b></div>
            <div class="sys-pill">CDP 状态: <b>${system.cdpConnected ? '✅ 已连通' : '❌ 未连接'}</b></div>
            <div class="sys-pill">服务运行: <b>${system.uptimeFormatted || '刚刚启动'}</b></div>
            <div class="sys-pill">服务内存: <b>${system.memoryMb || 0} MB</b></div>
            <div class="sys-pill">端口: <b>${system.port || 3000}</b></div>
        </div>
    `;

    // Start live countdown timer for reset
    if (window.usageCountdownTimer) clearInterval(window.usageCountdownTimer);

    let dailySeconds = quota.dailyResetSecondsRemaining || 0;
    let slidingSeconds = quota.slidingWindowSeconds || 60;

    function updateCountdownDisplay() {
        const h = Math.floor(dailySeconds / 3600);
        const m = Math.floor((dailySeconds % 3600) / 60);
        const s = dailySeconds % 60;
        const dailyEl = document.getElementById('dailyResetCountdownVal');
        if (dailyEl) {
            dailyEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
        const slidingEl = document.getElementById('slidingResetCountdownVal');
        if (slidingEl) {
            slidingEl.textContent = `${slidingSeconds}s`;
        }
    }

    updateCountdownDisplay();

    window.usageCountdownTimer = setInterval(() => {
        if (dailySeconds > 0) dailySeconds--;
        else dailySeconds = 86400;

        if (slidingSeconds > 1) slidingSeconds--;
        else slidingSeconds = 60;

        updateCountdownDisplay();
    }, 1000);
}

function closeUsageModal() {
    if (window.usageCountdownTimer) {
        clearInterval(window.usageCountdownTimer);
        window.usageCountdownTimer = null;
    }
    usageModalOverlay.classList.remove('show');
}

usageBtn.addEventListener('click', openUsageModal);
sidebarUsageBtn.addEventListener('click', () => {
    closeMobileSidebar();
    openUsageModal();
});
closeUsageModalBtn.addEventListener('click', closeUsageModal);
confirmUsageModalBtn.addEventListener('click', closeUsageModal);
refreshUsageBtn.addEventListener('click', fetchUsageData);
usageModalOverlay.addEventListener('click', (e) => {
    if (e.target === usageModalOverlay) closeUsageModal();
});

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
async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    const originalMessage = message;

    // Instantly clear textarea and blur virtual keyboard
    messageInput.value = '';
    messageInput.style.height = 'auto';
    messageInput.blur();

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        if (!chatIsOpen) {
            await startNewChat();
            await new Promise(r => setTimeout(r, 600));
        }

        const res = await fetchWithAuth('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: originalMessage })
        });

        const data = await res.json().catch(() => null);

        if (!res.ok || !data || data.success === false || data.ok === false) {
            // Restore input text so the user never loses their drafted message!
            messageInput.value = originalMessage;
            messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
            
            const msg = data?.message || data?.error || '消息发送失败，请重试';
            showToast(msg, 'error');
            return;
        }

        showToast('消息已发送', 'success', 1800);

        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 800);
        setTimeout(loadSidebarHistory, 1500);
    } catch (e) {
        console.error('Send message error:', e);
        messageInput.value = originalMessage;
        messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
        showToast('发送失败：网络连接异常，请重试', 'error');
    } finally {
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
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

// Auto-grow textarea
messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 180) + 'px';
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

// --- Quick Actions ---
quickActionChips.forEach(chip => {
    chip.addEventListener('click', () => {
        const text = chip.getAttribute('data-text') || chip.innerText.trim();
        messageInput.value = text;
        messageInput.focus();
        messageInput.style.height = 'auto';
        messageInput.style.height = messageInput.scrollHeight + 'px';
    });
});

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
    return div.innerHTML;
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
