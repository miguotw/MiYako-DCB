const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/raffle');
const { createInitializer } = require('../modules/event/raffle');
function createManifest(config) { return createFeature({ name: 'raffle', command: createCommand(config), scope: 'admin', intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers], initializer: createInitializer(config) }); }
module.exports = { createManifest };
