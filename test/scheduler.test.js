const assert = require('node:assert/strict');
const test = require('node:test');
const { SchedulerTimeoutError, createScheduler } = require('../core/scheduler');

function deferred() {
    let resolve;
    const promise = new Promise(innerResolve => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

async function flushMicrotasks(rounds = 12) {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

class FakeClock {
    constructor() {
        this.now = 0;
        this.nextId = 1;
        this.timers = new Map();
    }

    setTimeout(callback, delay) {
        const id = this.nextId;
        this.nextId += 1;
        this.timers.set(id, { at: this.now + delay, callback });
        return id;
    }

    clearTimeout(id) {
        this.timers.delete(id);
    }

    async advance(milliseconds) {
        const target = this.now + milliseconds;
        while (true) {
            let nextId;
            let nextTimer;
            for (const [id, timer] of this.timers) {
                if (timer.at <= target && (!nextTimer || timer.at < nextTimer.at || (timer.at === nextTimer.at && id < nextId))) {
                    nextId = id;
                    nextTimer = timer;
                }
            }
            if (!nextTimer) break;
            this.now = nextTimer.at;
            this.timers.delete(nextId);
            nextTimer.callback();
            await flushMicrotasks();
        }
        this.now = target;
        await flushMicrotasks();
    }
}

function silentLogger() {
    return { error() {}, warn() {}, info() {} };
}

test('awaited self-scheduling 會等上一輪完成後才開始計算 interval', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    const runs = [];
    scheduler.register({
        name: 'awaited',
        intervalMs: 100,
        immediate: true,
        run: () => {
            const current = deferred();
            runs.push(current);
            return current.promise;
        }
    });

    await clock.advance(0);
    assert.equal(runs.length, 1);
    await clock.advance(1000);
    assert.equal(runs.length, 1, '執行中的工作不得重疊');

    runs[0].resolve();
    await flushMicrotasks();
    await clock.advance(99);
    assert.equal(runs.length, 1);
    await clock.advance(1);
    assert.equal(runs.length, 2);

    runs[1].resolve();
    await flushMicrotasks();
    await scheduler.stop();
});

test('執行中的多次 trigger 只合併成一個 pending run', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    const runs = [];
    const job = scheduler.register({
        name: 'coalesced',
        intervalMs: 1000,
        run: () => {
            const current = deferred();
            runs.push(current);
            return current.promise;
        }
    });

    const first = job.trigger();
    await flushMicrotasks();
    const pendingA = job.trigger();
    const pendingB = job.trigger();
    assert.strictEqual(pendingA, pendingB);
    assert.equal(runs.length, 1);

    runs[0].resolve('first');
    await flushMicrotasks();
    assert.equal(runs.length, 2);
    runs[1].resolve('second');
    assert.equal((await first).status, 'success');
    assert.equal((await pendingA).status, 'success');
    assert.equal(runs.length, 2);
    await scheduler.stop();
});

test('失敗採指數退避、上限不超過 interval，成功後重設', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    const outcomes = ['fail', 'fail', 'success', 'fail', 'success'];
    const runTimes = [];
    scheduler.register({
        name: 'backoff',
        intervalMs: 6000,
        immediate: true,
        run: async () => {
            runTimes.push(clock.now);
            if (outcomes.shift() === 'fail') throw new Error('temporary');
        }
    });

    await clock.advance(0);       // t=0，第一次失敗
    await clock.advance(4999);
    assert.deepEqual(runTimes, [0]);
    await clock.advance(1);       // 首次退避 5000
    await clock.advance(5999);
    assert.deepEqual(runTimes, [0, 5000]);
    await clock.advance(1);       // 第二次退避 capped at interval=6000
    await clock.advance(6000);    // 成功後走正常 interval
    await clock.advance(4999);
    assert.deepEqual(runTimes, [0, 5000, 11000, 17000]);
    await clock.advance(1);       // 成功已重設，下一次失敗回到 5000

    assert.deepEqual(runTimes, [0, 5000, 11000, 17000, 22000]);
    await scheduler.stop();
});

test('timeout 會 abort 每輪 signal，合作式結束後依退避重試', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({
        clock,
        logger: silentLogger(),
        cancellationGraceMs: 50
    });
    const receivedSignals = [];
    const job = scheduler.register({
        name: 'timeout',
        intervalMs: 1000,
        timeoutMs: 100,
        run: ({ signal }) => new Promise((resolve, reject) => {
            receivedSignals.push(signal);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });

    const resultPromise = job.trigger();
    await flushMicrotasks();
    await clock.advance(100);
    const result = await resultPromise;
    assert.equal(result.status, 'timeout');
    assert.ok(result.error instanceof SchedulerTimeoutError);
    assert.equal(receivedSignals[0].aborted, true);

    await clock.advance(999);
    assert.equal(receivedSignals.length, 1);
    await clock.advance(1);
    assert.equal(receivedSignals.length, 2, '5000ms 初始退避受 interval 上限限制為 1000ms');
    const stopping = scheduler.stop();
    await flushMicrotasks();
    await stopping;
});

test('忽略取消的工作在 grace 後標記 stuck 並永久停用', async () => {
    const clock = new FakeClock();
    const errors = [];
    const scheduler = createScheduler({
        clock,
        logger: { error: (message, details) => errors.push({ message, details }) },
        cancellationGraceMs: 20
    });
    let calls = 0;
    const job = scheduler.register({
        name: 'stuck',
        intervalMs: 1000,
        timeoutMs: 100,
        run: () => {
            calls += 1;
            return new Promise(() => {});
        }
    });

    const execution = job.trigger();
    await flushMicrotasks();
    await clock.advance(100);
    await clock.advance(19);
    assert.equal(calls, 1);
    await clock.advance(1);

    assert.equal((await execution).status, 'stuck');
    assert.equal((await job.trigger()).status, 'stuck');
    await clock.advance(10000);
    assert.equal(calls, 1);
    assert.match(errors[0].message, /已停用/);
    await scheduler.stop();
});

test('拒絕重複名稱，個別與中央 stop 都是冪等且清除 timer', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    let calls = 0;
    const job = scheduler.register({
        name: 'unique',
        intervalMs: 100,
        run: async () => { calls += 1; }
    });

    assert.throws(() => scheduler.register({
        name: 'unique', intervalMs: 100, run: async () => {}
    }), /名稱重複/);
    const jobStopA = job.stop();
    const jobStopB = job.stop();
    assert.strictEqual(jobStopA, jobStopB);
    await jobStopA;

    const stopA = scheduler.stop();
    const stopB = scheduler.stop();
    assert.strictEqual(stopA, stopB);
    await stopA;
    await clock.advance(1000);
    assert.equal(calls, 0);
    assert.throws(() => scheduler.register({
        name: 'late', intervalMs: 100, run: async () => {}
    }), /已停止/);
});

test('外部 AbortSignal 會觸發中央停止並取消執行中工作', async () => {
    const clock = new FakeClock();
    const appController = new AbortController();
    const scheduler = createScheduler({
        clock,
        signal: appController.signal,
        logger: silentLogger(),
        cancellationGraceMs: 20
    });
    let jobSignal;
    const job = scheduler.register({
        name: 'app-signal',
        intervalMs: 100,
        run: ({ signal }) => new Promise((resolve, reject) => {
            jobSignal = signal;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });

    const execution = job.trigger();
    await flushMicrotasks();
    appController.abort(new Error('shutdown'));
    await flushMicrotasks();
    assert.equal(jobSignal.aborted, true);
    assert.equal((await execution).status, 'stopped');
    await scheduler.stop();
});

test('deadline 未到期不執行、成功只執行一次，reschedule 可重新啟用', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    const runTimes = [];
    const job = scheduler.scheduleDeadline({
        name: 'deadline-once', deadlineAt: 1000, timeoutMs: 100,
        run: async () => { runTimes.push(clock.now); }
    });
    await clock.advance(999);
    assert.deepEqual(runTimes, []);
    await clock.advance(1);
    assert.deepEqual(runTimes, [1000]);
    await clock.advance(10000);
    assert.deepEqual(runTimes, [1000]);
    job.reschedule(12000);
    await clock.advance(999);
    assert.deepEqual(runTimes, [1000]);
    await clock.advance(1);
    assert.deepEqual(runTimes, [1000, 12000]);
    await scheduler.stop();
});

test('deadline 失敗從五秒開始退避，成功後解除排程', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    let calls = 0;
    scheduler.scheduleDeadline({
        name: 'deadline-retry', deadlineAt: 0,
        run: async () => {
            calls += 1;
            if (calls < 3) throw new Error('temporary');
        }
    });
    await clock.advance(0);
    assert.equal(calls, 1);
    await clock.advance(4999);
    assert.equal(calls, 1);
    await clock.advance(1);
    assert.equal(calls, 2);
    await clock.advance(9999);
    assert.equal(calls, 2);
    await clock.advance(1);
    assert.equal(calls, 3);
    await clock.advance(60_000);
    assert.equal(calls, 3);
    await scheduler.stop();
});

test('個別停止 deadline 後可安全重用同一名稱', async () => {
    const clock = new FakeClock();
    const scheduler = createScheduler({ clock, logger: silentLogger() });
    const first = scheduler.scheduleDeadline({ name: 'reusable', deadlineAt: 1000, run: async () => {} });
    await first.stop();
    let calls = 0;
    scheduler.scheduleDeadline({ name: 'reusable', deadlineAt: 0, run: async () => { calls += 1; } });
    await clock.advance(0);
    assert.equal(calls, 1);
    await scheduler.stop();
});
