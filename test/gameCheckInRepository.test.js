'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { gameIDsForPlatform } = require('../util/gameCheckInCatalog');
const {
    CREDENTIAL_FORMAT,
    GameCheckInCredentialCryptoError,
    createGameCheckInCredentialCodec
} = require('../util/gameCheckInCredentialCodec');
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
    const credentialCodec = createGameCheckInCredentialCodec('22'.repeat(32));
    const repository = createGameCheckInRepository(json, {
        now: () => currentTime,
        idFactory: () => `id-${++sequence}`,
        credentialCodec
    });
    return {
        root,
        json,
        repository,
        credentialCodec,
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
    assert.deepEqual(first.disabledGames, []);

    const added = await setup.repository.setCredential('123456789012345678', 'hoyolab', 'cookie-secret');
    assert.equal(added.changed, true);
    assert.equal(added.firstActive, true);
    assert.equal(added.record.credentials.hoyolab.format, CREDENTIAL_FORMAT);
    assert.equal(added.record.credentials.hoyolab.revision, 1);
    assert.equal(added.record.credentials.hoyolab.value, undefined);
    assert.doesNotMatch(JSON.stringify(await setup.json.read('123456789012345678')), /cookie-secret/);

    const unchanged = await setup.repository.setCredential('123456789012345678', 'hoyolab', 'cookie-secret');
    assert.equal(unchanged.changed, false);
    const secondPlatform = await setup.repository.setCredential('123456789012345678', 'skport', 'sk-secret');
    assert.equal(secondPlatform.firstActive, false);
    await setup.repository.setCredential('222222222222222222', 'hoyolab', 'other-secret');
    assert.equal((await setup.repository.readUser('222222222222222222')).credentials.skport, null);
    const reservation = await setup.repository.reservePlatform(
        '123456789012345678', 'hoyolab', '2026-07-21'
    );
    assert.equal(reservation.credential, 'cookie-secret');

    assert.equal((await setup.repository.cycleNotification('123456789012345678')).mode, 'off');
    assert.equal((await setup.repository.cycleNotification('123456789012345678')).mode, 'all');
    assert.equal((await setup.repository.cycleNotification('123456789012345678')).mode, 'failures');

    const cleared = await setup.repository.setCredential('123456789012345678', 'hoyolab', '');
    assert.equal(cleared.disabled, true);
    assert.equal(cleared.record.credentials.hoyolab, null);

    assert.deepEqual(await setup.repository.listUserIDs(), ['123456789012345678', '222222222222222222']);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(setup.root, '123456789012345678.json')).mode & 0o777, 0o600);
    }
    await assert.rejects(() => setup.repository.setCredential('123456789012345678', 'unknown', 'x'), /不支援/);
});

test('舊 plain-v1 憑證視為未設定且不會在讀取或啟動驗證時自動改寫', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    await setup.json.update(userID, () => ({
        credentials: {
            hoyolab: {
                format: 'plain-v1', value: 'legacy-cookie', revision: 1,
                updatedAt: '2026-07-21T00:00:00.000Z'
            },
            skport: null
        }
    }));

    assert.equal((await setup.repository.readUser(userID)).credentials.hoyolab, null);
    assert.equal(await setup.repository.validateStoredCredentials(), true);
    assert.equal((await setup.json.read(userID)).credentials.hoyolab.value, 'legacy-cookie');
    assert.deepEqual(await setup.repository.listDuePlatforms('2026-07-21', setup.now() - 1), []);
});

test('啟動驗證拒絕錯誤金鑰、損壞 envelope，且錯誤不包含金鑰、密文或明文', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    await setup.repository.setCredential(userID, 'hoyolab', 'private-cookie');
    assert.equal(await setup.repository.validateStoredCredentials(), true);

    const wrongKey = createGameCheckInRepository(setup.json, {
        credentialCodec: createGameCheckInCredentialCodec('33'.repeat(32))
    });
    await assert.rejects(() => wrongKey.validateStoredCredentials(), error => {
        assert.ok(error instanceof GameCheckInCredentialCryptoError);
        assert.match(error.message, new RegExp(`${userID}.*hoyolab`));
        assert.doesNotMatch(error.message, /private-cookie|22{10}|33{10}/);
        return true;
    });

    const encrypted = (await setup.json.read(userID)).credentials.hoyolab;
    await setup.json.update(userID, current => ({
        ...current,
        credentials: {
            ...current.credentials,
            hoyolab: { ...encrypted, authTag: '' }
        }
    }));
    await assert.rejects(() => setup.repository.validateStoredCredentials(), error => {
        assert.ok(error instanceof GameCheckInCredentialCryptoError);
        assert.doesNotMatch(error.message, new RegExp(encrypted.ciphertext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
    });
});

test('repository 缺少憑證 codec 時拒絕建立', async t => {
    const setup = fixture(t);
    assert.throws(() => createGameCheckInRepository(setup.json), /缺少憑證加解密 codec/);
});

test('主面板 repository 每個 Guild 或 DM scope 僅保留最新 locator 並可收斂舊格式', async t => {
    const setup = fixture(t);
    const guildOne = { type: 'guild', id: 'guild-1' };
    const guildTwo = { type: 'guild', id: 'guild-2' };
    const dm = { type: 'dm', id: 'dm-channel' };
    const first = await setup.repository.savePanel(guildOne, { channelId: 'channel-1', id: 'message-1' });
    assert.deepEqual(first.replaced, []);
    const replacement = await setup.repository.savePanel(guildOne, {
        channelId: 'channel-2', id: 'message-2'
    });
    assert.deepEqual(replacement.replaced.map(panel => panel.messageID), ['message-1']);
    await setup.repository.savePanel(guildTwo, { channelId: 'channel-3', id: 'message-3' });
    await setup.repository.savePanel(dm, { channelId: 'dm-channel', id: 'dm-message-1' });
    const dmReplacement = await setup.repository.savePanel(dm, {
        channelId: 'dm-channel', id: 'dm-message-2'
    });
    assert.deepEqual(dmReplacement.replaced.map(panel => panel.messageID), ['dm-message-1']);
    assert.deepEqual((await setup.repository.listPanels()).map(panel => [
        panel.scopeType, panel.scopeID, panel.messageID
    ]), [
        ['guild', 'guild-1', 'message-2'],
        ['guild', 'guild-2', 'message-3'],
        ['dm', 'dm-channel', 'dm-message-2']
    ]);
    assert.equal(await setup.repository.isCurrentPanel(guildOne, 'message-1'), false);
    assert.equal(await setup.repository.isCurrentPanel(guildOne, 'message-2'), true);

    await setup.json.update('panels', current => ({
        panels: [
            ...current.panels,
            {
                channelID: 'legacy-channel-1', messageID: 'legacy-message-1',
                updatedAt: '2026-07-20T00:00:00.000Z'
            },
            {
                channelID: 'legacy-channel-2', messageID: 'legacy-message-2',
                updatedAt: '2026-07-21T00:00:00.000Z'
            }
        ]
    }));
    const legacyScope = { type: 'guild', id: 'legacy-guild' };
    assert.equal((await setup.repository.claimPanelScope(
        'legacy-channel-1', 'legacy-message-1', legacyScope
    )).tracked, true);
    const claimed = await setup.repository.claimPanelScope(
        'legacy-channel-2', 'legacy-message-2', legacyScope
    );
    assert.equal(claimed.tracked, true);
    assert.deepEqual(claimed.replaced.map(panel => panel.messageID), ['legacy-message-1']);
    assert.equal(await setup.repository.isCurrentPanel(legacyScope, 'legacy-message-1'), false);
    assert.equal(await setup.repository.isCurrentPanel(legacyScope, 'legacy-message-2'), true);

    await setup.repository.removePanel('legacy-channel-2', 'legacy-message-2');
    assert.equal(await setup.repository.isCurrentPanel(legacyScope, 'legacy-message-2'), false);
    await assert.rejects(
        () => setup.repository.savePanel({ type: 'unknown', id: 'x' }, { channelId: 'c', id: 'm' }),
        /scope/
    );
});

test('單一遊戲偏好會隔離使用者、忽略未知 ID，且憑證更新與清除皆保留設定', async t => {
    const setup = fixture(t);
    const firstUser = '123456789012345678';
    const secondUser = '222222222222222222';

    const disabled = await setup.repository.toggleGame(firstUser, 'hoyolab:genshin');
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.record.disabledGames, ['hoyolab:genshin']);
    assert.deepEqual((await setup.repository.readUser(secondUser)).disabledGames, []);

    await setup.repository.setCredential(firstUser, 'hoyolab', 'first-cookie');
    await setup.repository.setCredential(firstUser, 'hoyolab', 'second-cookie');
    await setup.repository.setCredential(firstUser, 'hoyolab', '');
    assert.deepEqual((await setup.repository.readUser(firstUser)).disabledGames, ['hoyolab:genshin']);

    await setup.json.update(firstUser, current => ({
        ...current,
        disabledGames: ['unknown:future', 'skport:endfield', 'skport:endfield']
    }));
    assert.deepEqual((await setup.repository.readUser(firstUser)).disabledGames, ['skport:endfield']);
    await assert.rejects(() => setup.repository.toggleGame(firstUser, 'unknown:future'), /不支援/);
});

test('reservation 固定當日遊戲快照，重試與舊資料沿用快照，隔日才採用新設定', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    const date = '2026-07-21';
    await setup.repository.setCredential(userID, 'hoyolab', 'cookie');
    await setup.repository.toggleGame(userID, 'hoyolab:starRail');

    const first = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.deepEqual(first.gameIDs, gameIDsForPlatform('hoyolab').filter(id => id !== 'hoyolab:starRail'));
    await setup.repository.toggleGame(userID, 'hoyolab:starRail');
    await setup.repository.toggleGame(userID, 'hoyolab:genshin');
    await setup.repository.completePlatform(first, result('failure', true));
    setup.advance(SIGN_RETRY_DELAYS_MS[0]);
    const retry = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.deepEqual(retry.gameIDs, first.gameIDs);
    await setup.repository.completePlatform(retry, result('success'));

    const nextDay = await setup.repository.reservePlatform(userID, 'hoyolab', '2026-07-22');
    assert.deepEqual(nextDay.gameIDs, gameIDsForPlatform('hoyolab').filter(id => id !== 'hoyolab:genshin'));

    await setup.json.update(userID, current => ({
        ...current,
        disabledGames: gameIDsForPlatform('hoyolab'),
        daily: {
            date: '2026-07-23', generation: 1, notificationQueued: false,
            platforms: {
                hoyolab: {
                    status: 'running', reservationID: 'legacy', credentialRevision: 1,
                    attempts: 1, leaseExpiresAt: new Date(setup.now() - 1).toISOString()
                }
            }
        }
    }));
    const legacyRetry = await setup.repository.reservePlatform(userID, 'hoyolab', '2026-07-23');
    assert.deepEqual(legacyRetry.gameIDs, gameIDsForPlatform('hoyolab'));
});

test('全部遊戲停用時不建立 reservation 或空白通知', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    const date = '2026-07-21';
    await setup.repository.setCredential(userID, 'hoyolab', 'cookie');
    await setup.repository.cycleNotification(userID); // failures -> off
    await setup.repository.cycleNotification(userID); // off -> all
    for (const gameID of gameIDsForPlatform('hoyolab')) {
        await setup.repository.toggleGame(userID, gameID);
    }

    assert.deepEqual(await setup.repository.listDuePlatforms(date, setup.now() - 1), []);
    assert.equal(await setup.repository.reservePlatform(userID, 'hoyolab', date), null);
    assert.equal(await setup.repository.earliestPending(date), null);
    await setup.repository.finalizeReady(date);
    assert.deepEqual(await setup.repository.listDueOutbox(), []);
    assert.equal((await setup.repository.readUser(userID)).credentials.hoyolab.format, CREDENTIAL_FORMAT);
});

test('當日尚未開始的平台採用最新開關，已開始的平台維持原快照', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    const date = '2026-07-21';
    await setup.repository.setCredential(userID, 'hoyolab', 'cookie');
    await setup.repository.setCredential(userID, 'skport', 'token');
    const hoyolab = await setup.repository.reservePlatform(userID, 'hoyolab', date);

    for (const gameID of gameIDsForPlatform('skport')) {
        await setup.repository.toggleGame(userID, gameID);
    }
    assert.deepEqual(await setup.repository.listDuePlatforms(date, setup.now() - 1), []);

    await setup.repository.toggleGame(userID, 'skport:endfield');
    assert.deepEqual(await setup.repository.listDuePlatforms(date, setup.now() - 1), [
        { userID, platform: 'skport' }
    ]);
    const skport = await setup.repository.reservePlatform(userID, 'skport', date);
    assert.deepEqual(skport.gameIDs, ['skport:endfield']);

    for (const gameID of hoyolab.gameIDs) {
        if (!(await setup.repository.readUser(userID)).disabledGames.includes(gameID)) {
            await setup.repository.toggleGame(userID, gameID);
        }
    }
    setup.advance(ATTEMPT_LEASE_MS);
    const due = await setup.repository.listDuePlatforms(date, setup.now() - 1);
    assert.equal(due.some(item => item.platform === 'hoyolab'), true);
    const recovered = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    assert.deepEqual(recovered.gameIDs, hoyolab.gameIDs);
});

test('重新啟用當日尚未開始的平台會撤回待送彙總，完成後再建立完整通知', async t => {
    const setup = fixture(t);
    const userID = '123456789012345678';
    const date = '2026-07-21';
    await setup.repository.setCredential(userID, 'hoyolab', 'cookie');
    await setup.repository.setCredential(userID, 'skport', 'token');
    await setup.repository.cycleNotification(userID); // failures -> off
    await setup.repository.cycleNotification(userID); // off -> all
    for (const gameID of gameIDsForPlatform('skport')) {
        await setup.repository.toggleGame(userID, gameID);
    }

    const hoyolab = await setup.repository.reservePlatform(userID, 'hoyolab', date);
    await setup.repository.completePlatform(hoyolab, result('success'));
    assert.equal((await setup.repository.listDueOutbox()).length, 1);

    await setup.repository.toggleGame(userID, 'skport:endfield', { date });
    assert.deepEqual(await setup.repository.listDueOutbox(), []);
    const skport = await setup.repository.reservePlatform(userID, 'skport', date);
    await setup.repository.completePlatform(skport, result('success', false, 'skport'));
    const [outbox] = await setup.repository.listDueOutbox();
    assert.deepEqual(outbox.result.outcomes.map(item => item.platform), ['hoyolab', 'skport']);
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
