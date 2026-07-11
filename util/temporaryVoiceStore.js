const fs = require('fs');
/**
 * 臨時語音頻道的 per-guild JSON repository。
 * entrances 是「加入即建立」的入口；channels 是本功能建立並負責清理的頻道。
 * 所有公開異動都經 updateGuildStore，以免呼叫端忘記將記憶體修改寫回磁碟。
 */
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'assets', 'temporaryVoice');
const GUILD_FILE_PATTERN = /^\d+\.json$/;

function createEmptyStore() {
    return { entrances: {}, channels: {} };
}

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 僅接受 Discord snowflake 數字，避免 guildID 被利用來跳脫資料目錄。 */
function getGuildFile(guildID) {
    const normalizedGuildID = String(guildID || '').trim();
    if (!/^\d+$/.test(normalizedGuildID)) throw new Error('無效的伺服器 ID。');
    return path.join(DATA_DIR, `${normalizedGuildID}.json`);
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

function loadGuildStore(guildID) {
    ensureDataDir();
    const filePath = getGuildFile(guildID);
    if (!fs.existsSync(filePath)) return createEmptyStore();

    try {
        return normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
        error.message = `無法讀取臨時語音頻道資料 ${filePath}：${error.message}`;
        throw error;
    }
}

/** 使用同目錄暫存檔原子替換，降低 crash 時留下損壞 JSON 的機率。 */
function saveGuildStore(guildID, store) {
    ensureDataDir();
    const filePath = getGuildFile(guildID);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    const normalizedStore = normalizeStore(store);

    fs.writeFileSync(temporaryPath, JSON.stringify(normalizedStore, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
    return normalizedStore;
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
    ensureDataDir();
    return fs.readdirSync(DATA_DIR)
        .filter(fileName => GUILD_FILE_PATTERN.test(fileName))
        .map(fileName => path.basename(fileName, '.json'));
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
