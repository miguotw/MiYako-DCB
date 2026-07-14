const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/messageDelete');
function createManifest(config) { return createFeature({ name: 'messageDelete', command: createCommand(config), scope: 'admin' }); }
module.exports = { createManifest };
