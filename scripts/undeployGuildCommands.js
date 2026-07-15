'use strict';

const { assertNoCommandArguments, undeployCommands } = require('./commandDeployment');

async function main(argv = process.argv.slice(2), dependencies = {}) {
    assertNoCommandArguments(argv);
    const { stdout = console.log, ...deploymentDependencies } = dependencies;
    const result = await undeployCommands({ ...deploymentDependencies, scope: 'guild' });
    stdout(`✅ 已撤銷 Guild ${result.guildId} 的全部 Slash Commands。`);
    return result;
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ Slash Commands Guild 撤銷失敗：${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
