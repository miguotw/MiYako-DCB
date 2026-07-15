const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

function createRaffleViews(config) {
const configCommands = config.commands;

const EMOJI = configCommands.raffle?.emoji || '🎁';
const COLOR = config.embed.color.default;

function participationRow(raffle, disabled = false) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`raffle_join:${raffle.id}`)
            .setLabel('參加/取消抽選')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    )];
}

function mentionFields(name, ids) {
    if (!ids.length) return [{ name, value: '無' }];
    const chunks = [];
    let output = '';
    for (const id of ids) {
        const next = `${output ? '、' : ''}<@${id}>`;
        if (output.length + next.length > 1000) {
            chunks.push(output);
            output = `<@${id}>`;
            continue;
        }
        output += next;
    }
    if (output) chunks.push(output);
    return chunks.map((value, index) => ({ name: index === 0 ? name : `${name}（續）`, value }));
}

function createRaffleEmbed(raffle, closed = false) {
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`${EMOJI} ┃ 抽選系統 (BETA)`)
        .setDescription(raffle.description)
        .addFields(
            { name: '抽選人數', value: `${raffle.winnerCount} 位${raffle.autoDraw === false ? '' : ' `已啟用自動抽選`'}`, inline: true },
            { name: '截止倒數', value: `<t:${raffle.entryDeadline}:R>`, inline: true },
            ...mentionFields('已登記抽選', raffle.participants)
        )
        .setFooter({ text: raffle.id })
        .setTimestamp(raffle.createdAt ? new Date(raffle.createdAt) : new Date());

    if (closed) {
        embed.addFields(...mentionFields('中選用戶', raffle.winners));
    }
    if (raffle.imageURL) embed.setImage(raffle.imageURL);
    return embed;
}

return { createRaffleEmbed, participationRow };
}

module.exports = { createRaffleViews };
