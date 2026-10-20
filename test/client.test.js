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
            attrs: new Map(), listeners: new Map(),
            setAttribute(name, value) { this.attrs.set(name, String(value)); },
            getAttribute(name) { return this.attrs.get(name) ?? null; },
            removeAttribute(name) { this.attrs.delete(name); },
            focus() { context.document.activeElement = this; },
            classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
            addEventListener(name, fn) { this.listeners.set(name, fn); }, querySelectorAll: () => [], querySelector: () => null
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
        document: { visibilityState: 'visible', getElementById: element, querySelector: () => null, querySelectorAll: () => [],
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

test('theme management resolves system/light/dark and snapshot base styling works without imported CSS', () => {
    const app = client();
    assert.equal(app.run("resolveTheme('light')"), 'light');
    assert.equal(app.run("resolveTheme('dark')"), 'dark');
    assert.equal(app.run("resolveTheme('system')"), 'dark');

    assert.equal(app.run("generateSnapshotStyles('.base { color: red; }')"), '');
    const css = fs.readFileSync(new URL('../public/css/snapshot.css', import.meta.url), 'utf8');
    assert.match(css, /position:\s*static\s*!important/);
    assert.match(css, /var\(--ag-user-bg\)/);
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

test('each conversation restores its own draft and uncertain retry receipt', () => {
    const app = client();
    app.run("activateConversation('id:one', 'one'); messageInput.value = 'first draft'; persistComposerDraft(); pendingSend = {requestId:'receipt-one', message:'first draft', conversationId:'one'}; savePending()");
    app.run("activateConversation('id:two', 'two')");
    assert.equal(app.elements.get('messageInput').value, '');
    assert.equal(app.run('pendingSend'), null);
    app.run("messageInput.value = 'second draft'; persistComposerDraft(); activateConversation('id:one', 'one')");
    assert.equal(app.elements.get('messageInput').value, 'first draft');
    assert.equal(app.run('pendingSend.requestId'), 'receipt-one');
    app.run("activateConversation('id:two', 'two')");
    assert.equal(app.elements.get('messageInput').value, 'second draft');
});

test('first desktop sync migrates the unsent draft and blocked storage retains drafts in memory', () => {
    const app = client({ ag_message_draft: 'legacy draft' });
    app.run("syncConversationId('one')");
    assert.equal(app.elements.get('messageInput').value, 'legacy draft');
    app.context.sessionStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
    app.run("messageInput.value = 'memory draft'; persistComposerDraft(); activateConversation('id:two', 'two'); activateConversation('id:one', 'one')");
    assert.equal(app.elements.get('messageInput').value, 'memory draft');
});

test('failed navigation preserves the active draft and cannot submit while switching', async () => {
    const app = client();
    app.run("activateConversation('id:one', 'one'); messageInput.value = 'keep me'");
    let resolve;
    let calls = 0;
    app.context.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
    const switching = app.run("selectChat('second', 'two')");
    assert.equal(app.elements.get('messageInput').readOnly, true);
    await app.run('sendMessage()');
    await app.run("selectChat('third', 'three')");
    assert.equal(calls, 1);
    resolve(new Response(JSON.stringify({ success: false }), { status: 409 }));
    await switching;
    assert.equal(app.run('activeConversationId'), 'one');
    assert.equal(app.elements.get('messageInput').value, 'keep me');
    assert.equal(app.elements.get('messageInput').readOnly, false);
});

test('late snapshots from the previous chat do not replace a selected or newly created chat', () => {
    const app = client();
    app.run("activateConversation('id:two', 'two'); expectedSelectionId = 'two'; syncConversationId('one')");
    assert.equal(app.run('activeConversationId'), 'two');
    app.run("syncConversationId('two'); navigationOriginId = 'two'; expectedSelectionId = ''; activateConversation('new:local'); messageInput.value = 'new draft'; syncConversationId('two')");
    assert.equal(app.run('activeConversationKey'), 'new:local');
    app.run("syncConversationId('fresh')");
    assert.equal(app.run('activeConversationId'), 'fresh');
    assert.equal(app.elements.get('messageInput').value, 'new draft');
});

test('a stale transcript cannot render under a newly selected conversation', async () => {
    const app = client();
    app.run("activateConversation('id:two', 'two'); expectedSelectionId = 'two'");
    app.elements.get('chatContent').innerHTML = 'current content';
    app.context.fetch = async () => new Response(JSON.stringify({ conversationId: 'one', html: 'stale transcript' }));
    await app.run('realLoadSnapshot()');
    assert.equal(app.elements.get('chatContent').innerHTML, 'current content');
    app.run('syncDesktop()');
    assert.equal(app.run('expectedSelectionId'), null);
});

test('palette searches project and title terms, locks navigation while sending, and appends prompts without sending', () => {
    const app = client();
    app.run("rawConversations = [{id:'one',title:'Fix login bug',workspace:'Web app'},{id:'two',title:'Database migration',workspace:'Backend'}]");
    assert.equal(app.run("commandItems('web login').length"), 1);
    assert.equal(app.run("commandItems('web login')[0].key"), 'id:one');
    app.run('isSending = true');
    assert.equal(app.run("commandItems('web login')[0].disabled"), true);
    app.run("isSending = false; messageInput.value = 'existing'; fillComposer('next instruction')");
    assert.equal(app.elements.get('messageInput').value, 'existing\nnext instruction');
    assert.equal(app.run('isSending'), false);
});

test('palette supports keyboard selection, IME safety, and focus restoration', () => {
    const app = client();
    app.run('messageInput.focus(); openCommandPalette()');
    assert.equal(app.elements.get('appShell').inert, true);
    assert.equal(app.elements.get('commandSearchInput').getAttribute('aria-expanded'), 'true');
    app.run("paletteKeydown({key:'ArrowDown',preventDefault(){}})");
    assert.equal(app.run('paletteSelected'), 1);
    app.run("paletteKeydown({key:'Enter',isComposing:true,preventDefault(){throw Error('must not handle composing input')}})");
    assert.equal(app.run('paletteIsOpen'), true);
    app.run("paletteKeydown({key:'Escape',preventDefault(){}})");
    assert.equal(app.elements.get('appShell').inert, false);
    assert.equal(app.context.document.activeElement, app.elements.get('messageInput'));
});

test('sidebar refresh retains filtering and project collapse state with accessible controls', () => {
    const app = client();
    app.run("rawConversations = [{id:'one',title:'Fix login',workspace:'Web app'},{id:'two',title:'Migration',workspace:'Backend'}]; collapsedProjects.add('Web app'); renderSidebarConversations(rawConversations)");
    assert.match(app.elements.get('sidebarConvoList').innerHTML, /sidebar-project-group collapsed/);
    app.elements.get('sidebarSearchInput').value = 'login';
    app.run('renderSidebarConversations(rawConversations)');
    const html = app.elements.get('sidebarConvoList').innerHTML;
    assert.match(html, /Fix login/);
    assert.doesNotMatch(html, /Migration/);
    assert.doesNotMatch(html, /sidebar-project-group collapsed/);
    assert.match(html, /<button type="button" class="sidebar-card/);
    assert.equal(app.run("collapsedProjects.has('Web app')"), true);
});


test('desktop CSS scopes every selector and grouping rule without importing global registrations', () => {
    const app = client();
    app.context.desktopRules = [
        { type: 1, selectorText: 'button, :is(a, [title="a,b"]), .hover\\:bg-black:hover', cssText: 'button, :is(a, [title="a,b"]), .hover\\:bg-black:hover { color: black; }' },
        { type: 4, cssText: '@media (min-width: 768px) { button { color: black; } }', cssRules: [
            { type: 1, selectorText: ':root, .modal-card', cssText: ':root, .modal-card { background: black; }' }
        ] },
        { type: 5, cssText: '@font-face { font-family: remote; src: url(test); }' },
        { type: 0, cssText: '@property --border { syntax: "*"; inherits: false; }' }
    ];
    const css = app.run('scopeSnapshotRules(desktopRules)');
    assert.match(css, /:where\(#chatContent\) button, :where\(#chatContent\) :is\(a, \[title="a,b"\]\)/);
    assert.match(css, /@media.*:where\(#chatContent\) :root, :where\(#chatContent\) \.modal-card/s);
    assert.doesNotMatch(css, /@font-face|@property/);
});

test('model search matches a vendor and marks only the exact selected model', () => {
    const app = client();
    app.run(`currentModel = 'Example High'; availableModels = [
        {name:'Example High', displayName:'Example', family:'Google'},
        {name:'Example Low', displayName:'Example', family:'Google'},
        {name:'Other', family:'Anthropic'}]; modelSearchInput.value = 'Google'; renderModelCards()`);
    const markup = app.elements.get('modelCardsGrid').innerHTML;
    assert.equal((markup.match(/aria-pressed="true"/g) || []).length, 1);
    assert.match(markup, /data-model-name="Example Low"/);
    assert.doesNotMatch(markup, /data-model-name="Other"/);
    app.run("modelSearchInput.value = 'missing'; renderModelCards()");
    assert.match(app.elements.get('modelCardsGrid').innerHTML, /没有匹配/);
});

test('failed model changes keep the confirmed model and re-enable selection', async () => {
    const app = client();
    app.run("currentModel = 'Original'; modelText.textContent = currentModel");
    app.context.fetch = async () => new Response(JSON.stringify({ error: 'offline' }), {status:503});
    await app.run("selectModel('New model')");
    assert.equal(app.run('currentModel'), 'Original');
    assert.equal(app.elements.get('modelText').textContent, 'Original');
    assert.equal(app.run('modelSelectionPending'), false);
    assert.equal(app.elements.get('modelSearchInput').disabled, false);
    assert.match(app.elements.get('modelSelectionStatus').textContent, /未获确认/);
});

test('model selection waits for desktop confirmation and prevents duplicate requests', async () => {
    const app = client(); let finish; let calls = 0;
    app.run("currentModel = 'Original'; modelText.textContent = currentModel");
    app.context.fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    const first = app.run("selectModel('New model')");
    await app.run("selectModel('Second model'); closeModelModal()");
    assert.equal(calls, 1);
    assert.equal(app.elements.get('modelText').textContent, 'Original');
    assert.equal(app.run('modelSelectionPending'), true);
    finish(new Response(JSON.stringify({success:true})));
    await first;
    assert.equal(app.run('currentModel'), 'New model');
    assert.equal(app.elements.get('modelText').textContent, 'New model');
    assert.equal(app.elements.get('appShell').inert, false);
});

test('a dismissed model load cannot overwrite a newly opened picker', async () => {
    const app = client(); let finish;
    app.context.fetch = () => new Promise(resolve => { finish = resolve; });
    const first = app.run('openModelModal()');
    app.run("closeModelModal(); modelCardsGrid.innerHTML = 'new picker'");
    finish(new Response(JSON.stringify({models:[{name:'Stale model'}]})));
    await first;
    assert.equal(app.elements.get('modelCardsGrid').innerHTML, 'new picker');
});

test('expanding native thought details never triggers a duplicate desktop click', async () => {
    const app = client(); let calls = 0;
    app.context.fetch = async () => { calls++; return new Response('{}'); };
    const summary = {parentElement:{dataset:{}}};
    await app.elements.get('chatContainer').listeners.get('click')({ target: {closest: selector => selector === 'details > summary' ? summary : null} });
    assert.equal(calls, 0);
});

test('snapshot morphing preserves host container attributes and locally expanded details', () => {
    const app = client();
    app.run(`
        let removed = [];
        const shell = {attributes:[{name:'id'},{name:'class'}],childNodes:[],removeAttribute:name=>removed.push(name)};
        morphDOM(shell, {attributes:[],childNodes:[],hasAttribute:()=>false}, false);
    `);
    assert.equal(app.run('removed.length'), 0);
    app.run(`
        const details = {tagName:'DETAILS',dataset:{clientDetailsConversation:activeConversationKey},
            attributes:[{name:'open'}], childNodes:[],querySelector:()=>({textContent:'Thought'}),removeAttribute:name=>removed.push(name)};
        const incoming = {attributes:[],childNodes:[],querySelector:()=>({textContent:'Thought'}),hasAttribute:()=>false};
        morphDOM(details,incoming);
    `);
    assert.equal(app.run('removed.length'), 0);
    app.run("activeConversationKey = 'id:different'; morphDOM(details, incoming)");
    assert.equal(app.run('removed[0]'), 'open');
});

test('desktop resizing releases mobile keyboard height and pinch zoom keeps the layout stable', () => {
    const app = client();
    app.context.document.body = {style:{height:''}};
    app.context.window.innerWidth = 390;
    app.context.window.visualViewport = {height:500,scale:1};
    app.run('syncViewportHeight()');
    assert.equal(app.context.document.body.style.height, '500px');
    app.context.window.visualViewport = {height:250,scale:2};
    app.run('syncViewportHeight()');
    assert.equal(app.context.document.body.style.height, '500px');
    app.context.window.innerWidth = 1280;
    app.run('syncViewportHeight()');
    assert.equal(app.context.document.body.style.height, '');
});


test('desktop code text preserves indentation, blank lines and excludes toolbar labels', () => {
    const app = client();
    app.context.desktopPre = {
        querySelectorAll: () => ['export function run() {', '    const value = 1;', '', '    return value;', '}'].map(text => ({querySelector: () => ({textContent:text})})),
        querySelector: () => { throw new Error('must read the actual code lines'); },
        textContent: 'typescript Copy code export function run() ...'
    };
    assert.equal(app.run('snapshotCodeText(desktopPre)'), 'export function run() {\n    const value = 1;\n\n    return value;\n}');
    app.context.standardPre = {querySelectorAll:()=>[],querySelector:()=>({textContent:'    one line\n'})};
    assert.equal(app.run('snapshotCodeText(standardPre)'), '    one line\n');
});

test('Review expansion targets the selected card and ignores repeated input until completion', async () => {
    const app = client(); let finish; const requests = [];
    app.context.reviewHeader = {setAttribute(){},removeAttribute(){}};
    app.elements.get('chatContent').querySelectorAll = () => [{},app.context.reviewHeader];
    app.context.fetch = (url, options) => { requests.push(JSON.parse(options.body)); return new Promise(resolve=>{finish=resolve;}); };
    const first = app.run('toggleReviewFiles(reviewHeader)');
    await app.run('toggleReviewFiles(reviewHeader)');
    assert.equal(requests.length,1);
    assert.deepEqual(requests[0],{selector:'.files-changed-header',index:1});
    finish(new Response(JSON.stringify({success:true})));
    await first;
    assert.equal(app.run('reviewTogglePending'),false);
});

test('Review expansion failure releases the lock and reports a recoverable error', async () => {
    const app = client();
    app.context.reviewHeader = {setAttribute(){},removeAttribute(){}};
    app.elements.get('chatContent').querySelectorAll = () => [app.context.reviewHeader];
    app.context.fetch = async () => new Response(JSON.stringify({error:'disconnected'}),{status:503});
    await app.run('toggleReviewFiles(reviewHeader)');
    assert.equal(app.run('reviewTogglePending'),false);
    assert.match(app.toasts[0][0],/文件变更未能展开/);
});


test('snapshot updates keep the scrollable code element and its local toolbar in place', () => {
    const app = client();
    app.context.Node = {ELEMENT_NODE:1,TEXT_NODE:3};
    app.run(`
        const textNode = {nodeType:3,nodeValue:'old code'};
        const liveCode = {tagName:'CODE',nodeType:1,attributes:[],childNodes:[textNode],classList:{contains:()=>false}};
        const toolbar = {nodeType:1,classList:{contains:name=>name==='codex-code-bar'}};
        const livePre = {tagName:'PRE',attributes:[],childNodes:[toolbar,liveCode],
            removeChild(){throw Error('must retain local controls and code')},
            replaceChild(){throw Error('must not replace focused code')}};
        const incoming = {tagName:'PRE',attributes:[],childNodes:[{tagName:'CODE',nodeType:1,attributes:[],classList:{contains:()=>false},childNodes:[{nodeType:3,nodeValue:'new code'}]}]};
        morphDOM(livePre,incoming);
    `);
    assert.equal(app.run('livePre.childNodes[1] === liveCode'),true);
    assert.equal(app.run('livePre.childNodes[0] === toolbar'),true);
    assert.equal(app.run('textNode.nodeValue'),'new code');
});
