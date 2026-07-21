'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const {
    ATTEMPT_LEASE_MS,
    SIGN_RETRY_DELAYS_MS,
    createGameCheckInRepository
} = require('../util/gameCheckInRepository');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-repository-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let currentTime = Date.parse('2026-07-21T02:00:00.000Z');
    let sequence = 0;
    const json = createJsonRepository({ directory: root });
    const repository = createGameCheckInRepository(json, {
        now: () => currentTime,
        idFactory: () => `id-${++sequence}`
    });
    return {
        root,
        json,
        repository,
        now: () => currentTime,
        advance(milliseconds) { currentTime += milliseconds; }
    };
}

function result(status = 'success', retryable = false, platform = 'hoyolab') {
    return {
        platform,
        retryable,
        outcomes: [{ platform, game: platform, account: null, status, message: status }]
    };
}

test('遊戲簽到 repository 以使用者隔離憑證、採 failure-only 預設並循環通知', async t => {
    const setup = fixture(t);
    const first = await setup.repository.readUser('123456789012345678');
    assert.equal(first.notificationMode, 'failures');
    assert.equal(first.credentials.hoyolab, null);

    const added = await setup.repository.setCredential('123456789012345678', 'hoyolab', 'cookie-secret');
    assert.equal(added.changed, true);
    assert.equal(added.firstActive, true);
    assert.equal(added.record.credentials.hoyolab.format, 'plain-v1');
    assert.equal(added.record.credentials.hoyolab.revision, 1);
    assert.equal(added.record.credentials.hoyolab.value, 'cookie-secret');

    const unchanged = await setup.repository.setCredential('123456789012345678', 'hoyolab', 'cookie-secret');
    assert.equal(unchanged.changed, false);
    const secondPlatform = await setup.repository.setCredential('123456789012345678', 'skport', 'sk-secret');
    assert.equal(secondPlatform.firstActive, false);
    await setup.repository.setCredential('222222222222222222', 'hoyolab', 'other-secret');
    assert.equal((await setup.repository.readUser('222222222222222222')).credentials.skport, null);

    assert.equal((await setup.repository.cycleNotification('123456789012345678')).mode, 'off');
    assert.equal((await setup.repository.cycleNotification('123456789012345678')).mode, 'all');
    assert.equal((await setup.repository.cycleNotification('123456789012345678')).mode, 'failures');

    const cleared = await setup.repository.setCredential('123456789012345678', 'hoyolab', '');
    assert.equal(cleared.disabled, true);
    assert.equal(cleared.record.credentials.hoyolab, null);

    await setup.repository.savePanel({ channelId: 'channel-1', id: 'message-1' });
    await setup.repository.savePanel({ channelId: 'channel-1', id: 'message-1' });
    await setup.repository.savePanel({ channelId: 'channel-2', id: 'message-2' });
    assert.deepEqual(await setup.repository.listPanels(), [
        { channelID: 'channel-1', messageID: 'message-1', updatedAt: new Date(setup.now()).toISOString() },
        { channelID: 'channel-2', messageID: 'message-2', updatedAt: new Date(setup.now()).toISOString() }
    ]);
    await setup.repository.removePanel('channel-1', 'message-1');
    assert.deepEqual((await setup.repository.listPanels()).map(panel => panel.messageID), ['message-2']);
    assert.deepEqual(await setup.repository.listUserIDs(), ['123456789012345678', '222222222222222222']);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(setup.root, '123456789012345678.json')).mode & 0o777, 0o600);
    }
    await assert.rejects(() => setup.repository.setCredential('123456789012345678', 'unknown', 'x'), /不支援/);
});

test('平台 reservation single-flight、暫時失敗退避三次並在全部完成後建立 outbox', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    await setup.repository.setCredential(userID, 'hoyolab', 'cookie');
    await setup.repository.setCredential(userID, 'skport', 'token');
    const date = '2026-07-21';

    const first = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.equal(first.attempts, 1);
    assert.equal(await setup.repository.reservePlatform(userID, 'hoyolab', date), null);
    const firstFailure = await setup.repository.completePlatform(first, result('failure', true));
    assert.equal(firstFailure.retryAt, setup.now() + SIGN_RETRY_DELAYS_MS[0]);
    assert.equal((await setup.repository.listDuePlatforms(date, setup.now() - 1))
        .some(item => item.platform === 'hoyolab'), false);

    setup.advance(SIGN_RETRY_DELAYS_MS[0]);
    const second = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.equal(second.attempts, 2);
    await setup.repository.completePlatform(second, result('failure', true));
    setup.advance(SIGN_RETRY_DELAYS_MS[1]);
    const third = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.equal(third.attempts, 3);
    await setup.repository.completePlatform(third, result('failure', true));

    const skport = await setup.repository.reservePlatform(userID, 'skport', date);
    await setup.repository.completePlatform(skport, result('success', false, 'skport'));
    const outbox = await setup.repository.listDueOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].result.outcomes.length, 2);

    assert.equal((await setup.repository.prepareOutboxDelivery(userID, outbox[0].id)).id, outbox[0].id);
    const retryAt = await setup.repository.markOutboxFailed(userID, outbox[0].id);
    assert.equal(retryAt, setup.now() + 60_000);
    setup.advance(60_000);
    assert.equal((await setup.repository.listDueOutbox()).length, 1);
    await setup.repository.markOutboxFailed(userID, outbox[0].id);
    setup.advance(5 * 60_000);
    await setup.repository.markOutboxFailed(userID, outbox[0].id);
    assert.deepEqual(await setup.repository.listDueOutbox(), []);
});

test('憑證 revision 使舊結果失效，過期 lease 可恢復且通知模式會在送出前重查', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    const date = '2026-07-21';
    await setup.repository.setCredential(userID, 'hoyolab', 'old-cookie');
    const stale = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    await setup.repository.setCredential(userID, 'hoyolab', 'new-cookie');
    assert.equal((await setup.repository.completePlatform(stale, result())).accepted, false);

    const current = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    setup.advance(ATTEMPT_LEASE_MS);
    assert.equal((await setup.repository.listDuePlatforms(date, setup.now() - 1)).length, 1);
    const recovered = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.equal(recovered.attempts, 2);
    assert.notEqual(recovered.id, current.id);
    await setup.repository.completePlatform(recovered, result('failure'));
    const [outbox] = await setup.repository.listDueOutbox();
    assert.ok(outbox);

    await setup.repository.cycleNotification(userID); // failures -> off
    assert.equal(await setup.repository.prepareOutboxDelivery(userID, outbox.id), null);
    assert.deepEqual(await setup.repository.listDueOutbox(), []);
});

test('成功結果僅在 all 模式通知，清除最後憑證可完成空的當日狀態', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    const date = '2026-07-21';
    await setup.repository.setCredential(userID, 'hoyolab', 'cookie');
    const reservation = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    await setup.repository.completePlatform(reservation, result('success'));
    assert.deepEqual(await setup.repository.listDueOutbox(), []);

    await setup.repository.cycleNotification(userID); // failures -> off
    await setup.repository.cycleNotification(userID); // off -> all
    await setup.repository.setCredential(userID, 'hoyolab', 'new-cookie');
    const next = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    await setup.repository.completePlatform(next, result('success'));
    const [outbox] = await setup.repository.listDueOutbox();
    assert.ok(outbox);
    await setup.repository.markOutboxDelivered(userID, outbox.id);
    assert.deepEqual(await setup.repository.listDueOutbox(), []);

    await setup.repository.setCredential(userID, 'hoyolab', '');
    await setup.repository.finalizeReady(date);
    assert.equal((await setup.repository.readUser(userID)).daily.notificationQueued, true);
});
