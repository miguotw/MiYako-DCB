const { REST, Routes } = require('discord.js');
const { loadConfig } = require('../core/config');
const { buildCommandCatalog } = require('../core/commandCatalog');
const { createFeatureManifests } = require('../src/features');
const { parseCommandScopeArgs } = require('./commandScope');
const parseDeployArgs = parseCommandScopeArgs;

/** 只建立 command JSON 並 PUT 指定 scope；不建立 Discord Client 或啟動 features。 */
async function deployCommands({
    args,
    config = loadConfig(),
    manifests = createFeatureManifests(config),
    rest = new REST({ version: '10' }).setToken(config.startup.token)
}) {
    const options = Array.isArray(args) ? parseDeployArgs(args) : args;
    const catalog = buildCommandCatalog(manifests, { adminCommandName: config.startup.adminCommandName });
    const route = options.scope === 'global'
        ? Routes.applicationCommands(config.startup.clientId)
        : Routes.applicationGuildCommands(config.startup.clientId, options.guildId);
    await rest.put(route, { body: catalog.commandJson });
    return { scope: options.scope, guildId: options.guildId, count: catalog.commandJson.length, route };
}

async function main(argv = process.argv.slice(2)) {
    // CLI grammar 必須在讀設定、建立真實 catalog 或 REST client 前先拒絕。
    const options = parseDeployArgs(argv);
    const result = await deployCommands({ args: options });
    const target = result.scope === 'global' ? '全域' : `Guild ${result.guildId}`;
    console.log(`✅ 已發布 ${result.count} 個 Slash Commands 至${target}。`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ Slash Commands 發布失敗：${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { deployCommands, main, parseDeployArgs };
