const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/errorReply'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.Ping;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('延遲')
        .setDescription('測試機器人延遲'),
    async execute(interaction) {
        try {
            
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/延遲`, "INFO");

            const latency = Math.abs(Date.now() - interaction.createdTimestamp); // 計算延遲
        
            // 創建一個嵌入訊息
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR) // 設置顏色
                .setTitle(`${EMBED_EMOJI} ┃ 乓！`)  // 標題
                .setDescription(`機器人延遲延遲: ${latency}ms`) // 顯示延遲時間
                .setTimestamp();  // 加入時間戳

            // 回應只對使用者可見
            await interaction.editReply({ embeds: [embed], ephemeral: true });
            
        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /延遲 指令時發生錯誤`, "ERROR", error);
            return errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**');
        }
    }
};
