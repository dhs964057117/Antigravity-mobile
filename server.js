#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inspectUI } from './ui_inspector.js';
import { execSync } from 'child_process';
import { connectCDP, getJson } from './core/cdp.js';
import { createSendCoordinator } from './core/send-coordinator.js';
import { createQuotaReader } from './core/quota.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const POLL_INTERVAL = 1000; // 1 second
const SERVER_PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const AUTH_COOKIE_NAME = 'ag_auth_token';

// Security warning for default credentials
if (APP_PASSWORD === 'antigravity') {
    console.warn('\n\x1b[33m%s\x1b[0m', '⚠️  SECURITY WARNING: Using default APP_PASSWORD ("antigravity").');
    console.warn('\x1b[33m%s\x1b[0m', '   Set a strong APP_PASSWORD in your .env file for production use.\n');
}

// Note: hashString is defined later, so we'll initialize the token inside createServer or use a simple string for now.
let AUTH_TOKEN = 'ag_default_token';


// Shared CDP connection
let cdpConnection = null;
let lastSnapshot = null;
let lastSnapshotHash = null;

// Kill any existing process on the server port (prevents EADDRINUSE)
function killPortProcess(port) {
    try {
        if (process.platform === 'win32') {
            // Windows: Find PID using netstat and kill it
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') pids.add(pid);
            }
            for (const pid of pids) {
                if (String(pid) === String(process.pid)) continue;
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            // Linux/macOS: Use lsof and kill
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p);
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
        // Small delay to let the port be released
        return new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
        // No process found on port - this is fine
        return Promise.resolve();
    }
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    if (process.env.LOCAL_IP) return process.env.LOCAL_IP;
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Find Antigravity CDP endpoint
async function discoverCDP() {
    const errors = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            // Priority 1: Modern Antigravity main page target
            const antigravityPage = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && (
                t.title?.includes('Antigravity') || 
                t.url?.includes('/c/') || 
                t.url?.includes('127.0.0.1') ||
                t.url?.includes('workbench.html') || 
                t.title?.includes('workbench')
            ));
            if (antigravityPage) {
                console.log('Found Antigravity page target:', antigravityPage.title);
                return { port, url: antigravityPage.webSocketDebuggerUrl };
            }

            // Priority 2: Any page target with WebSocket debugger URL
            const anyPage = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (anyPage) {
                console.log('Found page target:', anyPage.title);
                return { port, url: anyPage.webSocketDebuggerUrl };
            }

            // Priority 3: Jetski/Launchpad (Fallback)
            const jetski = list.find(t => (t.url?.includes('jetski') || t.title === 'Launchpad') && t.webSocketDebuggerUrl);
            if (jetski) {
                console.log('Found Jetski/Launchpad target:', jetski.title);
                return { port, url: jetski.webSocketDebuggerUrl };
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }
    const errorSummary = errors.length ? `Errors: ${errors.join(', ')}` : 'No ports responding';
    throw new Error(`CDP not found. ${errorSummary}`);
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = `(async () => {
        const cascade = document.getElementById('conversation') || 
                        document.getElementById('chat') || 
                        document.getElementById('cascade') ||
                        document.querySelector('.isolate.overflow-y-auto') ||
                        document.querySelector('[class*="scrollbar-hide"][class*="overflow-y-auto"]') ||
                        document.querySelector('.overflow-y-auto.md-table-bleed') ||
                        Array.from(document.querySelectorAll('.overflow-y-auto')).find(el => el.scrollHeight > 300);
        if (!cascade) {
            // Debug info
            const body = document.body;
            const childIds = Array.from(body.children).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        // Find the main scrollable container
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // Mark fixed/absolute elements in the original DOM before cloning
        // This is the only way to reliably catch CSS-class-based positioning
        const candidates = cascade.querySelectorAll('*');
        candidates.forEach(el => {
            try {
                const pos = window.getComputedStyle(el).position;
                if (pos === 'fixed' || pos === 'absolute') {
                    if (el.tagName === 'BUTTON' && (el.getAttribute('aria-label') || '').toLowerCase().includes('older messages')) {
                        return;
                    }
                    el.setAttribute('data-ag-rem', 'true');
                }
            } catch(e) {}
        });

        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);
        clone.id = 'conversation';
        clone.classList.remove('theme-light', 'theme-dark');
        clone.classList.add('antigravity-snapshot-root');
        clone.style.height = 'auto';
        clone.style.minHeight = '100%';
        clone.style.maxHeight = 'none';
        clone.style.overflow = 'visible';
        clone.style.containerType = 'normal';
        clone.style.paddingRight = '0px';

        const clonedOlderBtn = clone.querySelector('button[aria-label*="older messages"], button[aria-label*="Load older messages"]');
        if (clonedOlderBtn) {
            clonedOlderBtn.classList.add('ag-load-older-btn');
            clonedOlderBtn.classList.remove('sr-only', 'opacity-0');
        }

        // Clean user messages: remove sticky positioning, bleed classes, and double inner wrappers
        clone.querySelectorAll('[aria-label="User message"], .sticky, [class*="sticky"]').forEach(el => {
            el.classList.remove('sticky', 'top-0', 'z-10');
            el.style.position = 'static';
            el.style.top = 'auto';
            el.style.zIndex = '1';
        });

        clone.querySelectorAll('[class*="md-sticky-message-bleed"]').forEach(el => {
            const cls = (el.className || '').toString();
            el.className = cls.replace(/after:[^\s"]+/g, '').replace(/md-sticky-message-bleed/g, '').trim();
            el.style.position = 'static';
            el.style.top = 'auto';
            el.style.background = 'transparent';
        });

        clone.querySelectorAll('[data-testid="user-input-step"], [class*="group/user-input-step"]').forEach(userStep => {
            userStep.querySelectorAll('.bg-card, .bg-card-border, [class*="bg-card"], [class*="rounded-xl"], [class*="rounded-[calc"]').forEach(innerCard => {
                innerCard.classList.remove('bg-card', 'bg-card-border', 'p-px', 'rounded-xl');
                innerCard.style.background = 'transparent';
                innerCard.style.border = 'none';
                innerCard.style.boxShadow = 'none';
                innerCard.style.padding = '0';
            });
        });

        // Neutralize hardcoded theme classes and fix container-type
        clone.querySelectorAll('*').forEach(el => {
            el.classList.remove('theme-light', 'theme-dark');
            el.style.containerType = 'normal';
            if (el.style.maxWidth && el.style.maxWidth.includes('max(')) {
                el.style.maxWidth = '100%';
            }
        });
        
        // Clean up markers from the original DOM immediately after cloning
        candidates.forEach(el => el.removeAttribute('data-ag-rem'));
        
        // Aggressively remove the entire interaction/input/review area
        try {
            // 1. Identify common interaction wrappers by class combinations
            const interactionSelectors = [
                '.relative.flex.flex-col.gap-8',
                '.flex.grow.flex-col.justify-start.gap-8',
                'div[class*="interaction-area"]',
                '.p-1.bg-gray-500\\/10',
                '.outline-solid.justify-between',
                '[contenteditable="true"]',
                '[data-lexical-editor]',
                'form',
                // New aggressive selectors for recent Antigravity versions
                '.mx-8.mb-8',
                '.mx-4.mb-4',
                '.fixed.bottom-0',
                '.absolute.bottom-0'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        // Protect elements that contain interactive buttons the user might need
                        const text = (el.innerText || '').toLowerCase();
                        const isActionArea = text.includes('allow') || text.includes('deny') || 
                                           text.includes('review') || text.includes('run') ||
                                           text.includes('confirm');
                        
                        // BUT: If it's specifically an input-related element, we DON'T protect it
                        const isEditor = el.getAttribute('contenteditable') === 'true' || 
                                       el.hasAttribute('data-lexical-editor') ||
                                       text.includes('ask anything') ||
                                       text.includes('to mention');
                        if (!isEditor && isActionArea && selector !== '[contenteditable="true"]') {
                            return; // Protect action bars
                        }

                        // For the editor or its container, remove it
                        // Go up to find the main floating box if it's a deep selector
                        let targetToRemove = el;
                        if (isEditor || selector.includes('bottom-0')) {
                             // Find the common container for the input box (usually has margins or padding)
                             let parent = el.parentElement;
                             for (let i = 0; i < 4; i++) {
                                 if (!parent || parent === clone) break;
                                 const pCls = (parent.className || '').toString();
                                 if (pCls.includes('mx-') || pCls.includes('mb-') || pCls.includes('bg-')) {
                                     targetToRemove = parent;
                                 }
                                 parent = parent.parentElement;
                             }
                        }
                        
                        if (targetToRemove && targetToRemove !== clone) {
                            targetToRemove.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });

            // 2. Text-based cleanup for stray status bars and redundant desktop inputs
            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                    const isInputPlaceholder = text.includes('ask anything') || 
                                              text.includes('to mention') || 
                                              placeholder.includes('ask anything');
                    
                    // IF it's the main chat box (contains placeholder text), remove its container
                    if (isInputPlaceholder) {
                        // Find the container (usually a few levels up)
                        let container = el;
                        for (let i = 0; i < 5; i++) {
                            if (!container.parentElement || container.parentElement === clone) break;
                            const cls = (container.className || '').toString();
                            if (cls.includes('flex-col') || cls.includes('input') || cls.includes('area')) {
                                container.remove();
                                return;
                            }
                            container = container.parentElement;
                        }
                        el.remove();
                        return;
                    }
                } catch(e) {}
            });

            // 3. NUCLEAR: If any editor or redundant UI remains, remove its entire branch
            const redundantElements = clone.querySelectorAll('[contenteditable="true"], [data-lexical-editor], [role="textbox"], form, .mx-8.mb-8, .mx-4.mb-4');
            redundantElements.forEach(el => {
                try {
                    let branch = el;
                    // Go up to find the highest container that is still within the clone
                    // This ensures we remove the entire "box" (with chips, submit btn, etc)
                    while (branch.parentElement && branch.parentElement !== clone) {
                        const p = branch.parentElement;
                        const pCls = (p.className || '').toString().toLowerCase();
                        // Stop going up if we hit a main message/conversation wrapper
                        if (pCls.includes('message') || pCls.includes('bubble') || pCls.includes('conversation')) break;
                        branch = p;
                    }
                    if (branch && branch !== clone) branch.remove();
                    else el.remove();
                } catch(e) {}
            });

            // 4. Force hide any fixed/absolute elements (desktop overlays)
            // These were marked in the original before cloning to ensure accurate computed styles
            clone.querySelectorAll('[data-ag-rem]').forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    // Exclude Action Bars we want to keep
                    if (text.includes('allow') || text.includes('deny') || text.includes('review')) {
                        el.removeAttribute('data-ag-rem');
                        return;
                    }
                    el.remove();
                } catch(e) {}
            });
        } catch (globalErr) { }

        // Convert local images to base64
        const images = clone.querySelectorAll('img');
        const promises = Array.from(images).map(async (img) => {
            const rawSrc = img.getAttribute('src');
            if (rawSrc && (rawSrc.startsWith('/') || rawSrc.startsWith('vscode-file:')) && !rawSrc.startsWith('data:')) {
                try {
                    const res = await fetch(rawSrc);
                    const blob = await res.blob();
                    await new Promise(r => {
                        const reader = new FileReader();
                        reader.onloadend = () => { img.src = reader.result; r(); };
                        reader.onerror = () => r();
                        reader.readAsDataURL(blob);
                    });
                } catch(e) {}
            }
        });
        await Promise.all(promises);

        // Fix inline file references: Antigravity nests <div> elements inside
        // <span> and <p> tags (e.g. file-type icons). Browsers auto-close <p> and
        // <span> when they encounter a <div>, causing unwanted line breaks.
        // Solution: Convert any <div> inside an inline parent to a <span>.
        try {
            const inlineTags = new Set(['SPAN', 'P', 'A', 'LABEL', 'EM', 'STRONG', 'CODE']);
            const allDivs = Array.from(clone.querySelectorAll('div'));
            for (const div of allDivs) {
                try {
                    if (!div.parentNode) continue;
                    const parent = div.parentElement;
                    if (!parent) continue;
                    
                    const parentIsInline = inlineTags.has(parent.tagName) || 
                        (parent.className && (parent.className.includes('inline-flex') || parent.className.includes('inline-block')));
                        
                    if (parentIsInline) {
                        const span = document.createElement('span');
                        // MOVE children instead of copying (prevents orphaning nested divs)
                        while (div.firstChild) {
                            span.appendChild(div.firstChild);
                        }
                        if (div.className) span.className = div.className;
                        if (div.getAttribute('style')) span.setAttribute('style', div.getAttribute('style'));
                        span.style.display = 'inline-flex';
                        span.style.alignItems = 'center';
                        span.style.verticalAlign = 'middle';
                        div.replaceWith(span);
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        const html = clone.outerHTML;
        
        const rules = [];
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    rules.push(rule.cssText);
                }
            } catch (e) { }
        }
        const allCSS = rules.join('\\n');
        
        const cancelBtn = document.querySelector('#antigravity\\\\.agentSidePanelInputBox button[aria-label*="Cancel (Ctrl+D)"], [data-tooltip-id="input-send-button-cancel-tooltip"]');
        const isBusy = !!(cancelBtn && cancelBtn.offsetParent !== null);

        const olderBtn = cascade.querySelector('button[aria-label*="older messages"], button[aria-label*="Load older messages"]');
        let historyMeta = null;
        if (olderBtn) {
            const label = olderBtn.getAttribute('aria-label') || '';
            const match = label.match(/showing\\s+(\\d+)\\s+of\\s+(\\d+)/i);
            historyMeta = {
                hasOlder: (!label.toLowerCase().includes("no more")),
                label: label,
                showing: match ? parseInt(match[1], 10) : null,
                total: match ? parseInt(match[2], 10) : null
            };
        }

        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            isBusy: isBusy,
            history: historyMeta,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length,
                isBusy: isBusy
            }
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            // console.log(`Trying context ${ctx.id} (${ctx.name || ctx.origin})...`);
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                // console.log(`Context ${ctx.id} exception:`, result.exceptionDetails);
                continue;
            }

            if (result.result && result.result.value) {
                const val = result.result.value;
                if (val.error) {
                    // console.log(`Context ${ctx.id} script error:`, val.error);
                    // if (val.debug) console.log(`   Debug info:`, JSON.stringify(val.debug));
                } else {
                    return val;
                }
            }
        } catch (e) {
            console.log(`Context ${ctx.id} connection error:`, e.message);
        }
    }

    return null;
}

// Inject message into Antigravity (Supports regular send and Steer/Interjection 插话引导)
export async function injectMessage(cdp, text, options = {}) {
    let submissionStarted = false;
    try {
        const deadline = Date.now() + 30000;
        const transport = cdp;
        cdp = { ...transport, call: (...args) => {
            if (Date.now() > deadline) return Promise.reject(new Error('Message submission timed out'));
            return transport.call(...args);
        } };
        if (!text || typeof text !== 'string') {
            return { ok: false, error: 'empty_text', message: '消息内容不能为空' };
        }

        const forceSteer = options.isSteer === true;
        console.log(`[SEND] Processing message (chars: ${text.length}, forceSteer=${forceSteer})...`);

        // Step 1: Detect chat execution state (is the agent actively generating/running?)
        const BUSY_CHECK = `(() => {
            // Clear previous target markers
            document.querySelectorAll('[data-ag-active-target]').forEach(el => el.removeAttribute('data-ag-active-target'));

            const inputArea = document.getElementById('antigravity.agentSidePanelInputBox') ||
                              document.querySelector('#antigravity\\\\.agentSidePanelInputBox');

            // The chat's active generation button is Cancel (Ctrl+D) inside the input box
            const cancelBtn = inputArea ?
                inputArea.querySelector('button[aria-label*="Cancel (Ctrl+D)"], [data-tooltip-id="input-send-button-cancel-tooltip"]') :
                document.querySelector('#antigravity\\\\.agentSidePanelInputBox button[aria-label*="Cancel (Ctrl+D)"]');

            const isBusy = !!(cancelBtn && cancelBtn.offsetParent !== null);
            return { busy: isBusy };
        })()`;

        let isAgentBusy = false;
        for (const ctx of cdp.contexts) {
            try {
                const res = await cdp.call("Runtime.evaluate", {
                    expression: BUSY_CHECK,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                if (res.result?.value?.busy) {
                    isAgentBusy = true;
                    break;
                }
            } catch (e) { }
        }

        const isSteerMode = isAgentBusy || forceSteer;
        if (isSteerMode) {
            console.log('[SEND] Agent is actively running. Processing message as STEER / INTERJECTION (插话引导)...');
        }

        // Step 2: Locate target editor inside Antigravity
        const LOCATE_EXP = `(async () => {
            document.querySelectorAll('[data-ag-active-target]').forEach(el => el.removeAttribute('data-ag-active-target'));

            const cascade = document.getElementById('conversation') ||
                            document.getElementById('chat') ||
                            document.getElementById('cascade') ||
                            document.querySelector('.isolate.overflow-y-auto') ||
                            document.querySelector('[class*="scrollbar-hide"][class*="overflow-y-auto"]');

            const allEditors = Array.from(document.querySelectorAll('[data-lexical-editor="true"], [contenteditable="true"]'))
                .filter(el => el.offsetParent !== null || el.getClientRects().length > 0);

            if (allEditors.length === 0) {
                return { ok: false, error: "editor_not_found", message: "未找到输入框，请确认 Antigravity 界面正常打开" };
            }

            let target = null;
            if (cascade) {
                let curr = cascade;
                while (curr && curr !== document.body) {
                    target = allEditors.find(ed => curr.contains(ed));
                    if (target) break;
                    curr = curr.parentElement;
                }
            }
            if (!target) {
                target = allEditors.find(ed => {
                    const box = ed.closest('[id*="agentSidePanelInputBox"]') || ed.parentElement;
                    return box && box.querySelector('[data-testid="send-button"], [data-tooltip-id="input-send-button-send-tooltip"], button[aria-label*="Send"], button[aria-label*="发送"]');
                }) || allEditors[0];
            }

            target.setAttribute('data-ag-active-target', 'true');
            if (target.focus) target.focus();

            const rect = target.getBoundingClientRect();
            return {
                ok: true,
                isLexical: target.getAttribute('data-lexical-editor') === 'true',
                pos: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            };
        })()`;

        let locateResult = null;
        let targetContext = null;

        for (const ctx of cdp.contexts) {
            try {
                const res = await cdp.call("Runtime.evaluate", {
                    expression: LOCATE_EXP,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                if (res.result?.value?.ok) {
                    locateResult = res.result.value;
                    targetContext = ctx;
                    break;
                }
            } catch (e) { }
        }

        if (!locateResult || !targetContext) {
            console.error('[SEND] Editor not found in any context');
            return { ok: false, error: "editor_not_found", message: "未找到桌面端输入框" };
        }

        // From this point every check uses the exact marked editor. Losing that
        // editor or CDP context must never be interpreted as an empty composer.
        const readEditor = async (select = false) => {
            const res = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const target = document.querySelector('[data-ag-active-target="true"]');
                    if (!target || !target.isConnected) return { found: false };
                    if (${select}) {
                        target.focus();
                        if (document.activeElement !== target && !target.contains(document.activeElement)) {
                            return { found: true, focused: false };
                        }
                        const range = document.createRange();
                        range.selectNodeContents(target);
                        const selection = window.getSelection();
                        selection.removeAllRanges();
                        selection.addRange(range);
                    }
                    return { found: true, focused: true, text: target.innerText || '' };
                })()`,
                returnByValue: true,
                contextId: targetContext.id
            });
            const value = res.result?.value;
            if (res.exceptionDetails || !value?.found || !value.focused || typeof value.text !== 'string') {
                throw new Error('Desktop editor is no longer available or focused');
            }
            return value.text;
        };
        const normalize = value => value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
        const expected = normalize(text);
        const before = normalize(await readEditor());
        if (before && before !== expected) {
            return { ok: false, error: 'desktop_draft_exists', message: '桌面输入框已有草稿，请先处理后再发送' };
        }
        if (before !== expected) {
            await readEditor(true);
            await cdp.call('Input.insertText', { text });
            await new Promise(resolve => setTimeout(resolve, 150));
            if (normalize(await readEditor()) !== expected) {
                return { ok: false, error: 'insert_failed', message: '桌面输入内容未完整写入，草稿已保留，请检查后重试' };
            }
        }

        // A dispatched submission is never followed by another submission method:
        // a slow desktop may have accepted the first one already.
        let method = 'cdp_enter';
        if (!isSteerMode) {
            submissionStarted = true;
            const res = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const target = document.querySelector('[data-ag-active-target="true"]');
                    if (!target) throw new Error('Editor lost before submit');
                    const container = target.closest('[id*="agentSidePanelInputBox"]') || target.parentElement;
                    const button = container?.querySelector('[data-testid="send-button"], [data-tooltip-id="input-send-button-send-tooltip"], button[aria-label*="Send"], button[aria-label*="发送"]');
                    if (!button) return { clicked: false };
                    // Some desktop builds disable this button while Enter still works.
                    // Fall back only when no click has been dispatched.
                    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return { clicked: false };
                    button.click();
                    return { clicked: true };
                })()`,
                returnByValue: true,
                contextId: targetContext.id
            });
            if (res.exceptionDetails || !res.result?.value) throw new Error('Cannot verify submit button state');
            if (res.result.value.clicked) method = 'click_submit';
            else submissionStarted = false;
        }
        if (method === 'cdp_enter') {
            // Re-focus only; do not select or erase the message before Enter.
            const focus = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const target = document.querySelector('[data-ag-active-target="true"]');
                    target?.focus();
                    return !!target && (document.activeElement === target || target.contains(document.activeElement));
                })()`,
                returnByValue: true,
                contextId: targetContext.id
            });
            if (focus.result?.value !== true) throw new Error('Editor focus lost before Enter');
            submissionStarted = true;
            await cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r', unmodifiedText: '\r' });
            await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
        }
        for (let attempt = 0; attempt < 15; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!normalize(await readEditor())) {
                return { ok: true, isSteer: isSteerMode, method, message: '已发送' };
            }
        }
        return { ok: false, uncertain: true, error: 'submit_unconfirmed', message: '桌面尚未确认提交，请检查会话；草稿已保留' };
    } catch (error) {
        console.warn('[SEND] Desktop submission interrupted:', error.message);
        return { ok: false, uncertain: submissionStarted, error: submissionStarted ? 'send_uncertain' : 'desktop_unavailable',
            message: submissionStarted ? '提交结果未确认，请检查桌面会话，避免重复发送' : '桌面连接或输入框暂不可用，草稿已保留，请重试' };
    }
}

async function setMode(cdp, mode) {
    const validModes = ['Turbo', 'Default', 'Request Review', 'Fast', 'Planning'];
    if (!validModes.some(m => m.toLowerCase() === mode.toLowerCase())) {
        return { error: 'Invalid mode: ' + mode };
    }

    const EXP = `(async () => {
        try {
            // Priority 1: Antigravity 2.0 permissions preset selector
            let modeBtn = document.querySelector('[data-testid="permissions-selector-trigger"], button[aria-label*="permissions preset"], button[aria-label*="preset selector"]');
            
            // Priority 2: Fallback search by text
            if (!modeBtn) {
                const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
                modeBtn = allButtons.find(b => {
                    const txt = (b.innerText || '').trim();
                    return ['Turbo', 'Default', 'Request Review', 'Fast', 'Planning'].some(m => txt.includes(m));
                });
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if ((modeBtn.innerText || '').toLowerCase().includes('${mode}'.toLowerCase())) {
                return { success: true, alreadySet: true };
            }

            // Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 400));

            // Find menu items (Antigravity 2.0 uses role="menuitem")
            const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [data-radix-collection-item], button'));
            const target = items.find(el => {
                const txt = (el.innerText || '').toLowerCase();
                return txt.includes('${mode}'.toLowerCase());
            });

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            // Close menu if option not found
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            return { error: 'Mode option "${mode}" not found in dropdown' };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Stop Generation
async function stopGeneration(cdp) {
    const EXP = `(async () => {
        // Look for the cancel button inside input box or anywhere with exact cancel tooltip
        const cancel = document.querySelector('#antigravity\\\\.agentSidePanelInputBox [data-tooltip-id="input-send-button-cancel-tooltip"], #antigravity\\\\.agentSidePanelInputBox button[aria-label*="Cancel (Ctrl+D)"], [data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true, method: 'click_cancel' };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('#antigravity\\\\.agentSidePanelInputBox button svg.lucide-square, #antigravity\\\\.agentSidePanelInputBox div.bg-red-500')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true, method: 'fallback_square' };
        }

        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }

    // Also dispatch Ctrl+D key event via CDP
    try {
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 68, code: 'KeyD', key: 'd' });
        await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 68, code: 'KeyD', key: 'd' });
        return { success: true, method: 'cdp_ctrl_d' };
    } catch(e) {}

    return { error: 'Context failed' };
}

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const safeText = JSON.stringify(textContent || '');

    const EXP = `(async () => {
        try {
            // Priority: Search inside the chat container first for better accuracy
            const root = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade') || document.querySelector('.isolate.overflow-y-auto') || document;
            
            // Strategy: Find all elements matching the selector
            let elements = Array.from(root.querySelectorAll('${selector}'));
            
            const filterText = ${safeText};
            if (filterText) {
                elements = elements.filter(el => {
                    const txt = (el.innerText || el.textContent || '').trim();
                    const firstLine = txt.split('\\n')[0].trim();
                    // Match if first line matches (thought blocks) or if it contains the label (buttons)
                    return firstLine === filterText || txt.includes(filterText);
                });
                
                // CRITICAL: If elements are nested (e.g. <div><span>Text</span></div>), 
                // both will match. We only want the most specific (inner-most) one.
                elements = elements.filter(el => {
                    return !elements.some(other => other !== el && el.contains(other));
                });
            }

            const target = elements[${index}];

            if (target) {
                // Focus and Click
                if (target.focus) target.focus();
                target.click();
                return { success: true, found: elements.length, indexUsed: ${index} };
            }
            
            return { error: 'Element not found at index ' + ${index} + ' among ' + elements.length + ' matches' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
            // If we found it but click didn't return success (unlikely with this script), continue to next context
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts or element not found at index' };
}

// Load older messages (history)
export async function loadOlderMessages(cdp) {
    const SCRIPT = `(() => {
        const btn = document.querySelector('button[aria-label*="older messages"], button[aria-label*="Load older messages"]');
        if (btn) {
            const label = btn.getAttribute('aria-label') || '';
            const isDisabled = btn.getAttribute && btn.getAttribute('aria-disabled') === 'true';
            if (label.toLowerCase().includes('no more') || isDisabled) {
                return { success: true, noMore: true, label };
            }
            btn.click();
            return { success: true, clicked: true, before: label };
        }
        const scrollables = [...document.querySelectorAll('.isolate.overflow-y-auto, [class*="scrollbar-hide"][class*="overflow-y-auto"], #conversation, .overflow-y-auto')];
        for (const el of scrollables) {
            if (el.scrollHeight > el.clientHeight) {
                el.scrollTop = 0;
                return { success: true, scrolledTop: true };
            }
        }
        return { success: false, reason: 'No load older messages button found' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) {
                return res.result.value;
            }
        } catch(e) {}
    }
    return { success: false, error: 'Failed in all contexts' };
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    // Try to scroll the chat container in Antigravity
    const EXPRESSION = `(async () => {
        try {
            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('.isolate.overflow-y-auto, [class*="scrollbar-hide"][class*="overflow-y-auto"], #conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], .overflow-y-auto')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                // Fallback: scroll the main container element
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling for better sync
            if (${scrollPercent} !== undefined) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * ${scrollPercent};
            } else {
                target.scrollTop = ${scrollTop || 0};
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

// Models Catalog with full metadata
const MODELS_CATALOG = [
    {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash High",
        displayName: "Gemini 3.8 Flash",
        family: "Google",
        effort: "High",
        badge: "默认 · 极速",
        desc: "极速长上下文与强逻辑推理，日常工程首选",
        contextWindow: "1,000,000",
        contextWindowNum: 1000000,
        maxOutput: "8,192"
    },
    {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro (High)",
        displayName: "Gemini 3.1 Pro",
        family: "Google",
        effort: "High",
        badge: "深度推理",
        desc: "复杂代码重构、跨模块系统分析与算法攻关",
        contextWindow: "2,000,000",
        contextWindowNum: 2000000,
        maxOutput: "8,192"
    },
    {
        id: "gemini-3-flash",
        name: "Gemini 3 Flash",
        displayName: "Gemini 3 Flash",
        family: "Google",
        effort: "Standard",
        badge: "轻量快速",
        desc: "轻量高吞吐量日常助手，极低延迟",
        contextWindow: "1,000,000",
        contextWindowNum: 1000000,
        maxOutput: "8,192"
    },
    {
        id: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6 (Thinking)",
        displayName: "Claude Sonnet 4.6",
        family: "Anthropic",
        effort: "Thinking",
        badge: "深度思考",
        desc: "混合思考架构，复杂系统设计与精细代码修改",
        contextWindow: "200,000",
        contextWindowNum: 200000,
        maxOutput: "8,192"
    },
    {
        id: "claude-opus-4.6",
        name: "Claude Opus 4.6 (Thinking)",
        displayName: "Claude Opus 4.6",
        family: "Anthropic",
        effort: "Thinking",
        badge: "顶级推演",
        desc: "顶级学术与极高复杂度推演，最强综合推理能力",
        contextWindow: "200,000",
        contextWindowNum: 200000,
        maxOutput: "8,192"
    },
    {
        id: "gpt-oss-120b",
        name: "GPT-OSS 120B (Medium)",
        displayName: "GPT-OSS 120B",
        family: "Open-Source",
        effort: "Medium",
        badge: "开源前沿",
        desc: "开源旗舰权重与通用编程推理",
        contextWindow: "128,000",
        contextWindowNum: 128000,
        maxOutput: "4,096"
    }
];

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}天 ${h}小时 ${m}分`;
    if (h > 0) return `${h}小时 ${m}分`;
    if (m > 0) return `${m}分 ${s}秒`;
    return `${s}秒`;
}

// Set AI Model
async function setModel(cdp, modelName) {
    const safeModelName = JSON.stringify(modelName);
    const EXP = `(async () => {
        try {
            const rawTarget = ${safeModelName}.trim();
            const targetLower = rawTarget.toLowerCase();

            // 1. Open model selector trigger
            let trigger = document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"], [data-tooltip-id*="model"]');
            if (!trigger) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .filter(el => {
                        const txt = (el.innerText || '').trim();
                        return ["Gemini", "Claude", "GPT", "Model"].some(k => txt.includes(k)) && el.offsetParent !== null;
                    });
                trigger = candidates[0];
            }

            if (!trigger) return { error: 'Model selector trigger not found' };

            // Check if already matches
            const currentTriggerText = (trigger.innerText || '').toLowerCase();
            if (currentTriggerText.includes(targetLower) || targetLower.includes(currentTriggerText)) {
                return { success: true, alreadySet: true, model: trigger.innerText.trim() };
            }

            // Check if panel is already open
            let panel = document.querySelector('[data-testid="model-selector-panel"], [role="menu"]');
            if (!panel) {
                trigger.click();
                await new Promise(r => setTimeout(r, 450));
                panel = document.querySelector('[data-testid="model-selector-panel"], [role="menu"]');
            }

            // Find all candidate items in document or panel
            const items = Array.from(document.querySelectorAll('[role="menuitem"], [data-testid="model-selector-item"], [data-radix-collection-item], button'));
            
            // Priority 1: Exact or startsWith match
            let found = items.find(el => {
                const txt = (el.innerText || '').trim().toLowerCase();
                return txt.startsWith(targetLower) || txt === targetLower;
            });

            // Priority 2: Contains both brand and version (e.g. "sonnet" and "4.6")
            if (!found) {
                const tokens = targetLower.split(/[\\s\\(\\)]+/).filter(t => t.length >= 3);
                found = items.find(el => {
                    const txt = (el.innerText || '').trim().toLowerCase();
                    return tokens.length > 0 && tokens.every(t => txt.includes(t));
                });
            }

            // Priority 3: Loose includes
            if (!found) {
                found = items.find(el => {
                    const txt = (el.innerText || '').trim().toLowerCase();
                    return txt.includes(targetLower) || targetLower.includes(txt);
                });
            }

            if (found) {
                found.scrollIntoView({ block: 'nearest' });
                found.click();
                await new Promise(r => setTimeout(r, 250));
                return { success: true, model: (found.innerText || '').trim() };
            }

            // Close menu if not found
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            return { error: 'Model not found in menu: ' + rawTarget };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to set model' };
}

// Get Usage Metrics
const readAccountQuota = createQuotaReader();

export async function getUsageMetrics(cdp, options = {}) {
    const fallbackState = { mode: 'Unknown', model: 'Unknown' };
    const [accountQuota, appState] = await Promise.all([
        readAccountQuota(cdp, options),
        cdp ? getAppState(cdp).catch(() => fallbackState) : fallbackState
    ]);

    let turnCount = 0;
    let userMsgCount = 0;
    let assistantMsgCount = 0;
    let approxTokens = 0;

    if (lastSnapshot && lastSnapshot.html) {
        const html = lastSnapshot.html;
        userMsgCount = (html.match(/bg-background|md-sticky-message-bleed/g) || []).length;
        assistantMsgCount = (html.match(/role="article"|markdown|prose/g) || []).length;
        turnCount = Math.max(userMsgCount, Math.ceil(assistantMsgCount / 2));
        
        const strippedLen = html.replace(/<[^>]*>/g, '').length;
        approxTokens = Math.round(strippedLen / 3.8);
    }

    const currentModelName = appState.model || 'Unknown';
    const currentModeName = appState.mode || 'Unknown';

    // Find active model in catalog
    const matchedModel = MODELS_CATALOG.find(m => 
        currentModelName.toLowerCase().includes(m.id) || 
        m.name.toLowerCase().includes(currentModelName.toLowerCase()) ||
        currentModelName.toLowerCase().includes(m.displayName.toLowerCase())
    ) || MODELS_CATALOG[0];

    const maxContextTokens = matchedModel.contextWindowNum || 1000000;
    const contextUsedPercent = Math.min(100, Math.max(1, parseFloat(((approxTokens / maxContextTokens) * 100).toFixed(1))));

    return {
        success: true,
        model: currentModelName,
        mode: currentModeName,
        serverTime: new Date().toISOString(),
        matchedModel,
        session: {
            turns: turnCount,
            userMessages: userMsgCount,
            assistantMessages: assistantMsgCount,
            approxTokens,
            maxContextTokens,
            contextUsedPercent,
            nodes: lastSnapshot?.stats?.nodes || 0,
            payloadKb: lastSnapshot ? Math.round((lastSnapshot.stats.htmlSize + lastSnapshot.stats.cssSize) / 1024) : 0
        },
        quota: accountQuota,
        system: {
            uptimeSeconds: Math.round(process.uptime()),
            uptimeFormatted: formatUptime(process.uptime()),
            cdpConnected: cdp?.ws?.readyState === 1,
            memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
            localIP: getLocalIP(),
            port: SERVER_PORT
        },
        models: MODELS_CATALOG
    };
}

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            // Priority 1: Exact selector from user (data-tooltip-id="new-conversation-tooltip")
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true, method: 'data-tooltip-id' };
            }

            // Fallback: Use previous heuristics
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            
            // Find all buttons with plus icons
            const plusButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false; // Skip hidden
                const hasPlusIcon = btn.querySelector('svg.lucide-plus') || 
                                   btn.querySelector('svg.lucide-square-plus') ||
                                   btn.querySelector('svg[class*="plus"]');
                return hasPlusIcon;
            });
            
            // Filter only top buttons (toolbar area)
            const topPlusButtons = plusButtons.filter(btn => {
                const rect = btn.getBoundingClientRect();
                return rect.top < 200;
            });

            if (topPlusButtons.length > 0) {
                 topPlusButtons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                 topPlusButtons[0].click();
                 return { success: true, method: 'filtered_top_plus', count: topPlusButtons.length };
            }
            
            // Fallback: aria-label
             const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                return (ariaLabel.includes('new') || title.includes('new')) && btn.offsetParent !== null;
            });
            
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true, method: 'aria_label_new' };
            }
            
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}
// Get Chat History - Scrapes conversations from sidebar and search modal with desktop-matching grouping
export async function getChatHistory(cdp) {
    const EXP = `(async () => {
        try {
            const parseConversationLines = (lines) => {
                if (!lines || lines.length === 0) return null;
                const isTimestamp = (str) => /^(now|just now|[0-9]+[smhdwy]|([0-9]+mo)|([0-9]+y))$/i.test(str.trim());

                const title = lines[0].trim();
                let workspace = '';
                let timestamp = '';

                if (lines.length === 2) {
                    if (isTimestamp(lines[1])) {
                        timestamp = lines[1].trim();
                    } else {
                        workspace = lines[1].trim();
                    }
                } else if (lines.length >= 3) {
                    workspace = lines[1].trim();
                    timestamp = lines[2].trim();
                }
                return { title, workspace, timestamp };
            };

            const chats = [];
            const seenTitles = new Map();

            // Section detection in visible sidebar
            const sectionHeaders = Array.from(document.querySelectorAll('aside h2, [data-testid*="sidebar"] h2, h2.text-xs'));
            const projectsH2 = sectionHeaders.find(h => (h.innerText || '').trim().toLowerCase() === 'projects');
            const convH2 = sectionHeaders.find(h => (h.innerText || '').trim().toLowerCase() === 'conversations');
            const pinnedH2 = sectionHeaders.find(h => (h.innerText || '').trim().toLowerCase() === 'pinned');

            const getSectionForElement = (el) => {
                if (pinnedH2 && (pinnedH2.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                    if (!projectsH2 || (el.compareDocumentPosition(projectsH2) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                        return 'Pinned';
                    }
                }
                if (projectsH2 && (projectsH2.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                    if (!convH2 || (el.compareDocumentPosition(convH2) & Node.DOCUMENT_POSITION_FOLLOWING)) {
                        return 'Projects';
                    }
                }
                return 'Conversations';
            };

            // Strategy 1: Direct Sidebar Scan
            const sidebarRows = Array.from(document.querySelectorAll('[data-testid="conversation-row-sidebar"]'));
            for (const r of sidebarRows) {
                const lines = (r.innerText || '').trim().split('\\n').map(s => s.trim()).filter(Boolean);
                const parsed = parseConversationLines(lines);
                if (parsed && parsed.title.length >= 2) {
                    if (parsed.title.toLowerCase().startsWith('show ') && parsed.title.toLowerCase().endsWith('more...')) continue;
                    if (parsed.title.toLowerCase().includes('search for conversations')) continue;

                    const isPinned = !!r.querySelector('[data-testid="conversation-pin-button"] svg.fill-current, [aria-label*="Unpin"], [title*="Unpin"]');
                    const isActive = r.className.includes('bg-sidebar-secondary') || r.getAttribute('data-active') === 'true';
                    const detectedSection = isPinned ? 'Pinned' : (parsed.workspace ? 'Projects' : getSectionForElement(r));

                    const item = {
                        title: parsed.title,
                        workspace: parsed.workspace,
                        timestamp: parsed.timestamp,
                        isActive: isActive,
                        isPinned: isPinned,
                        group: detectedSection
                    };
                    seenTitles.set(parsed.title, item);
                    chats.push(item);
                }
            }

            // Polling is read-only: opening search here steals the composer focus.

            return { success: true, chats: chats };
        } catch (e) {
            return { error: e.toString(), chats: [] };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to retrieve chat history from any context', chats: [] };
}

// Select a Chat to switch to
async function selectChat(cdp, chatTitle) {
    const safeChatTitle = JSON.stringify(chatTitle);
    console.log(`[selectChat] Request received to switch to: "${chatTitle}"`);

    const EXP = `(async () => {
        try {
            const targetTitle = ${safeChatTitle}.trim().toLowerCase();

            const triggerClick = (el) => {
                if (!el) return;
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evt => {
                    el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
                });
            };

            const matches = (text) => {
                const t = (text || '').trim().toLowerCase();
                return t === targetTitle || t.startsWith(targetTitle) || targetTitle.startsWith(t) || t.includes(targetTitle) || targetTitle.includes(t);
            };

            // 1. Direct match in visible sidebar
            const sidebarRows = Array.from(document.querySelectorAll('[data-testid="conversation-row-sidebar"]'));
            for (const r of sidebarRows) {
                const lines = (r.innerText || '').trim().split('\\n');
                if (matches(lines[0])) {
                    const targetEl = r.querySelector('a') || r;
                    triggerClick(targetEl);
                    return { success: true, method: 'sidebar-anchor', title: lines[0] };
                }
            }

            // 2. Open Search Conversations modal
            const searchBtn = document.querySelector('[data-testid="sidebar-search-button"], [aria-label*="Search Conversations"], [aria-label*="Search conversations"]');
            if (!searchBtn) return { error: 'Search button not found' };

            triggerClick(searchBtn);
            await new Promise(r => setTimeout(r, 450));

            // Type in search input to filter (use optimal length for CMDK)
            const searchQuery = targetTitle.length > 20 ? targetTitle.slice(0, 20).trim() : targetTitle;
            const input = document.querySelector('input[placeholder*="Search for conversations"], input[placeholder*="search"], [cmdk-input]');
            if (input) {
                input.focus();
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) {
                    setter.call(input, searchQuery);
                } else {
                    input.value = searchQuery;
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await new Promise(r => setTimeout(r, 350));
            }

            const modal = document.querySelector('[cmdk-root], [role="dialog"], [data-testid*="modal"], [class*="dialog"], [data-state="open"]');
            if (modal) {
                const items = Array.from(modal.querySelectorAll('[role="option"], [cmdk-item], [data-testid*="item"], div.cursor-pointer'));
                
                // Exact / prefix / contains match
                for (const item of items) {
                    const lines = (item.innerText || '').trim().split('\\n');
                    if (matches(lines[0]) || (lines[0] && targetTitle.includes(lines[0].toLowerCase()))) {
                        triggerClick(item);
                        return { success: true, method: 'search-modal', title: lines[0] };
                    }
                }

                // Substring / fuzzy match across item text
                for (const item of items) {
                    const text = (item.innerText || '').trim().toLowerCase();
                    if (text.includes(searchQuery)) {
                        triggerClick(item);
                        return { success: true, method: 'search-modal-fuzzy', title: text.slice(0, 30) };
                    }
                }

                // Fallback: click the first search result if filtered
                if (items.length > 0 && input && input.value) {
                    triggerClick(items[0]);
                    return { success: true, method: 'first-search-result' };
                }
            }

            // If not found, dismiss dialog
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            return { error: 'Conversation not found: ' + targetTitle.slice(0, 30) };
        } catch (e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) {
                console.log(`[selectChat] Successfully switched via method "${res.result.value.method}":`, res.result.value.title);
                return res.result.value;
            }
        } catch (e) { }
    }
    console.error(`[selectChat] Failed to switch conversation: "${chatTitle}"`);
    return { error: 'Failed to switch conversation' };
}

// Close History Panel (Escape)
async function closeHistory(cdp) {
    const EXP = `(async () => {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            return { success: true };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to close history panel' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const chatContainer = document.getElementById('conversation') || 
                          document.getElementById('chat') || 
                          document.getElementById('cascade') ||
                          document.querySelector('.isolate.overflow-y-auto') ||
                          document.querySelector('[class*="scrollbar-hide"][class*="overflow-y-auto"]') ||
                          document.getElementById('antigravity.agentSidePanelInputBox');
    const hasMessages = chatContainer && (chatContainer.querySelectorAll('[class*="message"], [data-message], .prose, .markdown').length > 0 || chatContainer.scrollHeight > 300);
    const editor = document.querySelector('#antigravity\\.agentSidePanelInputBox [contenteditable="true"]') || document.querySelector('[contenteditable="true"]') || (chatContainer && chatContainer.querySelector('[data-lexical-editor="true"]'));
    return {
        hasChat: !!chatContainer,
        hasMessages: !!hasMessages,
        editorFound: !!editor
    };
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { hasChat: false, hasMessages: false, editorFound: false };
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Turbo', model: 'Select Model' };

        // 1. Get Mode (Turbo / Default / Request Review / Fast / Planning)
        const presetBtn = document.querySelector('[data-testid="permissions-selector-trigger"], button[aria-label*="permissions preset"], button[aria-label*="preset selector"]');
        if (presetBtn) {
            const aria = presetBtn.getAttribute('aria-label') || '';
            const match = aria.match(/current:\s*([^,]+)/i);
            state.mode = (presetBtn.innerText || '').trim() || (match ? match[1].trim() : 'Turbo');
        } else {
            const allEls = Array.from(document.querySelectorAll('*'));
            for (const el of allEls) {
                if (el.children.length > 0) continue;
                const text = (el.innerText || '').trim();
                if (['Turbo', 'Default', 'Request Review', 'Fast', 'Planning'].includes(text)) {
                    state.mode = text;
                    break;
                }
            }
        }

        // 2. Get Model (Gemini 3.8 Flash High, Claude Sonnet 4.6, etc.)
        const modelBtn = document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"], button[aria-label*="model"]');
        if (modelBtn) {
            const aria = modelBtn.getAttribute('aria-label') || '';
            const match = aria.match(/current:\s*([^,]+)/i);
            state.model = (modelBtn.innerText || '').trim() || (match ? match[1].trim() : 'Select Model');
        } else {
            const KNOWN_MODELS = ["Gemini", "Claude", "GPT", "DeepSeek"];
            const textNodes = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && el.innerText);
            const found = textNodes.find(el => {
                const txt = el.innerText.trim();
                return KNOWN_MODELS.some(k => txt.includes(k)) && txt.length < 60;
            });
            if (found) state.model = found.innerText.trim();
        }

        // 3. Detect if the agent is actively executing
        const cancelBtn = document.querySelector('#antigravity\\\\.agentSidePanelInputBox button[aria-label*="Cancel (Ctrl+D)"], [data-tooltip-id="input-send-button-cancel-tooltip"]');
        state.isBusy = !!(cancelBtn && cancelBtn.offsetParent !== null);

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Check if a request is from the same Wi-Fi (internal network)
function isLocalRequest(req) {
    // 1. Check for proxy headers (Cloudflare, ngrok, etc.)
    // If these exist, the request is coming via an external tunnel/proxy
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    // 2. Check the remote IP address
    const ip = req.ip || req.socket.remoteAddress || '';

    // Standard local/private IPv4 and IPv6 ranges
    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

// Initialize CDP connection
async function initCDP() {
    console.log('🔍 Discovering Antigravity CDP endpoint...');
    const cdpInfo = await discoverCDP();
    console.log(`✅ Found Antigravity on port ${cdpInfo.port} `);

    console.log('🔌 Connecting to CDP...');
    const invalidateSnapshot = () => { lastSnapshot = null; lastSnapshotHash = null; };
    let connection;
    connection = await connectCDP(cdpInfo.url, {
        onDisconnect: () => {
            if (cdpConnection === connection) {
                cdpConnection = null;
                invalidateSnapshot();
            }
        },
        onContextsCleared: invalidateSnapshot
    });
    cdpConnection = connection;
    console.log(`✅ Connected! Found ${cdpConnection.contexts.length} execution contexts\n`);
}

// Background polling
async function startPolling(wss) {
    let lastErrorLog = 0;
    let isConnecting = false;

    const poll = async () => {
        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('🔍 Looking for Antigravity CDP connection...');
                isConnecting = true;
            }
            if (cdpConnection) {
                // Was connected, now lost
                console.log('🔄 CDP connection lost. Attempting to reconnect...');
                cdpConnection = null;
                lastSnapshot = null;
                lastSnapshotHash = null;
            }
            try {
                await initCDP();
                if (cdpConnection) {
                    console.log('✅ CDP Connection established from polling loop');
                    isConnecting = false;
                }
            } catch (err) {
                // Not found yet, just wait for next cycle
            }
            setTimeout(poll, 2000); // Try again in 2 seconds if not found
            return;
        }

        try {
            const connection = cdpConnection;
            const snapshot = await captureSnapshot(connection);
            if (connection !== cdpConnection || connection.ws.readyState !== WebSocket.OPEN) return setTimeout(poll, POLL_INTERVAL);
            if (snapshot && !snapshot.error) {
                const hash = hashString(snapshot.html);

                // Only update if content changed
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;

                    // Broadcast to all connected clients
                    wss.clients.forEach(client => {
                        if (client.authenticated && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'snapshot_update',
                                timestamp: new Date().toISOString()
                            }), error => { if (error) client.terminate(); });
                        }
                    });

                    console.log(`📸 Snapshot updated(hash: ${hash})`);
                }
            } else {
                // Snapshot is null or has error
                const now = Date.now();
                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';
                    console.warn(`⚠️  Snapshot capture issue: ${errorMsg} `);
                    if (errorMsg.includes('container not found')) {
                        console.log('   (Tip: Ensure an active chat is open in Antigravity)');
                    }
                    if (connection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Antigravity window)');
                    }
                    lastErrorLog = now;
                }
            }
        } catch (err) {
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, POLL_INTERVAL);
    };

    poll();
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Create Express app
export async function createServer() {
    const app = express();
    const sends = createSendCoordinator();
    const desktopAction = handler => asyncRoute(async (req, res) => {
        const executed = await sends.runAction(() => handler(req, res));
        if (!executed) res.status(409).json({ success: false, error: 'desktop_busy', message: '桌面正在处理上一项操作，请稍后重试' });
    });

    // Check for SSL certificates
    const keyPath = join(__dirname, 'certs', 'server.key');
    const certPath = join(__dirname, 'certs', 'server.cert');
    const hasSSL = fs.existsSync(keyPath) && fs.existsSync(certPath);

    let server;
    let httpsServer = null;

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
        server = httpsServer;
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({ server });

    // Initialize Auth Token using a unique salt from environment
    const authSalt = process.env.AUTH_SALT || 'antigravity_default_salt_99';
    AUTH_TOKEN = hashString(APP_PASSWORD + authSalt);

    app.use(compression());
    app.use(express.json({ limit: '1mb' }));

    // Use a secure session secret from .env if available
    const sessionSecret = process.env.SESSION_SECRET || 'antigravity_secret_key_1337';

    if (sessionSecret === 'antigravity_secret_key_1337') {
        console.warn('\n\x1b[33m%s\x1b[0m', '⚠️  SECURITY WARNING: Using default SESSION_SECRET ("antigravity_secret_key_1337").');
        console.warn('\x1b[33m%s\x1b[0m', '   Set a strong SESSION_SECRET in your .env file for production use.\n');
    }
    app.use(cookieParser(sessionSecret));

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    // Auth Middleware
    app.use((req, res, next) => {
        const publicPaths = ['/login', '/login.html', '/favicon.ico'];
        if (publicPaths.includes(req.path) || req.path.startsWith('/css/')) {
            return next();
        }

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            return next();
        }

        // Magic Link / QR Code Auto-Login
        if (req.query.key === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            // Remove the key from the URL by redirecting to the base path
            return res.redirect('/');
        }

        const token = req.signedCookies[AUTH_COOKIE_NAME];
        if (token === AUTH_TOKEN) {
            return next();
        }

        // If it's an API request, return 401, otherwise redirect to login
        if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/snapshot') || req.path.startsWith('/send')) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    });

    app.use(express.static(join(__dirname, 'public')));

    // Login endpoint
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    // Logout endpoint
    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    // Get current snapshot
    app.get('/snapshot', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!cdpConnection || cdpConnection.ws.readyState !== WebSocket.OPEN) {
            return res.status(503).json({ error: 'cdp_disconnected', message: '桌面连接正在恢复' });
        }
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'snapshot_pending', message: '等待桌面会话同步' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(lastSnapshot);
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1, // WebSocket.OPEN = 1
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            https: hasSSL
        });
    });

    // SSL status endpoint
    app.get('/ssl-status', (req, res) => {
        const keyPath = join(__dirname, 'certs', 'server.key');
        const certPath = join(__dirname, 'certs', 'server.cert');
        const certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);
        res.json({
            enabled: hasSSL,
            certsExist: certsExist,
            message: hasSSL ? 'HTTPS is active' :
                certsExist ? 'Certificates exist, restart server to enable HTTPS' :
                    'No certificates found'
        });
    });

    // Generate SSL certificates endpoint
    app.post('/generate-ssl', asyncRoute(async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node generate_ssl.js', { cwd: __dirname, stdio: 'pipe' });
            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    }));

    // Debug UI Endpoint
    app.get('/debug-ui', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    }));

    // Set Mode
    app.post('/set-mode', desktopAction(async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    }));

    // Set Model
    app.post('/set-model', desktopAction(async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    }));

    // Stop Generation
    app.post('/stop', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    }));

    // Send message (single writer + receipts for lost HTTP responses).
    app.post('/send', asyncRoute(async (req, res) => {
        const { message, isSteer = false, requestId } = req.body || {};
        if (typeof message !== 'string' || !message.trim() || message.length > 100000) {
            return res.status(400).json({ success: false, ok: false, error: 'invalid_message', message: '请输入有效消息（最多 100000 字符）' });
        }
        if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))) {
            return res.status(400).json({ success: false, ok: false, error: 'invalid_request_id' });
        }
        const payload = { message: message.trim(), isSteer: !!isSteer };
        const response = await sends.run(requestId, payload, async () => {
            const connection = cdpConnection;
            if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
                return { status: 503, body: { success: false, ok: false, error: 'cdp_disconnected', message: '桌面连接正在恢复，请稍后重试' } };
            }
            const result = await injectMessage(connection, payload.message, { isSteer: payload.isSteer });
            return { status: result.ok ? 200 : 400, body: { ...result, success: result.ok === true, ok: result.ok === true } };
        });
        res.setHeader('Cache-Control', 'no-store');
        res.status(response.status).json(response.body);
    }));

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });

        const EXP = `(() => {
    try {
        // Safeguard for non-DOM contexts
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        // Helper to get string class name safely (handles SVGAnimatedString)
        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        // Helper to pierce Shadow DOM
        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (e) { }
            }
            return results;
        }

        // Get standard info
        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        // Scan for buttons
        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, i) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index: i,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(b => b.visible);

        return {
            url, title, bodyLen, hasCascade,
            buttons, lucideIcons: allLucideElements
        };
    } catch (err) {
        return { error: err.toString(), stack: err.stack };
    }
})()`;

        try {
            // 1. Get Frames
            const { frameTree } = await cdpConnection.call("Page.getFrameTree");
            function flattenFrames(node) {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];
                if (node.childFrames) {
                    for (const child of node.childFrames) list = list.concat(flattenFrames(child));
                }
                return list;
            }
            const allFrames = flattenFrames(frameTree);

            // 2. Map Contexts
            const contexts = cdpConnection.contexts.map(c => ({
                id: c.id,
                name: c.name,
                origin: c.origin,
                frameId: c.auxData ? c.auxData.frameId : null,
                isDefault: c.auxData ? c.auxData.isDefault : false
            }));

            // 3. Scan ALL Contexts
            const contextResults = [];
            for (const ctx of contexts) {
                try {
                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result?.value) {
                        const val = result.result.value;
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            url: val.url,
                            title: val.title,
                            hasCascade: val.hasCascade,
                            buttonCount: val.buttons.length,
                            lucideCount: val.lucideIcons.length,
                            buttons: val.buttons, // Store buttons for analysis
                            lucideIcons: val.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (e) {
                    contextResults.push({ contextId: ctx.id, error: e.message });
                }
            }

            // 4. Match and Analyze
            const cascadeFrame = allFrames.find(f => f.url.includes('cascade'));
            const matchingContext = contextResults.find(c => c.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((a, b) => (b.buttonCount || 0) - (a.buttonCount || 0))[0];

            // Prepare "useful buttons" from the best context
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext ? (bestContext.buttons || []).filter(b =>
                b.ariaLabel?.includes('New Conversation') ||
                b.title?.includes('New Conversation') ||
                b.ariaLabel?.includes('Past Conversations') ||
                b.title?.includes('Past Conversations') ||
                b.ariaLabel?.includes('History')
            ) : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts: contexts,
                scanResults: contextResults.map(c => ({
                    id: c.contextId,
                    frameId: c.frameId,
                    url: c.url,
                    hasCascade: c.hasCascade,
                    buttons: c.buttonCount,
                    error: c.error
                })),
                usefulButtons: usefulButtons,
                bestContextData: bestContext // Full data for the best context
            });

        } catch (e) {
            res.status(500).json({ error: e.message, stack: e.stack });
        }
    }));

    // Endpoint to list all CDP targets - helpful for debugging connection issues
    app.get('/cdp-targets', asyncRoute(async (req, res) => {
        const results = {};
        for (const port of PORTS) {
            try {
                const list = await getJson(`http://127.0.0.1:${port}/json/list`);
                results[port] = list;
            } catch (e) {
                results[port] = e.message;
            }
        }
        res.json(results);
    }));

    // WebSocket connection with Auth check
    // RFC 6455 Ping/Pong keep-alive: prevents Cloudflare (100s idle timeout) and carrier NAT drops
    const pingInterval = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.authenticated || ws.readyState !== WebSocket.OPEN) return;
            if (ws.isAlive === false) {
                console.log('📱 Terminating dead WebSocket client (heartbeat missed)');
                return ws.terminate();
            }
            ws.isAlive = false;
            try {
                ws.ping(error => { if (error) ws.terminate(); });
            } catch (err) { ws.terminate(); }
        });
    }, 25000);

    wss.on('close', () => {
        clearInterval(pingInterval);
    });

    wss.on('connection', (ws, req) => {
        ws.on('error', error => {
            console.warn('[WS] Client error:', error.message);
            ws.terminate();
        });
        // Track heartbeat state
        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        // Parse cookies from headers
        const rawCookies = req.headers.cookie || '';
        const parsedCookies = {};
        rawCookies.split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (k && v) {
                try {
                    parsedCookies[k] = decodeURIComponent(v);
                } catch (e) {
                    parsedCookies[k] = v;
                }
            }
        });

        // Verify signed cookie manually
        const signedToken = parsedCookies[AUTH_COOKIE_NAME];
        let isAuthenticated = false;

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            isAuthenticated = true;
        } else if (signedToken) {
            const sessionSecret = process.env.SESSION_SECRET || 'antigravity_secret_key_1337';

            if (sessionSecret === 'antigravity_secret_key_1337') {
                // Warning already printed on startup, but we check here for token verification
            }

            const token = cookieParser.signedCookie(signedToken, sessionSecret);
            if (token === AUTH_TOKEN) {
                isAuthenticated = true;
            }
        }

        if (!isAuthenticated) {
            console.log('🚫 Unauthorized WebSocket connection attempt');
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        ws.authenticated = true;
        ws.on('message', raw => {
            try {
                const data = JSON.parse(raw);
                if (data.type === 'ping' && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'pong', cdpConnected: cdpConnection?.ws.readyState === WebSocket.OPEN }), error => {
                        if (error) ws.terminate();
                    });
                }
            } catch { /* Ignore malformed client messages. */ }
        });
        console.log('📱 Client connected (Authenticated)');

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    // Remote Click
    app.post('/remote-click', desktopAction(async (req, res) => {
        const { selector, index, textContent } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await clickElement(cdpConnection, { selector, index, textContent });
        res.json(result);
    }));

    // Remote Scroll - sync phone scroll to desktop
    app.post('/remote-scroll', asyncRoute(async (req, res) => {
        const { scrollTop, scrollPercent } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
        res.json(result);
    }));

    // Load Older Messages (History)
    app.post('/load-older-messages', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await loadOlderMessages(cdpConnection);
        if (result && result.clicked) {
            await new Promise(r => setTimeout(r, 350));
        }
        lastSnapshot = null;
        lastSnapshotHash = null;
        res.json(result);
    }));

    // Get App State
    app.get('/app-state', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.json({ mode: 'Unknown', model: 'Unknown' });
        const result = await getAppState(cdpConnection);
        res.json(result);
    }));

    // Get Available Models Catalog
    app.get('/models', (req, res) => {
        res.json({ success: true, models: MODELS_CATALOG });
    });

    // Get Usage & Quota Metrics
    app.get('/usage', asyncRoute(async (req, res) => {
        const metrics = await getUsageMetrics(cdpConnection, { forceRefresh: req.query.refresh === '1' });
        res.setHeader('Cache-Control', 'no-store');
        res.json(metrics);
    }));

    // Start New Chat
    app.post('/new-chat', desktopAction(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await startNewChat(cdpConnection);
        if (result.success) { lastSnapshot = null; lastSnapshotHash = null; }
        res.json(result);
    }));

    // Get Chat History
    app.get('/chat-history', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.json({ error: 'CDP disconnected', chats: [] });
        const result = await getChatHistory(cdpConnection);
        res.json(result);
    }));

    // Select a Chat
    app.post('/select-chat', desktopAction(async (req, res) => {
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Chat title required' });
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await selectChat(cdpConnection, title);
        if (result.success) { lastSnapshot = null; lastSnapshotHash = null; }
        res.json(result);
    }));

    // Close Chat History
    app.post('/close-history', desktopAction(async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await closeHistory(cdpConnection);
        res.json(result);
    }));

    // Check if Chat is Open
    app.get('/chat-status', asyncRoute(async (req, res) => {
        if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
        const result = await hasChatOpen(cdpConnection);
        res.json(result);
    }));


    app.use((error, req, res, next) => {
        console.error(`[HTTP] ${req.method} ${req.path}:`, error.message);
        if (res.headersSent) return next(error);
        res.status(error.status || 500).json({ success: false, error: error.type || 'request_failed', message: '请求失败，请稍后重试' });
    });

    return { server, wss, app, hasSSL };
}

// Main
async function main() {
    try {
        await initCDP();
    } catch (err) {
        console.warn(`⚠️  Initial CDP discovery failed: ${err.message}`);
        console.log('💡 Start Antigravity with --remote-debugging-port=9000 to connect.');
    }

    try {
        const { server, wss, hasSSL } = await createServer();

        // Start background polling (it will now handle reconnections)
        startPolling(wss);

        // Kill any existing process on the port before starting
        await killPortProcess(SERVER_PORT);

        // Start server
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        server.listen(SERVER_PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on ${protocol}://${localIP}:${SERVER_PORT}`);
            if (hasSSL) {
                console.log(`💡 First time on phone? Accept the security warning to proceed.`);
            }
        });

        // Graceful shutdown handlers
        const gracefulShutdown = (signal) => {
            console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        process.on('uncaughtException', (err) => {
            console.error('⚠️ Uncaught Exception:', err);
        });
        process.on('unhandledRejection', (reason, promise) => {
            console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
        });

    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    main();
}
