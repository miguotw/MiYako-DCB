'use strict';

const { REST, Routes } = require('discord.js');
const { loadConfig } = require('../core/config');
const { buildCommandCatalog } = require('../core/commandCatalog');
const { createFeatureManifests } = require('../src/features');

const COMMAND_SCOPES = Object.freeze(['global', 'guild']);

function assertNoCommandArguments(argv) {
    if (!Array.isArray(argv)) throw new TypeError('argv 必須是陣列。');
    if (argv.length > 0) throw new Error('此指令不接受任何參數。');
}

function resolveCommandTarget(scope, config) {
    if (!COMMAND_SCOPES.includes(scope)) throw new Error('部署 scope 必須是 global 或 guild。');

    const guildId = scope === 'guild' ? config.startup.guildId : null;
    if (scope === 'guild' && !guildId) {
        throw new Error('guild 部署需要在 config.yml 設定 startup.guildId。');
    }

    const route = scope === 'global'
        ? Routes.applicationCommands(config.startup.clientId)
        : Routes.applicationGuildCommands(config.startup.clientId, guildId);
    return { scope, guildId, route };
}

function createRest(config) {
    return new REST({ version: '10' }).setToken(config.startup.token);
}

/** 只建立 command JSON 並 PUT 固定 scope；不建立 Discord Client 或啟動 features。 */
async function deployCommands({
    scope,
    config = loadConfig(),
    manifests,
    rest
} = {}) {
    const target = resolveCommandTarget(scope, config);
    const commandManifests = manifests ?? createFeatureManifests(config);
    const catalog = buildCommandCatalog(commandManifests, {
        adminCommandName: config.startup.adminCommandName
    });
    const restClient = rest ?? createRest(config);
    await restClient.put(target.route, { body: catalog.commandJson });
    return { ...target, count: catalog.commandJson.length };
}

/** 對固定 scope PUT 空 catalog；不建立 Discord Client，也不啟動任何 feature。 */
async function undeployCommands({
    scope,
    config = loadConfig(),
    rest
} = {}) {
    const target = resolveCommandTarget(scope, config);
    const restClient = rest ?? createRest(config);
    await restClient.put(target.route, { body: [] });
    return { ...target, count: 0 };
}

module.exports = {
    assertNoCommandArguments,
    deployCommands,
    resolveCommandTarget,
    undeployCommands
};
