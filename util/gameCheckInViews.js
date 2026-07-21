'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

function createGameCheckInPanelEmbed(config, nextTriggerAt) {
    return new EmbedBuilder()
        .setColor(config.embed.color.default)
        .setTitle(`${config.commands.gameCheckIn.emoji} ┃ 遊戲自動簽到（BETA）`)
        .setDescription([
            '設定憑證後，機器人會每日自動為已綁定的支援遊戲簽到。',
            '> 憑證只會在私密互動中處理，請勿將憑證張貼到頻道或交給他人。',
            '> 通知會透過私訊傳送，請確認 Discord 允許共同伺服器成員傳送私人訊息。'
        ].join('\n'))
        .addFields(
            {name: '支援遊戲',value: `HoYoLAB | \`原神\`、\`崩壞：星穹鐵道\`、\`崩壞3rd\`、\`未定事件簿\`、\`絕區零\`\nSKPORT | \`明日方舟（繁中服）\`、\`明日方舟：終末地\``},
            {name: '下次排程',value: `<t:${Math.floor(nextTriggerAt / 1000)}:R>`}
        );
}

function createGameCheckInPanelRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('game_checkin_credentials')
            .setLabel('輸入／更新憑證')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('game_checkin_games')
            .setLabel('啟用／停用簽到')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('game_checkin_notifications')
            .setLabel('啟用／停用通知')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

module.exports = { createGameCheckInPanelEmbed, createGameCheckInPanelRow };
