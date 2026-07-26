const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/globalAnnouncement');

function createManifest(config) {
    return createFeature({
        name: 'globalAnnouncement',
        command: createCommand(config),
        scope: 'provider',
        intents: [GatewayIntentBits.MessageContent],
        enabled: config.commands.globalAnnouncement.enable
    });
}

module.exports = { createManifest };
