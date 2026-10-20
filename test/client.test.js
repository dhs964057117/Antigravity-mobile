import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function client(initialStorage = {}) {
    const elements = new Map();
    const events = new Map();
    const timers = new Map();
    const sockets = [];
    const storage = new Map(Object.entries(initialStorage));
    const toasts = [];
    let timerId = 0;
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: '', innerHTML: '', textContent: '', style: {}, scrollHeight: 100,
            classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
            addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
        });
        return elements.get(id);
    };
    class Socket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
        close() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            queueMicrotask(() => this.onclose?.());
        }
        send(value) { this.sent.push(JSON.parse(value)); }
        open() { this.readyState = 1; this.onopen?.(); }
        message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const context = vm.createContext({
        document: { visibilityState: 'visible', getElementById: element, querySelectorAll: () => [],
            createElement: () => ({ set textContent(value) { this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }),
            addEventListener: (name, fn) => events.set(name, fn) },
        window: { innerWidth: 1000, location: { protocol: 'http:', host: 'localhost', href: '/' },
            crypto: { randomUUID: () => 'receipt-id' }, addEventListener: (name, fn) => events.set(name, fn) },
        navigator: { onLine: true }, localStorage: { getItem: () => null },
        sessionStorage: { getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        WebSocket: Socket, Headers, Response, AbortController, URL, queueMicrotask,
        setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
        clearTimeout: id => timers.delete(id),
        setInterval: (fn, delay) => { timers.set(++timerId, { fn, delay, interval: true }); return timerId; },
        clearInterval: id => timers.delete(id),
        console: { log() {}, warn() {}, error() {} },
        fetch: async () => new Response('{}')
    });
    const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
    vm.runInContext(source.split('// --- Init Application ---')[0], context);
    context.toasts = toasts;
    vm.runInContext(`
        const realLoadSnapshot = loadSnapshot;
        showToast = (...args) => toasts.push(args);
        loadSnapshot = async () => {};
        loadSidebarHistory = async () => {};
        fetchAppState = async () => {};
    `, context);
    return {
        context, elements, storage, sockets, events, timers, toasts,
        run: source => vm.runInContext(source, context),
        fire(delay) {
            const [id, timer] = [...timers].find(([, timer]) => timer.delay === delay) || [];
            assert.ok(timer, `expected timer with delay ${delay}`);
            if (!timer.interval) timers.delete(id);
            timer.fn();
        }
    };
}

test('network recovery replaces an OPEN zombie and ignores old close events', async () => {
    const app = client();
    app.run('connectWebSocket()');
    app.sockets[0].open();
    app.sockets[0].message({ type: 'pong', cdpConnected: false });
    assert.equal(app.elements.get('statusText').textContent, '桌面重连中...');
    app.events.get('online')();
    assert.equal(app.sockets.length, 2);
    assert.equal(app.sockets[0].readyState, 3);
    app.sockets[1].open();
    app.sockets[1].message({ type: 'pong', cdpConnected: true });
    await Promise.resolve();
    assert.equal(app.elements.get('statusText').textContent, '实时在线');
});

test('missing application pong forces a reconnect instead of staying falsely online', () => {
    const app = client();
    app.run('connectWebSocket()');
    app.sockets[0].open();
    app.fire(10000);
    assert.equal(app.sockets[0].readyState, 3);
    assert.equal(app.elements.get('statusText').textContent, '重连中...');
    assert.ok([...app.timers.values()].some(timer => timer.delay >= 1000 && timer.delay < 1500));
});

test('a websocket stuck in CONNECTING has a deadline', () => {
    const app = client();
    app.run('connectWebSocket()');
    app.fire(10000);
    assert.equal(app.sockets[0].readyState, 3);
    assert.equal(app.run('ws'), null);
});

test('blocked browser preference storage cannot prevent connection startup', () => {
    const app = client();
    app.context.localStorage = { getItem() { throw new Error('Storage disabled'); } };
    app.run('initSidebarState(); connectWebSocket()');
    assert.equal(app.sockets.length, 1);
});

test('HTTP timeout covers a body stalled after headers', async () => {
    const app = client();
    app.context.fetch = async (url, { signal }) => ({
        status: 200, headers: new Headers(),
        text: () => new Promise((resolve, reject) => {
            if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    });
    const request = app.run("fetchWithAuth('/health', { timeoutMs: 25 })");
    await new Promise(setImmediate);
    app.fire(25);
    await assert.rejects(request, /aborted/);
    assert.equal(app.timers.size, 0);
});

test('auth expiry redirects and rejects instead of hanging forever', async () => {
    const app = client();
    app.context.fetch = async () => new Response('{}', { status: 401 });
    await assert.rejects(app.run("fetchWithAuth('/send')"), /登录已过期/);
    assert.equal(app.context.window.location.href, '/login.html');
    assert.equal(app.timers.size, 0);
});

test('lost send response retries the same receipt ID exactly once', async () => {
    const app = client();
    const requests = [];
    app.context.fetch = async (url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) throw new TypeError('network lost');
        return new Response(JSON.stringify({ success: true, ok: true }));
    };
    app.elements.get('messageInput').value = 'hello';
    await app.run('sendMessage()');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.equal(app.elements.get('messageInput').value, '');
    assert.equal(app.storage.has('ag_pending_send'), false);
});

test('rapid send events do not duplicate requests or erase new edits', async () => {
    const app = client();
    let resolve;
    let calls = 0;
    app.context.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
    app.elements.get('messageInput').value = 'first';
    const first = app.run('sendMessage()');
    await app.run('sendMessage()');
    app.elements.get('messageInput').value = 'second';
    resolve(new Response(JSON.stringify({ success: true, ok: true })));
    await first;
    assert.equal(calls, 1);
    assert.equal(app.elements.get('messageInput').value, 'second');
    assert.equal(app.elements.get('sendBtn').disabled, false);
});

test('invalid success responses leave the draft and do not show success', async () => {
    const app = client();
    app.context.fetch = async () => new Response('{}');
    app.elements.get('messageInput').value = 'hello';
    await app.run('sendMessage()');
    assert.equal(app.elements.get('messageInput').value, 'hello');
    assert.equal(app.toasts[0][1], 'error');
});

test('draft and uncertain receipt survive reload', () => {
    const app = client({ ag_pending_send: JSON.stringify({ requestId: 'previous', message: 'draft', isSteer: false }) });
    assert.equal(app.elements.get('messageInput').value, 'draft');
    assert.equal(app.run('pendingSend.requestId'), 'previous');
});

test('snapshot 503 preserves the current conversation', async () => {
    const app = client();
    app.elements.get('chatContent').innerHTML = 'existing conversation';
    app.context.fetch = async () => new Response(JSON.stringify({ error: 'snapshot_pending' }), { status: 503 });
    await app.run('realLoadSnapshot()');
    assert.equal(app.elements.get('chatContent').innerHTML, 'existing conversation');
});

test('quota cards show daily unknown, actual weekly usage, disabled rolling windows, and escaped labels', () => {
    const app = client();
    app.context.quotaData = { available: true, groups: [{ name: '<script>group</script>', buckets: [
        { window: 'weekly', limitPercent: 100, usedPercent: 100, remainingPercent: 0, resetAt: '2026-10-24T02:48:26Z' },
        { window: 'five_hour', disabled: true, limitPercent: 100, usedPercent: 0, remainingPercent: 100 }
    ] }] };
    const html = app.run("renderQuotaGroups(quotaData, 'Claude')");
    assert.match(html, /日限额/);
    assert.match(html, /账户未提供/);
    assert.match(html, /周限额/);
    assert.match(html, /额度已用完/);
    assert.match(html, /暂不适用/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('quota countdown uses absolute time and never starts an invented new period', () => {
    const app = client();
    assert.equal(app.run("formatQuotaCountdown('2026-10-19T00:00:00Z', Date.parse('2026-10-19T00:00:01Z'))"), '已到重置时间，等待账户更新');
    assert.equal(app.run("formatQuotaCountdown('2026-10-20T01:02:03Z', Date.parse('2026-10-19T00:00:00Z'))"), '1天 01:02:03 后补充');
    assert.equal(app.run('formatQuotaTime(null)'), '未提供');
});

test('closing the quota modal aborts loading and removes its update timer', async () => {
    const app = client();
    let finish;
    app.context.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = app.run('fetchUsageData()');
    app.run('closeUsageModal()');
    finish(new Response(JSON.stringify({ quota: { groups: [] } })));
    await pending;
    assert.equal(app.run('usageLoading'), false);
    assert.equal(app.context.window.usageCountdownTimer, null);
    assert.equal(app.elements.get('usageModalBody').innerHTML, '');
});

test('quota countdown corrects device clock skew using the server response time', () => {
    const app = client();
    // Keep millisecond drift from rounding this clock-skew check up by a second.
    app.run("Date.now = () => Date.parse('2026-10-20T12:00:00Z')");
    app.run("renderUsageModal({serverTime: new Date(Date.now() - 8 * 3600000).toISOString()})");
    const countdown = app.run("formatQuotaCountdown(new Date(Date.now() - 7 * 3600000).toISOString())");
    assert.match(countdown, /^01:00:00/);
});

test('theme management resolves system/light/dark and generates adaptive snapshot styles without sticky user positioning', () => {
    const app = client();
    assert.equal(app.run("resolveTheme('light')"), 'light');
    assert.equal(app.run("resolveTheme('dark')"), 'dark');
    assert.equal(app.run("resolveTheme('system')"), 'dark');

    const css = app.run("generateSnapshotStyles('.base { color: red; }')");
    assert.match(css, /position:\s*static\s*!important/);
    assert.match(css, /var\(--bg-user-bubble\)/);
    assert.match(css, /#conversation\s+\[class\*="md-sticky-message-bleed"\]/);
    assert.match(css, /#conversation\s+div\[class\*="group\/user-input-step"\]/);
});

test('snapshot history metadata toggles historyLoaderBar visibility and text', async () => {
    const app = client();
    app.context.fetch = async () => new Response(JSON.stringify({
        html: '<div id="conversation">content</div>',
        css: '',
        history: { hasOlder: true, showing: 120, total: 500 }
    }));
    await app.run('realLoadSnapshot()');
    assert.equal(app.elements.get('historyLoaderBar').style.display, 'flex');
    assert.match(app.elements.get('historyLoaderText').textContent, /120\/500/);
});
