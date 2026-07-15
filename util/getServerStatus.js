const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { Buffer } = require('buffer');
const { http } = require('../core/http');
const { PROJECT_ROOT } = require('../core/config');

const MINECRAFT_TEMP_DIR = path.join(PROJECT_ROOT, 'runtime', 'tmp', 'minecraft');

function normalizeServerAddress(serverIP) {
    return serverIP.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function createSafeIconPath(serverIP) {
    const safeName = serverIP.replace(/[^a-zA-Z0-9.-]/g, '_');
    fs.mkdirSync(MINECRAFT_TEMP_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(MINECRAFT_TEMP_DIR, 0o700);
    return path.join(MINECRAFT_TEMP_DIR, `${safeName}_${crypto.randomUUID()}_icon.png`);
}

function createServerStatusError(message, publicMessage, debugDetails, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.publicMessage = publicMessage;
    error.debugDetails = debugDetails;
    return error;
}

function sanitizeApiResponse(data) {
    if (!data || typeof data !== 'object') return data;

    return {
        ...data,
        // 圖示可能包含很長的 Base64；日誌只需知道 API 是否有回傳。
        icon: data.icon ? `[omitted: ${data.icon.length} characters]` : data.icon
    };
}

/** 查詢 Minecraft 伺服器狀態；第三方 GET 套用共用 timeout／retry policy。 */
const getServerStatus = async (serverIP) => {
    const normalizedServerIP = normalizeServerAddress(serverIP);
    const requestURL = `https://api.mcsrvstat.us/2/${encodeURIComponent(normalizedServerIP)}`;

    try {
        const response = await http.get(requestURL);
        const data = response.data;

        // 處理玩家列表
        const players = data.players?.list?.map(p => p.replace(/_/g, '\\_')) || []; // 轉義 _ 避免 Markdown 格式
        let ServerStatusPlayersList;

        if (!data.players) {
            ServerStatusPlayersList = 'N/A';
        } else if (players.length === 0) {
            ServerStatusPlayersList = '無法取得線上玩家，或目前無玩家在線。';
        } else {
            ServerStatusPlayersList = players.join('、') + `\n-# 一次僅顯示最多 12 位玩家`;
        }

        // 處理伺服器圖標
        let ServerStatusIcon = null;
        if (data.icon && data.icon.startsWith('data:image/png;base64,')) {
            const base64Data = data.icon.split(',')[1]; // 去掉 data:image/png;base64, 前綴
            const iconBuffer = Buffer.from(base64Data, 'base64'); // 解碼 Base64
            const iconPath = createSafeIconPath(normalizedServerIP); // 臨時文件路徑
            fs.writeFileSync(iconPath, iconBuffer, { mode: 0o600 }); // 寫入文件
            ServerStatusIcon = iconPath; // 保存文件路徑
        }

        // 抓取其他資訊
        const ServerStatusMOTD = data.motd?.clean?.join('\n') || '無法取得 MOTD。';
        const ServerStatusPlayersOnline = data.players
            ? `${data.players.online ?? 'N/A'} / ${data.players.max ?? 'N/A'}`
            : 'N/A';
        const ServerStatusOnline = data.online ? '是' : '否';
        const ServerStatusVersionName = data.version || "N/A";
        const ServerStatusVersionProtocol = data.protocol?.toString() || "N/A";
        const ServerStatusHostname = data.hostname || normalizedServerIP;
        const ServerStatusIP = data.ip
            ? `${data.ip}${data.port ? `:${data.port}` : ''}`
            : 'N/A';
        const ServerStatusDiagnostic = data.online
            ? null
            : data.debug?.error?.ping || '伺服器未回應狀態查詢。';

        return { ServerStatusMOTD, ServerStatusPlayersOnline, ServerStatusOnline, ServerStatusVersionName, ServerStatusVersionProtocol, ServerStatusHostname, ServerStatusIP, ServerStatusPlayersList, ServerStatusIcon, ServerStatusDiagnostic };
    } catch (error) {
        // 保留程式主動建立的診斷資訊，不要重新建立 Error 而遺失堆疊與內容。
        if (error.debugDetails) throw error;

        throw createServerStatusError(
            `Minecraft status API request failed: ${error.message}`,
            '伺服器狀態查詢服務暫時無法使用，或伺服器位址格式不正確。',
            {
                serverInput: serverIP,
                normalizedServerAddress: normalizedServerIP,
                requestURL,
                axiosCode: error.code,
                httpStatus: error.response?.status,
                httpStatusText: error.response?.statusText,
                apiResponse: sanitizeApiResponse(error.response?.data)
            },
            error
        );
    }
};

module.exports = { getServerStatus };
