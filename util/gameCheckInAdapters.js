'use strict';

const crypto = require('node:crypto');

const HOYOLAB_GAMES = Object.freeze([
    {
        id: 'genshin', name: '原神',
        infoUrl: 'https://sg-hk4e-api.hoyolab.com/event/sol/info',
        signUrl: 'https://sg-hk4e-api.hoyolab.com/event/sol/sign',
        actId: 'e202102251931481'
    },
    {
        id: 'starRail', name: '崩壞：星穹鐵道',
        infoUrl: 'https://sg-public-api.hoyolab.com/event/luna/os/info',
        signUrl: 'https://sg-public-api.hoyolab.com/event/luna/os/sign',
        actId: 'e202303301540311'
    },
    {
        id: 'honkai3', name: '崩壞 3',
        infoUrl: 'https://sg-public-api.hoyolab.com/event/mani/info',
        signUrl: 'https://sg-public-api.hoyolab.com/event/mani/sign',
        actId: 'e202110291205111'
    },
    {
        id: 'tearsOfThemis', name: '未定事件簿',
        infoUrl: 'https://sg-public-api.hoyolab.com/event/luna/os/info',
        signUrl: 'https://sg-public-api.hoyolab.com/event/luna/os/sign',
        actId: 'e202308141137581'
    },
    {
        id: 'zenlessZoneZero', name: '絕區零',
        infoUrl: 'https://sg-public-api.hoyolab.com/event/luna/zzz/os/info',
        signUrl: 'https://sg-public-api.hoyolab.com/event/luna/zzz/os/sign',
        actId: 'e202406031448091',
        headers: { 'x-rpc-signgame': 'zzz' }
    }
]);

const HOYOLAB_HEADERS = Object.freeze({
    Accept: 'application/json, text/plain, */*',
    'x-rpc-app_version': '2.34.1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114 Safari/537.36',
    'x-rpc-client_type': '4',
    Referer: 'https://act.hoyolab.com/',
    Origin: 'https://act.hoyolab.com'
});

const SKPORT_HEADERS = Object.freeze({
    Accept: '*/*',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
    Referer: 'https://game.skport.com/',
    Origin: 'https://game.skport.com',
    platform: '3',
    vName: '1.0.0'
});

class GameCheckInAdapterError extends Error {
    constructor(code, message, { retryable = false, validation = false } = {}) {
        super(message);
        this.name = 'GameCheckInAdapterError';
        this.code = code;
        this.retryable = retryable;
        this.isValidationError = validation;
    }
}

function isAbortError(error, signal) {
    return signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED';
}

function normalizeRequestError(error, signal, label) {
    if (isAbortError(error, signal)) throw signal?.reason instanceof Error ? signal.reason : error;
    const status = Number(error?.response?.status);
    const retryable = !status || status === 408 || status === 429 || status >= 500;
    return new GameCheckInAdapterError(
        retryable ? 'PLATFORM_TEMPORARY' : 'PLATFORM_REJECTED',
        retryable ? `${label}暫時無法連線，將稍後重試。` : `${label}拒絕了請求。`,
        { retryable }
    );
}

async function requestData(request, signal, label) {
    let response;
    try {
        response = await request();
    } catch (error) {
        throw normalizeRequestError(error, signal, label);
    }
    if (!response?.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw new GameCheckInAdapterError('PLATFORM_INVALID_RESPONSE', `${label}回傳了無法辨識的資料。`, { retryable: true });
    }
    return response.data;
}

function parseHoyolabCookie(value) {
    const cookie = String(value || '').trim();
    if (!cookie || cookie.length > 4000 || /[\r\n\0]/.test(cookie)) {
        throw new GameCheckInAdapterError('HOYOLAB_COOKIE_INVALID', 'HoYoLAB Cookie 格式不正確。', { validation: true });
    }
    const pairs = new Map(cookie.split(';').map(part => {
        const index = part.indexOf('=');
        return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : ['', ''];
    }).filter(([key, item]) => key && item));
    if (!pairs.get('ltoken_v2') || !pairs.get('ltuid_v2')) {
        throw new GameCheckInAdapterError(
            'HOYOLAB_COOKIE_MISSING_FIELDS',
            'HoYoLAB Cookie 必須包含 ltoken_v2 與 ltuid_v2。',
            { validation: true }
        );
    }
    return cookie;
}

function hoyolabHeaders(cookie, game) {
    return { ...HOYOLAB_HEADERS, ...game.headers, Cookie: cookie };
}

function isHoyolabAuthError(data) {
    const message = String(data?.message || '');
    return [-100, -101, -10001].includes(Number(data?.retcode)) || /login|登入|cookie|token/i.test(message);
}

function isAlreadySigned(data) {
    return data?.data?.is_sign === true || /already|已.{0,4}簽到/i.test(String(data?.message || ''));
}

async function getHoyolabInfo(game, cookie, http, signal) {
    return requestData(
        () => http.get(game.infoUrl, {
            params: { lang: 'zh-tw', act_id: game.actId },
            headers: hoyolabHeaders(cookie, game),
            signal
        }),
        signal,
        `HoYoLAB ${game.name}`
    );
}

async function validateHoyolabCredential(value, { http, signal } = {}) {
    if (!http?.get) throw new TypeError('HoYoLAB adapter 缺少 HTTP client');
    const cookie = parseHoyolabCookie(value);
    const games = [];
    let temporaryError = null;
    let authFailures = 0;
    for (const game of HOYOLAB_GAMES) {
        try {
            const data = await getHoyolabInfo(game, cookie, http, signal);
            if (Number(data.retcode) === 0) games.push(game.id);
            else if (isHoyolabAuthError(data)) authFailures += 1;
        } catch (error) {
            if (!(error instanceof GameCheckInAdapterError)) throw error;
            if (error.retryable) temporaryError = error;
        }
    }
    if (games.length) return { games };
    if (temporaryError) throw new GameCheckInAdapterError(temporaryError.code, temporaryError.message, { validation: true });
    throw new GameCheckInAdapterError(
        authFailures ? 'HOYOLAB_AUTH_FAILED' : 'HOYOLAB_NO_GAMES',
        authFailures ? 'HoYoLAB Cookie 已失效，請重新取得。' : '此 HoYoLAB 帳號沒有可支援的已綁定遊戲。',
        { validation: true }
    );
}

function outcome(platform, game, status, message, account = null) {
    return { platform, game, account, status, message };
}

async function runHoyolabCheckIn(value, { http, signal } = {}) {
    let cookie;
    try {
        cookie = parseHoyolabCookie(value);
    } catch (error) {
        return { platform: 'hoyolab', retryable: false, outcomes: [outcome('hoyolab', 'HoYoLAB', 'failure', error.message)] };
    }

    const outcomes = [];
    let retryable = false;
    let boundGames = 0;
    for (const game of HOYOLAB_GAMES) {
        let info;
        try {
            info = await getHoyolabInfo(game, cookie, http, signal);
        } catch (error) {
            if (!(error instanceof GameCheckInAdapterError)) throw error;
            retryable ||= error.retryable;
            outcomes.push(outcome('hoyolab', game.name, 'failure', error.message));
            continue;
        }

        if (Number(info.retcode) !== 0) {
            if (isHoyolabAuthError(info)) outcomes.push(outcome('hoyolab', game.name, 'failure', 'HoYoLAB Cookie 已失效。'));
            else outcomes.push(outcome('hoyolab', game.name, 'skipped', '帳號未綁定此遊戲。'));
            continue;
        }
        boundGames += 1;
        if (isAlreadySigned(info)) {
            outcomes.push(outcome('hoyolab', game.name, 'already', '今日已完成簽到。'));
            continue;
        }

        let signed;
        try {
            signed = await requestData(
                () => http.post(game.signUrl, null, {
                    params: { lang: 'zh-tw', act_id: game.actId },
                    headers: hoyolabHeaders(cookie, game),
                    signal
                }),
                signal,
                `HoYoLAB ${game.name}`
            );
        } catch (error) {
            if (!(error instanceof GameCheckInAdapterError)) throw error;
            retryable ||= error.retryable;
            outcomes.push(outcome('hoyolab', game.name, 'failure', error.message));
            continue;
        }

        if (signed.data?.gt_result?.is_risk) {
            outcomes.push(outcome('hoyolab', game.name, 'failure', '簽到受到 CAPTCHA 風險驗證阻擋。'));
        } else if (Number(signed.retcode) === 0 || String(signed.message).toUpperCase() === 'OK') {
            outcomes.push(outcome('hoyolab', game.name, 'success', '簽到成功。'));
        } else if (isAlreadySigned(signed)) {
            outcomes.push(outcome('hoyolab', game.name, 'already', '今日已完成簽到。'));
        } else if (isHoyolabAuthError(signed)) {
            outcomes.push(outcome('hoyolab', game.name, 'failure', 'HoYoLAB Cookie 已失效。'));
        } else {
            outcomes.push(outcome('hoyolab', game.name, 'failure', 'HoYoLAB 拒絕了簽到請求。'));
        }
    }
    if (!boundGames && !outcomes.some(item => item.status === 'failure')) {
        outcomes.push(outcome('hoyolab', 'HoYoLAB', 'failure', '帳號沒有可支援的已綁定遊戲。'));
    }
    return { platform: 'hoyolab', retryable, outcomes };
}

function validateSkportToken(value) {
    const token = String(value || '').trim();
    if (!token || token.length > 2048 || /\s|[\0]/.test(token)) {
        throw new GameCheckInAdapterError('SKPORT_TOKEN_INVALID', 'SKPORT account_token 格式不正確。', { validation: true });
    }
    return token;
}

function generateSkportSign(path, method, headers, query, body, token) {
    let source = path + (String(method).toUpperCase() === 'GET' ? (query || '') : (body || ''));
    if (headers.timestamp) source += String(headers.timestamp);
    const signedHeaders = {};
    for (const key of ['platform', 'timestamp', 'dId', 'vName']) {
        if (headers[key]) signedHeaders[key] = headers[key];
        else if (key === 'dId') signedHeaders[key] = '';
    }
    source += JSON.stringify(signedHeaders);
    const hmac = crypto.createHmac('sha256', token).update(source).digest('hex');
    return crypto.createHash('md5').update(hmac).digest('hex');
}

function skportAuthError(code, message, validation = false) {
    return new GameCheckInAdapterError(code, message, { validation });
}

async function authorizeSkport(value, { http, signal, validation = false } = {}) {
    if (!http?.get || !http?.post) throw new TypeError('SKPORT adapter 缺少 HTTP client');
    const accountToken = validateSkportToken(value);
    const grant = await requestData(
        () => http.post('https://as.gryphline.com/user/oauth2/v2/grant', {
            token: accountToken, appCode: '6eb76d4e13aa36e6', type: 0
        }, { signal }),
        signal,
        'SKPORT OAuth'
    );
    if (Number(grant.status) !== 0 || !grant.data?.code) {
        throw skportAuthError('SKPORT_AUTH_FAILED', 'SKPORT account_token 已失效，請重新取得。', validation);
    }

    const credential = await requestData(
        () => http.post('https://zonai.skport.com/api/v1/user/auth/generate_cred_by_code', {
            code: grant.data.code, kind: 1
        }, { signal }),
        signal,
        'SKPORT 憑證交換'
    );
    if (Number(credential.code) !== 0 || !credential.data?.cred) {
        throw skportAuthError('SKPORT_CRED_FAILED', 'SKPORT 無法交換短效憑證。', validation);
    }
    const cred = credential.data.cred;
    let token = credential.data.token;
    if (!token) {
        const refreshHeaders = {
            ...SKPORT_HEADERS, cred, timestamp: String(Math.floor(Date.now() / 1000)), 'sk-language': 'zh_Hant'
        };
        const refresh = await requestData(
            () => http.get('https://zonai.skport.com/api/v1/auth/refresh', { headers: refreshHeaders, signal }),
            signal,
            'SKPORT Token 更新'
        );
        if (Number(refresh.code) !== 0 || !refresh.data?.token) {
            throw skportAuthError('SKPORT_REFRESH_FAILED', 'SKPORT 無法更新短效 Token。', validation);
        }
        token = refresh.data.token;
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const bindingHeaders = { ...SKPORT_HEADERS, cred, timestamp, 'sk-language': 'zh_Hant' };
    bindingHeaders.sign = generateSkportSign('/api/v1/game/player/binding', 'GET', bindingHeaders, '', '', token);
    const binding = await requestData(
        () => http.get('https://zonai.skport.com/api/v1/game/player/binding', { headers: bindingHeaders, signal }),
        signal,
        'SKPORT 角色查詢'
    );
    if (Number(binding.code) !== 0 || !Array.isArray(binding.data?.list)) {
        throw skportAuthError('SKPORT_BINDING_FAILED', 'SKPORT 無法取得已綁定角色。', validation);
    }

    const tasks = [];
    for (const app of binding.data.list) {
        if (app.appCode === 'arknights') {
            for (const item of app.bindingList || []) {
                tasks.push({
                    game: '明日方舟', account: item.nickName || String(item.uid),
                    url: 'https://zonai.skport.com/api/v1/game/attendance',
                    path: '/api/v1/game/attendance',
                    body: JSON.stringify({ uid: item.uid, gameId: '1' }),
                    role: `1_${item.uid}_1`
                });
            }
        }
        if (app.appCode === 'endfield') {
            for (const bindingItem of app.bindingList || []) {
                for (const role of bindingItem.roles || []) {
                    tasks.push({
                        game: '明日方舟：終末地',
                        account: `${role.nickName || role.roleId}（${role.serverName || role.serverId}）`,
                        url: 'https://zonai.skport.com/web/v1/game/endfield/attendance',
                        path: '/web/v1/game/endfield/attendance', body: '',
                        role: `3_${role.roleId}_${role.serverId}`
                    });
                }
            }
        }
    }
    if (!tasks.length) throw skportAuthError('SKPORT_NO_ROLES', '此 SKPORT 帳號沒有可支援的已綁定角色。', validation);
    return { cred, token, tasks };
}

async function validateSkportCredential(value, options = {}) {
    const auth = await authorizeSkport(value, { ...options, validation: true });
    return { roles: auth.tasks.length };
}

async function runSkportCheckIn(value, options = {}) {
    let auth;
    try {
        auth = await authorizeSkport(value, options);
    } catch (error) {
        if (!(error instanceof GameCheckInAdapterError)) throw error;
        return {
            platform: 'skport', retryable: error.retryable,
            outcomes: [outcome('skport', 'SKPORT', 'failure', error.message)]
        };
    }

    const outcomes = [];
    let retryable = false;
    for (const task of auth.tasks) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const headers = {
            ...SKPORT_HEADERS,
            cred: auth.cred,
            'sk-game-role': task.role,
            'sk-language': 'zh_Hant',
            timestamp
        };
        headers.sign = generateSkportSign(task.path, 'POST', headers, '', task.body, auth.token);
        let data;
        try {
            data = await requestData(
                () => options.http.post(task.url, task.body || '', { headers, signal: options.signal }),
                options.signal,
                `SKPORT ${task.game}`
            );
        } catch (error) {
            if (!(error instanceof GameCheckInAdapterError)) throw error;
            retryable ||= error.retryable;
            outcomes.push(outcome('skport', task.game, 'failure', error.message, task.account));
            continue;
        }
        if (Number(data.code) === 0 || String(data.message).toUpperCase() === 'OK') {
            outcomes.push(outcome('skport', task.game, 'success', '簽到成功。', task.account));
        } else if (/already|已.{0,4}簽到/i.test(String(data.message || ''))) {
            outcomes.push(outcome('skport', task.game, 'already', '今日已完成簽到。', task.account));
        } else if (Number(data.code) === 10000) {
            retryable = true;
            outcomes.push(outcome('skport', task.game, 'failure', 'SKPORT 短效 Token 無效，將重新授權後重試。', task.account));
        } else {
            outcomes.push(outcome('skport', task.game, 'failure', 'SKPORT 拒絕了簽到請求。', task.account));
        }
    }
    return { platform: 'skport', retryable, outcomes };
}

function createGameCheckInAdapters() {
    return Object.freeze({
        validate: {
            hoyolab: validateHoyolabCredential,
            skport: validateSkportCredential
        },
        run: {
            hoyolab: runHoyolabCheckIn,
            skport: runSkportCheckIn
        }
    });
}

module.exports = {
    GameCheckInAdapterError,
    HOYOLAB_GAMES,
    createGameCheckInAdapters,
    generateSkportSign,
    parseHoyolabCookie,
    runHoyolabCheckIn,
    runSkportCheckIn,
    validateHoyolabCredential,
    validateSkportCredential
};
