const { Events, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);
const JOIN_MESSAGES = config.Message.Member.Join;
const EMBED_COLOR = config.Embed_Color;  // 嵌入介面顏色

module.exports = (client) => {
    client.on(Events.GuildMemberAdd, async (member) => {
        try {
            const systemChannel = member.guild.systemChannel;
            if (!systemChannel) return;
            
            const randomMessage = JOIN_MESSAGES[Math.floor(Math.random() * JOIN_MESSAGES.length)];

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle('🚧 ┃ 歡迎新成員！')
                .setDescription(`**${member.user.username}** 已加入 **${member.guild.name}**！`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields({
                    name: '　',
                    value: randomMessage
                });

            await systemChannel.send({ embeds: [embed] });
        } catch (error) {
            console.error(`❌ 無法發送歡迎訊息至「${member.guild.name}」`, error);
        }
    });
};
