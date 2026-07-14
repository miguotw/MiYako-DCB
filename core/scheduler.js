const DEFAULT_CANCELLATION_GRACE_MS = 1000;
const DEFAULT_BACKOFF_INITIAL_MS = 5000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

const systemClock = {
    setTimeout(callback, delay) {
        return setTimeout(callback, delay);
    },
    clearTimeout(timer) {
        clearTimeout(timer);
    }
};

class SchedulerTimeoutError extends Error {
    constructor(name, timeoutMs) {
        super(`排程工作 ${name} 執行超過 ${timeoutMs} 毫秒`);
        this.name = 'SchedulerTimeoutError';
        this.code = 'SCHEDULER_TIMEOUT';
        this.jobName = name;
        this.timeoutMs = timeoutMs;
    }
}

function createDeferred() {
    let resolve;
    const promise = new Promise(innerResolve => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

function assertPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${label} 必須是正整數`);
    }
}

function normalizeBackoff(backoff, intervalMs) {
    if (backoff === false) return null;
    if (backoff !== undefined && backoff !== true && (backoff === null || typeof backoff !== 'object')) {
        throw new TypeError('backoff 必須是布林值或設定物件');
    }

    const options = typeof backoff === 'object' && backoff !== null ? backoff : {};
    const initialMs = options.initialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    const multiplier = options.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    const configuredMaxMs = options.maxMs ?? intervalMs;

    assertPositiveInteger(initialMs, 'backoff.initialMs');
    assertPositiveInteger(configuredMaxMs, 'backoff.maxMs');
    if (!Number.isFinite(multiplier) || multiplier < 1) {
        throw new TypeError('backoff.multiplier 必須是大於或等於 1 的有限數字');
    }

    return {
        initialMs,
        multiplier,
        // 退避不能比正常輪詢更慢，避免故障恢復後長時間沒有再嘗試。
        maxMs: Math.min(configuredMaxMs, intervalMs)
    };
}

function safeLog(logger, level, message, details) {
    try {
        logger?.[level]?.(message, details);
    } catch {
        // 記錄器失效不能破壞 scheduler 的 single-flight 與關機保證。
    }
}

function watchAbort(signal) {
    let listener;
    const promise = new Promise(resolve => {
        if (signal.aborted) {
            resolve({ type: 'aborted', reason: signal.reason });
            return;
        }
        listener = () => resolve({ type: 'aborted', reason: signal.reason });
        signal.addEventListener('abort', listener, { once: true });
    });
    return {
        promise,
        dispose() {
            if (listener) signal.removeEventListener('abort', listener);
        }
    };
}

function waitForGrace(settledPromise, milliseconds, clock) {
    let timer;
    const elapsed = new Promise(resolve => {
        timer = clock.setTimeout(() => resolve({ type: 'grace-elapsed' }), milliseconds);
    });
    return Promise.race([settledPromise, elapsed]).finally(() => {
        if (timer !== undefined) clock.clearTimeout(timer);
    });
}

/**
 * 建立中央排程器。
 *
 * 不變量：同名工作最多同時執行一輪；下一個 timer 只會在上一輪 awaited
 * 完成後建立。若工作忽略 AbortSignal 且超過取消寬限，該工作會永久停用，
 * scheduler 不會在舊 Promise 尚未結束時啟動替代輪次。
 */
function createScheduler({
    logger = console,
    signal,
    clock = systemClock,
    cancellationGraceMs = DEFAULT_CANCELLATION_GRACE_MS
} = {}) {
    if (!Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs < 0) {
        throw new TypeError('cancellationGraceMs 必須是非負整數');
    }
    if (!clock || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
        throw new TypeError('clock 必須提供 setTimeout 與 clearTimeout');
    }

    const jobs = new Map();
    let stopping = Boolean(signal?.aborted);
    let stopPromise = stopping ? Promise.resolve() : null;
    let appAbortListener;

    /**
     * 註冊 awaited self-scheduling 工作。run 固定接收 `{ signal }`；每輪 signal
     * 彼此獨立，timeout、個別 stop 或中央 stop 都會取消目前輪次。
     */
    function register({
        name,
        intervalMs,
        timeoutMs,
        immediate = false,
        backoff = true,
        run
    } = {}) {
        if (stopping) throw new Error('Scheduler 已停止，不能再註冊工作');
        if (typeof name !== 'string' || name.trim() === '') throw new TypeError('排程工作名稱不得為空');
        if (jobs.has(name)) throw new Error(`排程工作名稱重複：${name}`);
        assertPositiveInteger(intervalMs, 'intervalMs');
        if (timeoutMs !== undefined && timeoutMs !== null) assertPositiveInteger(timeoutMs, 'timeoutMs');
        if (typeof immediate !== 'boolean') throw new TypeError('immediate 必須是布林值');
        if (typeof run !== 'function') throw new TypeError('run 必須是函式');

        const backoffOptions = normalizeBackoff(backoff, intervalMs);
        let active = true;
        let stuck = false;
        let running = false;
        let pending = false;
        let pendingDeferred = null;
        let failures = 0;
        let timer;
        let currentController = null;
        let currentExecution = null;
        let jobStopPromise = null;

        function clearScheduledTimer() {
            if (timer === undefined) return;
            clock.clearTimeout(timer);
            timer = undefined;
        }

        function schedule(delay) {
            if (!active || stopping || timer !== undefined) return;
            timer = clock.setTimeout(() => {
                timer = undefined;
                startExecution();
            }, delay);
        }

        function failureDelay() {
            if (!backoffOptions) return intervalMs;
            const exponential = backoffOptions.initialMs * (backoffOptions.multiplier ** (failures - 1));
            return Math.min(exponential, backoffOptions.maxMs, intervalMs);
        }

        function finishPendingWith(result) {
            if (!pendingDeferred) return;
            const deferred = pendingDeferred;
            pendingDeferred = null;
            pending = false;
            deferred.resolve(result);
        }

        async function execute() {
            if (!active || stopping || running) {
                return { status: stuck ? 'stuck' : 'stopped', name };
            }

            running = true;
            const controller = new AbortController();
            currentController = controller;
            let timeoutTimer;
            let timeoutError = null;

            if (timeoutMs !== undefined && timeoutMs !== null) {
                timeoutTimer = clock.setTimeout(() => {
                    timeoutError = new SchedulerTimeoutError(name, timeoutMs);
                    controller.abort(timeoutError);
                }, timeoutMs);
            }

            // 先轉成永遠 fulfilled 的結果，避免背景工作失敗形成 unhandled rejection。
            const settledPromise = Promise.resolve()
                .then(() => {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    return run({ signal: controller.signal });
                })
                .then(
                    value => ({ type: 'fulfilled', value }),
                    error => ({ type: 'rejected', error })
                );
            const abortWatcher = watchAbort(controller.signal);
            let outcome = await Promise.race([settledPromise, abortWatcher.promise]);

            if (outcome.type === 'aborted') {
                const afterCancellation = await waitForGrace(settledPromise, cancellationGraceMs, clock);
                if (afterCancellation.type === 'grace-elapsed') {
                    stuck = true;
                    active = false;
                    const reason = timeoutError ?? outcome.reason;
                    safeLog(logger, 'error', `排程工作 ${name} 取消後仍未結束，已停用`, { error: reason });
                    outcome = { type: 'stuck', error: reason };
                } else {
                    outcome = afterCancellation;
                }
            }

            abortWatcher.dispose();
            if (timeoutTimer !== undefined) clock.clearTimeout(timeoutTimer);
            currentController = null;
            running = false;

            let result;
            let nextDelay = intervalMs;
            if (outcome.type === 'stuck') {
                result = { status: 'stuck', name, error: outcome.error };
            } else if (!active || stopping) {
                result = { status: 'stopped', name };
            } else if (timeoutError) {
                failures += 1;
                nextDelay = failureDelay();
                safeLog(logger, 'error', timeoutError.message, { error: timeoutError, nextDelay });
                result = { status: 'timeout', name, error: timeoutError };
            } else if (outcome.type === 'rejected') {
                failures += 1;
                nextDelay = failureDelay();
                safeLog(logger, 'error', `排程工作 ${name} 執行失敗`, { error: outcome.error, nextDelay });
                result = { status: 'failed', name, error: outcome.error };
            } else {
                failures = 0;
                result = { status: 'success', name, value: outcome.value };
            }

            if (active && !stopping) {
                if (pending) {
                    const deferred = pendingDeferred;
                    pendingDeferred = null;
                    pending = false;
                    const pendingExecution = startExecution();
                    pendingExecution.then(deferred.resolve);
                } else {
                    schedule(nextDelay);
                }
            } else {
                finishPendingWith({ status: stuck ? 'stuck' : 'stopped', name });
            }

            return result;
        }

        function startExecution() {
            if (!active || stopping) return Promise.resolve({ status: stuck ? 'stuck' : 'stopped', name });
            let execution;
            execution = execute().finally(() => {
                if (currentExecution === execution) currentExecution = null;
            });
            currentExecution = execution;
            return execution;
        }

        /** 執行中重複 trigger 只保留一輪，所有呼叫者共用該輪 Promise。 */
        function trigger() {
            if (!active || stopping) return Promise.resolve({ status: stuck ? 'stuck' : 'stopped', name });
            clearScheduledTimer();
            if (!running) return startExecution();
            pending = true;
            if (!pendingDeferred) pendingDeferred = createDeferred();
            return pendingDeferred.promise;
        }

        /** 個別 stop 可重複呼叫，且會等待合作式取消或 stuck 判定完成。 */
        function stopJob() {
            if (jobStopPromise) return jobStopPromise;
            jobStopPromise = (async () => {
                active = false;
                clearScheduledTimer();
                finishPendingWith({ status: 'stopped', name });
                currentController?.abort(new Error(`排程工作 ${name} 已停止`));
                if (currentExecution) await currentExecution;
            })();
            return jobStopPromise;
        }

        const job = { trigger, stop: stopJob };
        jobs.set(name, { stop: stopJob });
        schedule(immediate ? 0 : intervalMs);
        return job;
    }

    /** 中央 stop 為冪等操作；停止 timer、取消所有執行中工作並等待其收尾。 */
    function stop() {
        if (stopPromise) return stopPromise;
        stopping = true;
        if (signal && appAbortListener) signal.removeEventListener('abort', appAbortListener);
        stopPromise = Promise.all([...jobs.values()].map(job => job.stop())).then(() => undefined);
        return stopPromise;
    }

    if (signal && !signal.aborted) {
        appAbortListener = () => {
            stop();
        };
        signal.addEventListener('abort', appAbortListener, { once: true });
    }

    return { register, stop };
}

module.exports = {
    DEFAULT_BACKOFF_INITIAL_MS,
    DEFAULT_CANCELLATION_GRACE_MS,
    SchedulerTimeoutError,
    createScheduler
};
