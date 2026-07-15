const { createFeature } = require('./factory');
const { createCommand } = require('../commands/unixTimestamp');
function createManifest(config) { return createFeature({ name: 'unixTimestamp', command: createCommand(config), enabled: config.commands.unixTimestamp.enable }); }
module.exports = { createManifest };
