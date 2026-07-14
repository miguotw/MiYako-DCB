const { REST, Routes } = require('discord.js');
const { loadConfig } = require('../core/config');
const { buildCommandCatalog } = require('../core/commandCatalog');
const { createFeatureManifests } = require('../src/features');

const SNOWFLAKE = /^[1-9]\d{16,19}$/;

function parseDeployArgs(argv) {
    let scope = null;
    let guildId = null;
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--scope') {
            if (scope !== null) throw new Error('--scope 不可重複指定。');
            scope = argv[++index];
            if (!scope) throw new Error('--scope 缺少值。');
            continue;
        }
        if (argument === '--guild-id') {
            if (guildId !== null) throw new Error('--guild-id 不可重複指定。');
            guildId = argv[++index];
            if (!guildId) throw new Error('--guild-id 缺少值。');
            continue;
        }
        throw new Error(`不支援的部署參數：${argument}`);
    }

    if (!['global', 'guild'].includes(scope)) throw new Error('必須指定 --scope global 或 --scope guild。');
    if (scope === 'global' && guildId !== null) throw new Error('global 部署不可指定 --guild-id。');
    if (scope === 'guild' && !SNOWFLAKE.test(guildId || '')) throw new Error('guild 部署必須提供有效的 --guild-id Snowflake。');
    return Object.freeze({ scope, guildId });
}

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
