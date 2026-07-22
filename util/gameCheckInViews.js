'use strict';

const path = require('node:path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { PROJECT_ROOT } = require('../core/config');

const PANEL_BANNER_NAME = 'game-check-in-banner.png';
const PANEL_BANNER_PATH = path.join(PROJECT_ROOT, 'assets', 'gameCheckIn', 'banner.png');

function createGameCheckInPanelBanner() {
    return { attachment: PANEL_BANNER_PATH, name: PANEL_BANNER_NAME };
}

function createGameCheckInPanelEmbed(config, nextTriggerAt) {
    return new EmbedBuilder()
        .setColor(config.embed.color.default)
        .setTitle(`${config.commands.gameCheckIn.emoji} ┃ 遊戲自動簽到（BETA）`)
        .setDescription([
            '設定憑證後，機器人會每日自動為已綁定的支援遊戲簽到。',
            '> -# 1. 提交的憑證將使用 AES 安全加密，憑證只會在私密互動中處理，請勿將憑證張貼到頻道或交給他人。',
            '> -# 2. 通知會透過私訊傳送，請確認 Discord 允許共同伺服器成員傳送私人訊息。'
        ].join('\n'))
        .addFields(
            {name: '支援遊戲',value: `HoYoLAB | \`原神\`、\`崩壞：星穹鐵道\`、\`崩壞3rd\`、\`未定事件簿\`、\`絕區零\`\nSKPORT | \`明日方舟（繁中服）\`、\`明日方舟：終末地\``},
            {name: '下次排程',value: `<t:${Math.floor(nextTriggerAt / 1000)}:R>`}
        )
        .setImage(`attachment://${PANEL_BANNER_NAME}`);
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

module.exports = {
    createGameCheckInPanelBanner,
    createGameCheckInPanelEmbed,
    createGameCheckInPanelRow
};
