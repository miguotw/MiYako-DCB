const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');

const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);
const EMBED_COLOR_ERROR = config.Embed_Color_error;  // 嵌入介面顏色

/**
 * 回覆錯誤訊息給使用者
 * @param {Interaction} interaction - Discord 的 interaction 物件
 * @param {string} errorMessage - 錯誤訊息內容
 */
async function errorReply(interaction, errorMessage) {
    const embed = new EmbedBuilder()
        .setTitle('錯誤 / 無權限')
        .setColor(EMBED_COLOR_ERROR)
        .setDescription(errorMessage)

    await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
}

module.exports = { errorReply };
