'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    GameCheckInAdapterError,
    HOYOLAB_GAMES,
    generateSkportSign,
    parseHoyolabCookie,
    runHoyolabCheckIn,
    runSkportCheckIn,
    validateHoyolabCredential,
    validateSkportCredential
} = require('../util/gameCheckInAdapters');

const HOYO_COOKIE = 'account_id_v2=1; ltoken_v2=v2_secret; ltuid_v2=123456789;';

function hoyolabHttp({ networkFailure = false } = {}) {
    return {
        async get(_url, config) {
            if (networkFailure) {
                const error = new Error('secret transport error');
                error.code = 'ECONNRESET';
                throw error;
            }
            const actId = config.params.act_id;
            assert.equal(config.headers.Cookie, HOYO_COOKIE);
            if (actId === HOYOLAB_GAMES[0].actId) return { data: { retcode: 0, message: 'OK', data: { is_sign: true } } };
            if (actId === HOYOLAB_GAMES[1].actId) return { data: { retcode: 0, message: 'OK', data: { is_sign: false } } };
            if (actId === HOYOLAB_GAMES[2].actId) return { data: { retcode: -5003, message: 'No role' } };
            if (actId === HOYOLAB_GAMES[3].actId) return { data: { retcode: -100, message: 'Please login' } };
            return { data: { retcode: 0, message: 'OK', data: { is_sign: false } } };
        },
        async post(_url, _data, config) {
            assert.equal(config.headers.Cookie, HOYO_COOKIE);
            if (config.params.act_id === HOYOLAB_GAMES[4].actId) {
                return { data: { retcode: 0, message: 'OK', data: { gt_result: { is_risk: true } } } };
            }
            return { data: { retcode: 0, message: 'OK', data: {} } };
        }
    };
}

test('HoYoLAB 憑證驗證要求 v2 欄位並以 info endpoint 探索遊戲', async () => {
    assert.equal(parseHoyolabCookie(HOYO_COOKIE), HOYO_COOKIE);
    for (const invalid of ['', 'ltoken_v2=x;', 'ltuid_v2=1;', 'ltoken_v2=x; ltuid_v2=1;\nInjected: yes']) {
        assert.throws(() => parseHoyolabCookie(invalid), GameCheckInAdapterError);
    }
    const validated = await validateHoyolabCredential(HOYO_COOKIE, { http: hoyolabHttp() });
    assert.deepEqual(validated.games, ['genshin', 'starRail', 'zenlessZoneZero']);
});

test('HoYoLAB 簽到區分成功、已簽到、未綁定、登入失效與 CAPTCHA', async () => {
    const result = await runHoyolabCheckIn(HOYO_COOKIE, { http: hoyolabHttp() });
    assert.equal(result.retryable, false);
    assert.deepEqual(result.outcomes.map(item => item.status), ['already', 'success', 'skipped', 'failure', 'failure']);
    assert.match(result.outcomes.at(-1).message, /CAPTCHA/);
    assert.equal(JSON.stringify(result).includes('v2_secret'), false);
});

test('HoYoLAB 網路與異常 response 只回傳安全且可重試的錯誤', async () => {
    await assert.rejects(
        () => validateHoyolabCredential(HOYO_COOKIE, { http: hoyolabHttp({ networkFailure: true }) }),
        error => error.isValidationError && !error.message.includes('secret')
    );
    const network = await runHoyolabCheckIn(HOYO_COOKIE, { http: hoyolabHttp({ networkFailure: true }) });
    assert.equal(network.retryable, true);
    assert.equal(network.outcomes.length, HOYOLAB_GAMES.length);

    const malformed = await runHoyolabCheckIn(HOYO_COOKIE, {
        http: { get: async () => ({ data: 'not-an-object' }), post: async () => ({ data: {} }) }
    });
    assert.equal(malformed.retryable, true);
    assert.match(malformed.outcomes[0].message, /無法辨識/);
});

function skportHttp({ refresh = false, grantFailure = false, noRoles = false, tokenError = false } = {}) {
    const calls = [];
    const http = {
        calls,
        async post(url, data, config = {}) {
            calls.push({ method: 'POST', url, data, config });
            if (url.includes('/grant')) {
                return grantFailure
                    ? { data: { status: 1, msg: 'bad secret token' } }
                    : { data: { status: 0, data: { code: 'oauth-code' } } };
            }
            if (url.includes('generate_cred')) {
                return { data: { code: 0, data: { cred: 'short-cred', token: refresh ? null : 'short-token' } } };
            }
            if (url.includes('attendance')) {
                assert.match(config.headers.sign, /^[a-f0-9]{32}$/);
                assert.match(config.headers['sk-game-role'], /^(1|3)_/);
                if (tokenError) return { data: { code: 10000, message: 'expired' } };
                return data ? { data: { code: 0, message: 'OK' } } : { data: { code: 1, message: 'Already checked in' } };
            }
            throw new Error(`unexpected POST ${url}`);
        },
        async get(url, config = {}) {
            calls.push({ method: 'GET', url, config });
            if (url.includes('/auth/refresh')) return { data: { code: 0, data: { token: 'refreshed-token' } } };
            if (url.includes('/binding')) {
                return { data: { code: 0, data: { list: noRoles ? [] : [
                    { appCode: 'arknights', bindingList: [{ uid: '1001', nickName: 'Doctor' }] },
                    { appCode: 'endfield', bindingList: [{ roles: [
                        { roleId: '2002', serverId: '2', nickName: 'Endmin', serverName: 'Asia' }
                    ] }] }
                ] } } };
            }
            throw new Error(`unexpected GET ${url}`);
        }
    };
    return http;
}

test('SKPORT 使用 account_token 動態授權、簽章並探索明日方舟與終末地角色', async () => {
    const http = skportHttp();
    const validated = await validateSkportCredential('long-account-token', { http });
    assert.equal(validated.roles, 2);

    const result = await runSkportCheckIn('long-account-token', { http });
    assert.equal(result.retryable, false);
    assert.deepEqual(result.outcomes.map(item => item.game), ['明日方舟', '明日方舟：終末地']);
    assert.deepEqual(result.outcomes.map(item => item.status), ['success', 'already']);
    assert.equal(JSON.stringify(http.calls).includes('long-account-token'), true);
    assert.equal(JSON.stringify(result).includes('long-account-token'), false);
});

test('SKPORT 缺少交換 token 時呼叫 refresh，Token error 交由每日狀態機重試', async () => {
    const http = skportHttp({ refresh: true, tokenError: true });
    const result = await runSkportCheckIn('long-account-token', { http });
    assert.equal(http.calls.some(call => call.url.includes('/auth/refresh')), true);
    assert.equal(result.retryable, true);
    assert.equal(result.outcomes.every(item => item.status === 'failure'), true);
});

test('SKPORT 無效長效 Token、無角色與格式錯誤是安全驗證失敗', async () => {
    for (const value of ['', 'has whitespace']) {
        await assert.rejects(() => validateSkportCredential(value, { http: skportHttp() }), /格式不正確/);
    }
    await assert.rejects(
        () => validateSkportCredential('invalid-token', { http: skportHttp({ grantFailure: true }) }),
        error => error.isValidationError && !error.message.includes('secret')
    );
    await assert.rejects(
        () => validateSkportCredential('valid-token', { http: skportHttp({ noRoles: true }) }),
        error => error.isValidationError && /沒有可支援/.test(error.message)
    );
});

test('SKPORT 簽章固定為 32 位十六進位且 AbortSignal 取消不被轉成平台錯誤', async () => {
    const headers = { platform: '3', timestamp: '123', vName: '1.0.0' };
    const first = generateSkportSign('/path', 'POST', headers, '', '{}', 'token');
    const second = generateSkportSign('/path', 'GET', headers, '?a=1', '', 'token');
    assert.match(first, /^[a-f0-9]{32}$/);
    assert.notEqual(first, second);

    const controller = new AbortController();
    controller.abort(new Error('cancelled safely'));
    await assert.rejects(
        () => validateSkportCredential('valid-token', {
            signal: controller.signal,
            http: { post: async () => { throw new Error('transport'); }, get: async () => ({ data: {} }) }
        }),
        /cancelled safely/
    );
});
