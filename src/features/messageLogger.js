const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createInitializer } = require('../modules/logger/message');
function createManifest(config) { return createFeature({ name: 'messageLogger', enabled: Object.values(config.modules.message.enable).some(Boolean), intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], initializer: createInitializer(config) }); }
module.exports = { createManifest };
