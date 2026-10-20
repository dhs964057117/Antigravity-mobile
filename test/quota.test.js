import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createQuotaReader, normalizeQuotaSummary, quotaResetTimestamp } from '../core/quota.js';

const summary = () => ({
    description: 'Group members share weekly and five-hour quotas.',
    groups: [{ displayName: 'Gemini Models', description: 'Gemini Flash, Gemini Pro', buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', remaining: { case: 'remainingFraction', value: 0.20447652 }, resetTime: { seconds: '1792842183', nanos: 0 } },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', remaining: { case: 'remainingFraction', value: 0 }, resetTime: '2026-10-19T16:36:15Z' }
    ] }]
});

test('real quota percentages and reset times are normalized without inventing a daily allowance', () => {
    const quota = normalizeQuotaSummary(summary());
    assert.equal(quota.available, true);
    const [weekly, rolling] = quota.groups[0].buckets;
    assert.equal(weekly.window, 'weekly');
    assert.equal(weekly.usedPercent, 79.55);
    assert.equal(weekly.remainingPercent, 20.45);
    assert.equal(weekly.resetAt, '2026-10-24T11:43:03.000Z');
    assert.equal(rolling.window, 'five_hour');
    assert.equal(rolling.remainingPercent, 0);
    assert.equal(rolling.usedPercent, 100);
    assert.equal(quota.groups[0].buckets.some(bucket => bucket.window === 'daily'), false);
});

test('missing or invalid quota values remain unknown; disabled windows remain disabled', () => {
    const data = summary();
    data.groups[0].buckets = [null, ...[undefined, NaN, '0.5', -1, 1.2].map(value => ({
        bucketId: 'daily', remaining: { case: 'remainingFraction', value }, disabled: true
    }))];
    const buckets = normalizeQuotaSummary(data).groups[0].buckets;
    assert.equal(buckets.length, 5);
    assert.ok(buckets.every(bucket => bucket.usedPercent === null && bucket.remainingPercent === null && bucket.disabled));
    assert.equal(normalizeQuotaSummary(null).available, false);
    assert.deepEqual(normalizeQuotaSummary(null).groups, []);
    assert.equal(quotaResetTimestamp({ seconds: 'bad' }), null);
    assert.equal(quotaResetTimestamp({ seconds: '1', nanos: 1e9 }), null);
    assert.equal(quotaResetTimestamp({ seconds: '1', nanos: 123000000 }), '1970-01-01T00:00:01.123Z');
});

function desktop(service) {
    const element = { __reactFiber_test: { dependencies: { firstContext: {
        memoizedValue: { core: { cloudCodeService: service } }
    } } } };
    const context = vm.createContext({ document: { querySelector: () => element }, setTimeout, clearTimeout });
    return { contexts: [{ id: 1, auxData: { isDefault: true } }], ws: { readyState: 1 }, async call(method, params) {
        return { result: { value: await vm.runInContext(params.expression, context) } };
    } };
}

test('desktop service is reused without reading credentials and returns only quota fields', async () => {
    let calls = 0;
    const cdp = desktop({ async retrieveUserQuotaSummary(token, refresh) {
        calls++;
        assert.equal(token, undefined);
        assert.equal(refresh, true);
        return { response: { ...summary(), secret: 'must-never-leave', accessToken: 'must-never-leave' } };
    } });
    const quota = await createQuotaReader()(cdp, { forceRefresh: true });
    assert.equal(quota.available, true);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(quota).includes('must-never-leave'));
});

test('quota requests share in-flight work, cache results, and support forced refresh', async () => {
    let calls = 0;
    let clock = 1000;
    const cdp = desktop({ async retrieveUserQuotaSummary() { calls++; return { response: summary() }; } });
    const read = createQuotaReader({ now: () => clock, ttlMs: 100 });
    await Promise.all([read(cdp), read(cdp), read(cdp)]);
    assert.equal(calls, 1);
    await read(cdp);
    assert.equal(calls, 1);
    await read(cdp, { forceRefresh: true });
    assert.equal(calls, 2);
    clock += 101;
    await read(cdp);
    assert.equal(calls, 3);
    cdp.contexts[0].id = 2;
    await read(cdp);
    assert.equal(calls, 4);
});

test('unsupported desktop versions and disconnected sockets report unavailability', async () => {
    const read = createQuotaReader();
    assert.equal((await read(desktop({}))).available, false);
    const cdp = desktop({ retrieveUserQuotaSummary() { throw new Error('not signed in'); } });
    assert.equal((await read(cdp)).available, false);
    cdp.ws.readyState = 3;
    assert.equal((await read(cdp)).available, false);
});
