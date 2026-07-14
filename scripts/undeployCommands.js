const { REST, Routes } = require('discord.js');
const { loadConfig } = require('../core/config');
const { parseCommandScopeArgs } = require('./commandScope');

/** 對指定 scope PUT 空 catalog；不建立 Discord Client，也不啟動任何 feature。 */
async function undeployCommands({
    args,
    config = loadConfig(),
    rest = new REST({ version: '10' }).setToken(config.startup.token)
}) {
    const options = Array.isArray(args) ? parseCommandScopeArgs(args) : args;
    const route = options.scope === 'global'
        ? Routes.applicationCommands(config.startup.clientId)
        : Routes.applicationGuildCommands(config.startup.clientId, options.guildId);
    await rest.put(route, { body: [] });
    return { scope: options.scope, guildId: options.guildId, count: 0, route };
}

async function main(argv = process.argv.slice(2)) {
    const options = parseCommandScopeArgs(argv);
    const result = await undeployCommands({ args: options });
    const target = result.scope === 'global' ? '全域' : `Guild ${result.guildId}`;
    console.log(`✅ 已撤銷${target}的全部 Slash Commands。`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ Slash Commands 撤銷失敗：${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main, parseUndeployArgs: parseCommandScopeArgs, undeployCommands };
