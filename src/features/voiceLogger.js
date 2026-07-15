const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createInitializer } = require('../modules/logger/voice');
function createManifest(config) { return createFeature({ name: 'voiceLogger', enabled: config.modules.voice.enable, intents: [GatewayIntentBits.GuildVoiceStates], initializer: createInitializer(config) }); }
module.exports = { createManifest };
