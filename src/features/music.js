const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/music');
const { createInitializer } = require('../modules/event/music_dependencies');
function createManifest(config) {
    const command = createCommand(config);
    return createFeature({ name: 'music', command, intents: [GatewayIntentBits.GuildVoiceStates], initializer: createInitializer(config, { musicCommand: command }) });
}
module.exports = { createManifest };
