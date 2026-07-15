'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Routes } = require('discord.js');
const { buildCommandCatalog } = require('../core/commandCatalog');
const { loadConfig } = require('../core/config');
const { createFeatureManifests } = require('../src/features');
const {
    assertNoCommandArguments,
    deployCommands,
    resolveCommandTarget,
    undeployCommands
} = require('../scripts/commandDeployment');
const { main: deployGlobal } = require('../scripts/deployGlobalCommands');
const { main: deployGuild } = require('../scripts/deployGuildCommands');
const { main: undeployGlobal } = require('../scripts/undeployGlobalCommands');
const { main: undeployGuild } = require('../scripts/undeployGuildCommands');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CLIENT_ID = '12345678901234567';
const GUILD_ID = '23456789012345678';
const config = Object.freeze({
    startup: Object.freeze({
        token: 'fixture-token',
        clientId: CLIENT_ID,
        adminCommandName: '管理'
    })
});
const guildConfig = Object.freeze({
    startup: Object.freeze({ ...config.startup, guildId: GUILD_ID })
});

function createManifest({ onStart = () => {} } = {}) {
    return {
        name: 'deploy-test',
        enabled: true,
        intents: [],
        commands: [{
            name: '測試',
            access: 'public',
            data: {
                name: '測試',
                toJSON: () => ({ name: '測試', description: '部署測試' })
            },
            async execute() {}
        }],
        interactions: [],
        start: onStart,
        async stop() {}
    };
}

test('無參數 CLI grammar 與固定 scope target 會被嚴格驗證', () => {
    assert.doesNotThrow(() => assertNoCommandArguments([]));
    assert.throws(() => assertNoCommandArguments(['--scope', 'global']), /不接受任何參數/);
    assert.throws(() => assertNoCommandArguments('global'), /argv 必須是陣列/);

    assert.deepEqual(resolveCommandTarget('global', config), {
        scope: 'global',
        guildId: null,
        route: Routes.applicationCommands(CLIENT_ID)
    });
    assert.deepEqual(resolveCommandTarget('guild', guildConfig), {
        scope: 'guild',
        guildId: GUILD_ID,
        route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    });
    assert.throws(() => resolveCommandTarget('staging', config), /scope 必須是 global 或 guild/);
    assert.throws(() => resolveCommandTarget('guild', config), /設定 startup\.guildId/);
});

test('undeploy 對固定 global/guild route 只 PUT 空 catalog', async () => {
    const calls = [];
    const rest = { async put(route, options) { calls.push({ route, options }); } };
    const globalResult = await undeployCommands({ scope: 'global', config, rest });
    const guildResult = await undeployCommands({ scope: 'guild', config: guildConfig, rest });
    assert.deepEqual(calls, [
        { route: Routes.applicationCommands(CLIENT_ID), options: { body: [] } },
        { route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), options: { body: [] } }
    ]);
    assert.deepEqual(globalResult, {
        scope: 'global', guildId: null, route: Routes.applicationCommands(CLIENT_ID), count: 0
    });
    assert.deepEqual(guildResult, {
        scope: 'guild', guildId: GUILD_ID,
        route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), count: 0
    });
});

test('deployCommands 對 global/guild 使用正確 REST route 與共用 catalog body', async () => {
    const calls = [];
    let featureStarts = 0;
    const rest = {
        async put(route, options) {
            calls.push({ route, options });
        }
    };
    const manifests = [createManifest({ onStart: () => { featureStarts += 1; } })];

    const globalResult = await deployCommands({ scope: 'global', config, manifests, rest });
    const guildResult = await deployCommands({ scope: 'guild', config: guildConfig, manifests, rest });

    const expectedBody = [{ name: '測試', description: '部署測試' }];
    assert.deepEqual(calls, [
        {
            route: Routes.applicationCommands(CLIENT_ID),
            options: { body: expectedBody }
        },
        {
            route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            options: { body: expectedBody }
        }
    ]);
    assert.deepEqual(globalResult, {
        scope: 'global',
        guildId: null,
        route: Routes.applicationCommands(CLIENT_ID),
        count: 1
    });
    assert.deepEqual(guildResult, {
        scope: 'guild',
        guildId: GUILD_ID,
        route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        count: 1
    });
    assert.equal(featureStarts, 0, 'deploy 不得啟動 feature');
});

test('四個 main 不需參數並固定各自 scope', async () => {
    const calls = [];
    const output = [];
    const rest = { async put(route, options) { calls.push({ route, options }); } };
    const shared = {
        config: guildConfig,
        manifests: [createManifest()],
        rest,
        stdout: message => output.push(message)
    };

    const results = [
        await deployGlobal([], { ...shared, scope: 'guild' }),
        await deployGuild([], { ...shared, scope: 'global' }),
        await undeployGlobal([], { ...shared, scope: 'guild' }),
        await undeployGuild([], { ...shared, scope: 'global' })
    ];

    assert.deepEqual(results.map(result => result.scope), ['global', 'guild', 'global', 'guild']);
    assert.deepEqual(calls.map(call => call.route), [
        Routes.applicationCommands(CLIENT_ID),
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        Routes.applicationCommands(CLIENT_ID),
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    ]);
    assert.deepEqual(calls.map(call => call.options.body.length), [1, 1, 0, 0]);
    assert.equal(output.length, 4);
    assert.match(output[0], /已發布 1 個.*全域/);
    assert.match(output[1], new RegExp(`Guild ${GUILD_ID}`));
    assert.match(output[2], /已撤銷全域/);
    assert.match(output[3], new RegExp(`Guild ${GUILD_ID}`));
});

test('guild 缺少設定時在建立 REST 請求前失敗', async () => {
    let requests = 0;
    const rest = { async put() { requests += 1; } };
    await assert.rejects(
        deployCommands({ scope: 'guild', config, manifests: [createManifest()], rest }),
        /設定 startup\.guildId/
    );
    await assert.rejects(
        undeployCommands({ scope: 'guild', config, rest }),
        /設定 startup\.guildId/
    );
    assert.equal(requests, 0);
});

test('四支 CLI 拒絕額外參數，guild CLI 缺少設定時以非零狀態結束', async t => {
    const scripts = [
        'deployGlobalCommands.js',
        'deployGuildCommands.js',
        'undeployGlobalCommands.js',
        'undeployGuildCommands.js'
    ];
    const mains = [deployGlobal, deployGuild, undeployGlobal, undeployGuild];
    for (const main of mains) {
        await assert.rejects(main(['--unexpected'], { config: guildConfig }), /不接受任何參數/);
    }
    await assert.rejects(deployGuild([], { config }), /設定 startup\.guildId/);
    await assert.rejects(undeployGuild([], { config }), /設定 startup\.guildId/);

    for (const script of scripts) {
        const result = spawnSync(process.execPath, [`scripts/${script}`, '--unexpected'], {
            cwd: PROJECT_ROOT,
            env: process.env,
            encoding: 'utf8'
        });
        if (result.error?.code === 'EPERM') {
            t.diagnostic('sandbox 不允許測試程序建立 CLI 子程序，已改由 main 單元測試覆蓋。');
            return;
        }
        assert.equal(result.status, 1, script);
        assert.match(result.stderr, /不接受任何參數/, script);
    }

    for (const script of ['deployGuildCommands.js', 'undeployGuildCommands.js']) {
        const result = spawnSync(process.execPath, [`scripts/${script}`], {
            cwd: PROJECT_ROOT,
            env: process.env,
            encoding: 'utf8'
        });
        assert.equal(result.status, 1, script);
        assert.match(result.stderr, /設定 startup\.guildId/, script);
    }
});

test('部署核心傳遞 REST PUT 失敗，且部署腳本不建立 Discord Client', async () => {
    const restError = new Error('Discord REST unavailable');
    await assert.rejects(
        deployCommands({
            scope: 'global',
            config,
            manifests: [createManifest()],
            rest: { put: async () => { throw restError; } }
        }),
        error => error === restError
    );
    await assert.rejects(
        undeployCommands({
            scope: 'guild',
            config: guildConfig,
            rest: { put: async () => { throw restError; } }
        }),
        error => error === restError
    );

    const source = fs.readdirSync(path.join(PROJECT_ROOT, 'scripts'))
        .filter(name => name.endsWith('.js'))
        .map(name => fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', name), 'utf8'))
        .join('\n');
    assert.doesNotMatch(source, /\bnew\s+Client\s*\(/);
});

test('deploy 使用真實 enabled manifests 的完整 catalog，且不執行 feature start', async () => {
    const realConfig = loadConfig();
    const expected = buildCommandCatalog(createFeatureManifests(realConfig), {
        adminCommandName: realConfig.startup.adminCommandName
    }).commandJson;
    let request;
    await deployCommands({
        scope: 'global',
        config: realConfig,
        rest: { async put(route, options) { request = { route, options }; } }
    });
    assert.equal(request.route, Routes.applicationCommands(realConfig.startup.clientId));
    assert.deepEqual(request.options.body, expected);
});

test('package scripts 只公開四個無參數部署入口', () => {
    const scripts = require('../package.json').scripts;
    assert.equal(scripts['deploy:global'], 'node scripts/deployGlobalCommands.js');
    assert.equal(scripts['deploy:guild'], 'node scripts/deployGuildCommands.js');
    assert.equal(scripts['undeploy:global'], 'node scripts/undeployGlobalCommands.js');
    assert.equal(scripts['undeploy:guild'], 'node scripts/undeployGuildCommands.js');
    assert.equal(scripts['deploy:commands'], undefined);
    assert.equal(scripts['undeploy:commands'], undefined);
});
