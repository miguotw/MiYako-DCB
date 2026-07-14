const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/dataCollection');
const { createDataCollectionDeadlineCoordinator } = require('../modules/event/data_collection');
function createManifest(config) {
    const coordinator = createDataCollectionDeadlineCoordinator(config);
    const command = createCommand(config, { scheduleCollection: coordinator.schedule });
    return createFeature({
        name: 'dataCollection', command, scope: 'admin',
        intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
        initializer: (_client, context) => coordinator.start(context)
    });
}
module.exports = { createManifest };
