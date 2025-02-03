const { Events } = require('discord.js');
const { sendLog } = require('../../log');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);


module.exports = (client) => {
    // 成員加入與離開
    if (config.Logger.Type.Member) {
        client.on(Events.GuildMemberAdd, async (member) => {
            try {
                sendLog(client, `🚧 ${member.user.username} 已加入「${member.guild.name}」`);
            } catch (error) {
                sendLog(client, `❌ 在 GuildMemberAdd 事件中發生錯誤`, "ERROR", error);
            }
        });

        client.on(Events.GuildMemberRemove, async (member) => {
            try {
                sendLog(client, `🚧 ${member.user.username} 已離開「${member.guild.name}」`);
            } catch (error) {
                sendLog(client, `❌ 在 GuildMemberRemove 事件中發生錯誤`, "ERROR", error);
            }
        });

    }
};
