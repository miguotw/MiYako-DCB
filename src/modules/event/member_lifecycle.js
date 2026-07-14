const path = require('path');
const { Events, EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const configModules = config.modules;

const EMBED_COLOR = config.embed.color.default;

/**
 * 發送成員加入或離開的系統頻道通知。
 * type 決定讀取 join／leave 設定，其他流程共用以確保兩種通知格式一致。
 */
async function sendMemberNotice(client, member, type) {
    const systemChannel = member.guild.systemChannel;
    if (!systemChannel) return;

    const messages = configModules.member.message[type];
    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    const isJoin = type === 'join';
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${configModules.member.emoji[type]} ┃ ${isJoin ? '歡迎新成員！' : "成員離開 (；′⌒')"}`)
        .setDescription(`**${member.user.username}** 已${isJoin ? '加入' : '離開'} **${member.guild.name}**！`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .addFields({ name: '　', value: randomMessage });

    await systemChannel.send({ embeds: [embed] });
}

/** 為加入與離開事件套用相同的錯誤紀錄策略。 */
function registerMemberEvent(client, event, type, actionName) {
    client.on(event, async member => {
        try {
            await sendMemberNotice(client, member, type);
        } catch (error) {
            sendLog(client, `❌ 無法發送${actionName}訊息至「${member.guild.name}」`, 'ERROR', error);
        }
    });
}

const initializer = client => {
    registerMemberEvent(client, Events.GuildMemberAdd, 'join', '歡迎');
    registerMemberEvent(client, Events.GuildMemberRemove, 'leave', '離開');
};
return initializer;
}

module.exports = { createInitializer };
