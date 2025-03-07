const axios = require('axios');
const fs = require('fs');
const { Buffer } = require('buffer');

// 查詢伺服器狀態
const getServerStatus = async (serverIP) => {
    try {
        const response = await axios.get(`https://api.mcsrvstat.us/2/${serverIP}`);
        const data = response.data;

        // 伺服器離線時的回應
        if (data.debug.ping === false) {
            throw new Error("伺服器離線或位址格式不正確。");
        }

        // 處理玩家列表
        const players = data.players?.list?.map(p => p.replace(/_/g, '\\_')) || []; // 轉義 _ 避免 Markdown 格式
        let ServerStatusPlayersList;

        if (players.length === 0) {
            ServerStatusPlayersList = '無法取得線上玩家，或目前無玩家在線。';
        } else {
            ServerStatusPlayersList = players.join('、') + `\n-# 一次僅顯示最多 12 位玩家`;
        }

        // 處理伺服器圖標
        let ServerStatusIcon = null;
        if (data.icon) {
            const base64Data = data.icon.split(',')[1]; // 去掉 data:image/png;base64, 前綴
            const iconBuffer = Buffer.from(base64Data, 'base64'); // 解碼 Base64
            const iconPath = `./${serverIP}_icon.png`; // 臨時文件路徑
            fs.writeFileSync(iconPath, iconBuffer); // 寫入文件
            ServerStatusIcon = iconPath; // 保存文件路徑
        }

        // 抓取其他資訊
        const ServerStatusMOTD = data.motd.clean.join('\n');
        const ServerStatusPlayersOnline = `${data.players.online} / ${data.players.max}`;
        const ServerStatusOnline = data.online ? '是' : '否';
        const ServerStatusVersionName = data.version;
        const ServerStatusVersionProtocol = data.protocol.toString();
        const ServerStatusHostname = data.hostname;
        const ServerStatusIP = `${data.ip}:${data.port}`;

        return { ServerStatusMOTD, ServerStatusPlayersOnline, ServerStatusOnline, ServerStatusVersionName, ServerStatusVersionProtocol, ServerStatusHostname, ServerStatusIP, ServerStatusPlayersList, ServerStatusIcon };
    } catch (error) {
        throw new Error(error.message);
    }
};

module.exports = { getServerStatus };