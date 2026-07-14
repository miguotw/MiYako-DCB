const path = require('node:path');
const { PROJECT_ROOT } = require('./config');
const { createJsonRepository } = require('./jsonRepository');

/** 建立 runtime 唯一的持久層入口；factory 本身不做 I/O，方便 deploy 離線建 catalog。 */
function createStoreRegistry({ dataRoot = path.join(PROJECT_ROOT, 'runtime', 'data') } = {}) {
    return Object.freeze({
        packageTracking: createJsonRepository({ directory: path.join(dataRoot, 'package-tracking'), schemaVersion: 1 }),
        dataCollection: createJsonRepository({ directory: path.join(dataRoot, 'data-collection'), schemaVersion: 1 }),
        raffle: createJsonRepository({ directory: path.join(dataRoot, 'raffle'), schemaVersion: 1 }),
        temporaryVoice: createJsonRepository({ directory: path.join(dataRoot, 'temporary-voice'), schemaVersion: 1 }),
        twitchStream: createJsonRepository({ directory: path.join(dataRoot, 'twitch'), schemaVersion: 1 }),
        musicQueue: createJsonRepository({ directory: path.join(dataRoot, 'music', 'queues'), schemaVersion: 1 }),
        musicPanel: createJsonRepository({ directory: path.join(dataRoot, 'music', 'panels'), schemaVersion: 1 })
    });
}

module.exports = { createStoreRegistry };
