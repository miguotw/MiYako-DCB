const axios = require('axios');

// 查詢玩家外觀
const getPlayerSkin = async (playerName) => {
    try {
        return `https://starlightskins.lunareclipse.studio/render/default/${playerName}/full`;
    } catch (error) {
        throw new Error(error.message);
    }
};

// 查詢玩家頭貼
const getPlayerSkinDownload = async (playerName) => {
    try {
        return `https://minotar.net/download/${playerName}`;
    } catch (error) {
        throw new Error(error.message);
    }
};

// 查詢玩家頭貼
const getPlayerAvatar = async (playerName) => {
    try {
        return `https://minotar.net/avatar/${playerName}/64.png`;
    } catch (error) {
        throw new Error(error.message);
    }
};

// 查詢伺服器狀態
const getServerStatus = async (serverIP) => {
    try {
        const response = await axios.get(`https://api.mcstatus.io/v2/status/java/${serverIP}`);
        const data = response.data;

        // 伺服器離線時的回應
        if (data.online === false) {
            throw new Error("伺服器離線。");
        }

        // 處理玩家列表
        const players = data.players?.list?.map(p => p.name_clean.replace(/_/g, '\\_')) || []; // 轉義 _ 避免 Markdown 格式
        let ServerStatusPlayersList;

        if (players.length === 0) {
            ServerStatusPlayersList = '無法取得線上玩家，或目前無玩家在線。';
        } else {
            ServerStatusPlayersList = players.join('、') + `\n-# 一次僅顯示最多 12 位玩家`;
        }

        // 抓取其他資訊
        const ServerStatusMOTD = data.motd.clean;
        const ServerStatusPlayersOnline = data.players.online;
        const ServerStatusPlayersMax = data.players.max;
        const ServerStatusVersionName = data.version.name_clean;
        const ServerStatusVersionProtocol = data.version.protocol.toString();
        const ServerStatusIP = data.ip_address;

        return { ServerStatusMOTD, ServerStatusPlayersOnline, ServerStatusPlayersMax, ServerStatusVersionName, ServerStatusVersionProtocol, ServerStatusPlayersList, ServerStatusIP };
    } catch (error) {
        // 如果錯誤是 axios 的錯誤，檢查狀態碼
        if (error.response && error.response.status === 400) {
            throw new Error("伺服器位址格式不正確，請檢查後重新輸入。");
        } else {
            // 其他錯誤直接拋出
            throw new Error(error.message);
        }
    }
};

// 查詢伺服器圖標
const getServerIcon = async (serverIP) => {
    try {
        return `https://api.mcstatus.io/v2/icon/${serverIP}`;
    } catch (error) {
        throw new Error(error.message);
    }
};

module.exports = { getPlayerSkin, getPlayerAvatar, getPlayerSkinDownload, getServerStatus, getServerIcon };