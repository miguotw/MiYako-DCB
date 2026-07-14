const { createFeature } = require('./factory');
const { createCommand } = require('../commands/ipQuery');
function createManifest(config) { return createFeature({ name: 'ipQuery', command: createCommand(config) }); }
module.exports = { createManifest };
