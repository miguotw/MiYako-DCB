const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createInitializer } = require('../modules/logger/member');
function createManifest(config) { return createFeature({ name: 'memberLogger', enabled: config.modules.member.enable, intents: [GatewayIntentBits.GuildMembers], initializer: createInitializer(config) }); }
module.exports = { createManifest };
