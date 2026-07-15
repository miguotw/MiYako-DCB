const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/userInfo');
function createManifest(config) { return createFeature({ name: 'userInfo', command: createCommand(config), scope: 'admin', enabled: config.commands.userInfo.enable }); }
module.exports = { createManifest };
