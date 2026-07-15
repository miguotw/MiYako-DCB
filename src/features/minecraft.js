const { createFeature } = require('./factory');
const { createCommand } = require('../commands/minecraft');
function createManifest(config) { return createFeature({ name: 'minecraft', command: createCommand(config), enabled: config.commands.minecraft.enable }); }
module.exports = { createManifest };
