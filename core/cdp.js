import http from 'node:http';
import WebSocket from 'ws';

// Bound discovery even when a debug port accepts TCP but never responds.
export function getJson(url, { timeoutMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
        let timer;
        const finish = (error, value) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const req = http.get(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                finish(new Error(`Discovery returned HTTP ${res.statusCode}`));
                return;
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('error', error => finish(error));
            res.on('aborted', () => finish(new Error('Discovery response interrupted')));
            res.on('end', () => {
                try { finish(null, JSON.parse(data)); }
                catch (error) { finish(error); }
            });
        });
        req.on('error', error => finish(error));
        timer = setTimeout(() => req.destroy(new Error('CDP discovery timed out')), timeoutMs);
    });
}

export async function connectCDP(url, {
    connectTimeoutMs = 5000,
    callTimeoutMs = 10000,
    heartbeatMs = 15000,
    onDisconnect = () => {},
    onContextsCleared = () => {}
} = {}) {
    const ws = new WebSocket(url, { handshakeTimeout: connectTimeoutMs });
    const pending = new Map();
    const contexts = [];
    let nextId = 1;
    let stopped = false;
    let heartbeat;
    let awaitingPong = false;

    const fail = error => {
        if (stopped) return;
        stopped = true;
        clearInterval(heartbeat);
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        pending.clear();
        contexts.length = 0;
        onDisconnect(error);
    };

    ws.on('error', error => {
        fail(error);
        ws.terminate();
    });
    ws.on('close', () => fail(new Error('CDP connection closed')));
    ws.on('pong', () => { awaitingPong = false; });
    ws.on('message', raw => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }
        const entry = pending.get(data.id);
        if (entry) {
            clearTimeout(entry.timer);
            pending.delete(data.id);
            if (data.error) entry.reject(new Error(data.error.message || 'CDP command failed'));
            else entry.resolve(data.result);
        }
        if (data.method === 'Runtime.executionContextCreated') {
            const context = data.params.context;
            if (!contexts.some(item => item.id === context.id)) contexts.push(context);
        } else if (data.method === 'Runtime.executionContextDestroyed') {
            const index = contexts.findIndex(item => item.id === data.params.executionContextId);
            if (index !== -1) contexts.splice(index, 1);
        } else if (data.method === 'Runtime.executionContextsCleared') {
            contexts.length = 0;
            onContextsCleared();
        }
    });

    await new Promise((resolve, reject) => {
        const cleanup = () => {
            ws.off('open', opened);
            ws.off('error', failed);
            ws.off('close', closed);
        };
        const opened = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        const closed = () => failed(new Error('CDP closed during handshake'));
        ws.once('open', opened);
        ws.once('error', failed);
        ws.once('close', closed);
    });

    const call = (method, params = {}) => new Promise((resolve, reject) => {
        if (stopped || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('CDP disconnected'));
            return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
            fail(new Error(`CDP call ${method} timed out after ${callTimeoutMs}ms`));
            ws.terminate();
        }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
            ws.send(JSON.stringify({ id, method, params }), error => {
                if (error) {
                    fail(error);
                    ws.terminate();
                }
            });
        } catch (error) {
            fail(error);
            ws.terminate();
        }
    });

    try {
        await call('Runtime.enable');
        if (stopped || ws.readyState !== WebSocket.OPEN) throw new Error('CDP disconnected during initialization');
        heartbeat = setInterval(() => {
            if (awaitingPong) {
                fail(new Error('CDP heartbeat timed out'));
                ws.terminate();
                return;
            }
            awaitingPong = true;
            ws.ping(error => {
                if (error) { fail(error); ws.terminate(); }
            });
        }, heartbeatMs);
        heartbeat.unref();
        return { ws, call, contexts };
    } catch (error) {
        fail(error);
        ws.terminate();
        throw error;
    }
}
