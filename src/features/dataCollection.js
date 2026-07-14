const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/dataCollection');
const { createInitializer } = require('../modules/event/data_collection');
function createManifest(config) { return createFeature({ name: 'dataCollection', command: createCommand(config), scope: 'admin', intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers], initializer: createInitializer(config) }); }
module.exports = { createManifest };
