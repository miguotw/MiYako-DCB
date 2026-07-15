'use strict';

const { assertNoCommandArguments, deployCommands } = require('./commandDeployment');

async function main(argv = process.argv.slice(2), dependencies = {}) {
    assertNoCommandArguments(argv);
    const { stdout = console.log, ...deploymentDependencies } = dependencies;
    const result = await deployCommands({ ...deploymentDependencies, scope: 'guild' });
    stdout(`✅ 已發布 ${result.count} 個 Slash Commands 至 Guild ${result.guildId}。`);
    return result;
}

if (require.main === module) {
    main().catch(error => {
        console.error(`❌ Slash Commands Guild 發布失敗：${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
