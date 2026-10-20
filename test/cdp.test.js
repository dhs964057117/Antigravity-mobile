import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { connectCDP, getJson } from '../core/cdp.js';

async function debugServer(t, handler, options = {}) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, ...options });
    wss.on('connection', ws => {
        ws.on('message', raw => {
            const data = JSON.parse(raw);
            if (data.method === 'Runtime.enable') {
                ws.send(JSON.stringify({ method: 'Runtime.executionContextCreated', params: { context: { id: 1 } } }));
                ws.send(JSON.stringify({ id: data.id, result: {} }));
            } else handler(ws, data);
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        for (const client of wss.clients) client.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    });
    return { url: `ws://127.0.0.1:${server.address().port}`, wss };
}

test('CDP disconnect rejects every outstanding command promptly', async t => {
    const { url, wss } = await debugServer(t, () => {});
    const cdp = await connectCDP(url);
    assert.equal(cdp.contexts.length, 1);
    const results = Promise.allSettled([cdp.call('First'), cdp.call('Second')]);
    for (const client of wss.clients) client.terminate();
    const settled = await results;
    assert.ok(settled.every(item => item.status === 'rejected' && /closed/.test(item.reason.message)));
    await assert.rejects(cdp.call('AfterClose'), /disconnected/);
});

test('a stuck CDP command terminates the transport and releases other calls', async t => {
    const { url } = await debugServer(t, () => {});
    const cdp = await connectCDP(url, { callTimeoutMs: 40 });
    const settled = await Promise.allSettled([cdp.call('Hung'), cdp.call('AlsoHung')]);
    assert.ok(settled.every(item => item.status === 'rejected' && /timed out/.test(item.reason.message)));
    await assert.rejects(cdp.call('Next'), /disconnected/);
});

test('CDP protocol errors are Error objects', async t => {
    const { url } = await debugServer(t, (ws, data) => {
        ws.send(JSON.stringify({ id: data.id, error: { message: 'Context vanished' } }));
    });
    const cdp = await connectCDP(url);
    t.after(() => cdp.ws.terminate());
    await assert.rejects(cdp.call('Runtime.evaluate'), error => error instanceof Error && error.message === 'Context vanished');
});

test('an unresponsive CDP heartbeat disconnects a zombie transport', async t => {
    const { url } = await debugServer(t, () => {}, { autoPong: false });
    let reason;
    const cdp = await connectCDP(url, { heartbeatMs: 20, onDisconnect: error => { reason = error; } });
    await once(cdp.ws, 'close');
    assert.match(reason.message, /heartbeat timed out/);
    await assert.rejects(cdp.call('AfterHeartbeat'), /disconnected/);
});

test('a TCP endpoint that never upgrades cannot hang CDP initialization', async t => {
    const server = http.createServer();
    server.on('upgrade', () => {});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    await assert.rejects(connectCDP(`ws://127.0.0.1:${server.address().port}`, { connectTimeoutMs: 40 }), /timed out/);
});

test('discovery has a deadline even if headers arrive but the body stalls', async t => {
    const server = http.createServer((req, res) => { res.writeHead(200); res.write('['); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    await assert.rejects(getJson(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 40 }), /timed out|interrupted/);
});
