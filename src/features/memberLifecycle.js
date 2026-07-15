const { GatewayIntentBits } = require('discord.js');
const { createFeature } = require('./factory');
const { createInitializer } = require('../modules/event/member_lifecycle');
function createManifest(config) { return createFeature({ name: 'memberLifecycle', intents: [GatewayIntentBits.GuildMembers], initializer: createInitializer(config) }); }
module.exports = { createManifest };
