import { createHash } from 'node:crypto';

// A retry with the same ID shares the original result, including uncertain results.
// All phones share one desktop editor, so only one injection may run at a time.
export function createSendCoordinator({ ttlMs = 30 * 60 * 1000, maxEntries = 500, now = Date.now } = {}) {
    const receipts = new Map();
    let busy = false;
    return {
        get busy() { return busy; },
        async runAction(operation) {
            if (busy) return false;
            busy = true;
            try { await operation(); return true; }
            finally { busy = false; }
        },
        async run(requestId, payload, operation) {
            for (const [id, entry] of receipts) {
                if (entry.completedAt !== null && now() - entry.completedAt >= ttlMs) receipts.delete(id);
            }
            const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
            const previous = requestId && receipts.get(requestId);
            if (previous) {
                if (previous.fingerprint !== fingerprint) {
                    return { status: 409, body: { success: false, error: 'request_id_conflict', message: '请求编号与原消息不一致' } };
                }
                return previous.promise;
            }
            if (busy) return { status: 409, body: { success: false, error: 'send_busy', message: '上一条消息正在提交，请稍后重试' } };
            if (requestId && receipts.size >= maxEntries) {
                return { status: 503, body: { success: false, error: 'send_capacity', message: '发送记录已满，请稍后重试' } };
            }
            busy = true;
            const entry = { fingerprint, completedAt: null, promise: null };
            entry.promise = Promise.resolve().then(operation).catch(error => {
                console.error('[SEND] Injection interrupted:', error.message);
                return { status: 503, body: { success: false, ok: false, uncertain: true, error: 'send_uncertain', message: '提交结果未确认，请先检查桌面会话，避免重复发送' } };
            }).finally(() => {
                busy = false;
                entry.completedAt = now();
            });
            if (requestId) receipts.set(requestId, entry);
            return entry.promise;
        }
    };
}
