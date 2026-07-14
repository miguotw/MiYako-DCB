const { createFeature } = require('./factory');
const { createCommand } = require('../commands/ping');
function createManifest(config) { return createFeature({ name: 'ping', command: createCommand(config) }); }
module.exports = { createManifest };
