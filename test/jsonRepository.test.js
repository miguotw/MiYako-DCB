'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RepositoryBlockedError, createJsonRepository } = require('../core/jsonRepository');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-json-repository-'));
    return { root, repository: createJsonRepository({ directory: path.join(root, 'data'), schemaVersion: 1 }) };
}

test('JSON repository 並行 update 不遺失且使用 envelope 與安全權限', async t => {
    const { root, repository } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await Promise.all(Array.from({ length: 100 }, () => repository.update('counter', current => ({
        count: Number(current?.count || 0) + 1
    }))));
    assert.deepEqual(await repository.read('counter'), { count: 100 });

    const file = path.join(root, 'data', 'counter.json');
    const envelope = JSON.parse(await fsp.readFile(file, 'utf8'));
    assert.equal(envelope.schemaVersion, 1);
    assert.equal(envelope.data.count, 100);
    assert.ok(Number.isFinite(Date.parse(envelope.updatedAt)));
    if (process.platform !== 'win32') {
        assert.equal((await fsp.stat(path.dirname(file))).mode & 0o777, 0o700);
        assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    }
});

test('原子替換期間所有 read 都只能看到完整 envelope', async t => {
    const { root, repository } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await repository.write('state', { version: 0, payload: 'x'.repeat(4096) });
    const writes = Array.from({ length: 30 }, (_, version) =>
        repository.write('state', { version: version + 1, payload: 'x'.repeat(4096) }));
    const reads = Array.from({ length: 100 }, () => repository.read('state'));
    const results = await Promise.all([...writes, ...reads]);
    for (const value of results.slice(writes.length)) {
        assert.equal(typeof value.version, 'number');
        assert.equal(value.payload.length, 4096);
    }
    assert.equal((await repository.read('state')).version, 30);
});

test('壞檔先 blocked 再 quarantine，禁止 read/write/update 覆寫', async t => {
    const { root, repository } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, 'data');
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(directory, 'broken.json'), '{not-json', { mode: 0o600 });

    await assert.rejects(repository.read('broken'), RepositoryBlockedError);
    await assert.rejects(repository.write('broken', { replaced: true }), RepositoryBlockedError);
    await assert.rejects(repository.update('broken', () => ({ replaced: true })), RepositoryBlockedError);
    assert.ok((await repository.listKeys()).includes('broken'));
    assert.ok(fs.existsSync(path.join(directory, '.blocked', 'broken.json')));
    assert.equal((await fsp.readdir(path.join(directory, '.quarantine'))).length, 1);
    assert.equal(fs.existsSync(path.join(directory, 'broken.json')), false);
});

test('repository 拒絕路徑穿越與非同步 updater', async t => {
    const { root, repository } = fixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    await assert.rejects(repository.read('../secret'), /安全/);
    await assert.rejects(repository.update('valid', async () => ({ value: 1 })), /同步函式/);
    await assert.rejects(repository.write('valid', undefined), /序列化/);
    await assert.rejects(repository.update('valid', () => undefined), /序列化/);
    await repository.write('stable', { value: 'before' });
    await assert.rejects(repository.update('stable', () => { throw new Error('updater failed'); }), /updater failed/);
    assert.deepEqual(await repository.read('stable'), { value: 'before' });
    assert.equal(await repository.read('missing'), null);
});
