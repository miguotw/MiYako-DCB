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
const { deployCommands, parseDeployArgs } = require('../scripts/deployCommands');
const { undeployCommands, parseUndeployArgs } = require('../scripts/undeployCommands');

const CLIENT_ID = '12345678901234567';
const GUILD_ID = '23456789012345678';
const config = Object.freeze({
    startup: Object.freeze({
        token: 'fixture-token',
        clientId: CLIENT_ID,
        adminCommandName: '管理'
    })
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

test('parseDeployArgs 嚴格解析 global 與 guild scope', () => {
    assert.deepEqual(parseDeployArgs(['--scope', 'global']), {
        scope: 'global',
        guildId: null
    });
    assert.deepEqual(parseDeployArgs(['--scope', 'guild', '--guild-id', GUILD_ID]), {
        scope: 'guild',
        guildId: GUILD_ID
    });
});

test('parseDeployArgs 拒絕缺少參數、未知參數與 scope 衝突', () => {
    assert.throws(() => parseDeployArgs([]), /必須指定 --scope/);
    assert.throws(() => parseDeployArgs(['--scope']), /--scope 缺少值/);
    assert.throws(() => parseDeployArgs(['--scope', 'staging']), /必須指定 --scope/);
    assert.throws(() => parseDeployArgs(['--scope', 'global', '--unknown']), /不支援的部署參數/);
    assert.throws(
        () => parseDeployArgs(['--scope', 'global', '--guild-id', GUILD_ID]),
        /global 部署不可指定/
    );
    assert.throws(() => parseDeployArgs(['--scope', 'guild']), /必須提供有效的 --guild-id/);
    assert.throws(
        () => parseDeployArgs(['--scope', 'guild', '--guild-id', 'not-a-snowflake']),
        /有效的 --guild-id Snowflake/
    );
    assert.throws(
        () => parseDeployArgs(['--scope', 'global', '--scope', 'guild']),
        /--scope 不可重複指定/
    );
});

test('部署 CLI 對無效參數以非零狀態結束', () => {
    const result = spawnSync(process.execPath, ['scripts/deployCommands.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);

    const undeployResult = spawnSync(process.execPath, ['scripts/undeployCommands.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        encoding: 'utf8'
    });
    assert.equal(undeployResult.status, 1);
});

test('undeploy 對指定 global/guild route 只 PUT 空 catalog', async () => {
    assert.deepEqual(parseUndeployArgs(['--scope', 'global']), { scope: 'global', guildId: null });
    const calls = [];
    const rest = { async put(route, options) { calls.push({ route, options }); } };
    const globalResult = await undeployCommands({ args: ['--scope', 'global'], config, rest });
    const guildResult = await undeployCommands({
        args: ['--scope', 'guild', '--guild-id', GUILD_ID], config, rest
    });
    assert.deepEqual(calls, [
        { route: Routes.applicationCommands(CLIENT_ID), options: { body: [] } },
        { route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), options: { body: [] } }
    ]);
    assert.equal(globalResult.count, 0);
    assert.equal(guildResult.count, 0);
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

    const globalResult = await deployCommands({
        args: ['--scope', 'global'],
        config,
        manifests,
        rest
    });
    const guildResult = await deployCommands({
        args: ['--scope', 'guild', '--guild-id', GUILD_ID],
        config,
        manifests,
        rest
    });

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
        count: 1,
        route: Routes.applicationCommands(CLIENT_ID)
    });
    assert.deepEqual(guildResult, {
        scope: 'guild',
        guildId: GUILD_ID,
        count: 1,
        route: Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    });
    assert.equal(featureStarts, 0, 'deploy 不得啟動 feature');
});

test('deployCommands 傳遞 REST PUT 失敗，且部署腳本不建立 Discord Client', async () => {
    const restError = new Error('Discord REST unavailable');
    await assert.rejects(
        deployCommands({
            args: ['--scope', 'global'],
            config,
            manifests: [createManifest()],
            rest: { put: async () => { throw restError; } }
        }),
        error => error === restError
    );
    await assert.rejects(
        undeployCommands({
            args: ['--scope', 'guild', '--guild-id', GUILD_ID],
            config,
            rest: { put: async () => { throw restError; } }
        }),
        error => error === restError
    );

    const source = fs.readFileSync(path.resolve(__dirname, '../scripts/deployCommands.js'), 'utf8');
    assert.doesNotMatch(source, /\bnew\s+Client\s*\(/);
    const undeploySource = fs.readFileSync(path.resolve(__dirname, '../scripts/undeployCommands.js'), 'utf8');
    assert.doesNotMatch(undeploySource, /\bnew\s+Client\s*\(/);
});

test('deploy 使用真實 enabled manifests 的完整 catalog，且不執行 feature start', async () => {
    const realConfig = loadConfig();
    const expected = buildCommandCatalog(createFeatureManifests(realConfig), {
        adminCommandName: realConfig.startup.adminCommandName
    }).commandJson;
    let request;
    await deployCommands({
        args: ['--scope', 'global'],
        config: realConfig,
        rest: { async put(route, options) { request = { route, options }; } }
    });
    assert.equal(request.route, Routes.applicationCommands(realConfig.startup.clientId));
    assert.deepEqual(request.options.body, expected);
});
