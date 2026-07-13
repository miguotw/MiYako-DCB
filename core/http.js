const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_GET_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 60000;
const RETRYABLE_STATUS = new Set([408, 429]);
const RETRYABLE_NETWORK_CODES = new Set([
    'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH',
    'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE', 'ERR_NETWORK', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'
]);

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
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
            try {
                return await dispatch({ ...requestConfig, method, timeout: timeoutMs });
            } catch (error) {
                if (attempt >= retryLimit || method !== 'GET' || !isRetryableGetError(error)) throw error;
                const retryAfter = parseRetryAfter(getHeader(error.response?.headers, 'retry-after'), now());
                if (retryAfter !== null && retryAfter > maxRetryAfterMs) throw error;
                await sleepFn(retryAfter ?? 500 * (2 ** attempt));
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

const http = createHttpClient();

module.exports = {
    DEFAULT_TIMEOUT_MS,
    createHttpClient,
    http,
    isRetryableGetError,
    parseRetryAfter
};
