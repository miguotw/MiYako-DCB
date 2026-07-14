const { createFeature } = require('./factory');
const { createCommand } = require('../commands/minecraft');
function createManifest(config) { return createFeature({ name: 'minecraft', command: createCommand(config) }); }
module.exports = { createManifest };
