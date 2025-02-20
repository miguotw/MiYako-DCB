const path = require('path');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));

// 記錄訊息
module.exports = (client) => {
    // 記錄新訊息
    if (config.Logger.Type.Message.Create) {
        client.on('messageCreate', (message) => {
            if (!message.author.bot) {
                sendLog(client, `✏️ ${message.author.tag} 在「#${message.channel.name}」發送了訊息: ${message.content}`);
            }
        });
    }
    
    // 記錄訊息變更
    if (config.Logger.Type.Message.Update) {
        client.on('messageUpdate', async (oldMessage, newMessage) => {
            if (!oldMessage.author.bot && oldMessage.content !== newMessage.content) {
                sendLog(client, `✏️ ${oldMessage.author.tag} 在「#${oldMessage.channel.name}」編輯了訊息: \n 原內容: ${oldMessage.content} \n 新內容: ${newMessage.content}`, "WARN");
            }
        });
    }

    // 記錄訊息刪除
    if (config.Logger.Type.Message.Delete) {
        client.on('messageDelete', async (message) => {
            if (!message.author.bot) {
                sendLog(client, `✏️ ${message.author.tag} 在「#${message.channel.name}」刪除了訊息: ${message.content || "無法獲取內容"}`, "WARN");
            }
        });
    }
};
