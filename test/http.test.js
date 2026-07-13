const assert = require('node:assert/strict');
const test = require('node:test');
const { createHttpClient, parseRetryAfter } = require('../core/http');

function httpError(status, headers = {}) {
    return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });
}

test('HTTP client 對每次嘗試強制 15 秒 timeout，GET 最多重試兩次', async () => {
    const requests = [];
    const delays = [];
    const client = createHttpClient({
        transport: async config => {
            requests.push(config);
            if (requests.length < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            return { data: 'ok' };
        },
        sleepFn: async delay => delays.push(delay)
    });

    assert.equal((await client.get('https://example.test')).data, 'ok');
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(item => item.timeout), [15000, 15000, 15000]);
    assert.deepEqual(delays, [500, 1000]);
});

test('HTTP client 僅重試 408、429、5xx，且遵守 Retry-After', async () => {
    const delays = [];
    let attempts = 0;
    const client = createHttpClient({
        transport: async () => {
            attempts += 1;
            if (attempts === 1) throw httpError(429, { 'retry-after': '2' });
            return { data: 'ok' };
        },
        sleepFn: async delay => delays.push(delay)
    });
    await client.get('https://example.test');
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2000]);

    let badRequestAttempts = 0;
    const noRetry = createHttpClient({ transport: async () => {
        badRequestAttempts += 1;
        throw httpError(400);
    } });
    await assert.rejects(noRetry.get('https://example.test'), /HTTP 400/);
    assert.equal(badRequestAttempts, 1);
});

test('過長 Retry-After 與非 GET 請求都不重試', async () => {
    let getAttempts = 0;
    const longRetry = createHttpClient({ transport: async () => {
        getAttempts += 1;
        throw httpError(503, { 'retry-after': '61' });
    } });
    await assert.rejects(longRetry.get('https://example.test'), /HTTP 503/);
    assert.equal(getAttempts, 1);

    for (const method of ['post', 'patch']) {
        let attempts = 0;
        const client = createHttpClient({ transport: async () => {
            attempts += 1;
            throw httpError(503);
        } });
        await assert.rejects(client[method]('https://example.test', {}), /HTTP 503/);
        assert.equal(attempts, 1);
    }
});

test('沒有網路錯誤代碼的程式錯誤不重試', async () => {
    let attempts = 0;
    const client = createHttpClient({ transport: async () => {
        attempts += 1;
        throw new TypeError('invalid URL');
    } });
    await assert.rejects(client.get('bad-url'), /invalid URL/);
    assert.equal(attempts, 1);
});

test('Retry-After 支援秒數與 HTTP 日期', () => {
    assert.equal(parseRetryAfter('1.5', 0), 1500);
    assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
    assert.equal(parseRetryAfter('invalid', 0), null);
});
