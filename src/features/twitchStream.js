const { createFeature } = require('./factory');
const { createCommand } = require('../commands/admin/twitchStream');
const { createTwitchStreamFeature } = require('../modules/event/twitch_stream');
function createManifest(config) {
    const twitch = createTwitchStreamFeature(config);
    return createFeature({ name: 'twitchStream', command: createCommand(config, twitch), scope: 'admin', initializer: twitch.initializer });
}
module.exports = { createManifest };
