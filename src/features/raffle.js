const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/raffle');
const { createRaffleDeadlineCoordinator } = require('../modules/event/raffle');
function createManifest(config) {
    const coordinator = createRaffleDeadlineCoordinator(config);
    const command = createCommand(config, { scheduleRaffle: coordinator.schedule });
    return createFeature({
        name: 'raffle', command, scope: 'admin',
        intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
        initializer: (_client, context) => coordinator.start(context)
    });
}
module.exports = { createManifest };
