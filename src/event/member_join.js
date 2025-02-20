const path = require('path');
const { Events, EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));

// 導入設定檔內容
const JOIN_MESSAGES = config.Message.Member.Join;
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Event.Member;

module.exports = (client) => {
    client.on(Events.GuildMemberAdd, async (member) => {
        try {
            const systemChannel = member.guild.systemChannel;
            if (!systemChannel) return;
            
            const randomMessage = JOIN_MESSAGES[Math.floor(Math.random() * JOIN_MESSAGES.length)];

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 歡迎新成員！`)
                .setDescription(`**${member.user.username}** 已加入 **${member.guild.name}**！`)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields({
                    name: '　',
                    value: randomMessage
                });

            await systemChannel.send({ embeds: [embed] });
        } catch (error) {
            sendLog(client, `❌ 無法發送歡迎訊息至「${member.guild.name}」`, "ERROR", error);
        }
    });
};
