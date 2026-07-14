const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/temporaryVoice');
const { createInitializer } = require('../modules/event/temporary_voice');
function createManifest(config) { return createFeature({ name: 'temporaryVoice', command: createCommand(config), scope: 'admin', intents: [GatewayIntentBits.GuildVoiceStates], initializer: createInitializer(config) }); }
module.exports = { createManifest };
