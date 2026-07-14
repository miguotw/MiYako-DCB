const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createProcessManager } = require('../core/processManager');

function createChild(pid = 1234) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killSignals = [];
    child.kill = childSignal => {
        child.killSignals.push(childSignal);
        return true;
    };
    child.close = (code = null, childSignal = null) => {
        child.exitCode = code;
        child.signalCode = childSignal;
        child.emit('close', code, childSignal);
    };
    return child;
}

test('POSIX run 建立 process group，stopAll 先 TERM、寬限後 KILL 完整程序樹', async () => {
    const child = createChild(4321);
    const groupSignals = [];
    let spawnOptions;
    const manager = createProcessManager({
        platform: 'linux',
        killGraceMs: 0,
        spawnFn: (_command, _args, options) => {
            spawnOptions = options;
            return child;
        },
        killFn: (pid, childSignal) => {
            groupSignals.push([pid, childSignal]);
            if (childSignal === 'SIGKILL') queueMicrotask(() => child.close(null, 'SIGKILL'));
        }
    });

    const running = manager.run('yt-dlp', ['--version']);
    const rejected = assert.rejects(running, error => error.name === 'AbortError' && error.signal === 'SIGKILL');
    const firstStop = manager.stopAll();
    const secondStop = manager.stopAll();

    assert.equal(firstStop, secondStop);
    await firstStop;
    await rejected;
    assert.equal(spawnOptions.detached, true);
    assert.deepEqual(groupSignals, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
    assert.deepEqual(child.killSignals, []);
    await manager.stopAll();
});

test('track 的外部 child 預設只終止直接子程序並在 close 後完成', async () => {
    const child = createChild();
    child.kill = childSignal => {
        child.killSignals.push(childSignal);
        queueMicrotask(() => child.close(null, childSignal));
        return true;
    };
    const groupSignals = [];
    const manager = createProcessManager({
        platform: 'linux',
        killFn: (...args) => groupSignals.push(args)
    });

    assert.equal(manager.track(child), child);
    assert.equal(manager.track(child), child);
    await manager.stopAll();
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.deepEqual(groupSignals, []);
});

test('Windows run 不建立 process group，並保留 stdout/stderr 結果', async () => {
    const child = createChild();
    let spawnOptions;
    const manager = createProcessManager({
        platform: 'win32',
        spawnFn: (_command, _args, options) => {
            spawnOptions = options;
            queueMicrotask(() => {
                child.stdout.write('out');
                child.stderr.write('warning');
                child.close(0, null);
            });
            return child;
        }
    });

    const result = await manager.run('tool', []);
    assert.equal(spawnOptions.detached, undefined);
    assert.deepEqual(result, { code: 0, signal: null, stdout: 'out', stderr: 'warning' });
    await manager.stopAll();
});

test('根 signal 取消會停止所有程序，停止後拒絕新的 run', async () => {
    const controller = new AbortController();
    const reason = new Error('shutdown');
    const child = createChild();
    child.kill = childSignal => {
        child.killSignals.push(childSignal);
        queueMicrotask(() => child.close(null, childSignal));
        return true;
    };
    const manager = createProcessManager({
        signal: controller.signal,
        platform: 'win32',
        spawnFn: () => child
    });
    const running = manager.run('tool');
    const rejected = assert.rejects(running, error => error === reason);

    controller.abort(reason);
    await rejected;
    await manager.stopAll();
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    await assert.rejects(manager.run('later'), /shutdown/);
});

test('run timeout 終止 child 並保留 ETIMEDOUT 錯誤代碼', async () => {
    const child = createChild();
    child.kill = childSignal => {
        child.killSignals.push(childSignal);
        queueMicrotask(() => child.close(null, childSignal));
        return true;
    };
    const manager = createProcessManager({ platform: 'win32', spawnFn: () => child });

    await assert.rejects(
        manager.run('slow-tool', [], { timeout: 1 }),
        error => error.code === 'ETIMEDOUT' && error.exitCode === null && error.signal === 'SIGTERM'
    );
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    await manager.stopAll();
});

test('stdout/stderr 超過上限會終止程序樹並回傳 MAX_BUFFER', async () => {
    const child = createChild();
    child.kill = childSignal => {
        child.killSignals.push(childSignal);
        queueMicrotask(() => child.close(null, childSignal));
        return true;
    };
    const manager = createProcessManager({
        platform: 'win32',
        spawnFn: () => {
            queueMicrotask(() => child.stdout.write('12345'));
            return child;
        }
    });
    await assert.rejects(manager.run('noisy-tool', [], { maxStdoutBytes: 4 }), error => error.code === 'MAX_BUFFER');
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    await manager.stopAll();
});
