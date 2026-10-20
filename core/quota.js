// Use the desktop application's existing authenticated, read-only quota service.
// Credentials never leave the desktop; only the allowlisted quota fields return.
async function captureDesktopQuota(forceRefresh) {
    if (typeof document === 'undefined') return { error: 'quota_service_unavailable' };
    const anchors = ['[data-testid="settings-button"]', '[data-testid="model-selector-trigger"]', '[data-lexical-editor="true"]'];
    let service;
    for (const selector of anchors) {
        const element = document.querySelector(selector);
        const fiberKey = Object.keys(element || {}).find(key => key.startsWith('__reactFiber'));
        let node = element?.[fiberKey];
        for (let depth = 0; node && depth < 200 && !service; depth++, node = node.return) {
            const values = [node.memoizedProps?.value];
            for (let context = node.dependencies?.firstContext; context; context = context.next) values.push(context.memoizedValue);
            service = values.find(value => typeof value?.core?.cloudCodeService?.retrieveUserQuotaSummary === 'function')?.core.cloudCodeService;
        }
        if (service) break;
    }
    if (!service) return { error: 'quota_service_unavailable' };
    let timer;
    try {
        const result = await Promise.race([
            service.retrieveUserQuotaSummary(undefined, forceRefresh),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('quota_timeout')), 7000); })
        ]);
        if (!result?.response || !Array.isArray(result.response.groups)) return { error: 'quota_response_invalid' };
        const response = result.response;
        return JSON.parse(JSON.stringify({
            description: response.description,
            groups: response.groups.slice(0, 30).map(group => ({
                groupId: group.groupId,
                displayName: group.displayName,
                description: group.description,
                buckets: (group.buckets || []).slice(0, 20).map(bucket => ({
                    bucketId: bucket.bucketId, displayName: bucket.displayName,
                    description: bucket.description, disabled: bucket.disabled,
                    remaining: bucket.remaining?.case === 'remainingFraction' ? { case: 'remainingFraction', value: bucket.remaining.value } : null,
                    resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : bucket.resetTime ? { seconds: bucket.resetTime.seconds, nanos: bucket.resetTime.nanos } : null
                }))
            }))
        }, (key, value) => typeof value === 'bigint' ? String(value) : value));
    } catch {
        return { error: 'quota_fetch_failed' };
    } finally {
        clearTimeout(timer);
    }
}

const cleanText = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';

export function quotaResetTimestamp(value) {
    let milliseconds;
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) milliseconds = Date.parse(value);
    else if (value && typeof value === 'object' && /^-?\d+$/.test(String(value.seconds))) {
        const nanos = value.nanos ?? 0;
        if (!Number.isInteger(nanos) || nanos < 0 || nanos >= 1e9) return null;
        milliseconds = Number(value.seconds) * 1000 + Math.floor(nanos / 1e6);
    }
    if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8640000000000000) return null;
    return new Date(milliseconds).toISOString();
}

export function normalizeQuotaSummary(summary, capturedAt = new Date().toISOString()) {
    if (!summary || summary.error || !Array.isArray(summary.groups)) {
        return { available: false, source: 'desktop', capturedAt: null, groups: [],
            message: '暂未读取到账户配额，请确认桌面已登录并刷新用量。' };
    }
    return {
        available: true, source: 'desktop', capturedAt,
        description: cleanText(summary.description),
        groups: summary.groups.filter(group => group && typeof group === 'object').slice(0, 30).map((group, index) => ({
            id: cleanText(group.groupId, 200) || `group-${index}`,
            name: cleanText(group.displayName, 200) || `模型组 ${index + 1}`,
            description: cleanText(group.description),
            buckets: (Array.isArray(group.buckets) ? group.buckets : []).filter(bucket => bucket && typeof bucket === 'object').slice(0, 20).map(bucket => {
                const id = cleanText(bucket.bucketId, 200);
                const label = cleanText(bucket.displayName, 200);
                const text = `${id} ${label}`;
                const window = /weekly|week|每周|周限/i.test(text) ? 'weekly' :
                    /daily|\bday\b|每日|日限/i.test(text) ? 'daily' :
                    /\b5h\b|five[ _-]*hour|5\s*(hours?|小时)/i.test(text) ? 'five_hour' : 'other';
                const fraction = bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : null;
                const known = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
                const remainingPercent = known ? Math.round(fraction * 10000) / 100 : null;
                return {
                    id, label, window, description: cleanText(bucket.description),
                    disabled: bucket.disabled === true,
                    limitPercent: known ? 100 : null,
                    usedPercent: known ? Math.round((1 - fraction) * 10000) / 100 : null,
                    remainingPercent, resetAt: quotaResetTimestamp(bucket.resetTime)
                };
            })
        }))
    };
}

export function createQuotaReader({ ttlMs = 30000, now = Date.now } = {}) {
    const cache = new WeakMap();
    return async (cdp, { forceRefresh = false } = {}) => {
        if (!cdp || cdp.ws?.readyState !== 1) return normalizeQuotaSummary(null);
        const contextKey = cdp.contexts.map(context => context.id).join(',');
        let entry = cache.get(cdp);
        if (entry?.pending) return entry.pending;
        if (!forceRefresh && entry?.contextKey === contextKey && now() - entry.updatedAt < ttlMs) return entry.data;
        entry = { contextKey, pending: null, data: null, updatedAt: 0 };
        cache.set(cdp, entry);
        entry.pending = (async () => {
            const contexts = [...cdp.contexts].sort((a, b) => Number(!!b.auxData?.isDefault) - Number(!!a.auxData?.isDefault));
            let summary;
            for (const context of contexts) {
                try {
                    const result = await cdp.call('Runtime.evaluate', {
                        expression: `(${captureDesktopQuota.toString()})(${JSON.stringify(forceRefresh)})`,
                        contextId: context.id, returnByValue: true, awaitPromise: true
                    });
                    const value = result.exceptionDetails ? null : result.result?.value;
                    if (value && value.error !== 'quota_service_unavailable') { summary = value; break; }
                } catch { break; }
            }
            entry.data = normalizeQuotaSummary(summary, new Date(now()).toISOString());
            entry.updatedAt = now();
            return entry.data;
        })().finally(() => { entry.pending = null; });
        return entry.pending;
    };
}
