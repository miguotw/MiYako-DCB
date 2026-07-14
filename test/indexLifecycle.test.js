'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { main } = require('../index');

function processFixture() {
    const processApi = new EventEmitter();
    processApi.exitCode = undefined;
    processApi.exits = [];
    processApi.exit = code => processApi.exits.push(code);
    return processApi;
}

test('main 使用同一 shutdown 處理 SIGINT 並在完成後移除 signal listeners', async () => {
    const processApi = processFixture();
    const reasons = [];
    const runtime = {
        start: async () => {},
        shutdown: async reason => { reasons.push(reason); }
    };
    assert.equal(await main({ runtime, processApi }), runtime);
    processApi.emit('SIGINT');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(reasons[0].message, /SIGINT/);
    assert.equal(processApi.exitCode, 0);
    assert.equal(processApi.listenerCount('SIGINT'), 0);
    assert.deepEqual(processApi.exits, []);
});

test('第二次 signal 立即標記失敗，shutdown rejection 交由注入的 force exit', async () => {
    const processApi = processFixture();
    let rejectShutdown;
    const shutdown = new Promise((_, reject) => { rejectShutdown = reject; });
    const forced = [];
    const runtime = { start: async () => {}, shutdown: () => shutdown };
    await main({ runtime, processApi, forceExitFn: error => forced.push(error) });
    processApi.emit('SIGTERM');
    processApi.emit('SIGINT');
    assert.deepEqual(processApi.exits, [1]);
    const failure = new Error('shutdown failed');
    rejectShutdown(failure);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(forced, [failure]);
});
