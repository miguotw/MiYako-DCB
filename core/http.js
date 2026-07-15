const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_GET_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 60000;
const RETRYABLE_STATUS = new Set([408, 429]);
const RETRYABLE_NETWORK_CODES = new Set([
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH',
    'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'
]);

function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(getAbortReason(signal));
        const timer = setTimeout(finish, milliseconds);

        function finish() {
            signal?.removeEventListener('abort', abort);
            resolve();
        }

        function abort() {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(getAbortReason(signal));
        }

        signal?.addEventListener('abort', abort, { once: true });
    });
}

/** 將 AbortSignal 的 reason 正規化為可辨識的取消錯誤。 */
function getAbortReason(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('HTTP 請求已取消。');
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    return error;
}

/**
 * 合併應用層與單次請求的 AbortSignal，並提供清理函式，避免長時間執行時
 * 在根 signal 上累積 listener。
 */
function mergeSignals(signals) {
    const validSignals = signals.filter(Boolean);
    if (validSignals.length === 0) return { signal: undefined, cleanup() {} };
    if (validSignals.length === 1) return { signal: validSignals[0], cleanup() {} };

    const controller = new AbortController();
    const listeners = [];
    const cleanup = () => {
        for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
        listeners.length = 0;
    };

    for (const signal of validSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const listener = () => controller.abort(signal.reason);
        listeners.push([signal, listener]);
        signal.addEventListener('abort', listener, { once: true });
    }
    if (controller.signal.aborted) cleanup();
    else controller.signal.addEventListener('abort', cleanup, { once: true });
    return { signal: controller.signal, cleanup };
}

/** 即使注入的 sleepFn 不支援 signal，取消也能立即結束邏輯等待。 */
function waitForRetry(milliseconds, signal, sleepFn) {
    if (signal?.aborted) return Promise.reject(getAbortReason(signal));
    if (!signal) return Promise.resolve().then(() => sleepFn(milliseconds));

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => finish(reject, getAbortReason(signal));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
            .then(() => sleepFn(milliseconds, signal))
            .then(value => finish(resolve, value), error => finish(reject, error));
    });
}

/** 等待 transport，確保不合作的測試 adapter 也不會阻塞 HTTP client 關閉。 */
function dispatchWithSignal(dispatch, config, signal) {
    if (signal?.aborted) return Promise.reject(getAbortReason(signal));
    if (!signal) return Promise.resolve().then(() => dispatch(config));

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => finish(reject, getAbortReason(signal));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
            .then(() => dispatch(config))
            .then(value => finish(resolve, value), error => finish(reject, error));
    });
}

function getHeader(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()];
}

/** 解析 HTTP Retry-After 的秒數或日期格式；無效值回傳 null。 */
function parseRetryAfter(value, now = Date.now()) {
    if (value === undefined || value === null || value === '') return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(String(value));
    if (!Number.isFinite(date)) return null;
    return Math.max(date - now, 0);
}

/** 僅辨識暫時性網路錯誤與明確可重試的 HTTP 狀態，取消或程式錯誤不重送。 */
function isRetryableGetError(error) {
    if (!error || error.code === 'ERR_CANCELED' || axios.isCancel?.(error)) return false;
    const status = Number(error.response?.status);
    if (status) return RETRYABLE_STATUS.has(status) || status >= 500;
    return RETRYABLE_NETWORK_CODES.has(error.code);
}

/**
 * 建立第三方 HTTP client。只有 GET 可重試，避免 POST/PATCH 在網路結果不明時
 * 重複建立或改動遠端資料；每次嘗試都強制套用相同 timeout。
 */
function createHttpClient({
    transport = axios,
    sleepFn = sleep,
    now = () => Date.now(),
    signal: rootSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxGetRetries = DEFAULT_MAX_GET_RETRIES,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS
} = {}) {
    const dispatch = typeof transport === 'function'
        ? transport
        : config => transport.request(config);

    async function request(requestConfig) {
        const method = String(requestConfig.method || 'GET').toUpperCase();
        const retryLimit = method === 'GET' ? maxGetRetries : 0;

        for (let attempt = 0; ; attempt++) {
            const merged = mergeSignals([rootSignal, requestConfig.signal]);
            try {
                if (merged.signal?.aborted) throw getAbortReason(merged.signal);
                return await dispatchWithSignal(
                    dispatch,
                    { ...requestConfig, method, timeout: timeoutMs, signal: merged.signal },
                    merged.signal
                );
            } catch (error) {
                if (merged.signal?.aborted) throw getAbortReason(merged.signal);
                if (attempt >= retryLimit || method !== 'GET' || !isRetryableGetError(error)) throw error;
                const retryAfter = parseRetryAfter(getHeader(error.response?.headers, 'retry-after'), now());
                if (retryAfter !== null && retryAfter > maxRetryAfterMs) throw error;
                await waitForRetry(retryAfter ?? 500 * (2 ** attempt), merged.signal, sleepFn);
            } finally {
                merged.cleanup();
            }
        }
    }

    return {
        request,
        get(url, config = {}) { return request({ ...config, method: 'GET', url }); },
        post(url, data, config = {}) { return request({ ...config, method: 'POST', url, data }); },
        patch(url, data, config = {}) { return request({ ...config, method: 'PATCH', url, data }); }
    };
}

let defaultHttpClient = createHttpClient();
const http = {
    request(config) { return defaultHttpClient.request(config); },
    get(url, config) { return defaultHttpClient.get(url, config); },
    post(url, data, config) { return defaultHttpClient.post(url, data, config); },
    patch(url, data, config) { return defaultHttpClient.patch(url, data, config); }
};

/** Runtime 在建立 root AbortSignal 後替換共用 client；穩定 facade 讓既有 adapter 同步受控。 */
function setDefaultHttpClient(client) {
    if (!client || typeof client.request !== 'function') throw new TypeError('預設 HTTP client 必須提供 request。');
    defaultHttpClient = client;
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    createHttpClient,
    http,
    isRetryableGetError,
    parseRetryAfter,
    setDefaultHttpClient
};
