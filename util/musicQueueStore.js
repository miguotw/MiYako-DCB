const fs = require('fs');
/**
 * 音樂序列快照 repository；每個 guild 一個 JSON，供 Bot 重啟後恢復播放。
 * 寫入採 temporary + rename，避免意外終止造成截斷檔案。
 */
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
/** 壞檔只略過該 guild，避免單一 snapshot 阻止其他伺服器恢復。 */
function loadAllGuildQueues() {
    if (!fs.existsSync(QUEUE_DIRECTORY)) return [];
    return fs.readdirSync(QUEUE_DIRECTORY).filter(name => /^\d+\.json$/.test(name)).map(name => {
        try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIRECTORY, name), 'utf8')); } catch { return null; }
    }).filter(Boolean);
}
/** 序列完全結束後移除 snapshot；刪除本身設計為冪等。 */
function deleteGuildQueue(guildID) { try { fs.rmSync(filePath(guildID), { force: true }); } catch {} }
module.exports = { QUEUE_DIRECTORY, saveGuildQueue, loadAllGuildQueues, deleteGuildQueue };
