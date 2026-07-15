const { spawn } = require('node:child_process');

/** 建立一致的程序取消錯誤，供關機與單次工作取消共用。 */
function createAbortError(message = '外部程序已取消。', reason) {
    if (reason instanceof Error) return reason;
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'ERR_CANCELED';
    return error;
}

/** 判斷 child 是否仍可能存在；exitCode 與 signalCode 都為空才需要送 signal。 */
function isRunning(child) {
    return child && child.exitCode == null && child.signalCode == null;
}

/** 附加程序輸出；保留 ETIMEDOUT／ERR_CANCELED 等既有錯誤代碼。 */
function attachResult(error, result) {
    const errorCode = typeof error.code === 'string' ? error.code : null;
    Object.assign(error, result);
    if (errorCode !== null) {
        error.exitCode = result.code;
        error.code = errorCode;
    }
    return error;
}

/**
 * 建立外部程序管理器。由 run 建立的 POSIX child 會成為獨立 process group，
 * 關閉時先送 SIGTERM，寬限期後再以 SIGKILL 結束完整程序樹；外部 track 的
 * child 預設只終止直接子程序，除非明確標示 processGroup。
 */
function createProcessManager({
    signal: rootSignal,
    platform = process.platform,
    killGraceMs = 3000,
    spawnFn = spawn,
    killFn = process.kill.bind(process),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout
} = {}) {
    const records = new Map();
    const useProcessGroups = platform !== 'win32';
    let stopping = false;
    let stopPromise = null;

    /** 記住 child 的關閉狀態，避免重複追蹤或重複送終止訊號。 */
    function addRecord(child, { processGroup = false } = {}) {
        if (!child || typeof child.once !== 'function') {
            throw new TypeError('track() 需要 ChildProcess 相容物件。');
        }
        if (records.has(child)) return records.get(child);

        let resolveClosed;
        const record = {
            child,
            processGroup: Boolean(processGroup && useProcessGroups),
            cancelError: null,
            terminationPromise: null,
            closed: new Promise(resolve => { resolveClosed = resolve; })
        };
        const close = () => {
            records.delete(child);
            resolveClosed();
        };
        child.once('close', close);
        // spawn 失敗時可能沒有 pid；此時 error 已是終態，不能讓 stopAll 永久等待。
        child.once('error', () => { if (!child.pid) close(); });
        records.set(child, record);
        return record;
    }

    /** 對 process group 或直接 child 送出 signal；不存在視同已終止。 */
    function sendSignal(record, childSignal) {
        const child = record.child;
        if (!isRunning(child)) return;
        if (record.processGroup && Number.isInteger(child.pid) && child.pid > 0) {
            try {
                killFn(-child.pid, childSignal);
                return;
            } catch (error) {
                if (error?.code === 'ESRCH') return;
                // process group 無法使用時，至少嘗試終止直接 child。
            }
        }
        try { child.kill?.(childSignal); }
        catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }

    function closesWithin(closed, milliseconds) {
        return new Promise(resolve => {
            const timer = setTimeoutFn(() => resolve(false), milliseconds);
            closed.then(() => {
                clearTimeoutFn(timer);
                resolve(true);
            });
        });
    }

    /** 單一 child 的 TERM/KILL 流程，同時合併來自 timeout、signal 與 shutdown 的競態。 */
    function terminate(record, reason) {
        if (record.terminationPromise) {
            record.cancelError ||= reason;
            return record.terminationPromise;
        }
        record.cancelError = reason;
        record.terminationPromise = (async () => {
            if (!isRunning(record.child)) return;
            sendSignal(record, 'SIGTERM');
            const closedDuringGrace = await closesWithin(record.closed, Math.max(0, killGraceMs));
            if (!closedDuringGrace && isRunning(record.child)) sendSignal(record, 'SIGKILL');
            await record.closed;
        })();
        return record.terminationPromise;
    }

    /**
     * 追蹤既有 ChildProcess；它關閉後會自動移除。外部 child 若確定為獨立
     * POSIX process-group leader，可傳入 `{ processGroup: true }`。
     */
    function track(child, options = {}) {
        const record = addRecord(child, options);
        if (stopping) void terminate(record, createAbortError('程序管理器已停止。')).catch(() => {});
        return child;
    }

    /**
     * 啟動並等待一個外部程序。stdout/stderr 各自有固定上限；timeout、輸出超限
     * 或 signal 取消時都會走同一套 TERM/KILL 流程。
     */
    function run(command, args = [], options = {}) {
        if (stopping || rootSignal?.aborted) {
            return Promise.reject(createAbortError('程序管理器已停止。', rootSignal?.reason));
        }
        if (!Array.isArray(args)) return Promise.reject(new TypeError('run() 的 args 必須是陣列。'));

        const {
            timeout = 0,
            signal,
            onStdout,
            onStderr,
            rejectOnNonZero = true,
            maxStdoutBytes = 8 * 1024 * 1024,
            maxStderrBytes = 8 * 1024 * 1024,
            ...spawnOptions
        } = options;
        if (signal?.aborted) return Promise.reject(createAbortError('外部程序已取消。', signal.reason));

        let child;
        try {
            child = spawnFn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                ...spawnOptions,
                ...(useProcessGroups ? { detached: true } : {})
            });
        } catch (error) {
            return Promise.reject(error);
        }
        const record = addRecord(child, { processGroup: useProcessGroups });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let timeoutTimer = null;
        let settled = false;

        const resultPromise = new Promise((resolve, reject) => {
            const cleanup = () => {
                if (timeoutTimer !== null) clearTimeoutFn(timeoutTimer);
                signal?.removeEventListener('abort', abort);
            };
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(value);
            };
            const abort = () => {
                void terminate(record, createAbortError('外部程序已取消。', signal.reason)).catch(() => {});
            };

            child.stdout?.on('data', chunk => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                stdoutBytes += buffer.length;
                if (stdoutBytes > maxStdoutBytes) {
                    const error = new Error(`${command} stdout 超過 ${maxStdoutBytes} bytes 上限。`);
                    error.code = 'MAX_BUFFER';
                    void terminate(record, error).catch(() => {});
                    return;
                }
                stdout.push(buffer);
                onStdout?.(buffer.toString());
            });
            child.stderr?.on('data', chunk => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                stderrBytes += buffer.length;
                if (stderrBytes > maxStderrBytes) {
                    const error = new Error(`${command} stderr 超過 ${maxStderrBytes} bytes 上限。`);
                    error.code = 'MAX_BUFFER';
                    void terminate(record, error).catch(() => {});
                    return;
                }
                stderr.push(buffer);
                onStderr?.(buffer.toString());
            });
            child.once('error', error => finish(reject, error));
            child.once('close', (code, childSignal) => {
                const result = {
                    code,
                    signal: childSignal,
                    stdout: Buffer.concat(stdout).toString(),
                    stderr: Buffer.concat(stderr).toString()
                };
                if (record.cancelError) return finish(reject, attachResult(record.cancelError, result));
                if (!rejectOnNonZero || code === 0) return finish(resolve, result);
                const message = result.stderr.trim() || `${command} 結束，代碼 ${code}`;
                finish(reject, Object.assign(new Error(message), result));
            });

            signal?.addEventListener('abort', abort, { once: true });
            if (Number(timeout) > 0) {
                timeoutTimer = setTimeoutFn(() => {
                    const error = new Error(`${command} 執行逾時。`);
                    error.code = 'ETIMEDOUT';
                    void terminate(record, error).catch(() => {});
                }, Number(timeout));
            }
        });
        // 需要進度或客製串流處理的呼叫端可取得 child，但完成狀態仍以 Promise 為準。
        resultPromise.child = child;
        return resultPromise;
    }

    /** 冪等停止所有已追蹤程序；第一次呼叫後不再接受新的 run。 */
    function stopAll() {
        if (stopPromise) return stopPromise;
        stopping = true;
        rootSignal?.removeEventListener('abort', onRootAbort);
        const reason = createAbortError('應用程式正在關閉，外部程序已取消。', rootSignal?.reason);
        stopPromise = Promise.all([...records.values()].map(record => terminate(record, reason))).then(() => undefined);
        return stopPromise;
    }

    function onRootAbort() {
        void stopAll().catch(() => {});
    }

    if (rootSignal?.aborted) stopping = true;
    else rootSignal?.addEventListener('abort', onRootAbort, { once: true });

    return { run, track, stopAll };
}

module.exports = { createProcessManager };
