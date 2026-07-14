/**
 * 第二階段只集中注入既有 Store，不改動 JSON 路徑或同步 I/O；第三階段可在不改
 * manifest context 的前提下替換成 createJsonRepository。
 */
function createStoreRegistry() {
    return Object.freeze({
        dataCollection: require('../util/dataCollectionStore'),
        musicPanel: require('../util/musicPanelStore'),
        musicQueue: require('../util/musicQueueStore'),
        raffle: require('../util/raffleStore'),
        temporaryVoice: require('../util/temporaryVoiceStore'),
        twitchStream: require('../util/twitchStreamStore')
    });
}

module.exports = { createStoreRegistry };
