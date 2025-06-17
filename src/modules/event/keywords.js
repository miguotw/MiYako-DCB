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
                    // 收集本次觸發的訊息與 emoji
                    let response = null;
                    let reactionsUsed = [];

                    // 反應 emoji（允許 reaction 欄位為單一 emoji 或陣列）
                    if (group.reaction) {
                        const reactions = Array.isArray(group.reaction) ? group.reaction : [group.reaction];
                        for (const emoji of reactions) {
                            try {
                                await new Promise(resolve => setTimeout(resolve, COOLDOWN));
                                await message.react(emoji);
                                reactionsUsed.push(emoji);
                            } catch (e) {
                                // 無法添加的 emoji 忽略
                            }
                        }
                    }

                    // 回覆訊息（允許 message 欄位為單一訊息或陣列）
                    if (group.message) {
                        const responses = Array.isArray(group.message) ? group.message : [group.message];
                        response = responses[Math.floor(Math.random() * responses.length)];
                        await new Promise(resolve => setTimeout(resolve, COOLDOWN));
                        await message.channel.send(response);
                    }

                    // 優化日誌：同時顯示 message 與 reaction
                    if (ENABLE) {
                        sendLog(
                            client,
                            `🔍 ${message.author.tag} 在「#${message.channel.name}」觸發關鍵字組「${groupName}」:\n` +
                            `關鍵字內容: ${foundKeyword}\n` +
                            (response ? `回應的訊息: ${response}\n` : '') +
                            (reactionsUsed.length > 0 ? `回應的反應: ${reactionsUsed.join(' ')}\n` : ''),
                            "INFO"
                        );
                    }
                    break;
                }
            }
        } catch (error) {
            sendLog(client, `❌ 關鍵字回應失敗 (頻道: ${message.channel.name})`, "ERROR", error);
        }
    });
};