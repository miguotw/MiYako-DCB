'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('yaml');
const { buildCommandCatalog } = require('../core/commandCatalog');
const { createFeatureManifests } = require('../src/features');
const {
    ConfigError,
    PROJECT_ROOT,
    loadConfig,
    _resetConfigCacheForTests
} = require('../core/config');
const {
    createConfigFixture,
    createValidConfigDocuments,
    removeConfigFixture
} = require('./helpers/configFixture');

const originalConfigDirectory = process.env.MIYAKO_CONFIG_DIR;
const COMMAND_CONFIG_SECTIONS = [
    'announcement', 'raffle', 'dataCollection', 'messageDelete', 'userInfo', 'stream',
    'about', 'ping', 'hitokoto', 'packageTracking', 'gameCheckIn', 'ipQuery', 'minecraft', 'unixTimestamp', 'music'
];

function useFixture(options) {
    const fixture = createConfigFixture(options);
    process.env.MIYAKO_CONFIG_DIR = fixture.directory;
    _resetConfigCacheForTests();
    return fixture;
}

function rewriteDocument(directory, fileName, document) {
    const filePath = path.join(directory, fileName);
    fs.writeFileSync(filePath, yaml.stringify(document), { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
}

function restoreEnvironment() {
    if (originalConfigDirectory === undefined) delete process.env.MIYAKO_CONFIG_DIR;
    else process.env.MIYAKO_CONFIG_DIR = originalConfigDirectory;
    _resetConfigCacheForTests();
}

test.after(restoreEnvironment);
test.beforeEach(() => _resetConfigCacheForTests());

test('loadConfig 回傳統一 camelCase 結構，空白外部憑證可停用輪詢', () => {
    const fixture = useFixture();
    try {
        const config = loadConfig();
        assert.deepEqual(Object.keys(config), ['startup', 'log', 'embed', 'emoji', 'commands', 'modules']);
        assert.equal(config.startup.clientId, '123456789012345678');
        assert.equal(config.startup.guildId, undefined);
        assert.equal(config.startup.statusType, 'online');
        assert.equal(config.commands.stream.twitchClientId, '');
        assert.equal(config.commands.stream.twitchClientSecret, '');
        assert.equal(config.commands.packageTracking.trackTwToken, '');
        assert.equal(config.commands.packageTracking.maxActivePackages, 20);
        assert.equal(config.commands.gameCheckIn.checkInTime, '10:00');
        assert.equal(config.commands.gameCheckIn.timezone, undefined);
        assert.equal(config.log.timezone, 0);
        assert.equal(config.commands.music.maxQueueTracks, 100);
        assert.equal(config.commands.music.maxConcurrentYtDlpProcesses, 3);
        assert.equal(config.commands.music.maxFileSizeMiB, 256);
        assert.equal(config.commands.music.maxCacheSizeMiB, 2048);
        for (const section of COMMAND_CONFIG_SECTIONS) assert.equal(config.commands[section].enable, true, section);
        assert.equal(config.modules.temporaryVoice.enable, true);
        assert.equal(config.modules.temporaryVoice.deleteAfterMinutes, 5);
    } finally {
        removeConfigFixture(fixture.directory);
    }
});

test('startup.guildId 可省略，有填寫時必須是有效 Snowflake', () => {
    const validDocuments = createValidConfigDocuments();
    validDocuments['config.yml'].startup.guildId = '234567890123456789';
    let fixture = useFixture({ documents: validDocuments });
    try {
        assert.equal(loadConfig().startup.guildId, '234567890123456789');
    } finally {
        removeConfigFixture(fixture.directory);
    }

    for (const value of ['', 'not-a-snowflake', null]) {
        const documents = createValidConfigDocuments();
        documents['config.yml'].startup.guildId = value;
        fixture = useFixture({ documents });
        try {
            assert.throws(() => loadConfig(), error => {
                assert.ok(error instanceof ConfigError);
                assert.match(error.message, /startup\.guildId/);
                return true;
            });
        } finally {
            removeConfigFixture(fixture.directory);
        }
    }
});

test('16 個指令開關缺省為啟用，並接受顯式停用', () => {
    const defaults = createValidConfigDocuments();
    for (const section of COMMAND_CONFIG_SECTIONS) delete defaults['configCommands.yml'][section].enable;
    delete defaults['configCommands.yml'].music.maxConcurrentYtDlpProcesses;
    delete defaults['configModules.yml'].temporaryVoice.enable;
    let fixture = useFixture({ documents: defaults });
    try {
        const config = loadConfig();
        for (const section of COMMAND_CONFIG_SECTIONS) assert.equal(config.commands[section].enable, true, section);
        assert.equal(config.commands.music.maxConcurrentYtDlpProcesses, 3);
        assert.equal(config.modules.temporaryVoice.enable, true);
    } finally {
        removeConfigFixture(fixture.directory);
    }

    const disabled = createValidConfigDocuments();
    for (const section of COMMAND_CONFIG_SECTIONS) disabled['configCommands.yml'][section].enable = false;
    disabled['configModules.yml'].temporaryVoice.enable = false;
    fixture = useFixture({ documents: disabled });
    try {
        const config = loadConfig();
        for (const section of COMMAND_CONFIG_SECTIONS) assert.equal(config.commands[section].enable, false, section);
        assert.equal(config.modules.temporaryVoice.enable, false);
    } finally {
        removeConfigFixture(fixture.directory);
    }
});

test('設定路徑不受目前工作目錄影響，且相對 MIYAKO_CONFIG_DIR 以專案根目錄解析', () => {
    const fixture = createConfigFixture();
    const originalCwd = process.cwd();
    try {
        process.env.MIYAKO_CONFIG_DIR = path.relative(PROJECT_ROOT, fixture.directory);
        process.chdir(os.tmpdir());
        _resetConfigCacheForTests();
        assert.equal(loadConfig().startup.adminCommandName, 'admin');
    } finally {
        process.chdir(originalCwd);
        removeConfigFixture(fixture.directory);
    }
});

test('設定只載入一次並回傳相同快取物件', () => {
    const fixture = useFixture();
    try {
        const first = loadConfig();
        fixture.documents['config.yml'].startup.token = '另一個不應被重新載入的值';
        rewriteDocument(fixture.directory, 'config.yml', fixture.documents['config.yml']);
        const second = loadConfig();
        assert.equal(second, first);
        assert.equal(second.startup.token, '請替換為 Discord Bot Token');
    } finally {
        removeConfigFixture(fixture.directory);
    }
});

test('packageTracking.maxActivePackages 未填時預設 20，邊界 1 與 100 有效', () => {
    for (const value of [undefined, 1, 100]) {
        const documents = createValidConfigDocuments();
        if (value === undefined) delete documents['configCommands.yml'].packageTracking.maxActivePackages;
        else documents['configCommands.yml'].packageTracking.maxActivePackages = value;
        const fixture = useFixture({ documents });
        try {
            assert.equal(loadConfig().commands.packageTracking.maxActivePackages, value ?? 20);
        } finally {
            removeConfigFixture(fixture.directory);
            _resetConfigCacheForTests();
        }
    }
});

test('舊設定鍵與未知鍵會被 strict schema 拒絕', () => {
    for (const mutate of [
        documents => {
            documents['config.yml'].Startup = documents['config.yml'].startup;
            delete documents['config.yml'].startup;
        },
        documents => {
            documents['config.yml'].startup.clientID = documents['config.yml'].startup.clientId;
            delete documents['config.yml'].startup.clientId;
        },
        documents => {
            documents['config.yml'].startup.deployGuildId = '234567890123456789';
        },
        documents => {
            documents['configModules.yml'].accountBook = { enable: true };
        },
        documents => {
            documents['configCommands.yml'].music.ytDlpPath = 'assets/music/yt-dlp';
        },
        documents => {
            documents['configCommands.yml'].gameCheckIn.timezone = 8;
        }
    ]) {
        const documents = createValidConfigDocuments();
        mutate(documents);
        const fixture = useFixture({ documents });
        try {
            assert.throws(() => loadConfig(), error => {
                assert.ok(error instanceof ConfigError);
                assert.match(error.message, /驗證失敗|資料型別不正確/);
                return true;
            });
        } finally {
            removeConfigFixture(fixture.directory);
        }
    }
});

test('POSIX 上三份 YAML 必須精確為 0600', { skip: process.platform === 'win32' }, () => {
    const fixture = useFixture({ modes: { 'configCommands.yml': 0o640 } });
    try {
        assert.throws(() => loadConfig(), /configCommands\.yml.*0600/);
    } finally {
        removeConfigFixture(fixture.directory);
    }
});

test('固定數值範圍與 Discord 欄位限制會被驗證', () => {
    const cases = [
        ['configCommands.yml', document => { document.stream.checkInterval = 0; }],
        ['configCommands.yml', document => { document.stream.editInterval = 1441; }],
        ['configCommands.yml', document => { document.music.panelUpdateSeconds = 4; }],
        ['configCommands.yml', document => { document.music.inactivityTimeoutMinutes = 1441; }],
        ['configModules.yml', document => { document.temporaryVoice.deleteAfterMinutes = 0; }],
        ['configModules.yml', document => { document.keywords.cooldown = 600001; }],
        ['configCommands.yml', document => { document.packageTracking.archiveAfterDays = 3651; }],
        ['configCommands.yml', document => { document.packageTracking.maxActivePackages = 0; }],
        ['configCommands.yml', document => { document.packageTracking.maxActivePackages = 101; }],
        ['configCommands.yml', document => { document.gameCheckIn.checkInTime = '24:00'; }],
        ['configCommands.yml', document => { document.gameCheckIn.checkInTime = '9:00'; }],
        ['configCommands.yml', document => { document.music.ytDlpUpdateHours = 721; }],
        ['configCommands.yml', document => { document.music.maxConcurrentYtDlpProcesses = 11; }],
        ['configCommands.yml', document => { document.music.liveReconnectWindowSeconds = 9; }],
        ['configCommands.yml', document => { document.music.maxDurationMinutes = 1441; }],
        ['configCommands.yml', document => { document.music.maxQueueTracks = 0; }],
        ['configCommands.yml', document => { document.music.maxFileSizeMiB = 4097; }],
        ['configCommands.yml', document => { document.music.maxCacheSizeMiB = 102401; }],
        ['configCommands.yml', document => { document.dataCollection.titleMaxLength = 46; }],
        ['configCommands.yml', document => { document.messageDelete.deleteLimit = 101; }],
        ['configCommands.yml', document => { document.stream.message = ['x'.repeat(1901)]; }],
        ['configCommands.yml', document => { document.minecraft.defaultServer['測試'] = 'x'.repeat(101); }],
        ['configModules.yml', document => { document.member.message.join = ['x'.repeat(1025)]; }],
        ['config.yml', document => { document.embed.color.default = 0x1000000; }],
        ['config.yml', document => { document.log.timezone = 15; }]
    ];

    for (const [fileName, mutate] of cases) {
        const documents = createValidConfigDocuments();
        mutate(documents[fileName]);
        const fixture = useFixture({ documents });
        try {
            assert.throws(() => loadConfig(), ConfigError);
        } finally {
            removeConfigFixture(fixture.directory);
        }
    }
});

test('Discord UI 邊界值通過 config 後也能建立真實 command catalog', () => {
    const documents = createValidConfigDocuments();
    documents['configCommands.yml'].minecraft.defaultServer = { ['n'.repeat(100)]: 'x'.repeat(100) };
    documents['configModules.yml'].member.message.join = ['x'.repeat(1024)];
    const fixture = useFixture({ documents });
    try {
        const config = loadConfig();
        assert.doesNotThrow(() => buildCommandCatalog(createFeatureManifests(config), {
            adminCommandName: config.startup.adminCommandName
        }));
    } finally {
        removeConfigFixture(fixture.directory);
    }
});

test('Snowflake、HTTP(S) URL 與 Discord enum 會被驗證', () => {
    const cases = [
        ['config.yml', document => { document.startup.clientId = 'abc'; }],
        ['config.yml', document => { document.startup.activityType = 4; }],
        ['config.yml', document => { document.startup.statusType = 'offline'; }],
        ['configCommands.yml', document => { document.about.repository = 'ftp://example.test/repo'; }],
        ['configModules.yml', document => { document.keywords.channels = ['not-a-snowflake']; }]
    ];

    for (const [fileName, mutate] of cases) {
        const documents = createValidConfigDocuments();
        mutate(documents[fileName]);
        const fixture = useFixture({ documents });
        try {
            assert.throws(() => loadConfig(), ConfigError);
        } finally {
            removeConfigFixture(fixture.directory);
        }
    }
});

test('跨欄位規則拒絕半套 Twitch 憑證、反向音樂時長與無效關於指令名稱', () => {
    const cases = [
        document => { document.stream.twitchClientId = 'client-id'; },
        document => {
            document.music.minDurationMinutes = 10;
            document.music.maxDurationMinutes = 5;
        },
        document => {
            document.music.maxFileSizeMiB = 512;
            document.music.maxCacheSizeMiB = 256;
        },
        document => { document.about.botNickname = 'Bad Name'; }
    ];

    for (const mutate of cases) {
        const documents = createValidConfigDocuments();
        mutate(documents['configCommands.yml']);
        const fixture = useFixture({ documents });
        try {
            assert.throws(() => loadConfig(), ConfigError);
        } finally {
            removeConfigFixture(fixture.directory);
        }
    }
});

test('中文錯誤不會包含設定中的敏感值', () => {
    const documents = createValidConfigDocuments();
    const secret = 'DO-NOT-LEAK-THIS-SECRET';
    documents['config.yml'].startup.token = secret;
    documents['configCommands.yml'].stream.twitchClientSecret = secret;
    documents['configCommands.yml'].stream.twitchClientId = '';
    const fixture = useFixture({ documents });
    try {
        assert.throws(() => loadConfig(), error => {
            assert.ok(error instanceof ConfigError);
            assert.match(error.message, /[\u3400-\u9fff]/u);
            assert.doesNotMatch(error.message, new RegExp(secret));
            return true;
        });
    } finally {
        removeConfigFixture(fixture.directory);
    }
});
