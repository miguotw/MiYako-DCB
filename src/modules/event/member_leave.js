const path = require('path');
const { Events, EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

// 導入設定檔內容
const LEAVE_MESSAGES = config.Message.Member.Leave;
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Event.Member;

module.exports = (client) => {
    client.on(Events.GuildMemberRemove, async (member) => {
        try {
            const systemChannel = member.guild.systemChannel;
            if (!systemChannel) return;
            
            const randomMessage = LEAVE_MESSAGES[Math.floor(Math.random() * LEAVE_MESSAGES.length)];

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 成員離開 (；′⌒')`)
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