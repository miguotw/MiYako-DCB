const { createFeature } = require('./factory');
const { createCommand } = require('../commands/unixTimestamp');
function createManifest(config) { return createFeature({ name: 'unixTimestamp', command: createCommand(config) }); }
module.exports = { createManifest };
