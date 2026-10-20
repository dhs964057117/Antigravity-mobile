import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from '../server.js';

test('HTTP and websocket endpoints remain responsive while desktop is disconnected', async t => {
    const { server, wss, hasSSL } = await createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        for (const socket of wss.clients) socket.terminate();
        await new Promise(resolve => wss.close(resolve));
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const request = (path, body, extraHeaders = {}) => new Promise((resolve, reject) => {
        const req = (hasSSL ? https : http).request({
            hostname: '127.0.0.1', port: server.address().port, path,
            rejectUnauthorized: false, method: body === undefined ? 'GET' : 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...extraHeaders }
        }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.end(body);
    });
    assert.equal((await request('/health')).body.cdpConnected, false);
    assert.equal((await request('/snapshot')).status, 503);
    const usage = (await request('/usage')).body;
    assert.equal(usage.quota.available, false);
    assert.deepEqual(usage.quota.groups, []);
    assert.equal(usage.quota.nextDailyResetUtc, undefined);
    assert.ok(Number.isFinite(Date.parse(usage.serverTime)));
    for (const message of [null, 42, {}, '', '   ']) {
        assert.equal((await request('/send', JSON.stringify({ message }))).status, 400);
    }
    assert.equal((await request('/send', '{broken json')).status, 400);
    const payload = JSON.stringify({ message: 'hello', requestId: 'same-receipt' });
    assert.equal((await request('/send', payload)).status, 503);
    assert.equal((await request('/send', payload)).status, 503);
    assert.equal((await request('/send', JSON.stringify({ message: 'changed', requestId: 'same-receipt' }))).status, 409);
    assert.equal((await request('/health', undefined, { 'x-forwarded-for': '203.0.113.10' })).status, 401);

    const ws = new WebSocket(`${hasSSL ? 'wss' : 'ws'}://127.0.0.1:${server.address().port}`, { rejectUnauthorized: false });
    await once(ws, 'open');
    const message = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'ping' }));
    assert.deepEqual(JSON.parse((await message)[0].toString()), { type: 'pong', cdpConnected: false });
    ws.close();
    await once(ws, 'close');
});
