const { Events, EmbedBuilder } = require('discord.js');
const { sendLog } = require('../../log');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);
const LEAVE_MESSAGES = config.Message.Member.Leave;
const EMBED_COLOR = config.Embed_Color;  // 嵌入介面顏色

module.exports = (client) => {
    client.on(Events.GuildMemberRemove, async (member) => {
        try {
            const systemChannel = member.guild.systemChannel;
            if (!systemChannel) return;
            
            const randomMessage = LEAVE_MESSAGES[Math.floor(Math.random() * LEAVE_MESSAGES.length)];

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle('🚧 ┃ 成員離開 (；′⌒`)')
                .setDescription(`**${member.user.username}** 已離開 **${member.guild.name}**！`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields({
                    name: '　',
                    value: randomMessage
                });

            await systemChannel.send({ embeds: [embed] });
        } catch (error) {
            sendLog(client, `❌ 無法發送離開訊息至「${member.guild.name}」`, "ERROR", error);
        }
    });
};