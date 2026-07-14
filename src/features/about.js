const { createFeature } = require('./factory');
const { createCommand } = require('../commands/about');
function createManifest(config) { return createFeature({ name: 'about', command: createCommand(config) }); }
module.exports = { createManifest };
