'use strict';

const { createCommand } = require('../commands/gameCheckIn');
const { createGameCheckInDeadlineCoordinator } = require('../modules/event/game_check_in');
const { createFeature } = require('./factory');

function createManifest(config) {
    const coordinator = createGameCheckInDeadlineCoordinator(config);
    return createFeature({
        name: 'gameCheckIn',
        command: createCommand(config, { wake: coordinator.wake }),
        initializer: (_client, context) => coordinator.start(context),
        enabled: config.commands.gameCheckIn.enable
    });
}

module.exports = { createManifest };
