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

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Find Antigravity CDP endpoint
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

// Connect to CDP
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map(); // Track pending calls by ID
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000; // 30 seconds timeout

    // Single centralized message handler (fixes MaxListenersExceeded warning)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;

        // Setup timeout to prevent memory leaks from never-resolved calls
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);

        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return { ws, call, contexts };
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
                    el.setAttribute('data-ag-rem', 'true');
                }
            } catch(e) {}
        });

        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);
        clone.id = 'conversation';
        clone.classList.remove('theme-light');
        clone.classList.add('theme-dark', 'antigravity-snapshot-root');
        clone.style.height = 'auto';
        clone.style.minHeight = '100%';
        clone.style.maxHeight = 'none';
        clone.style.overflow = 'visible';
        clone.style.containerType = 'normal';
        clone.style.paddingRight = '0px';

        // Fix container-type: size and max-width on children to prevent collapsing
        clone.querySelectorAll('*').forEach(el => {
            if (el.classList.contains('theme-light')) {
                el.classList.remove('theme-light');
                el.classList.add('theme-dark');
            }
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
        
        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length
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

// Inject message into Antigravity
async function injectMessage(cdp, text) {
    // Use JSON.stringify for robust escaping (handles ", \, newlines, backticks, unicode, etc.)
    const safeText = JSON.stringify(text);

    const EXPRESSION = `(async () => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]') || document.querySelector('button[aria-label*="Cancel"], button[aria-label*="取消"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        const editors = [...document.querySelectorAll('#antigravity\\.agentSidePanelInputBox [contenteditable="true"], [contenteditable="true"], #conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
            .filter(el => el.offsetParent !== null || el.getClientRects().length > 0);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        const textToInsert = ${safeText};

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
        if (!inserted) {
            editor.textContent = textToInsert;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const submit = document.querySelector("#antigravity\\.agentSidePanelInputBox button[aria-label*='Send'], #antigravity\\.agentSidePanelInputBox button[aria-label*='发送'], svg.lucide-arrow-right")?.closest("button");
        if (submit && !submit.disabled) {
            submit.click();
            return { ok:true, method:"click_submit" };
        }

        // Submit button not found, trigger Enter key
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, cancelable:true, key:"Enter", code:"Enter", keyCode:13, which:13 }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, cancelable:true, key:"Enter", code:"Enter", keyCode:13, which:13 }));
        
        return { ok:true, method:"enter_keypress" };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Set functionality mode (Turbo / Default / Request Review / Fast / Planning)
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
        // Look for the cancel button
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
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
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
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

// Set AI Model
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            let modelBtn = null;
            
            // Strategy 1: Look for data-testid and aria-label (Antigravity 2.0)
            modelBtn = document.querySelector('[data-testid="model-selector-trigger"], button[aria-label*="Select model"], [data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
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
async function getChatHistory(cdp) {
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

            // Strategy 2: Search Conversations modal for full history
            const searchBtn = document.querySelector('[data-testid="sidebar-search-button"], [aria-label*="Search Conversations"], [aria-label*="Search conversations"]');
            if (searchBtn) {
                searchBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                searchBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                searchBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                await new Promise(r => setTimeout(r, 450));

                const modal = document.querySelector('[cmdk-root], [role="dialog"], [data-testid*="modal"], [class*="dialog"], [data-state="open"]');
                if (modal) {
                    const items = modal.querySelectorAll('[role="option"], [cmdk-item], [data-testid*="item"], div.cursor-pointer');
                    for (const item of items) {
                        const lines = (item.innerText || '').trim().split('\\n').map(s => s.trim()).filter(Boolean);
                        const parsed = parseConversationLines(lines);
                        if (parsed && parsed.title.length >= 2) {
                            if (parsed.title.toLowerCase().startsWith('show ') && parsed.title.toLowerCase().endsWith('more...')) continue;
                            if (parsed.title.toLowerCase().includes('search for conversations')) continue;

                            if (seenTitles.has(parsed.title)) {
                                const existing = seenTitles.get(parsed.title);
                                if (!existing.workspace && parsed.workspace) {
                                    existing.workspace = parsed.workspace;
                                    if (existing.group === 'Conversations') {
                                        existing.group = 'Projects';
                                    }
                                }
                                if (!existing.timestamp && parsed.timestamp) {
                                    existing.timestamp = parsed.timestamp;
                                }
                            } else {
                                const newItem = {
                                    title: parsed.title,
                                    workspace: parsed.workspace,
                                    timestamp: parsed.timestamp,
                                    isActive: false,
                                    isPinned: false,
                                    group: parsed.workspace ? 'Projects' : 'Conversations'
                                };
                                seenTitles.set(parsed.title, newItem);
                                chats.push(newItem);
                            }
                        }
                    }
                }

                // Close search dialog with Escape
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            }

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
    cdpConnection = await connectCDP(cdpInfo.url);
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
            const snapshot = await captureSnapshot(cdpConnection);
            if (snapshot && !snapshot.error) {
                const hash = hashString(snapshot.html);

                // Only update if content changed
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;

                    // Broadcast to all connected clients
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'snapshot_update',
                                timestamp: new Date().toISOString()
                            }));
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
                    if (cdpConnection.contexts.length === 0) {
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

// Create Express app
async function createServer() {
    const app = express();

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
    app.use(express.json());

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
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
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
    app.post('/generate-ssl', async (req, res) => {
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
    });

    // Debug UI Endpoint
    app.get('/debug-ui', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    });

    // Set Mode
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    });

    // Set Model
    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    });

    // Stop Generation
    app.post('/stop', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    });

    // Send message
    app.post('/send', async (req, res) => {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const result = await injectMessage(cdpConnection, message);

        // Always return 200 - the message usually goes through even if CDP reports issues
        // The client will refresh and see if the message appeared
        res.json({
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        });
    });

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', async (req, res) => {
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
    });

    // Endpoint to list all CDP targets - helpful for debugging connection issues
    app.get('/cdp-targets', async (req, res) => {
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
    });

    // WebSocket connection with Auth check
    wss.on('connection', (ws, req) => {
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

        console.log('📱 Client connected (Authenticated)');

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
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
        const { server, wss, app, hasSSL } = await createServer();

        // Start background polling (it will now handle reconnections)
        startPolling(wss);

        // Remote Click
        app.post('/remote-click', async (req, res) => {
            const { selector, index, textContent } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await clickElement(cdpConnection, { selector, index, textContent });
            res.json(result);
        });

        // Remote Scroll - sync phone scroll to desktop
        app.post('/remote-scroll', async (req, res) => {
            const { scrollTop, scrollPercent } = req.body;
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
            res.json(result);
        });

        // Get App State
        app.get('/app-state', async (req, res) => {
            if (!cdpConnection) return res.json({ mode: 'Unknown', model: 'Unknown' });
            const result = await getAppState(cdpConnection);
            res.json(result);
        });

        // Start New Chat
        app.post('/new-chat', async (req, res) => {
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await startNewChat(cdpConnection);
            res.json(result);
        });

        // Get Chat History
        app.get('/chat-history', async (req, res) => {
            if (!cdpConnection) return res.json({ error: 'CDP disconnected', chats: [] });
            const result = await getChatHistory(cdpConnection);
            res.json(result);
        });

        // Select a Chat
        app.post('/select-chat', async (req, res) => {
            const { title } = req.body;
            if (!title) return res.status(400).json({ error: 'Chat title required' });
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await selectChat(cdpConnection, title);
            res.json(result);
        });

        // Close Chat History
        app.post('/close-history', async (req, res) => {
            if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await closeHistory(cdpConnection);
            res.json(result);
        });

        // Check if Chat is Open
        app.get('/chat-status', async (req, res) => {
            if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
            const result = await hasChatOpen(cdpConnection);
            res.json(result);
        });

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

main();
