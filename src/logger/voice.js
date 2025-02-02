const { Events } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);


module.exports = (client, sendLog) => {
    // 記錄語音頻道進出
    if (config.Logger.Type.Voice) {
        client.on('voiceStateUpdate', (oldState, newState) => {
            const user = newState.member.user; // 取得使用者資料

            // 使用者加入語音頻道
            if (!oldState.channel && newState.channel) {
                sendLog(`🔊 ${user.tag} 加入了語音頻道「${newState.channel.name}」`);
            }

            // 使用者離開語音頻道
            else if (oldState.channel && !newState.channel) {
                sendLog(`🔇 ${user.tag} 離開了語音頻道「${oldState.channel.name}」`);
            }

            // 使用者切換語音頻道
            else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
                sendLog(`🔊 ${user.tag} 從「${oldState.channel.name}」切換到「${newState.channel.name}」`);
            }
        });
    }
};
