const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/announcement');
function createManifest(config) { return createFeature({ name: 'announcement', command: createCommand(config), scope: 'admin', intents: [GatewayIntentBits.MessageContent], enabled: config.commands.announcement.enable }); }
module.exports = { createManifest };
