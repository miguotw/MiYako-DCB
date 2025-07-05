const path = require('path');
const { Player, QueryType, useMainPlayer } = require('discord-player');
const { YoutubeiExtractor } = require('discord-player-youtubei');
const { configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

// 導入設定檔內容
const PROGRESSBAR_LENGTH = configCommands.music.discordPlayer.progressBar.length;
const PROGRESSBAR_INDICATOR = configCommands.music.discordPlayer.progressBar.indicator;
const PROGRESSBAR_LEFTCHAR = configCommands.music.discordPlayer.progressBar.leftChar;
const PROGRESSBAR_RIGHTCHAR = configCommands.music.discordPlayer.progressBar.rightChar;
const COOKIES = configCommands.music.discordPlayer.cookies;

/**
 * 取得 cookies 中 HSID 的過期時間
 * @param {string} cookiesStr - cookies 的 JSON 字串
 * @returns {string} - HSID 過期時間的日期字串，若無則回傳 "未知"
 */
function getCookiesExpireTime(cookiesStr) {
    try {
        const obj = JSON.parse(cookiesStr);
        if (!obj.cookies || !Array.isArray(obj.cookies)) return "未知";
        const hsidCookie = obj.cookies.find(c => c.name === "VISITOR_INFO1_LIVE" && typeof c.expirationDate === "number");
        if (hsidCookie) {
            const date = new Date(hsidCookie.expirationDate * 1000);
            return date.toISOString();
        }
        return "未知";
    } catch {
        return "未知";
    }
}

/**
 * 初始化 Player 並註冊 Extractor
 * @param {Client} client - Discord client 實例
 */
const initPlayer = (client) => {
    client.player = new Player(client);
    sendLog(client, '✅ 初始化完成：Discord Player');
    if (COOKIES && typeof COOKIES === 'string' && COOKIES.trim() !== '') {
        client.player.extractors.register(YoutubeiExtractor, { cookies: COOKIES });
        const expireTime = getCookiesExpireTime(COOKIES);
        sendLog(client, `✅ 已註冊完成：Youtubei Extractor (已套用 cookies，有效至：${expireTime} )`);
    } else {
        client.player.extractors.register(YoutubeiExtractor, {});
        sendLog(client, '✅ 已註冊完成：Youtubei Extractor (未套用 cookies )');
    }
};

/**
 * 獲取音樂播放器實例
 * @returns {Object} - discord-player 實例
 */
const getPlayer = () => {
    return useMainPlayer();
};

/**
 * 搜尋音樂
 * @param {string} query - 搜尋查詢
 * @param {Object} member - 發起請求的成員
 * @returns {Promise<Object>} - 搜尋結果
 */
const searchMusic = async (query, member) => {
    const player = getPlayer();
    return await player.search(query, {
        requestedBy: member,
        searchEngine: QueryType.AUTO
    });
};

/**
 * 播放音樂
 * @param {Object} voiceChannel - 語音頻道
 * @param {string} query - 搜尋查詢
 * @param {Object} interaction - 互動物件
 * @returns {Promise<Object>} - 播放結果
 */
const playMusic = async (voiceChannel, query, interaction) => {
    const player = getPlayer();
    return await player.play(voiceChannel, query, {
        nodeOptions: {
            metadata: {
                channel: interaction.channel,
                client: interaction.client
            },
            volume: 10,
            leaveOnEmpty: true,
            leaveOnEmptyCooldown: 300000,
            leaveOnEnd: true,
            leaveOnEndCooldown: 300000,
        }
    });
};

/**
 * 創建進度條
 * @param {Object} queue - 音樂隊列
 * @returns {string} - 進度條字串
 */
const createProgressBar = (queue) => {
    return queue.node.createProgressBar({
        length: PROGRESSBAR_LENGTH,
        indicator: PROGRESSBAR_INDICATOR,
        leftChar: PROGRESSBAR_LEFTCHAR,
        rightChar: PROGRESSBAR_RIGHTCHAR
    });
};

/**
 * 獲取當前播放狀態
 * @param {string} guildId - 伺服器ID
 * @returns {Object} - 當前播放狀態
 */
const getPlayerState = (guildId) => {
    const player = getPlayer();
    const queue = player.nodes.get(guildId);
    
    return {
        queue,
        isPlaying: queue && queue.currentTrack,
        isPaused: queue?.node.isPaused(),
        repeatMode: queue?.repeatMode
    };
};

/**
 * 控制音樂播放
 * @param {string} guildId - 伺服器ID
 * @param {string} action - 動作類型 (pause/resume/skip/repeat)
 * @returns {Object} - 操作結果
 */
const controlPlayer = (guildId, action) => {
    const player = getPlayer();
    const queue = player.nodes.get(guildId);
    
    if (!queue || !queue.currentTrack) {
        return { success: false, message: '沒有音樂正在播放' };
    }

    try {
        switch (action) {
            case 'pause':
                queue.node.pause();
                return { success: true, message: '音樂已暫停' };
            case 'resume':
                queue.node.resume();
                return { success: true, message: '音樂已繼續' };
            case 'skip':
                queue.node.skip();
                return { success: true, message: '已跳過當前曲目' };
            case 'repeat':
                const newMode = queue.repeatMode === 1 ? 0 : 1;
                queue.setRepeatMode(newMode);
                return { 
                    success: true, 
                    message: newMode === 1 ? '重複播放已開啟' : '重複播放已關閉' 
                };
            default:
                return { success: false, message: '未知操作' };
        }
    } catch (error) {
        return { success: false, message: error.message };
    }
};

module.exports = { initPlayer, getPlayer, searchMusic, playMusic, createProgressBar, getPlayerState, controlPlayer };
