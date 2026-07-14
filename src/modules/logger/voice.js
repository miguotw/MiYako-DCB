const { createLogTools } = require('../../../core/sendLog');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const configModules = config.modules;

// 記錄語音頻道進出
const initializer = (client) => {

    if (configModules.voice.enable) {
        client.on('voiceStateUpdate', (oldState, newState) => {
            const user = newState.member.user; // 取得使用者資料

            // 使用者加入語音頻道
            if (!oldState.channel && newState.channel) {
                sendLog(client, `🔊 ${user.tag} 加入了語音頻道「${newState.channel.name}」`);
            }

            // 使用者離開語音頻道
            else if (oldState.channel && !newState.channel) {
                sendLog(client, `🔇 ${user.tag} 離開了語音頻道「${oldState.channel.name}」`);
            }

            // 使用者切換語音頻道
            else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
                sendLog(client, `🔊 ${user.tag} 從「${oldState.channel.name}」切換到「${newState.channel.name}」`);
            }
        });
    }
};
return initializer;
}

module.exports = { createInitializer };
