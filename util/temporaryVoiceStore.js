/**
 * 臨時語音頻道的 per-guild JSON repository。
 * entrances 是「加入即建立」的入口；channels 是本功能建立並負責清理的頻道。
 * 所有公開異動都經 updateGuildStore，以免呼叫端忘記將記憶體修改寫回磁碟。
 */
const path = require('path');
const { createGuildJsonStore } = require('./guildJsonStore');

const DATA_DIR = path.join(process.cwd(), 'assets', 'temporaryVoice');

function createEmptyStore() {
    return { entrances: {}, channels: {} };
}

/** 容忍缺欄或舊版檔案，但不接受 array 等錯誤容器型別。 */
function normalizeStore(value) {
    return {
        entrances: value?.entrances && typeof value.entrances === 'object' && !Array.isArray(value.entrances)
            ? value.entrances
            : {},
        channels: value?.channels && typeof value.channels === 'object' && !Array.isArray(value.channels)
            ? value.channels
            : {}
    };
}

// 共用存取器負責 Guild ID 驗證、空資料、列舉及原子寫入。
const guildStore = createGuildJsonStore({
    directory: DATA_DIR,
    createEmpty: createEmptyStore,
    normalize: normalizeStore
});

function loadGuildStore(guildID) {
    try {
        return guildStore.read(guildID);
    } catch (error) {
        error.message = `無法讀取臨時語音頻道資料 ${guildStore.getFile(guildID)}：${error.message}`;
        throw error;
    }
}

function saveGuildStore(guildID, store) {
    return guildStore.write(guildID, store);
}

/** read-modify-write 共用入口；updater 的回傳值會原樣傳給呼叫端。 */
function updateGuildStore(guildID, updater) {
    const store = loadGuildStore(guildID);
    const result = updater(store);
    saveGuildStore(guildID, store);
    return result;
}

function setEntrance(guildID, channelID, prefix = '') {
    const now = new Date().toISOString();
    return updateGuildStore(guildID, store => {
        const entrance = {
            channelID: String(channelID),
            prefix: String(prefix || '').trim(),
            createdAt: store.entrances[channelID]?.createdAt || now,
            updatedAt: now
        };
        store.entrances[channelID] = entrance;
        return entrance;
    });
}

function removeEntrance(guildID, channelID) {
    return updateGuildStore(guildID, store => {
        if (!store.entrances[channelID]) return false;
        delete store.entrances[channelID];
        return true;
    });
}

function addManagedChannel(guildID, channelID, data) {
    return updateGuildStore(guildID, store => {
        const record = {
            channelID: String(channelID),
            entranceChannelID: String(data.entranceChannelID),
            ownerID: String(data.ownerID),
            createdAt: data.createdAt || new Date().toISOString(),
            emptySince: data.emptySince || null
        };
        store.channels[channelID] = record;
        return record;
    });
}

function updateManagedChannel(guildID, channelID, changes) {
    return updateGuildStore(guildID, store => {
        if (!store.channels[channelID]) return null;
        store.channels[channelID] = { ...store.channels[channelID], ...changes, channelID: String(channelID) };
        return store.channels[channelID];
    });
}

function removeManagedChannel(guildID, channelID) {
    return updateGuildStore(guildID, store => {
        if (!store.channels[channelID]) return false;
        delete store.channels[channelID];
        return true;
    });
}

function listStoredGuildIDs() {
    return guildStore.listGuildIDs();
}

module.exports = {
    DATA_DIR,
    loadGuildStore,
    saveGuildStore,
    setEntrance,
    removeEntrance,
    addManagedChannel,
    updateManagedChannel,
    removeManagedChannel,
    listStoredGuildIDs
};
