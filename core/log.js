const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);

const getTimePrefix = (level) => {
    const now = new Date();
    now.setHours(now.getHours() + config.Logger.Settings.Time_Zone);
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
        }
        
        console.log(logMessage);
        
        // 確保機器人 ready 後才發送到頻道
        if (!client.isReady()) {
            // console.error('❌ 機器人尚未 ready，無法發送日誌到頻道。');
            return;
        }
        
        const logChannel = client.channels.cache.get(config.Logger.Settings.Channel);
        if (logChannel) {
            logChannel.send(`\`\`\`diff\n${logSymbol} ${logMessage}\n\`\`\``).catch(err => {
                console.error(`${prefix} ❌ 無法發送日誌到頻道：`, err);
            });
        } else {
            console.error(`${prefix} ❌ 無法找到日誌頻道，請檢查 config.yml。`);
        }
    } catch (err) {
        console.error(`${prefix} ❌ 在 sendLog 函數中發生錯誤：`, err);
    }
};

module.exports = { getTimePrefix, sendLog };
