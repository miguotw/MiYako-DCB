const SNOWFLAKE = /^[1-9]\d{16,19}$/;

/** deploy 與 undeploy 共用同一套嚴格 scope grammar。 */
function parseCommandScopeArgs(argv) {
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

module.exports = { parseCommandScopeArgs };
