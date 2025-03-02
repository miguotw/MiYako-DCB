const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));

// 導入設定檔內容
const EMBED_COLOR_ERROR = config.Embed_Color_error;  
const EMBED_EMOJI = config.Emoji.Error_Reply;
const REPOSITORY = config.About.Repository;
const PROVIDER = config.About.Provider;

/**
// 回覆錯誤訊息給使用者
 * @param {Interaction} interaction - Discord 的 interaction 物件
 * @param {string} errorMessage - 錯誤訊息內容
 */
async function errorReply(interaction, errorMessage) {
    const embed = new EmbedBuilder()
        .setTitle(`${EMBED_EMOJI} ┃ 執行時失敗`)
        .setColor(EMBED_COLOR_ERROR)
        .addFields(
            { name: errorMessage, value: `-# 如果您認為這是機器人本身的問題，請至 [GitHub 儲存庫](${REPOSITORY}) 建立一個 Issue，或與 <@${PROVIDER}> 聯繫，來報告該問題。`, inline: true }
        );

    await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
}

module.exports = { errorReply };
