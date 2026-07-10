const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(process.cwd(), 'assets', 'music', 'panels.json');

function readStore() {
    try {
        const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch { return {}; }
}

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
