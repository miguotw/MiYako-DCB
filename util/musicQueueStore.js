const fs = require('fs');
const path = require('path');
const QUEUE_DIRECTORY = path.join(process.cwd(), 'assets', 'music', 'queues');
function filePath(guildID) {
    if (!/^\d+$/.test(String(guildID || ''))) throw new Error('無效的伺服器 ID。');
    return path.join(QUEUE_DIRECTORY, `${guildID}.json`);
}
function saveGuildQueue(guildID, data) {
    fs.mkdirSync(QUEUE_DIRECTORY, { recursive: true });
    const destination = filePath(guildID);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...data, guildID: String(guildID), savedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(temporary, destination);
}
function loadAllGuildQueues() {
    if (!fs.existsSync(QUEUE_DIRECTORY)) return [];
    return fs.readdirSync(QUEUE_DIRECTORY).filter(name => /^\d+\.json$/.test(name)).map(name => {
        try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIRECTORY, name), 'utf8')); } catch { return null; }
    }).filter(Boolean);
}
function deleteGuildQueue(guildID) { try { fs.rmSync(filePath(guildID), { force: true }); } catch {} }
module.exports = { QUEUE_DIRECTORY, saveGuildQueue, loadAllGuildQueues, deleteGuildQueue };
