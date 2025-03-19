const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color_error;  
const EMBED_EMOJI_ERROR = config.Emoji.Error_Reply;
const EMBED_EMOJI_SUCCESS = config.Emoji.Success_Reply;
const REPOSITORY = config.About.Repository;
const PROVIDER = config.About.Provider;

/**
// 回覆錯誤訊息給使用者
 * @param {Interaction} interaction - Discord 的 interaction 物件
 * @param {string} errorMessage - 錯誤訊息內容
 * @param {Array<Attachment>} [files] - 附加的檔案（可選）
 */
async function errorReply(interaction, errorMessage, files = []) {
    const embed = new EmbedBuilder()
        .setTitle(`${EMBED_EMOJI_ERROR} ┃ 執行時失敗`)
        .setColor(EMBED_COLOR)
        .addFields(
            { name: errorMessage, value: `-# 如果您認為這是機器人本身的問題，請至 [GitHub 儲存庫](${REPOSITORY}) 建立一個 Issue，或與 <@${PROVIDER}> 聯繫，來報告該問題。`, inline: true }
        );

    const replyOptions = { embeds: [embed], files: files };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(replyOptions).catch(() => {});
    } else {
        await interaction.reply(replyOptions).catch(() => {});
    }
}

/**
 * 回覆成功訊息給使用者
 * @param {Interaction} interaction - Discord 的 interaction 物件
 * @param {string} successMessage - 成功訊息內容
 * @param {Array<Attachment>} [files] - 附加的檔案（可選）
 */
async function infoReply(interaction, successMessage, files = []) {
    const embed = new EmbedBuilder()
        .setTitle(`${EMBED_EMOJI_SUCCESS} ┃ 操作成功`)
        .setColor(EMBED_COLOR)
        .addFields(
            { name: successMessage, value: `　`, inline: true }
        );

    const replyOptions = { embeds: [embed], files: files };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(replyOptions).catch(() => {});
    } else {
        await interaction.reply(replyOptions).catch(() => {});
    }
}

module.exports = { errorReply, infoReply };
