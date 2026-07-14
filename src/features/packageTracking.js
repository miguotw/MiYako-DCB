const { createFeature } = require('./factory');
const { createCommand } = require('../commands/packageTracking');
const { createInitializer } = require('../modules/event/package_tracking');
function createManifest(config) { return createFeature({ name: 'packageTracking', command: createCommand(config), initializer: createInitializer(config), enabled: config.commands.packageTracking.enable }); }
module.exports = { createManifest };
