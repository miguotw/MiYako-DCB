'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { createStoreRegistry } = require('../core/storeRegistry');
const { PROJECT_ROOT } = require('../core/config');
const { createTemporaryVoiceRepository } = require('../util/temporaryVoiceRepository');
const { createTwitchStreamRepository } = require('../util/twitchStreamRepository');

test('臨時語音 repository 可建立、更新與列舉 Guild 資料', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-store-refactor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const json = createJsonRepository({ directory: path.join(root, 'voice') });
    const repository = createTemporaryVoiceRepository(json);
    await repository.setEntrance('12345678901234567', '23456789012345678', '臨時');
    await repository.addChannel('12345678901234567', '34567890123456789', {
        entranceChannelID: '23456789012345678', ownerID: '45678901234567890'
    });
    assert.equal((await repository.readGuild('12345678901234567')).entrances['23456789012345678'].prefix, '臨時');
    assert.deepEqual(await repository.listGuildIDs(), ['12345678901234567']);
});

test('Twitch repository 部分更新不會清除通知資料', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-twitch-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = createTwitchStreamRepository(createJsonRepository({ directory: path.join(root, 'twitch') }));
    await repository.writeGuild('56789012345678901', {
        subscriptions: [{ twitchUserLogin: 'example' }], notifications: [{ messageID: '1' }]
    });
    await repository.updateGuild('56789012345678901', store => {
        store.subscriptions = [{ twitchUserLogin: 'updated' }];
    });
    const stored = await repository.readGuild('56789012345678901');
    assert.equal(stored.subscriptions[0].twitchUserLogin, 'updated');
    assert.equal(stored.notifications[0].messageID, '1');
});

test('非專案 CWD 仍使用專案根目錄下的固定 runtime 路徑', t => {
    const previous = process.cwd();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-other-cwd-'));
    t.after(() => {
        process.chdir(previous);
        fs.rmSync(elsewhere, { recursive: true, force: true });
    });
    process.chdir(elsewhere);
    const store = createStoreRegistry();
    assert.equal(store.packageTracking.directory,
        path.join(PROJECT_ROOT, 'runtime', 'data', 'package-tracking'));
    assert.equal(store.musicQueue.directory,
        path.join(PROJECT_ROOT, 'runtime', 'data', 'music', 'queues'));
});
