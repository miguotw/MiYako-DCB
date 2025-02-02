const { Events } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);


module.exports = (client, sendLog) => {
    // 成員加入與離開
    if (config.Logger.Type.Member) {
        client.on(Events.GuildMemberAdd, async (member) => {
            sendLog(`🚧 ${member.user.username} 已加入「${member.guild.name}」`);
        });

        client.on(Events.GuildMemberRemove, async (member) => {
            sendLog(`🚧 ${member.user.username} 已離開「${member.guild.name}」`);
        });

    }
};
