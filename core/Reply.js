const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const EMBED_COLOR_ERROR = config.embed.color.error;  
const EMBED_EMOJI_ERROR = config.emoji.error;
const EMBED_COLOR_SUCCESS = config.embed.color.success;  
const EMBED_EMOJI_SUCCESS = config.emoji.success;
const REPOSITORY = configCommands.about.repository;
const PROVIDER = configCommands.about.provider;

function createErrorEmbed(errorMessage) {
    return new EmbedBuilder()
        .setTitle(`${EMBED_EMOJI_ERROR} ┃ 執行時失敗`)
        .setColor(EMBED_COLOR_ERROR)
        .setDescription(
            `${errorMessage}\n-# 如果您認為這是機器人本身的問題，請至 [GitHub 儲存庫](${REPOSITORY}) 建立一個 Issue，或與 <@${PROVIDER}> 聯繫，來報告該問題。`
        );
}

function createInfoEmbed(successMessage) {
    return new EmbedBuilder()
        .setTitle(`${EMBED_EMOJI_SUCCESS} ┃ 操作成功`)
        .setColor(EMBED_COLOR_SUCCESS)
        .setDescription(successMessage);
}

/**
// 回覆錯誤訊息給使用者
 * @param {Interaction} interaction - Discord 的 interaction 物件
 * @param {string} errorMessage - 錯誤訊息內容
 * @param {Array<Attachment>} [files] - 附加的檔案（可選）
 * @param {boolean} [ephemeral] - 是否僅讓觸發互動的使用者看見
 */
async function errorReply(interaction, errorMessage, files = [], ephemeral = false) {
    const embed = createErrorEmbed(errorMessage);

    const replyOptions = { embeds: [embed], files: files };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(replyOptions).catch(() => {});
    } else {
        await interaction.reply({ ...replyOptions, ephemeral }).catch(() => {});
    }
}

/**
 * 回覆成功訊息給使用者
 * @param {Interaction} interaction - Discord 的 interaction 物件
 * @param {string} successMessage - 成功訊息內容
 * @param {Array<Attachment>} [files] - 附加的檔案（可選）
 */
async function infoReply(interaction, successMessage, files = [], ephemeral = false) {
    const embed = createInfoEmbed(successMessage);

    const replyOptions = { embeds: [embed], files: files };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(replyOptions).catch(() => {});
    } else {
        await interaction.reply({ ...replyOptions, ephemeral }).catch(() => {});
    }
}

module.exports = { createErrorEmbed, createInfoEmbed, errorReply, infoReply };
