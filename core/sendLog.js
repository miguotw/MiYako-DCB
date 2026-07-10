const path = require('path');
const { config } = require(path.join(process.cwd(), 'core/config'));

const getTimePrefix = (level) => {
    const now = new Date();
    now.setHours(now.getHours() + config.log.timezone);
    const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const day = days[now.getDay()];
    const time = now.toLocaleTimeString('zh-TW', { hour12: false });
    return `[${day} ${time} ${level} ]`;
};

const sendLog = (client, message, level = 'INFO', error = null) => {
    try {
        // 檢查 client 是否定義
        if (!client) {
            console.error('❌ client 未定義，無法發送日誌。');
            return;
        }

        let logSymbol = '';
        if (level === 'INFO') logSymbol = ' ';
        if (level === 'WARN') logSymbol = '!';
        if (level === 'ERROR') logSymbol = '-';
        
        const prefix = getTimePrefix(level);
        let logMessage = `${prefix} ${message}`;
        
        if (level === 'ERROR' && error) {
            logMessage += `\n${error.stack || error}`;

            if (error.debugDetails) {
                logMessage += `\nDebug details:\n${JSON.stringify(error.debugDetails, null, 2)}`;
            }
        }
        
        console.log(logMessage);
        
        // 確保機器人 ready 後才發送到頻道
        if (!client.isReady()) {
            // console.error('❌ 機器人尚未 ready，無法發送日誌到頻道。');
            return;
        }
        
        const logChannel = client.channels.cache.get(config.log.channel);
        if (logChannel) {
            const maxDiscordLogLength = 1900;
            const discordLogMessage = logMessage.length > maxDiscordLogLength
                ? `${logMessage.slice(0, maxDiscordLogLength)}\n...（錯誤內容過長，已截斷；完整內容請查看終端日誌）`
                : logMessage;
            logChannel.send(`\`\`\`diff\n${logSymbol} ${discordLogMessage}\n\`\`\``).catch(err => {
                console.error(`${prefix} ❌ 無法發送日誌到頻道：`, err);
            });
        } else {
            console.error(`${prefix} ❌ 無法找到日誌頻道，請檢查 config.yml。`);
        }
    } catch (err) {
        console.error(`${prefix} ❌ 在 sendLog 函數中發生錯誤：`, err);
    }
};

module.exports = { sendLog };
