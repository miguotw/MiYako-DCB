const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 讓 Store 將測試資料寫到獨立暫存目錄，不碰觸正式 assets 資料。
const originalCwd = process.cwd();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-store-refactor-'));
process.chdir(temporaryRoot);
const temporaryVoiceStore = require('../util/temporaryVoiceStore');
const twitchStreamStore = require('../util/twitchStreamStore');
process.chdir(originalCwd);

test.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

test('臨時語音 Store 遷移後仍可建立、更新與列舉 Guild 資料', () => {
    const guildID = '12345678901234567';
    temporaryVoiceStore.setEntrance(guildID, '23456789012345678', '臨時');
    temporaryVoiceStore.addManagedChannel(guildID, '34567890123456789', {
        entranceChannelID: '23456789012345678', ownerID: '45678901234567890'
    });
    assert.equal(temporaryVoiceStore.loadGuildStore(guildID).entrances['23456789012345678'].prefix, '臨時');
    assert.deepEqual(temporaryVoiceStore.listStoredGuildIDs(), [guildID]);
});

test('Twitch Store 部分更新不會清除另一類既有資料', () => {
    const guildID = '56789012345678901';
    twitchStreamStore.writeGuildStore(guildID, {
        subscriptions: [{ twitchUserLogin: 'example' }],
        notifications: [{ messageID: '1' }]
    });
    twitchStreamStore.writeGuildStore(guildID, { subscriptions: [{ twitchUserLogin: 'updated' }] });
    const stored = twitchStreamStore.readGuildStore(guildID);
    assert.equal(stored.subscriptions[0].twitchUserLogin, 'updated');
    assert.equal(stored.notifications[0].messageID, '1');
});
