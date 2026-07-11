const fs = require('fs');
/**
 * 每個 guild 最新音樂面板的輕量索引。
 * 只保存 Discord IDs，不保存 Message 物件；重啟後由 command 重新 fetch 並綁定。
 */
const path = require('path');

const STORE_PATH = path.join(process.cwd(), 'assets', 'music', 'panels.json');

function readStore() {
    try {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch { return {}; }
}

/** 先寫暫存檔再 rename，避免程序中斷留下半份 JSON。 */
function writeStore(store) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const temporary = `${STORE_PATH}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
    fs.renameSync(temporary, STORE_PATH);
}

function getLatestMusicPanel(guildID) {
    return readStore()[String(guildID)] || null;
}

function getAllLatestMusicPanels() {
    return Object.values(readStore()).filter(panel => panel?.guildID && panel?.channelID && panel?.messageID);
}

/** 新面板覆寫同 guild 舊索引；舊 Discord 訊息是否停用由 command 負責。 */
function saveLatestMusicPanel(guildID, message) {
    if (!guildID || !message?.id || !message?.channelId) return;
    const store = readStore();
    store[String(guildID)] = {
        guildID: String(guildID),
        channelID: String(message.channelId),
        messageID: String(message.id),
        updatedAt: new Date().toISOString()
    };
    writeStore(store);
}

module.exports = { STORE_PATH, getLatestMusicPanel, getAllLatestMusicPanels, saveLatestMusicPanel };
