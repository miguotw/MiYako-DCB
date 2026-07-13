const fs = require('fs');
const path = require('path');

/**
 * 建立「每個 Discord 伺服器一份 JSON」的共用資料存取器。
 *
 * 各功能只需提供資料目錄、空資料結構與正規化函式；本模組統一負責
 * Guild ID 驗證、檔案讀寫、原子替換及列舉資料，避免每個功能各自實作。
 */
function createGuildJsonStore({ directory, createEmpty, normalize }) {
    const guildFilePattern = /^\d+\.json$/;

    /** 驗證 Guild ID，避免外部輸入跳脫指定的資料目錄。 */
    function getFile(guildID) {
        const id = String(guildID || '').trim();
        if (!/^\d+$/.test(id)) throw new Error('無效的伺服器 ID。');
        return path.join(directory, `${id}.json`);
    }

    /** 讀取並修正舊版或缺少欄位的資料；檔案不存在時回傳空資料。 */
    function read(guildID) {
        try {
            return normalize(JSON.parse(fs.readFileSync(getFile(guildID), 'utf8')));
        } catch (error) {
            if (error.code === 'ENOENT') return createEmpty();
            throw error;
        }
    }

    /**
     * 先寫入同目錄暫存檔再原子替換，降低程序中斷時留下半份 JSON 的風險。
     */
    function write(guildID, value) {
        fs.mkdirSync(directory, { recursive: true });
        const file = getFile(guildID);
        const temporary = `${file}.${process.pid}.tmp`;
        const normalized = normalize(value);
        fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
        fs.renameSync(temporary, file);
        return normalized;
    }

    /** 執行單次 read-modify-write，並將 updater 的結果傳回呼叫端。 */
    function update(guildID, updater) {
        const value = read(guildID);
        const result = updater(value);
        write(guildID, value);
        return result;
    }

    /** 列出資料目錄內所有有效的 Guild ID；目錄不存在時視為沒有資料。 */
    function listGuildIDs() {
        try {
            return fs.readdirSync(directory)
                .filter(fileName => guildFilePattern.test(fileName))
                .map(fileName => path.basename(fileName, '.json'));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    return { getFile, listGuildIDs, read, update, write };
}

module.exports = { createGuildJsonStore };
