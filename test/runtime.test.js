'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Events } = require('discord.js');
const { loadConfig } = require('../core/config');

let activeEvents = null;
const musicPlayerPath = require.resolve('../util/musicPlayer');
require.cache[musicPlayerPath] = {
    id: musicPlayerPath,
    filename: musicPlayerPath,
    loaded: true,
    exports: {
        snapshotAllGuildStates() { activeEvents?.push('snapshot'); },
        shutdownAllPlayers() { activeEvents?.push('players'); }
    }
};

const { createRuntime } = require('../core/runtime');
const { forceExit } = require('../index');

function createConfig() {
    const config = structuredClone(loadConfig());
    config.startup.token = 'fixture-token';
    config.startup.clientId = '12345678901234567';
    config.startup.adminCommandName = '管理';
    return config;
}

function createManifest(name, { start, stop } = {}) {
    return {
        name,
        enabled: true,
        intents: [],
        commands: [],
        interactions: [],
        start: start || (async () => {}),
        stop: stop || (async () => {})
    };
}

class FakeClient extends EventEmitter {
    constructor(events) {
        super();
        this.events = events;
        this.ready = false;
        this.user = { tag: 'fixture#0001' };
        this.guilds = { cache: new Map() };
        this.destroyed = false;
    }

    isReady() {
        return this.ready;
    }

    async login(token) {
        this.events.push(`login:${token}`);
        queueMicrotask(() => {
            this.ready = true;
            this.emit(Events.ClientReady, this);
        });
        return token;
    }

    destroy() {
        this.destroyed = true;
        this.events.push('client');
    }
}

function createHarness(manifests, events = [], overrides = {}) {
    activeEvents = events;
    let rootSignal;
    const client = new FakeClient(events);
    const runtime = createRuntime({
        config: createConfig(),
        manifests,
        clientFactory: () => client,
        logger: {
            attachClient() {},
            info() {},
            error() {}
        },
        httpFactory: ({ signal }) => {
            rootSignal = signal;
            signal.addEventListener('abort', () => events.push('abort'), { once: true });
            return { async request() {} };
        },
        schedulerFactory: overrides.schedulerFactory || (() => ({
            async stop() { events.push('scheduler'); }
        })),
        processManagerFactory: overrides.processManagerFactory || (() => ({
            async stopAll() { events.push('process'); }
        })),
        storeFactory: () => Object.freeze({}),
        readyTimeoutMs: 100,
        shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 100
    });
    return { runtime, client, events, get rootSignal() { return rootSignal; } };
}

test('runtime 建構不登入，start 等待 fake Client ready 後依序啟動 features', async () => {
    const events = [];
    let receivedContext;
    const manifests = [createManifest('feature', {
        async start(context) {
            receivedContext = context;
            events.push('start:feature');
        },
        async stop() { events.push('stop:feature'); }
    })];
    const harness = createHarness(manifests, events);

    assert.deepEqual(events, []);
    const context = await harness.runtime.start();
    assert.equal(context, harness.runtime.context);
    assert.equal(receivedContext.client, harness.client);
    assert.equal(receivedContext.signal, harness.rootSignal);
    assert.deepEqual(events, ['login:fixture-token', 'start:feature']);
    assert.equal(harness.runtime.started, true);

    await harness.runtime.shutdown();
    assert.equal(harness.client.destroyed, true);
});

test('feature 啟動失敗時反向 rollback 已成功啟動的 features 並關閉 Client', async () => {
    const events = [];
    const manifests = [
        createManifest('first', {
            async start() { events.push('start:first'); },
            async stop() { events.push('stop:first'); }
        }),
        createManifest('second', {
            async start() { events.push('start:second'); },
            async stop() { events.push('stop:second'); }
        }),
        createManifest('failure', {
            async start() {
                events.push('start:failure');
                throw new Error('feature failed');
            },
            async stop() { events.push('stop:failure'); }
        })
    ];
    const harness = createHarness(manifests, events);

    await assert.rejects(harness.runtime.start(), /feature failed/);
    assert.deepEqual(
        events.filter(event => event.startsWith('start:') || event.startsWith('stop:')),
        ['start:first', 'start:second', 'start:failure', 'stop:second', 'stop:first']
    );
    assert.equal(events.includes('stop:failure'), false);
    assert.equal(harness.runtime.started, false);
    assert.equal(harness.client.destroyed, true);
});

test('shutdown 冪等，並依 router、abort、scheduler、process、snapshot、feature、client 順序執行', async () => {
    const events = [];
    const manifests = [
        createManifest('first', { async stop() { events.push('stop:first'); } }),
        createManifest('second', { async stop() { events.push('stop:second'); } })
    ];
    const harness = createHarness(manifests, events);
    await harness.runtime.start();
    events.length = 0;

    const originalClose = harness.runtime.context.router.close;
    harness.runtime.context.router.close = () => {
        events.push('router');
        originalClose();
    };

    const firstShutdown = harness.runtime.shutdown(new Error('test shutdown'));
    const secondShutdown = harness.runtime.shutdown(new Error('ignored duplicate'));
    assert.equal(firstShutdown, secondShutdown);
    await firstShutdown;

    assert.deepEqual(events, [
        'router',
        'abort',
        'scheduler',
        'process',
        'snapshot',
        'stop:second',
        'stop:first',
        'players',
        'client'
    ]);
    assert.equal(harness.runtime.context.router.accepting, false);
    await harness.runtime.shutdown();
    assert.equal(events.filter(event => event === 'client').length, 1);
});

test('runtime 與 index import 不包含 Slash Commands REST PUT', () => {
    for (const relativePath of ['../core/runtime.js', '../index.js']) {
        const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
        assert.doesNotMatch(source, /\bREST\b|\bRoutes\b|\.put\s*\(/, relativePath);
    }
});

test('任一 shutdown phase 失敗仍會完成後續清理並回報 aggregate error', async () => {
    const events = [];
    const manifests = [createManifest('feature', { async stop() { events.push('stop:feature'); } })];
    const harness = createHarness(manifests, events, {
        schedulerFactory: () => ({
            async stop() {
                events.push('scheduler');
                throw new Error('scheduler failed');
            }
        })
    });
    await harness.runtime.start();
    events.length = 0;

    await assert.rejects(harness.runtime.shutdown(), /Graceful shutdown 有階段失敗/);
    assert.deepEqual(events, [
        'abort', 'scheduler', 'process', 'snapshot', 'stop:feature', 'players', 'client'
    ]);
    assert.equal(harness.client.destroyed, true);
});

test('feature start 與 shutdown 競態會等待啟動收尾、停止該 feature 並拒絕 start', async () => {
    let releaseStart;
    const entered = new Promise(resolve => { releaseStart = resolve; });
    let allowFinish;
    const finish = new Promise(resolve => { allowFinish = resolve; });
    const events = [];
    const feature = createManifest('slow', {
        async start() {
            events.push('start:slow');
            releaseStart();
            await finish;
        },
        async stop() { events.push('stop:slow'); }
    });
    const harness = createHarness([feature], events);
    const starting = harness.runtime.start();
    await entered;
    const reason = new Error('concurrent shutdown');
    const shuttingDown = harness.runtime.shutdown(reason);
    allowFinish();

    await assert.rejects(starting, error => error === reason);
    await shuttingDown;
    assert.equal(harness.runtime.started, false);
    assert.equal(events.filter(event => event === 'stop:slow').length, 1);
    assert.equal(harness.client.destroyed, true);
});

test('runtime 不將 HTTP root signal 傳給 scheduler/process manager，避免平行關閉', () => {
    let schedulerOptions;
    let processOptions;
    const harness = createHarness([], [], {
        schedulerFactory: options => {
            schedulerOptions = options;
            return { async stop() {} };
        },
        processManagerFactory: options => {
            processOptions = options;
            return { async stopAll() {} };
        }
    });
    assert.equal(schedulerOptions.signal, undefined);
    assert.equal(processOptions?.signal, undefined);
    return harness.runtime.shutdown();
});

test('graceful shutdown 超過總期限會拒絕，entrypoint 會強制失敗退出', async () => {
    const harness = createHarness([], [], {
        shutdownTimeoutMs: 5,
        schedulerFactory: () => ({ stop: () => new Promise(() => {}) })
    });
    await assert.rejects(harness.runtime.shutdown(), /Graceful shutdown 超過 5 毫秒/);
    const source = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
    assert.match(source, /main\(\)\.catch\(error => forceExit\(error\)\)/);
});

test('shutdown 已開始後 start 會在 attach/login 前直接拒絕', async () => {
    const events = [];
    const harness = createHarness([], events);
    const reason = new Error('stopped before start');
    await harness.runtime.shutdown(reason);

    await assert.rejects(harness.runtime.start(), error => error === reason);
    assert.equal(events.some(event => event.startsWith('login:')), false);
    assert.equal(harness.client.listenerCount(Events.InteractionCreate), 0);
    assert.equal(harness.runtime.context.router.accepting, false);
});

test('啟動 rollback timeout 到達 top-level catch 時會要求立即 exit(1)', () => {
    const previousExitCode = process.exitCode;
    let exitCode;
    let logged;
    const error = new Error('startup rollback timeout');
    try {
        forceExit(error, {
            exit(code) { exitCode = code; },
            log(value) { logged = value; }
        });
        assert.equal(exitCode, 1);
        assert.equal(logged, error);
        assert.equal(process.exitCode, 1);
    } finally {
        process.exitCode = previousExitCode;
    }
});
