const { createFeature } = require('./factory');
const { createCommand } = require('../commands/about');
function createManifest(config) { return createFeature({ name: 'about', command: createCommand(config), enabled: config.commands.about.enable }); }
module.exports = { createManifest };
