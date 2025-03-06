const path = require('path');
const { Events } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

// 成員加入與離開
module.exports = (client) => {

    if (config.Logger.Type.Member) {
        //成員加入
        client.on(Events.GuildMemberAdd, async (member) => {
            try {
                sendLog(client, `🚧 ${member.user.username} 已加入「${member.guild.name}」`);
            } catch (error) {
                sendLog(client, `❌ 在 GuildMemberAdd 事件中發生錯誤`, "ERROR", error);
            }
        });

        //成員離開
        client.on(Events.GuildMemberRemove, async (member) => {
            try {
                sendLog(client, `🚧 ${member.user.username} 已離開「${member.guild.name}」`);
            } catch (error) {
                sendLog(client, `❌ 在 GuildMemberRemove 事件中發生錯誤`, "ERROR", error);
            }
        });

    }
};
