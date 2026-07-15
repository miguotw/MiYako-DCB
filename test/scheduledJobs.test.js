'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../core/config');
const { createInitializer } = require('../src/modules/event/package_tracking');
const { createTwitchStreamFeature } = require('../src/modules/event/twitch_stream');

test('物流週期工作會將系統性 API 失敗傳回 scheduler 以啟動退避', async () => {
    const apiError = new Error('Track.TW unavailable');
    let descriptor;
    const initializer = createInitializer(loadConfig(), {
        logTools: { sendLog() {} },
        packageTools: {
            getPackageTrackingConfig: () => ({ checkInterval: 60000, archiveAfter: 86400000 }),
            hasTrackTwToken: () => true,
            getPackageRecords: () => [{
                userID: '12345678901234567',
                userPackageID: 'package-1',
                trackingNumber: 'secret-tracking',
                status: 'active'
            }],
            trackingPackage: async () => { throw apiError; }
        }
    });
    initializer({}, {
        scheduler: {
            register(value) {
                descriptor = value;
                return { async stop() {} };
            }
        }
    });

    await assert.rejects(
        descriptor.run({ signal: new AbortController().signal }),
        error => error instanceof AggregateError && error.errors.includes(apiError)
    );
});

test('Twitch 管理指令觸發的合併檢查會強制通知當下已直播的新訂閱', async () => {
    const config = structuredClone(loadConfig());
    config.commands.stream.twitchClientId = 'client-id';
    config.commands.stream.twitchClientSecret = 'client-secret';
    const forceValues = [];
    const descriptors = new Map();
    const twitch = createTwitchStreamFeature(config, {
        logTools: { sendLog() {} },
        checkStreamStatusImpl: async (_client, _streamConfig, forceNotifyCurrentLive) => {
            forceValues.push(forceNotifyCurrentLive);
        }
    });
    const scheduler = {
        register(descriptor) {
            descriptors.set(descriptor.name, descriptor);
            return {
                trigger: () => descriptor.run({ signal: new AbortController().signal }),
                async stop() {}
            };
        }
    };
    const client = { guilds: { cache: new Map() } };
    const stop = await twitch.initializer(client, { scheduler });

    await twitch.requestTwitchCheck();
    await descriptors.get('twitchStream.check').run({ signal: new AbortController().signal });
    assert.deepEqual(forceValues, [true, false]);
    await stop();
});

test('Twitch 通知內容加入 mention 與主播名稱後仍不超過 Discord 2000 字元', () => {
    const twitch = createTwitchStreamFeature(loadConfig(), { logTools: { sendLog() {} } });
    const content = twitch._test.buildNotificationContent('<@&123456789012345678>', 'x'.repeat(100), 'm'.repeat(1900));
    assert.equal(content.length, 2000);
    assert.match(content, /^<@&123456789012345678> \*\*/);
});
