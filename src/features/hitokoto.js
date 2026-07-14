const { createFeature } = require('./factory');
const { createCommand } = require('../commands/hitokoto');
function createManifest(config) { return createFeature({ name: 'hitokoto', command: createCommand(config), enabled: config.commands.hitokoto.enable }); }
module.exports = { createManifest };
