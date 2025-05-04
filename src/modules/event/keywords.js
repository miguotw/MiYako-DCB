const path = require('path');
const { Events } = require('discord.js');
const { configModules } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

// 導入設定檔內容
const COOLDOWN = configModules.keywords.cooldown;
const WHITELIST = configModules.keywords.whitelist;
const CHANNELS = configModules.keywords.channels;
const TRIGGER_GROUPS = configModules.keywords.triggers;
const ENABLE = configModules.keywords.enable;

module.exports = (client) => {
    client.on(Events.MessageCreate, async (message) => {
        try {
            // 忽略機器人發送的消息
            if (message.author.bot) return;

            // 檢查頻道是否符合白名單規則
            const isInChannelList = CHANNELS.includes(message.channel.id);
            const shouldRespond = WHITELIST ? isInChannelList : !isInChannelList;
            if (!shouldRespond) return;

            // 檢查所有觸發組
            for (const [groupName, group] of Object.entries(TRIGGER_GROUPS)) {
                const foundKeyword = group.keywords.find(keyword =>
                    message.content.toLowerCase().includes(keyword.toLowerCase())
                );

                if (foundKeyword) {
                    // 從該組隨機選擇回應
                    const response = group.responses[Math.floor(Math.random() * group.responses.length)];
                    await new Promise(resolve => setTimeout(resolve, COOLDOWN));
                    await message.channel.send(response);
                    
                    if (ENABLE) {
                        sendLog(client, `🔍 ${message.author.tag} 在「#${message.channel.name}」觸發關鍵字組「${groupName}」: \n 關鍵字內容: ${foundKeyword} \n 回應的內容: ${response}`,"INFO");
                    }
                    // 找到匹配後立即停止檢查其他組
                    break;
                }
            }
        } catch (error) {
            sendLog(client, `❌ 關鍵字回應失敗 (頻道: ${message.channel.name})`, "ERROR", error);
        }
    });
};