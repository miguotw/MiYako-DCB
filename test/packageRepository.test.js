'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { createPackageTrackingRepository } = require('../util/packageTrackingRepository');
const { createPackageSessionManager } = require('../util/packageSessionManager');
const { createInitializer } = require('../src/modules/event/package_tracking');
const { loadConfig } = require('../core/config');

function repositoryFixture(limit = 20) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-package-repository-'));
    const json = createJsonRepository({ directory: path.join(root, 'packages'), schemaVersion: 1 });
    return { root, json, repository: createPackageTrackingRepository(json, { maxActivePackages: limit }) };
}

test('active 與 reservation 共用可設定上限，並行新增不得超額', async t => {
    const { root, repository } = repositoryFixture(2);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerID = '12345678901234567';
    const outcomes = await Promise.allSettled([1, 2, 3].map(index => repository.reserveImport(ownerID, {
        carrierID: `carrier-${index}`, trackingNumber: `tracking-${index}`
    })));
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 2);
    assert.equal(outcomes.filter(item => item.reason?.code === 'PACKAGE_ACTIVE_LIMIT').length, 1);
});

test('降低 active 上限不改動舊資料，但禁止新增與喚醒直到低於上限', async t => {
    const { root, json, repository } = repositoryFixture(2);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerID = '12345678901234567';
    for (const index of [1, 2]) {
        const reservation = await repository.reserveImport(ownerID, {
            carrierID: `c${index}`, trackingNumber: `n${index}`
        });
        await repository.commitImport(ownerID, reservation.id, {
            userID: ownerID, userPackageID: `p${index}`, carrierID: `c${index}`,
            trackingNumber: `n${index}`, status: 'active'
        });
    }
    const lowered = createPackageTrackingRepository(json, { maxActivePackages: 1 });
    assert.equal((await lowered.listPackages({ ownerID, status: 'active' })).length, 2);
    await assert.rejects(lowered.reserveImport(ownerID, { carrierID: 'd', trackingNumber: 'm' }),
        error => error.code === 'PACKAGE_ACTIVE_LIMIT');
    await lowered.updatePackage(ownerID, 'p1', { status: 'archived' });
    await assert.rejects(lowered.reserveWake(ownerID, 'p1'), error => error.code === 'PACKAGE_ACTIVE_LIMIT');
    await lowered.updatePackage(ownerID, 'p2', { status: 'archived' });
    await assert.doesNotReject(lowered.reserveImport(ownerID, { carrierID: 'd', trackingNumber: 'm' }));
    assert.equal((await lowered.listPackages({ ownerID })).length, 2);
});

test('相同包裹的並行匯入 reservation 只有一筆能成立', async t => {
    const { root, repository } = repositoryFixture(20);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerID = '12345678901234567';
    const outcomes = await Promise.allSettled([
        repository.reserveImport(ownerID, { carrierID: 'same', trackingNumber: 'same' }),
        repository.reserveImport(ownerID, { carrierID: 'same', trackingNumber: 'SAME' })
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.reason?.code === 'PACKAGE_DUPLICATE').length, 1);
});

test('outbox 只有 delivered 後才提交 signature 與新 locator', async t => {
    const { root, repository } = repositoryFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerID = '12345678901234567';
    const reservation = await repository.reserveImport(ownerID, { carrierID: 'c', trackingNumber: 'n' });
    await repository.commitImport(ownerID, reservation.id, {
        userID: ownerID, userPackageID: 'p1', carrierID: 'c', trackingNumber: 'n', status: 'active',
        lastHistorySignature: 'old', lastNotificationChannelID: 'old-channel', lastNotificationMessageID: 'old-message'
    });
    const item = await repository.stageNotification(ownerID, 'p1', { signature: 'new', packageData: { status: 'new' } });
    assert.equal((await repository.getPackage(ownerID, 'p1')).lastHistorySignature, 'old');
    await repository.markOutboxFailed(ownerID, item.id);
    assert.equal((await repository.getPackage(ownerID, 'p1')).lastHistorySignature, 'old');
    const previous = await repository.markOutboxDelivered(ownerID, item.id, { channelID: 'new-channel', messageID: 'new-message' });
    assert.deepEqual(previous, { channelID: 'old-channel', messageID: 'old-message' });
    assert.equal((await repository.getPackage(ownerID, 'p1')).lastHistorySignature, 'new');
});

test('outbox 傳送期間出現更新貨態時不會把舊貨態誤標為 delivered', async t => {
    const { root, repository } = repositoryFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerID = '12345678901234567';
    const reservation = await repository.reserveImport(ownerID, { carrierID: 'c', trackingNumber: 'n' });
    await repository.commitImport(ownerID, reservation.id, {
        userID: ownerID, userPackageID: 'p1', carrierID: 'c', trackingNumber: 'n', status: 'active',
        lastHistorySignature: 'old'
    });
    const sending = await repository.stageNotification(ownerID, 'p1', {
        signature: 'first', packageData: { status: 'first' }
    });
    await repository.stageNotification(ownerID, 'p1', {
        signature: 'latest', packageData: { status: 'latest' }
    });
    const delivered = await repository.markOutboxDelivered(ownerID, sending.id, {
        channelID: 'new-channel', messageID: 'new-message'
    }, sending.signature);
    assert.equal(delivered, false);
    assert.equal((await repository.getPackage(ownerID, 'p1')).lastHistorySignature, 'old');
    const due = await repository.listDueOutbox(Date.now() + 3_600_000);
    assert.equal(due[0].signature, 'latest');
});

test('物流 session 驗證 TTL、guild/message 綁定與每 user 容量', () => {
    let now = 0;
    const manager = createPackageSessionManager({ ttlMs: 100, maxPerUser: 2, clock: { now: () => now } });
    const binding = { userID: 'u', guildID: 'g', messageID: 'm' };
    const first = manager.create({ ...binding, data: { value: 1 } });
    assert.equal(manager.get(first.id, binding).data.value, 1);
    assert.equal(manager.get(first.id, { ...binding, guildID: 'other' }), null);
    assert.equal(manager.get(first.id, { ...binding, messageID: 'other' }), null);
    manager.create({ ...binding, data: {} });
    assert.throws(() => manager.create({ ...binding, data: {} }), /最多/);
    now = 101;
    assert.equal(manager.get(first.id, binding), null);
});

test('新物流通知失敗時舊通知仍存在且 delivered signature 不前進', async t => {
    const { root, repository } = repositoryFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownerID = '12345678901234567';
    const reservation = await repository.reserveImport(ownerID, { carrierID: 'c', trackingNumber: 'n' });
    await repository.commitImport(ownerID, reservation.id, {
        userID: ownerID, userPackageID: 'p1', carrierID: 'c', carrierName: 'carrier',
        trackingNumber: 'n', status: 'active', channelID: 'target',
        lastHistorySignature: 'old', lastNotificationChannelID: 'old-channel', lastNotificationMessageID: 'old-message'
    });
    await repository.stageNotification(ownerID, 'p1', { signature: 'new', packageData: { data: [] } });
    let oldDeletes = 0;
    const client = {
        channels: {
            fetch: async channelID => channelID === 'target'
                ? { send: async () => { throw new Error('send failed'); } }
                : { messages: { fetch: async () => ({ delete: async () => { oldDeletes += 1; } }) } }
        },
        users: { fetch: async () => null }
    };
    const initializer = createInitializer(loadConfig(), { logTools: { sendLog() {} } });
    await assert.rejects(initializer._test.processOutbox(client, repository, new AbortController().signal), AggregateError);
    assert.equal(oldDeletes, 0);
    assert.equal((await repository.getPackage(ownerID, 'p1')).lastHistorySignature, 'old');
});
