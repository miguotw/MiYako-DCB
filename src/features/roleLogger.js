const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createInitializer } = require('../modules/logger/role');
function createManifest(config) { return createFeature({ name: 'roleLogger', enabled: config.modules.role.enable, intents: [GatewayIntentBits.GuildMembers], initializer: createInitializer(config) }); }
module.exports = { createManifest };
