'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GatewayIntentBits } = require('discord.js');
const { buildCommandCatalog } = require('../core/commandCatalog');
const { loadConfig } = require('../core/config');
const { createFeatureManifests } = require('../src/features');

function disabledLoggerConfig() {
    const config = structuredClone(loadConfig());
    config.modules.member.enable = false;
    config.modules.message.enable.create = false;
    config.modules.message.enable.update = false;
    config.modules.message.enable.delete = false;
    config.modules.role.enable = false;
    config.modules.voice.enable = false;
    return config;
}

const FEATURE_FILES = [
    'about', 'hitokoto', 'ipQuery', 'minecraft', 'ping', 'unixTimestamp',
    'announcement', 'messageDelete', 'userInfo', 'music', 'packageTracking',
    'gameCheckIn', 'dataCollection', 'raffle', 'temporaryVoice', 'twitchStream', 'keywords',
    'memberLifecycle', 'memberLogger', 'messageLogger', 'roleLogger', 'voiceLogger', 'presence'
];

const COMMAND_FEATURES = new Map([
    ['about', config => config.commands.about],
    ['hitokoto', config => config.commands.hitokoto],
    ['ipQuery', config => config.commands.ipQuery],
    ['minecraft', config => config.commands.minecraft],
    ['ping', config => config.commands.ping],
    ['unixTimestamp', config => config.commands.unixTimestamp],
    ['announcement', config => config.commands.announcement],
    ['messageDelete', config => config.commands.messageDelete],
    ['userInfo', config => config.commands.userInfo],
    ['music', config => config.commands.music],
    ['packageTracking', config => config.commands.packageTracking],
    ['gameCheckIn', config => config.commands.gameCheckIn],
    ['dataCollection', config => config.commands.dataCollection],
    ['raffle', config => config.commands.raffle],
    ['temporaryVoice', config => config.modules.temporaryVoice],
    ['twitchStream', config => config.commands.stream]
]);

test('每個 feature 模組各自匯出 createManifest(config)', () => {
    for (const file of FEATURE_FILES) {
        const feature = require(`../src/features/${file}`);
        assert.equal(typeof feature.createManifest, 'function', file);
    }
});

test('實際 feature manifest 名稱唯一，重複名稱會在 catalog 建立時失敗', () => {
    const config = loadConfig();
    const manifests = createFeatureManifests(config);
    const names = manifests.map(manifest => manifest.name);
    assert.equal(new Set(names).size, names.length);

    const duplicate = { ...manifests[0], commands: [], interactions: [] };
    assert.throws(
        () => buildCommandCatalog([...manifests, duplicate], { adminCommandName: config.startup.adminCommandName }),
        /Feature manifest 名稱重複/
    );
});

test('runtime/deploy 共用 catalog 的 command JSON 與 enabled command descriptor 一致', () => {
    const config = loadConfig();
    const catalog = buildCommandCatalog(createFeatureManifests(config), {
        adminCommandName: config.startup.adminCommandName
    });

    assert.deepEqual(
        catalog.commandJson,
        catalog.commands.map(command => command.data.toJSON())
    );
    assert.equal(catalog.commandJson.length, catalog.commands.length);
    assert.deepEqual(
        catalog.commandJson.map(command => command.name),
        ['關於みやこ', '一言', '網際協定位址資訊', '麥塊', '延遲', '時間戳', '音樂', '物流追蹤', '遊戲簽到', config.startup.adminCommandName]
    );

    const admin = catalog.commands.find(command => command.name === config.startup.adminCommandName);
    assert.equal(admin.access, 'admin');
    assert.equal(admin.data.toJSON().options.length, 7);
});

test('manifest factory 完全使用呼叫端注入的 config 建立指令', () => {
    const config = structuredClone(loadConfig());
    config.commands.about.botNickname = '測試機器人';
    const catalog = buildCommandCatalog(createFeatureManifests(config), {
        adminCommandName: config.startup.adminCommandName
    });
    assert.equal(catalog.commandJson[0].name, '關於測試機器人');
    assert.equal(catalog.commandJson.some(command => command.name === '關於みやこ'), false);
});

test('實際 enabled manifests 推導出預設最小 Gateway Intents 聯集', () => {
    const config = loadConfig();
    const catalog = buildCommandCatalog(createFeatureManifests(config), {
        adminCommandName: config.startup.adminCommandName
    });
    const minimumIntents = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates
    ];

    assert.deepEqual(new Set(catalog.intents), new Set(minimumIntents));
    assert.equal(catalog.intents.includes(GatewayIntentBits.DirectMessages), false);
});

test('遊戲簽到 manifest 註冊遊戲設定 exact 與 toggle prefix 路由', () => {
    const config = loadConfig();
    const manifest = createFeatureManifests(config).find(item => item.name === 'gameCheckIn');
    const games = manifest.interactions.find(route => route.kind === 'button' && route.id === 'game_checkin_games');
    const toggle = manifest.interactions.find(route => route.kind === 'button'
        && route.id === 'game_checkin_game_toggle');
    assert.equal(games.match, 'exact');
    assert.equal(toggle.match, 'prefix');
    assert.equal(games.access, 'public');
    assert.equal(toggle.access, 'public');
});

test('停用四種 logger 後不會加入 manifest 或額外 Gateway Intent', () => {
    const config = disabledLoggerConfig();
    const manifests = createFeatureManifests(config);
    const loggerNames = ['memberLogger', 'messageLogger', 'roleLogger', 'voiceLogger'];
    for (const name of loggerNames) {
        assert.equal(manifests.find(manifest => manifest.name === name).enabled, false);
    }

    const catalog = buildCommandCatalog(manifests, {
        adminCommandName: config.startup.adminCommandName
    });
    for (const name of loggerNames) {
        assert.equal(catalog.manifests.some(manifest => manifest.name === name), false);
    }

    const enabledIntentUnion = new Set(
        manifests
            .filter(manifest => manifest.enabled !== false)
            .flatMap(manifest => manifest.intents || [])
    );
    assert.deepEqual(new Set(catalog.intents), enabledIntentUnion);

    const disabledOnlyIntent = GatewayIntentBits.GuildModeration;
    const isolatedCatalog = buildCommandCatalog([
        {
            name: 'enabled',
            enabled: true,
            intents: [GatewayIntentBits.Guilds],
            commands: [],
            interactions: []
        },
        {
            name: 'disabledLogger',
            enabled: false,
            intents: [disabledOnlyIntent],
            commands: [],
            interactions: []
        }
    ], { adminCommandName: config.startup.adminCommandName });
    assert.deepEqual(isolatedCatalog.intents, [GatewayIntentBits.Guilds]);
    assert.equal(isolatedCatalog.intents.includes(disabledOnlyIntent), false);
});

test('16 個指令開關會停用整個 feature、互動、啟動與 intents', () => {
    for (const [featureName, selectConfig] of COMMAND_FEATURES) {
        const config = structuredClone(loadConfig());
        selectConfig(config).enable = false;
        const manifest = createFeatureManifests(config).find(item => item.name === featureName);
        assert.equal(manifest.enabled, false, featureName);
        const catalog = buildCommandCatalog([manifest], { adminCommandName: config.startup.adminCommandName });
        assert.deepEqual(catalog.manifests, [], featureName);
        assert.deepEqual(catalog.commands, [], featureName);
        assert.deepEqual(catalog.interactions, [], featureName);
        assert.deepEqual(catalog.intents, [], featureName);
    }
});

test('全部管理指令停用時不建立 admin aggregate', () => {
    const config = structuredClone(loadConfig());
    for (const section of ['announcement', 'raffle', 'dataCollection', 'messageDelete', 'userInfo', 'stream']) {
        config.commands[section].enable = false;
    }
    config.modules.temporaryVoice.enable = false;
    const catalog = buildCommandCatalog(createFeatureManifests(config), {
        adminCommandName: config.startup.adminCommandName
    });
    assert.equal(catalog.commands.some(command => command.name === config.startup.adminCommandName), false);
});
