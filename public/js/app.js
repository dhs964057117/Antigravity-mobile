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
const headerThemeBtn = document.getElementById('headerThemeBtn');
const headerThemeIcon = document.getElementById('headerThemeIcon');
const historyLoaderBar = document.getElementById('historyLoaderBar');
const historyLoadMoreBtn = document.getElementById('historyLoadMoreBtn');
const historyLoaderText = document.getElementById('historyLoaderText');

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
const composerStatus = document.getElementById('composerStatus');
const commandPalette = document.getElementById('commandPalette');
const commandSearchInput = document.getElementById('commandSearchInput');
const commandResults = document.getElementById('commandResults');
const commandResultCount = document.getElementById('commandResultCount');

// --- State Variables ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0;
let ws = null;
let idleTimer = null;
let currentMode = 'Turbo';
let currentModel = 'Gemini 3.8 Flash High';
let isSending = false;
let isNavigating = false;
let deliveryState = 'idle';
let expectedSelectionId = null;
let navigationOriginId = '';
let authRedirecting = false;
let isAgentBusy = false;
let rawConversations = [];
let availableModels = [];

const USER_SCROLL_LOCK_DURATION = 3000;

// --- Theme Management (Dark / Light / System) ---
const THEME_STORAGE_KEY = 'ag_theme_preference';
let currentThemePref = (function() {
    try {
        if (typeof localStorage !== 'undefined') {
            return localStorage.getItem(THEME_STORAGE_KEY) || 'system';
        }
    } catch (e) {}
    return 'system';
})();

function getSystemTheme() {
    try {
        if (typeof window !== 'undefined' && window.matchMedia) {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
    } catch (e) {}
    return 'dark';
}

function resolveTheme(pref) {
    if (pref === 'system') return getSystemTheme();
    return pref === 'light' ? 'light' : 'dark';
}

// Parse selectors with the browser's CSS parser, then contain every imported rule.
// In particular, desktop :root, button and modal rules must never style our shell.
function splitSnapshotSelectors(selector) {
    const parts = [];
    let start = 0, depth = 0, quote = '', escaped = false;
    for (let i = 0; i < selector.length; i++) {
        const char = selector[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (quote) { if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '(' || char === '[') depth++;
        if (char === ')' || char === ']') depth--;
        if (char === ',' && depth === 0) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(selector.slice(start).trim());
    return parts.filter(Boolean);
}

function scopeSnapshotRules(rules) {
    return Array.from(rules).map(rule => {
        if (rule.type === 1 && rule.selectorText) {
            const selectors = splitSnapshotSelectors(rule.selectorText)
                .map(selector => `:where(#chatContent) ${selector}`).join(', ');
            return selectors + ' ' + rule.cssText.slice(rule.cssText.indexOf('{'));
        }
        // Keep layout queries and layers, but never import global fonts, properties or keyframes.
        if (rule.cssRules && /^@(media|supports|container|layer)\b/i.test(rule.cssText)) {
            return rule.cssText.slice(0, rule.cssText.indexOf('{')) + '{' + scopeSnapshotRules(rule.cssRules) + '}';
        }
        return '';
    }).join('\n');
}

function generateSnapshotStyles(rawCss) {
    if (!rawCss || typeof CSSStyleSheet === 'undefined') return '';
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(rawCss);
        return scopeSnapshotRules(sheet.cssRules);
    } catch (e) {
        // Base Markdown styling remains usable if a desktop stylesheet cannot be parsed.
        return '';
    }
}

function decorateSnapshotControls() {
    chatContent.querySelectorAll('button, [role="button"], summary, [data-testid="worked-for-collapsible"]').forEach(control => {
        if (control.matches('.codex-copy-btn, .ag-review-summary')) return;
        const text = (control.innerText || control.textContent || '').trim();
        const thought = control.matches('[data-testid="worked-for-collapsible"], summary') ||
            (text.length < 180 && /^(thought|thinking|worked for|思考|已思考|正在思考|edited|changed|\d+\s+files?\b)/i.test(text));
        const action = text.length < 100 && /^(review|open|view|run|allow|deny|accept|reject|confirm|审查|查看|打开|运行|允许|拒绝|确认)\b/i.test(text);
        control.classList.toggle('ag-snapshot-toggle', thought);
        control.classList.toggle('ag-snapshot-action', !thought && action);
    });
}

function snapshotCodeText(pre) {
    const lines = Array.from(pre.querySelectorAll('.code-line'));
    if (lines.length) return lines.map(line => (line.querySelector('.line-content') || line).textContent || '').join('\n');
    return (pre.querySelector('code') || pre).textContent || '';
}

// Normalize the actual desktop markup before morphing it into the document.
function prepareSnapshotContent(root) {
    root.querySelectorAll('style, script, link[rel="stylesheet"]').forEach(el => el.remove());
    root.querySelectorAll('[data-testid="planner-response-text"] > div, .md-divider-spacing, .prose, .markdown').forEach(el => {
        if (!el.parentElement?.closest('.ag-markdown')) el.classList.add('ag-markdown');
    });
    root.querySelectorAll('.files-changed-header').forEach(header => {
        header.classList.add('ag-review-header');
        header.setAttribute('role', 'group');
        header.setAttribute('aria-label', '文件变更');
        header.firstElementChild?.classList.add('ag-review-summary');
        const summary = header.firstElementChild;
        if (summary && summary.tagName !== 'BUTTON') {
            summary.setAttribute('role', 'button');
            summary.setAttribute('tabindex', '0');
            summary.setAttribute('aria-label', '展开或收起文件变更');
            summary.setAttribute('aria-expanded', String(header.parentElement?.children.length > 1));
        }
        if (header.parentElement && header.parentElement !== root) header.parentElement.classList.add('ag-review-card');
        header.querySelector('.review-button')?.classList.add('ag-review-button');
    });
    root.querySelectorAll('pre').forEach(pre => {
        const lines = pre.querySelectorAll('.code-line');
        const existingCode = pre.querySelector('code');
        if (!lines.length && existingCode) { pre.replaceChildren(existingCode); return; }
        const languageLabel = (pre.querySelector('.font-sans')?.textContent || '').trim().toLowerCase();
        const code = document.createElement('code');
        if (/^[a-z0-9_+#.-]{1,24}$/.test(languageLabel)) code.className = 'language-' + languageLabel;
        if (lines.length) {
            Array.from(lines).forEach((line, index) => {
                if (index) code.appendChild(document.createTextNode('\n'));
                const content = line.querySelector('.line-content') || line;
                Array.from(content.childNodes).forEach(child => code.appendChild(child.cloneNode(true)));
            });
        } else if (pre.querySelector('.code-block')) {
            Array.from(pre.querySelector('.code-block').childNodes).forEach(child => code.appendChild(child.cloneNode(true)));
        } else {
            while (pre.firstChild) code.appendChild(pre.firstChild);
        }
        pre.replaceChildren(code);
    });
    root.querySelectorAll('table').forEach(table => {
        if (table.parentElement?.classList.contains('ag-table-scroll')) return;
        const scroll = document.createElement('div');
        scroll.className = 'ag-table-scroll';
        scroll.setAttribute('role', 'region');
        scroll.setAttribute('aria-label', '表格，可横向滚动');
        scroll.setAttribute('tabindex', '0');
        table.replaceWith(scroll);
        scroll.appendChild(table);
    });
}

function applyTheme(pref, save = true) {
    currentThemePref = pref || 'system';
    if (save) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(THEME_STORAGE_KEY, currentThemePref);
            }
        } catch (e) {}
    }
    const resolved = resolveTheme(currentThemePref);

    const doc = (typeof document !== 'undefined') ? (document.documentElement || document.body) : null;
    if (doc && doc.setAttribute) {
        doc.setAttribute('data-theme', resolved);
        doc.setAttribute('data-theme-preference', currentThemePref);
    }



    // Update header theme icon
    const headerIcon = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('headerThemeIcon') : null;
    const headerBtn = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('headerThemeBtn') : null;
    if (headerIcon) {
        if (resolved === 'dark') {
            headerIcon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
        } else {
            headerIcon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
        }
    }
    if (headerBtn) {
        const label = currentThemePref === 'system' ? `跟随系统 (${resolved === 'dark' ? '深色' : '浅色'})` : (currentThemePref === 'light' ? '浅色模式' : '深色模式');
        headerBtn.title = `深浅主题: ${label} (点击切换)`;
    }


}

function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    const nextIdx = (order.indexOf(currentThemePref) + 1) % order.length;
    const nextTheme = order[nextIdx];
    applyTheme(nextTheme, true);
    if (typeof showToast === 'function') {
        showToast(`已切换主题为: ${nextTheme === 'system' ? '跟随系统' : (nextTheme === 'light' ? '浅色模式' : '深色模式')}`, 'info');
    }
}

function initTheme() {
    applyTheme(currentThemePref, false);

    if (typeof window !== 'undefined' && window.matchMedia) {
        try {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
                if (currentThemePref === 'system') {
                    applyTheme('system', false);
                }
            });
        } catch (e) {}
    }

    const chips = (typeof document !== 'undefined' && document.querySelectorAll) ? document.querySelectorAll('.theme-chip') : [];
    if (chips && chips.forEach) {
        chips.forEach(chip => {
            if (chip.addEventListener) {
                chip.addEventListener('click', () => {
                    if (chip.dataset && chip.dataset.themeVal) {
                        applyTheme(chip.dataset.themeVal, true);
                    }
                });
            }
        });
    }

    const headerBtn = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('headerThemeBtn') : null;
    if (headerBtn && headerBtn.addEventListener) {
        headerBtn.addEventListener('click', cycleTheme);
    }
}

// --- History Loading Management (拉取更多历史记录) ---
let isLoadingOlderHistory = false;
let lastHistoryLoadTime = 0;

async function requestOlderMessages() {
    if (isLoadingOlderHistory) return;
    const now = Date.now();
    if (now - lastHistoryLoadTime < 1200) return;
    isLoadingOlderHistory = true;
    lastHistoryLoadTime = now;

    if (historyLoadMoreBtn && historyLoadMoreBtn.classList) {
        historyLoadMoreBtn.classList.add('loading');
    }
    const origText = historyLoaderText ? historyLoaderText.textContent : '';
    if (historyLoaderText) historyLoaderText.textContent = '正在拉取更早历史消息...';

    const prevScrollHeight = chatContainer ? chatContainer.scrollHeight : 0;
    const prevScrollTop = chatContainer ? chatContainer.scrollTop : 0;

    try {
        const res = await fetchWithAuth('/load-older-messages', { method: 'POST' });
        if (res.ok) {
            const result = await res.json();
            if (result && result.noMore) {
                if (historyLoadMoreBtn) {
                    historyLoadMoreBtn.disabled = true;
                    historyLoadMoreBtn.style.opacity = '0.6';
                    historyLoadMoreBtn.style.cursor = 'default';
                }
                if (historyLoaderText) historyLoaderText.textContent = '已加载全部历史消息';
                return;
            }
            await loadSnapshot(false, { isHistoryLoad: true, prevScrollHeight, prevScrollTop });
        }
    } catch (err) {
        console.error('Failed to load older messages:', err);
    } finally {
        isLoadingOlderHistory = false;
        if (historyLoadMoreBtn && historyLoadMoreBtn.classList) {
            historyLoadMoreBtn.classList.remove('loading');
        }
        if (historyLoaderText && origText && (!historyLoadMoreBtn || !historyLoadMoreBtn.disabled)) {
            historyLoaderText.textContent = origText;
        }
    }
}

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
    stopBtn.hidden = !isAgentBusy;
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
    updateComposerStatus();
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

const volatileSession = new Map();
function readSession(key) {
    if (volatileSession.has(key)) return volatileSession.get(key);
    try { return sessionStorage.getItem(key); } catch { return null; }
}
function saveSession(key, value) {
    volatileSession.set(key, value);
    try {
        if (value === null) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, value);
        return true;
    } catch { return false; /* Storage can be unavailable in private browsing. */ }
}
// Drafts and retry receipts belong to a conversation, including unsent new chats.
let activeConversationKey = readSession('ag_active_conversation') || 'unassigned';
let activeConversationId = activeConversationKey.startsWith('id:') ? activeConversationKey.slice(3) : '';
const draftKey = key => `ag_message_draft:${key}`;
const pendingKey = key => `ag_pending_send:${key}`;
function readPending(key) {
    try {
        const value = JSON.parse(readSession(pendingKey(key)));
        return value && typeof value.message === 'string' && typeof value.requestId === 'string' ? value : null;
    } catch { return null; }
}
let pendingSend = readPending(activeConversationKey);
if (!pendingSend) {
    try { pendingSend = JSON.parse(readSession('ag_pending_send')); } catch { /* Ignore old data. */ }
}
if (!pendingSend || typeof pendingSend.message !== 'string' || typeof pendingSend.requestId !== 'string') pendingSend = null;
const restoredDraft = readSession(draftKey(activeConversationKey)) ?? readSession('ag_message_draft') ?? pendingSend?.message;
if (restoredDraft) messageInput.value = restoredDraft;
if (restoredDraft !== undefined && restoredDraft !== null) saveSession(draftKey(activeConversationKey), restoredDraft || null);
if (pendingSend) saveSession(pendingKey(activeConversationKey), JSON.stringify(pendingSend));
deliveryState = pendingSend ? 'uncertain' : restoredDraft ? 'draft' : 'idle';
saveSession('ag_message_draft', null);
saveSession('ag_pending_send', null);

function conversationKey(chat) {
    return chat.id ? `id:${chat.id}` : `title:${JSON.stringify([chat.workspace || '', chat.title || ''])}`;
}
function savePending() {
    saveSession(pendingKey(activeConversationKey), pendingSend ? JSON.stringify(pendingSend) : null);
}
function persistComposerDraft() {
    const saved = saveSession(draftKey(activeConversationKey), messageInput.value || null);
    if (deliveryState !== 'sending') deliveryState = messageInput.value ? (saved ? 'draft' : 'memory') : 'idle';
    updateComposerStatus();
    sidebarConvoList.querySelectorAll('[data-draft-for]').forEach(badge => {
        badge.hidden = !readSession(draftKey(badge.getAttribute('data-draft-for')));
    });
}
function activateConversation(key, id = '', migrate = false) {
    if (!key || key === activeConversationKey) return;
    const oldKey = activeConversationKey;
    persistComposerDraft();
    savePending();
    // First sync and the first submission of a new chat acquire a real ID.
    if (migrate && readSession(draftKey(key)) === null) {
        saveSession(draftKey(key), messageInput.value || null);
        if (pendingSend) saveSession(pendingKey(key), JSON.stringify(pendingSend));
        saveSession(draftKey(oldKey), null);
        saveSession(pendingKey(oldKey), null);
    }
    activeConversationKey = key;
    activeConversationId = id;
    saveSession('ag_active_conversation', key);
    pendingSend = readPending(key);
    messageInput.value = readSession(draftKey(key)) ?? pendingSend?.message ?? '';
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
    deliveryState = pendingSend ? 'uncertain' : messageInput.value ? 'draft' : 'idle';
    updateSendButtonState();
    updateComposerStatus();
    if (rawConversations.length) renderSidebarConversations(rawConversations);
}
function acceptsConversationId(id) {
    if (expectedSelectionId) return id === expectedSelectionId;
    if (expectedSelectionId === '' && id && id === navigationOriginId) return false;
    return !isSending || !activeConversationId || id === activeConversationId;
}
function syncConversationId(id) {
    if (isSending || isNavigating || typeof id !== 'string' || !acceptsConversationId(id)) return;
    if (expectedSelectionId !== null) {
        if (expectedSelectionId && id !== expectedSelectionId) return;
        if (expectedSelectionId === '' && id && id === navigationOriginId) return;
        expectedSelectionId = null;
    }
    if (!id) {
        if (activeConversationId) activateConversation('unassigned');
        return;
    }
    activateConversation(`id:${id}`, id, activeConversationKey === 'unassigned' || activeConversationKey.startsWith('new:'));
}
function updateComposerStatus() {
    if (!composerStatus) return;
    const state = isNavigating ? 'navigating' : isSending ? 'sending' : deliveryState;
    const labels = { idle: isAgentBusy ? '智能体正在执行，可发送插话' : '输入消息开始协作', draft: '此会话草稿已保存', memory: '草稿保留在当前页面', navigating: '正在切换会话…', sending: '正在提交到桌面…', sent: '已提交到桌面', failed: '发送失败，草稿已保留', uncertain: '结果未确认，请检查会话后重试' };
    const label = labels[state] || labels.idle;
    if (composerStatus.textContent !== label) composerStatus.textContent = label;
    composerStatus.setAttribute('data-state', state);
    messageInput.readOnly = isNavigating;
    sidebarNewChatBtn.disabled = isNavigating || isSending;
    sendBtn.disabled = isNavigating || isSending;
}
let collapsedProjects = new Set();
try {
    const saved = JSON.parse(readSession('ag_collapsed_projects'));
    if (Array.isArray(saved)) collapsedProjects = new Set(saved.filter(value => typeof value === 'string').slice(0, 200));
} catch { /* Use expanded groups by default. */ }

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
    syncSidebarAccessibility();
}

function syncSidebarAccessibility() {
    const hidden = !isDesktop() && !sidebar.classList.contains('open');
    sidebar.inert = hidden;
    sidebar.setAttribute('aria-hidden', String(hidden));
    sidebarToggleBtn.setAttribute('aria-expanded', String(!hidden && !sidebar.classList.contains('collapsed')));
}

function toggleSidebar() {
    if (isDesktop()) {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        try { localStorage.setItem('ag_sidebar_collapsed', isCollapsed ? 'true' : 'false'); } catch { /* Keep this session usable. */ }
    } else {
        const isOpen = sidebar.classList.toggle('open');
        sidebarBackdrop.classList.toggle('show', isOpen);
    }
    syncSidebarAccessibility();
}

function closeMobileSidebar() {
    if (!isDesktop()) {
        sidebar.classList.remove('open');
        sidebarBackdrop.classList.remove('show');
    }
    syncSidebarAccessibility();
}

sidebarToggleBtn.addEventListener('click', toggleSidebar);
sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
sidebarBackdrop.addEventListener('click', closeMobileSidebar);

window.addEventListener('resize', () => {
    if (isDesktop() && sidebar.classList.contains('open')) {
        closeMobileSidebar();
    }
    syncSidebarAccessibility();
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

        if (typeof data.conversationId === 'string') syncConversationId(data.conversationId);
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
function morphDOM(oldRoot, newRoot, syncAttributes = true) {
    const oldAttrs = oldRoot.attributes;
    const newAttrs = newRoot.attributes;
    const preserveDetails = oldRoot.tagName === 'DETAILS' && oldRoot.dataset.clientDetailsConversation === activeConversationKey &&
        oldRoot.querySelector('summary')?.textContent === newRoot.querySelector('summary')?.textContent;
    if (oldRoot.tagName === 'DETAILS' && !preserveDetails) {
        delete oldRoot.dataset.clientDetailsConversation;
    }

    if (syncAttributes && oldAttrs && newAttrs) {
        for (let i = oldAttrs.length - 1; i >= 0; i--) {
            const name = oldAttrs[i].name;
            if (preserveDetails && name === 'open') continue;
            if (!newRoot.hasAttribute(name) && !name.startsWith('data-client-')) {
                oldRoot.removeAttribute(name);
            }
        }
        for (let i = 0; i < newAttrs.length; i++) {
            const name = newAttrs[i].name;
            if (preserveDetails && name === 'open') continue;
            const val = newAttrs[i].value;
            if (oldRoot.getAttribute(name) !== val) {
                oldRoot.setAttribute(name, val);
            }
        }
    }

    const oldChildren = Array.from(oldRoot.childNodes).filter(
        n => !(n.nodeType === Node.ELEMENT_NODE && (n.classList.contains('mobile-copy-btn') ||
            (oldRoot.tagName === 'PRE' && n.classList.contains('codex-code-bar'))))
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
async function loadSnapshot(isManual = false, options = {}) {
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

        if (isNavigating) return;
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
        if (isNavigating) return;
        if (typeof data.conversationId === 'string') {
            if (!acceptsConversationId(data.conversationId)) return;
            syncConversationId(data.conversationId);
        }

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
            if (statsText) statsText.textContent = '已同步 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        }

        // CSS Injection (Cached & Theme Adaptive)
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag && document.head && document.head.appendChild) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        if (styleTag) {
            if (!styleTag.dataset) styleTag.dataset = {};
            if (styleTag.dataset.rawCss !== data.css) {
                styleTag.dataset.rawCss = data.css;
                styleTag.textContent = generateSnapshotStyles(data.css);
            }
        }

        // History older messages indicator update
        if (data.history) {
            if (historyLoaderBar) {
                historyLoaderBar.style.display = 'flex';
                if (data.history.hasOlder) {
                    if (historyLoadMoreBtn) {
                        historyLoadMoreBtn.disabled = false;
                        historyLoadMoreBtn.style.opacity = '1';
                        historyLoadMoreBtn.style.cursor = 'pointer';
                    }
                    if (historyLoaderText) {
                        if (data.history.showing && data.history.total) {
                            historyLoaderText.textContent = `加载更早历史消息 (已显示 ${data.history.showing}/${data.history.total})`;
                        } else {
                            historyLoaderText.textContent = '加载更早历史消息';
                        }
                    }
                } else {
                    if (historyLoadMoreBtn) {
                        historyLoadMoreBtn.disabled = true;
                        historyLoadMoreBtn.style.opacity = '0.6';
                        historyLoadMoreBtn.style.cursor = 'default';
                    }
                    if (historyLoaderText) {
                        if (data.history.showing && data.history.total) {
                            historyLoaderText.textContent = `已加载全部历史消息 (${data.history.showing}/${data.history.total})`;
                        } else {
                            historyLoaderText.textContent = '已显示全部历史消息';
                        }
                    }
                }
            }
        } else if (historyLoaderBar) {
            historyLoaderBar.style.display = 'none';
        }

        const wasEmpty = !chatContent.firstElementChild ||
            chatContent.querySelector('.empty-state') ||
            chatContent.querySelector('.loading-state');

        const isSnapshotEmpty = !data.html || !data.html.trim() ||
            (data.html.length < 500 && !data.html.includes('user-input-step') && !data.html.includes('md-sticky-message-bleed'));

        if (isSnapshotEmpty) {
            renderCodexWelcomeScreen();
        } else {
            const temp = document.createElement('div');
            temp.innerHTML = data.html;
            prepareSnapshotContent(temp);
            if (wasEmpty) chatContent.replaceChildren(...temp.childNodes);
            else morphDOM(chatContent, temp, false);
        }

        decorateSnapshotControls();
        addCodexCodeHeaders();

        // Update steer mode from snapshot stats or flags
        if (typeof data.isBusy === 'boolean' || (data.stats && typeof data.stats.isBusy === 'boolean')) {
            setSteerMode(!!(data.isBusy || (data.stats && data.stats.isBusy)));
        }

        // Scroll positioning
        const newScrollHeight = chatContainer.scrollHeight;
        if (options && options.isHistoryLoad) {
            const diff = newScrollHeight - (options.prevScrollHeight || 0);
            chatContainer.scrollTop = (options.prevScrollTop || 0) + (diff > 0 ? diff : 0);
            userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
        } else if (wasEmpty) {
            chatContainer.scrollTop = newScrollHeight;
        } else if (isUserScrollLocked) {
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            chatContainer.scrollTop = newScrollHeight * scrollPercent;
        } else if (isNearBottom) {
            chatContainer.scrollTop = newScrollHeight;
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

// --- OpenAI Codex Welcome Screen (Empty State) ---
function renderCodexWelcomeScreen() {
    chatContent.innerHTML = `
        <div class="codex-welcome-view">
            <div class="codex-welcome-avatar">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="12 2 2 7 12 12 22 7 12 2" />
                    <polyline points="2 17 12 22 22 17" />
                    <polyline points="2 12 12 17 22 12" />
                </svg>
            </div>
            <h2 class="codex-welcome-title">今天有什么我可以帮你的？</h2>
            <div class="codex-suggestions-grid">
                <button class="codex-suggestion-card" data-prompt="请继续推进当前会话任务，完成未竟的编码与自测">
                    <div class="suggestion-icon">🚀</div>
                    <div class="suggestion-text">
                        <strong>继续推进任务</strong>
                        <span>一键执行未完成的代码并自动自测</span>
                    </div>
                </button>
                <button class="codex-suggestion-card" data-prompt="请详细解释当前代码架构的设计模式与实现细节">
                    <div class="suggestion-icon">💡</div>
                    <div class="suggestion-text">
                        <strong>剖析架构原理</strong>
                        <span>解释核心模块实现细节与设计决策</span>
                    </div>
                </button>
                <button class="codex-suggestion-card" data-prompt="请全面检查代码中的潜在边界漏洞、异常处理与健壮性">
                    <div class="suggestion-icon">🛠️</div>
                    <div class="suggestion-text">
                        <strong>代码审查与加固</strong>
                        <span>排查潜在边界异常与性能瓶颈</span>
                    </div>
                </button>
                <button class="codex-suggestion-card" data-prompt="请总结当前工程的已变更文件、核心进展与下一步行动项">
                    <div class="suggestion-icon">📋</div>
                    <div class="suggestion-text">
                        <strong>生成进展报告</strong>
                        <span>梳理已变更文件与后续待办建议</span>
                    </div>
                </button>
            </div>
        </div>
    `;

    chatContent.querySelectorAll('.codex-suggestion-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const prompt = btn.getAttribute('data-prompt');
            if (prompt) sendMessage(prompt);
        });
    });
}

// --- OpenAI Codex Code Block Headers & Copy Buttons ---
function addCodexCodeHeaders() {
    const codeBlocks = chatContent.querySelectorAll('pre');
    codeBlocks.forEach((pre) => {
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = snapshotCodeText(pre);
        if (!textToCopy) return;

        // Detect language
        let lang = 'code';
        const classes = (codeElement.className || '') + ' ' + (pre.className || '');
        const match = classes.match(/(?:language-|lang-)([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
            lang = match[1].toLowerCase();
        } else {
            if (/^\s*(import|from|def |class |print\(|if __name__)/m.test(textToCopy)) lang = 'python';
            else if (/^\s*(const |let |var |function|import .* from|console\.log)/m.test(textToCopy)) lang = 'javascript';
            else if (/^\s*(<html|<!DOCTYPE|<div|<script|<template)/im.test(textToCopy)) lang = 'html';
            else if (/^\s*(curl|git |npm |pnpm |yarn |pip |python |bash|cd |ls |mkdir)/m.test(textToCopy)) lang = 'bash';
            else if (/^\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/m.test(textToCopy)) lang = 'json';
            else if (/@import|{\s*margin|{\s*padding|\.[\w-]+\s*\{/m.test(textToCopy)) lang = 'css';
        }

        codeElement.setAttribute('tabindex', '0');
        codeElement.setAttribute('role', 'region');
        codeElement.setAttribute('aria-label', lang + ' 代码，可横向滚动');
        const existingBar = pre.querySelector('.codex-code-bar');
        if (existingBar) {
            existingBar.querySelector('.codex-code-lang').textContent = lang;
            return;
        }
        const bar = document.createElement('div');
        bar.className = 'codex-code-bar';
        bar.innerHTML = `
            <span class="codex-code-lang">${escapeHtml(lang)}</span>
            <button class="codex-copy-btn" aria-label="复制代码" title="复制代码">
                <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span class="copy-label">复制代码</span>
            </button>
        `;

        const copyBtn = bar.querySelector('.codex-copy-btn');
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ok = await copyToClipboard(snapshotCodeText(pre));
            if (ok) {
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" width="13" height="13" stroke="#10b981" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    <span class="copy-label" style="color:#10b981;">已复制!</span>
                `;
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
                        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <span class="copy-label">复制代码</span>
                    `;
                }, 2000);
            } else {
                showToast('复制失败，请选择代码后手动复制', 'error');
            }
        });

        pre.insertBefore(bar, pre.firstChild);
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

        const current = rawConversations.find(chat => chat.isActive && chat.id);
        if (current) syncConversationId(current.id);
        renderSidebarConversations(rawConversations);
        if (paletteIsOpen) renderCommandResults();

        // Update header active session title
        const activeChat = rawConversations.find(c => c.isActive);
        if (activeChat && !isNavigating && (expectedSelectionId === null || (expectedSelectionId && activeChat.id === expectedSelectionId))) {
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

let lastSidebarMarkup = null;
function renderSidebarConversations(chats) {
    const query = sidebarSearchInput.value.trim().toLowerCase();
    if (query) chats = chats.filter(chat => `${chat.title} ${chat.workspace || ''}`.toLowerCase().includes(query));
    sidebarSearchClear.style.display = query ? 'block' : 'none';
    if (chats.length === 0) {
        lastSidebarMarkup = null;
        sidebarConvoList.innerHTML = `
            <div class="sidebar-state-empty">
                <span>${query ? '没有匹配的会话' : '暂无历史会话'}</span>
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
        const isActive = activeConversationId ? chat.id === activeConversationId : activeConversationKey.startsWith('new:') ? false : chat.isActive;
        const safeTitle = escapeHtml(chat.title);
        const safeWorkspace = escapeHtml(chat.workspace || '');
        const safeId = escapeHtml(chat.id || '');
        return `
            <button type="button" class="sidebar-card ${isActive ? 'active' : ''}" aria-current="${isActive ? 'page' : 'false'}" data-title="${safeTitle}" data-workspace="${safeWorkspace}" data-id="${safeId}">
                <div class="sidebar-card-icon">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                </div>
                <div class="sidebar-card-content">
                    <span class="sidebar-card-title">${safeTitle}</span>
                    <div class="sidebar-card-meta">
                        ${chat.workspace ? `<span class="sidebar-card-workspace">📁 ${safeWorkspace}</span>` : ''}
                        ${isActive ? '<span class="sidebar-active-badge">当前</span>' : ''}
                        <span class="sidebar-draft-badge" data-draft-for="${escapeHtml(conversationKey(chat))}" ${readSession(draftKey(conversationKey(chat))) ? '' : 'hidden'}>草稿</span>
                    </div>
                </div>
                ${chat.timestamp ? `<span class="sidebar-card-time">${escapeHtml(chat.timestamp)}</span>` : ''}
            </button>
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
                <div class="sidebar-project-group ${!query && collapsedProjects.has(workspaceName) ? 'collapsed' : ''}" data-project="${escapeHtml(workspaceName)}">
                    <button type="button" class="sidebar-project-header" aria-expanded="${query || !collapsedProjects.has(workspaceName) ? 'true' : 'false'}">
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
                    </button>
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

    if (lastSidebarMarkup === html) return;
    const focused = sidebarConvoList.contains?.(document.activeElement) ? document.activeElement : null;
    const focusId = focused?.getAttribute('data-id');
    const focusTitle = focused?.getAttribute('data-title');
    const focusProject = focused?.classList.contains('sidebar-project-header') ? focused.closest('.sidebar-project-group')?.getAttribute('data-project') : null;
    const previousScroll = sidebarConvoList.scrollTop;
    sidebarConvoList.innerHTML = html;
    lastSidebarMarkup = html;
    sidebarConvoList.scrollTop = previousScroll;
    if (focused) sidebarConvoList.querySelectorAll('button').forEach(button => {
        if ((focusId !== null && button.getAttribute('data-id') === focusId && button.getAttribute('data-title') === focusTitle) ||
            (focusProject && button.classList.contains('sidebar-project-header') && button.closest('.sidebar-project-group')?.getAttribute('data-project') === focusProject)) button.focus({ preventScroll: true });
    });
}

// Filtering is reapplied from the source list, including after background refresh.
sidebarSearchInput.addEventListener('input', () => renderSidebarConversations(rawConversations));
sidebarSearchClear.addEventListener('click', () => {
    sidebarSearchInput.value = '';
    renderSidebarConversations(rawConversations);
    sidebarSearchInput.focus();
});

// Sidebar Event Delegation
sidebarConvoList.addEventListener('click', async (e) => {
    const projectHeader = e.target.closest('.sidebar-project-header');
    if (projectHeader) {
        const group = projectHeader.closest('.sidebar-project-group');
        if (group) {
            const name = group.getAttribute('data-project');
            const collapsed = group.classList.toggle('collapsed');
            if (collapsed) collapsedProjects.add(name); else collapsedProjects.delete(name);
            projectHeader.setAttribute('aria-expanded', String(!collapsed));
            saveSession('ag_collapsed_projects', JSON.stringify([...collapsedProjects].slice(-200)));
        }
        return;
    }

    const card = e.target.closest('.sidebar-card');
    if (card) {
        const title = card.getAttribute('data-title');
        const id = card.getAttribute('data-id') || '';
        closeMobileSidebar();
        selectChat(title, id);
    }
});

// --- Select / Switch Conversation ---
async function selectChat(title, id = '') {
    if (!title && !id) return;
    if (isSending || isNavigating) { showToast('上一项操作正在处理，请稍后切换会话', 'info'); return; }
    isNavigating = true;
    const previousTitle = headerSessionTitle.textContent;
    updateComposerStatus();

    headerSessionTitle.textContent = title || '切换会话';
    chatContent.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <p style="font-size:15px; font-weight:600; color:var(--text-main);">正在切换会话...</p>
            <p style="font-size:12px; color:var(--text-muted); margin-top:4px;">${escapeHtml(title || id)}</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, id })
        });
        const data = await res.json();

        if (res.ok && data.success) {
            expectedSelectionId = id || null;
            activateConversation(id ? `id:${id}` : conversationKey({ title, workspace: '' }), id);
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(loadSnapshot, 1600);
            setTimeout(loadSidebarHistory, 1200);
        } else {
            headerSessionTitle.textContent = previousTitle;
            showToast(data.message || '切换会话失败，草稿已保留', 'error');
            console.error('Failed to select chat:', data.error);
            loadSnapshot();
        }
    } catch (e) {
        headerSessionTitle.textContent = previousTitle;
        showToast('未确认会话切换，请同步后重试', 'error');
        console.error('Select chat error:', e);
        loadSnapshot();
    } finally {
        isNavigating = false;
        updateComposerStatus();
        fetchAppState();
    }
}

// --- Start New Chat ---
async function startNewChat() {
    if (isSending || isNavigating) { showToast('上一项操作正在处理，请稍后新建会话', 'info'); return false; }
    isNavigating = true;
    navigationOriginId = activeConversationId;
    updateComposerStatus();
    sidebarNewChatBtn.style.opacity = '0.5';
    closeMobileSidebar();

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
            expectedSelectionId = '';
            activateConversation(`new:${window.crypto?.randomUUID?.() || Date.now()}`);
            headerSessionTitle.textContent = '新会话';
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1200);
            setTimeout(loadSidebarHistory, 1500);
            return true;
        }
        showToast(data.message || '新建会话失败，草稿已保留', 'error');
    } catch (e) {
        showToast('新建会话失败，草稿已保留', 'error');
        console.error('New chat error:', e);
    } finally {
        isNavigating = false;
        updateComposerStatus();
        setTimeout(() => sidebarNewChatBtn.style.opacity = '1', 500);
    }
}

sidebarNewChatBtn.addEventListener('click', startNewChat);

// --- Model Switcher Logic ---
const modelSearchInput = document.getElementById('modelSearchInput');
const modelSelectionStatus = document.getElementById('modelSelectionStatus');
let modelSelectionPending = false;
let modelListLoading = false;
let modelDialogOpener = null;
let modelLoadVersion = 0;

async function openModelModal() {
    modelDialogOpener = document.activeElement;
    modelSearchInput.value = '';
    modelModalOverlay.classList.add('show');
    document.getElementById('appShell').inert = true;
    modelSearchInput.focus();
    await loadModels();
}

async function loadModels() {
    const version = ++modelLoadVersion;
    modelListLoading = true;
    modelSelectionStatus.textContent = '正在获取可用模型…';
    modelCardsGrid.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>正在获取模型列表…</p></div>';
    try {
        const res = await fetchWithAuth('/models');
        const data = await res.json();
        if (!res.ok || data.error) throw new Error('models unavailable');
        if (version !== modelLoadVersion) return;
        availableModels = (data.models || []).filter(model => model && typeof model.name === 'string');
        modelListLoading = false;
        renderModelCards(availableModels);
    } catch (e) {
        if (version !== modelLoadVersion) return;
        modelSelectionStatus.textContent = '模型列表加载失败';
        modelCardsGrid.innerHTML = '<div class="model-empty"><p>暂时无法获取模型列表</p><button class="modal-btn-cancel" id="retryModelsBtn" type="button">重试</button></div>';
    } finally {
        if (version === modelLoadVersion) modelListLoading = false;
    }
}

function renderModelCards(models = availableModels) {
    const terms = modelSearchInput.value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const filtered = models.filter(m => terms.every(term => [m.name, m.displayName, m.family, m.desc, m.badge].join(' ').toLocaleLowerCase().includes(term)));
    const exact = models.some(m => m.name.toLowerCase() === currentModel.toLowerCase());
    modelCardsGrid.innerHTML = filtered.map(m => {
        const isCurrent = exact ? m.name.toLowerCase() === currentModel.toLowerCase() :
            (m.displayName || m.name).toLowerCase() === currentModel.toLowerCase();
        return `<button type="button" class="model-select-card ${isCurrent ? 'active' : ''}" data-model-name="${escapeHtml(m.name)}" aria-pressed="${isCurrent}" ${modelSelectionPending ? 'disabled' : ''}>
            <span class="model-card-icon" aria-hidden="true">${m.family === 'Anthropic' ? 'A' : m.family === 'Open-Source' ? 'O' : 'G'}</span>
            <span class="model-card-info">
                <span class="model-card-header"><span class="model-card-name">${escapeHtml(m.displayName || m.name)}</span>${isCurrent ? '<span class="model-current-badge">当前</span>' : ''}${m.badge ? `<span class="model-card-badge">${escapeHtml(m.badge)}</span>` : ''}</span>
                <span class="model-card-desc">${escapeHtml(m.desc || '')}</span>
                <span class="model-card-meta"><span>${escapeHtml(m.family || '')}</span>${m.contextWindow ? `<span>${escapeHtml(m.contextWindow)} 上下文</span>` : ''}</span>
            </span><span class="model-card-radio" aria-hidden="true"></span>
        </button>`;
    }).join('') || '<div class="model-empty">' + (models.length ? '没有匹配的模型，试试其他名称或厂商' : '桌面端未返回可用模型') + '</div>';
    if (!modelSelectionPending) modelSelectionStatus.textContent = `当前：${currentModel} · 显示 ${filtered.length} 个模型`;
}

async function selectModel(chosenModel) {
    if (!chosenModel || modelSelectionPending || modelListLoading) return;
    if (isSending || isNavigating) {
        modelSelectionStatus.textContent = '请等待当前发送或会话切换完成后再选择模型';
        return;
    }
    if (chosenModel === currentModel) { closeModelModal(); return; }
    modelSelectionPending = true;
    modelSearchInput.disabled = true;
    cancelModelModalBtn.disabled = true;
    closeModelModalBtn.disabled = true;
    modelCardsGrid.setAttribute('aria-busy', 'true');
    modelSelectionStatus.textContent = '正在切换，请稍候…';
    renderModelCards();
    try {
        const res = await fetchWithAuth('/set-model', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: chosenModel })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || '桌面端未确认切换');
        currentModel = chosenModel;
        modelText.textContent = chosenModel;
        modelSelectionPending = false;
        closeModelModal();
        showToast('模型已切换为 ' + chosenModel, 'success');
        setTimeout(fetchAppState, 800);
    } catch (e) {
        modelSelectionStatus.textContent = '切换未获确认，保留当前选择；可同步桌面后重试';
        showToast('模型切换未获确认', 'error');
    } finally {
        modelSelectionPending = false;
        modelSearchInput.disabled = false;
        cancelModelModalBtn.disabled = false;
        closeModelModalBtn.disabled = false;
        modelCardsGrid.removeAttribute('aria-busy');
        const status = modelSelectionStatus.textContent;
        renderModelCards();
        modelSelectionStatus.textContent = status;
    }
}

modelCardsGrid.addEventListener('click', e => {
    if (e.target.closest('#retryModelsBtn')) { loadModels(); return; }
    const card = e.target.closest('.model-select-card');
    if (card) selectModel(card.getAttribute('data-model-name'));
});
modelSearchInput.addEventListener('input', () => { if (!modelListLoading && !modelSelectionPending) renderModelCards(); });
modelModalOverlay.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModelModal(); return; }
    if (e.key === 'Tab') {
        const focusable = Array.from(modelModalOverlay.querySelectorAll('button:not(:disabled), input:not(:disabled)')).filter(el => el.offsetParent !== null);
        if (!focusable.length) { e.preventDefault(); document.getElementById('modelModalCard').focus(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
});

function closeModelModal() {
    if (modelSelectionPending) return;
    modelLoadVersion++;
    modelListLoading = false;
    modelModalOverlay.classList.remove('show');
    document.getElementById('appShell').inert = false;
    (modelDialogOpener?.isConnected ? modelDialogOpener : modelBtn).focus();
}

modelBtn.addEventListener('click', openModelModal);
closeModelModalBtn.addEventListener('click', closeModelModal);
cancelModelModalBtn.addEventListener('click', closeModelModal);
modelModalOverlay.addEventListener('click', e => { if (e.target === modelModalOverlay) closeModelModal(); });

// --- Workspace Command Palette ---
let paletteIsOpen = false;
let paletteItems = [];
let paletteSelected = 0;
let palettePreviousFocus = null;
function fillComposer(text) {
    if (isNavigating) return;
    messageInput.value = messageInput.value.trim() ? `${messageInput.value}\n${text}` : text;
    persistComposerDraft();
    updateSendButtonState();
    messageInput.focus();
    messageInput.style.height = Math.min(messageInput.scrollHeight, 180) + 'px';
}
function commandItems(query = '') {
    const locked = isSending || isNavigating;
    const actions = [
        { id: 'new', label: '新会话', detail: '创建桌面对话', shortcut: 'Ctrl N', disabled: locked, run: startNewChat },
        { id: 'focus', label: '专注输入', detail: '返回当前会话草稿', run: () => messageInput.focus() },
        { id: 'model', label: '切换模型', detail: currentModel, disabled: locked, run: openModelModal },
        { id: 'mode', label: '切换执行模式', detail: currentMode, disabled: locked, run: openModeModal },
        { id: 'usage', label: '用量与配额', detail: '模型组额度与重置时间', run: openUsageModal },
        { id: 'sync', label: '同步桌面', detail: '刷新对话和连接状态', run: syncDesktop },
        { id: 'theme', label: '切换主题', detail: '跟随系统 / 浅色 / 深色', run: cycleTheme },
        { id: 'summary', label: '总结进展', detail: '将提示添加到草稿', run: () => fillComposer('请总结当前进展、已变更的文件及下一步建议') },
        { id: 'review', label: '检查代码与自测', detail: '将提示添加到草稿', run: () => fillComposer('请检查潜在边界问题、异常情况并进行自测验证') }
    ].map(item => ({ ...item, kind: 'action', key: `action:${item.id}` }));
    const chats = rawConversations.map(chat => ({
        kind: 'chat', key: conversationKey(chat), label: chat.title || '未命名会话',
        detail: chat.workspace || '独立会话', disabled: locked,
        draft: !!readSession(draftKey(conversationKey(chat))),
        current: chat.id ? chat.id === activeConversationId : chat.isActive,
        run: () => { closeMobileSidebar(); selectChat(chat.title, chat.id || ''); }
    }));
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = item => tokens.every(token => `${item.label} ${item.detail}`.toLowerCase().includes(token));
    return query.trim() ? [...actions.filter(matches), ...chats.filter(matches)].slice(0, 50) : [...chats.slice(0, 6), ...actions];
}
function renderCommandResults(reset = false) {
    const previousKey = !reset && paletteItems[paletteSelected]?.key;
    paletteItems = commandItems(commandSearchInput.value);
    paletteSelected = previousKey ? paletteItems.findIndex(item => item.key === previousKey && !item.disabled) : -1;
    if (paletteSelected < 0) paletteSelected = paletteItems.findIndex(item => !item.disabled);
    commandResults.innerHTML = paletteItems.length ? paletteItems.map((item, index) => `
        ${index === 0 || item.kind !== paletteItems[index - 1].kind ? `<div class="command-group-label" role="presentation">${item.kind === 'chat' ? '会话' : '快捷操作'}</div>` : ''}
        <button type="button" class="command-option" id="command-option-${index}" role="option" aria-selected="${index === paletteSelected}" aria-disabled="${!!item.disabled}" data-command-index="${index}" tabindex="-1">
            <span class="command-option-icon" aria-hidden="true">${item.kind === 'chat' ? '↳' : '›'}</span>
            <span class="command-option-copy"><span class="command-option-title">${escapeHtml(item.label)}</span><span class="command-option-detail">${escapeHtml(item.detail)}</span></span>
            ${item.current ? '<span class="command-tag">当前</span>' : ''}${item.draft ? '<span class="command-tag">草稿</span>' : ''}
            ${item.disabled ? '<span class="command-tag">处理中</span>' : item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : ''}
        </button>`).join('') : '<div class="command-empty">没有找到匹配的会话或操作<span>试试项目名、会话标题或“模型”“用量”。</span></div>';
    commandResultCount.textContent = paletteItems.length ? `显示 ${paletteItems.length} 项` : '无匹配结果';
    updatePaletteSelection();
}
function updatePaletteSelection() {
    commandResults.querySelectorAll('[data-command-index]').forEach((element, index) => element.setAttribute('aria-selected', String(index === paletteSelected)));
    if (paletteSelected >= 0) {
        commandSearchInput.setAttribute('aria-activedescendant', `command-option-${paletteSelected}`);
        document.getElementById(`command-option-${paletteSelected}`)?.scrollIntoView?.({ block: 'nearest' });
    } else commandSearchInput.removeAttribute('aria-activedescendant');
}
function openCommandPalette() {
    if (paletteIsOpen) return;
    if (document.querySelector('.modal-overlay.show')) return;
    palettePreviousFocus = document.activeElement;
    paletteIsOpen = true;
    commandPalette.hidden = false;
    document.getElementById('appShell').inert = true;
    commandSearchInput.value = '';
    commandSearchInput.setAttribute('aria-expanded', 'true');
    renderCommandResults(true);
    commandSearchInput.focus();
}
function closeCommandPalette(restoreFocus = true) {
    paletteIsOpen = false;
    commandPalette.hidden = true;
    document.getElementById('appShell').inert = false;
    commandSearchInput.setAttribute('aria-expanded', 'false');
    commandSearchInput.removeAttribute('aria-activedescendant');
    if (restoreFocus) (palettePreviousFocus?.isConnected ? palettePreviousFocus : messageInput)?.focus?.();
}
function runPaletteItem(index) {
    const item = paletteItems[index];
    if (!item || item.disabled) return;
    closeCommandPalette();
    Promise.resolve(item.run()).catch(() => showToast('操作未完成，请重试', 'error'));
}
function paletteKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); closeCommandPalette(); }
    else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(paletteSelected); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        for (let step = 0; step < paletteItems.length; step++) {
            paletteSelected = (paletteSelected + delta + paletteItems.length) % paletteItems.length;
            if (!paletteItems[paletteSelected].disabled) break;
        }
        updatePaletteSelection();
    } else if (event.key === 'Tab') {
        event.preventDefault();
        (document.activeElement === commandSearchInput ? document.getElementById('closeCommandPaletteBtn') : commandSearchInput).focus();
    }
}
['commandPaletteBtn', 'headerCommandBtn', 'composerCommandBtn'].forEach(id => document.getElementById(id)?.addEventListener('click', openCommandPalette));
document.getElementById('closeCommandPaletteBtn').addEventListener('click', () => closeCommandPalette());
commandPalette.addEventListener('click', event => { if (event.target === commandPalette) closeCommandPalette(); });
commandSearchInput.addEventListener('input', () => renderCommandResults(true));
commandResults.addEventListener('click', event => {
    const option = event.target.closest('[data-command-index]');
    if (option) runPaletteItem(Number(option.getAttribute('data-command-index')));
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
    closeUsageModalBtn.focus();
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
    closeModeModalBtn.focus();
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
    if (isSending || isNavigating) return;
    const rawText = overrideText !== null ? overrideText : messageInput.value;
    const message = rawText ? rawText.trim() : '';
    if (!message) return;
    if (navigator.onLine === false) { persistComposerDraft(); deliveryState = 'failed'; updateComposerStatus(); showToast('网络离线，消息草稿已保留', 'error'); return; }
    const sameRequest = pendingSend?.message === message;
    if (!sameRequest) {
        pendingSend = {
            requestId: window.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            message, isSteer: isAgentBusy, ...(activeConversationId || activeConversationKey.startsWith('new:') ? { conversationId: activeConversationId } : {})
        };
    }
    savePending();
    if (overrideText === null) persistComposerDraft();
    isSending = true;
    deliveryState = 'sending';
    updateComposerStatus();
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
                savePending();
            }
            if (overrideText !== null && !messageInput.value) {
                messageInput.value = message;
                saveSession(draftKey(activeConversationKey), message);
            }
            deliveryState = data?.uncertain ? 'uncertain' : 'failed';
            showToast(data?.message || '消息发送失败，草稿已保留', 'error');
            return;
        }
        pendingSend = null;
        savePending();
        // Keep any edits typed while this request was in progress.
        if (overrideText === null && messageInput.value === rawText) {
            messageInput.value = '';
            messageInput.style.height = 'auto';
            saveSession(draftKey(activeConversationKey), null);
            updateSendButtonState();
        }
        deliveryState = messageInput.value.trim() ? 'draft' : 'sent';
        showToast(data.isSteer ? '⚡ 插话已提交' : '消息已发送', 'success', 1800);
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSidebarHistory, 1500);
    } catch (error) {
        deliveryState = 'uncertain';
        console.error('Send message error:', error);
        if (overrideText !== null && !messageInput.value) messageInput.value = message;
        showToast(authRedirecting ? '登录已过期，草稿已保留' : '未收到发送结果，草稿已保留；重试会核对原请求', 'error');
    } finally {
        isSending = false;
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        updateSendButtonState();
        updateComposerStatus();
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
    if (paletteIsOpen || document.querySelector('.modal-overlay.show') || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Auto-grow textarea and update Codex send button state
messageInput.addEventListener('input', function () {
    persistComposerDraft();
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 180) + 'px';
    updateSendButtonState();
});

// Global Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (document.querySelector('.modal-overlay.show')) return;
        if (paletteIsOpen) closeCommandPalette(); else openCommandPalette();
        return;
    }
    if (paletteIsOpen) { paletteKeydown(e); return; }
    if (document.querySelector('.modal-overlay.show')) {
        if (e.key === 'Escape') {
            if (usageModalOverlay.classList.contains('show')) closeUsageModal();
            else if (modelModalOverlay.classList.contains('show')) closeModelModal();
            else if (modeModalOverlay.classList.contains('show')) closeModeModal();
        }
        return;
    }
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

    // Auto pull older messages when scrolled to the very top
    if (chatContainer.scrollTop <= 30 && historyLoaderBar && historyLoaderBar.style.display !== 'none' && (!historyLoadMoreBtn || !historyLoadMoreBtn.disabled)) {
        requestOlderMessages();
    }

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

if (historyLoadMoreBtn) {
    historyLoadMoreBtn.addEventListener('click', () => {
        requestOlderMessages();
    });
}

if (chatContent) {
    chatContent.addEventListener('click', (e) => {
        const olderBtn = e.target.closest && (e.target.closest('.ag-load-older-btn') || e.target.closest('[aria-label*="Load older messages"]'));
        if (olderBtn) {
            e.preventDefault();
            e.stopPropagation();
            requestOlderMessages();
        }
    });
}

// Virtual Keyboard compensation for mobile
function syncViewportHeight() {
    if (isDesktop()) {
        document.body.style.height = '';
        return;
    }
    if (!window.visualViewport || window.visualViewport.scale > 1) return;
    document.body.style.height = window.visualViewport.height + 'px';
    if (document.activeElement === messageInput) {
        setTimeout(() => { chatContainer.scrollTop = chatContainer.scrollHeight; }, 100);
    }
}
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.addEventListener('resize', syncViewportHeight);
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
                persistComposerDraft();
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

function syncDesktop() {
    if (!isSending && !isNavigating) expectedSelectionId = null;
    loadSnapshot(true);
    fetchAppState();
    loadSidebarHistory();
}
refreshBtn.addEventListener('click', syncDesktop);
sidebarSyncBtn.addEventListener('click', syncDesktop);

// --- Remote Click Handling (Thinking blocks, Run/Allow buttons) ---
let reviewTogglePending = false;
async function toggleReviewFiles(header) {
    if (!header || reviewTogglePending) return;
    const index = Array.from(chatContent.querySelectorAll('.files-changed-header')).indexOf(header);
    if (index < 0) return;
    reviewTogglePending = true;
    header.setAttribute('aria-busy', 'true');
    try {
        const res = await fetchWithAuth('/remote-click', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selector: '.files-changed-header', index })
        });
        const result = await res.json();
        if (!res.ok || result.error || result.success === false) throw new Error('review unavailable');
        setTimeout(loadSnapshot, 250);
        setTimeout(loadSnapshot, 800);
    } catch (e) {
        showToast('文件变更未能展开，请同步桌面后重试', 'error');
    } finally {
        reviewTogglePending = false;
        header.removeAttribute('aria-busy');
    }
}
chatContainer.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || !e.target.matches('.ag-review-summary')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleReviewFiles(e.target.closest('.files-changed-header')); }
});
chatContainer.addEventListener('click', async (e) => {
    if (e.target.closest('.codex-copy-btn')) return;
    const nativeSummary = e.target.closest('details > summary');
    if (nativeSummary) {
        nativeSummary.parentElement.dataset.clientDetailsConversation = activeConversationKey;
        return;
    }
    const reviewHeader = e.target.closest('.files-changed-header');
    if (reviewHeader && !e.target.closest('button, a')) { await toggleReviewFiles(reviewHeader); return; }
    const target = e.target.closest('.ag-snapshot-toggle, .ag-snapshot-action, button, [role="button"]');
    if (!target) return;

    const text = target.innerText || '';
    const isUiToggle = target.classList.contains('ag-snapshot-toggle') && text.length < 500;

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
initTheme();
initSidebarState();
updateComposerStatus();
updateSendButtonState();
connectWebSocket();
fetchAppState();
loadSidebarHistory();
setInterval(fetchAppState, 6000);
setInterval(loadSidebarHistory, 15000);
