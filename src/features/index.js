const featureModules = [
    require('./about'),
    require('./hitokoto'),
    require('./ipQuery'),
    require('./minecraft'),
    require('./ping'),
    require('./unixTimestamp'),
    require('./announcement'),
    require('./messageDelete'),
    require('./userInfo'),
    require('./music'),
    require('./packageTracking'),
    require('./dataCollection'),
    require('./raffle'),
    require('./temporaryVoice'),
    require('./twitchStream'),
    require('./keywords'),
    require('./memberLifecycle'),
    require('./memberLogger'),
    require('./messageLogger'),
    require('./roleLogger'),
    require('./voiceLogger'),
    require('./presence')
];

/** Runtime 與 deploy 共用同一組 feature factories；建 catalog 不會呼叫 start。 */
function createFeatureManifests(config) {
    return featureModules.map(feature => feature.createManifest(config));
}

module.exports = { createFeatureManifests };
