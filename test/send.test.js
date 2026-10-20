import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSendCoordinator } from '../core/send-coordinator.js';
import { injectMessage } from '../server.js';

test('concurrent and later retries share one submission receipt', async () => {
    const sends = createSendCoordinator();
    let release;
    let calls = 0;
    const operation = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const first = sends.run('same-id', { message: 'hello' }, operation);
    const retry = sends.run('same-id', { message: 'hello' }, operation);
    const conflicting = await sends.run('same-id', { message: 'changed' }, operation);
    const other = await sends.run('other-id', {}, operation);
    assert.equal(conflicting.status, 409);
    assert.equal(other.status, 409);
    assert.equal(calls, 1);
    release({ status: 200, body: { ok: true } });
    assert.deepEqual(await first, await retry);
    await sends.run('same-id', { message: 'hello' }, operation);
    assert.equal(calls, 1);
    assert.equal(sends.busy, false);
});

test('UI navigation and sending cannot use the editor concurrently', async () => {
    const sends = createSendCoordinator();
    let release;
    const action = sends.runAction(() => new Promise(resolve => { release = resolve; }));
    const blocked = await sends.run('id', {}, () => assert.fail('must not inject while navigating'));
    assert.equal(blocked.status, 409);
    release();
    await action;
    assert.equal(sends.busy, false);
});

test('an uncertain submission is cached and the lock is released', async () => {
    const sends = createSendCoordinator();
    let calls = 0;
    const operation = () => { calls++; throw new Error('connection lost'); };
    const result = await sends.run('id', {}, operation);
    assert.equal(result.body.uncertain, true);
    assert.equal(sends.busy, false);
    await sends.run('id', {}, operation);
    assert.equal(calls, 1);
});

test('receipt cache is bounded and expires completed results', async () => {
    let clock = 0;
    const sends = createSendCoordinator({ now: () => clock, ttlMs: 100, maxEntries: 1 });
    await sends.run('id', {}, () => ({ status: 200 }));
    assert.equal((await sends.run('next', {}, () => ({}))).status, 503);
    clock = 101;
    assert.equal((await sends.run('next', {}, () => ({ status: 200 }))).status, 200);
});

// Evaluate the real injected scripts against a small desktop DOM model.
function desktop({ initialText = '', loseEditorOnSubmit = false, disconnectOnSubmit = false,
    partialInsert = false, delayedClear = 0, buttonMissing = false, buttonDisabled = false,
    ariaDisabled = false, neverClear = false } = {}) {
    let clicks = 0;
    let enters = 0;
    let inserts = 0;
    const keyEvents = [];
    let lost = false;
    const target = {
        innerText: initialText, isConnected: true, offsetParent: {}, parentElement: null,
        getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 1, top: 1, width: 20, height: 20 }),
        setAttribute() {}, removeAttribute() {}, getAttribute: () => 'true',
        focus() { document.activeElement = target; }, contains: item => item === target,
        closest: () => container
    };
    const submit = () => {
        if (loseEditorOnSubmit) lost = true;
        else if (!neverClear) {
            if (delayedClear) setTimeout(() => { target.innerText = ''; }, delayedClear);
            else target.innerText = '';
        }
    };
    const button = {
        disabled: buttonDisabled,
        getAttribute: name => name === 'aria-disabled' && ariaDisabled ? 'true' : null,
        click() { clicks++; submit(); }
    };
    const container = { querySelector: () => buttonMissing ? null : button };
    target.parentElement = container;
    const document = {
        activeElement: target,
        getElementById: id => id.includes('InputBox') ? { querySelector: () => null } : null,
        querySelectorAll: () => [target],
        querySelector: selector => selector.includes('data-ag-active-target') ? (lost ? null : target) : null,
        createRange: () => ({ selectNodeContents() {} })
    };
    const context = vm.createContext({ document, window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } });
    const cdp = {
        contexts: [{ id: 1 }],
        async call(method, params) {
            if (disconnectOnSubmit && clicks + enters > 0) throw new Error('CDP disconnected');
            if (method === 'Runtime.evaluate') {
                return { result: { value: await vm.runInContext(params.expression, context) } };
            }
            if (method === 'Input.insertText') {
                inserts++;
                target.innerText = partialInsert ? params.text.slice(0, 21) : params.text;
            }
            if (method === 'Input.dispatchKeyEvent') {
                keyEvents.push(params.type);
                if (params.type === 'rawKeyDown') { enters++; submit(); }
            }
            return {};
        }
    };
    return { cdp, target, keyEvents, clicks: () => clicks, enters: () => enters, inserts: () => inserts };
}

test('successful and slow submissions click exactly once', async () => {
    const fixture = desktop({ delayedClear: 450 });
    const result = await injectMessage(fixture.cdp, '测试消息\nsecond line');
    assert.equal(result.ok, true);
    assert.equal(fixture.clicks(), 1);
    assert.equal(fixture.enters(), 0);
});

test('missing editor and disconnected readback cannot report success', async () => {
    for (const options of [{ loseEditorOnSubmit: true }, { disconnectOnSubmit: true }]) {
        const fixture = desktop(options);
        const result = await injectMessage(fixture.cdp, 'hello');
        assert.equal(result.ok, false);
        assert.equal(result.uncertain, true);
        assert.equal(fixture.clicks(), 1);
        assert.equal(fixture.enters(), 0);
    }
});

test('partial text is never submitted and a desktop draft is preserved', async () => {
    const partial = desktop({ partialInsert: true });
    const result = await injectMessage(partial.cdp, 'this message has more than twenty-one characters');
    assert.equal(result.ok, false);
    assert.equal(partial.clicks(), 0);
    const existing = desktop({ initialText: 'a desktop draft' });
    assert.equal((await injectMessage(existing.cdp, 'hello')).error, 'desktop_draft_exists');
    assert.equal(existing.target.innerText, 'a desktop draft');
});

test('Enter fallback submits once without an extra char event', async () => {
    const fixture = desktop({ buttonMissing: true });
    const result = await injectMessage(fixture.cdp, 'hello');
    assert.equal(result.ok, true);
    assert.equal(fixture.enters(), 1);
    assert.deepEqual(fixture.keyEvents, ['rawKeyDown', 'keyUp']);
});

test('disabled send buttons use Enter once instead of blocking submission', async () => {
    for (const options of [{ buttonDisabled: true }, { ariaDisabled: true }]) {
        const fixture = desktop(options);
        const result = await injectMessage(fixture.cdp, '测试消息\nsecond line');
        assert.equal(result.ok, true);
        assert.equal(result.method, 'cdp_enter');
        assert.equal(result.isSteer, false);
        assert.equal(fixture.clicks(), 0);
        assert.equal(fixture.enters(), 1);
        assert.deepEqual(fixture.keyEvents, ['rawKeyDown', 'keyUp']);
    }
});

test('disabled-button retry submits an existing matching draft without rewriting it', async () => {
    const fixture = desktop({ buttonDisabled: true, initialText: 'hello' });
    const result = await injectMessage(fixture.cdp, 'hello');
    assert.equal(result.ok, true);
    assert.equal(fixture.inserts(), 0);
    assert.equal(fixture.clicks(), 0);
    assert.equal(fixture.enters(), 1);
});

test('failed or uncertain Enter submissions preserve safety without another attempt', async () => {
    for (const options of [{ neverClear: true }, { loseEditorOnSubmit: true }, { disconnectOnSubmit: true }]) {
        const fixture = desktop({ ...options, buttonDisabled: true });
        const result = await injectMessage(fixture.cdp, 'hello');
        assert.equal(result.ok, false);
        assert.equal(result.uncertain, true);
        assert.equal(fixture.clicks(), 0);
        assert.equal(fixture.enters(), 1);
        if (options.neverClear) assert.equal(fixture.target.innerText, 'hello');
    }
});

test('unconfirmed submission retains the desktop draft and avoids fallback duplicates', async () => {
    const fixture = desktop({ neverClear: true });
    const result = await injectMessage(fixture.cdp, 'hello');
    assert.equal(result.uncertain, true);
    assert.equal(fixture.target.innerText, 'hello');
    assert.equal(fixture.clicks(), 1);
    assert.equal(fixture.enters(), 0);
});
