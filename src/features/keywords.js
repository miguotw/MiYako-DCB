const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createInitializer } = require('../modules/event/keywords');
function createManifest(config) { return createFeature({ name: 'keywords', intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], initializer: createInitializer(config) }); }
module.exports = { createManifest };
