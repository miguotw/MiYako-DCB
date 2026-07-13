const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/Reply'));
const { getHitokoto } = require(path.join(process.cwd(), 'util/getHitokoto'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.hitokoto.emoji;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('一言')
        .setDescription('獲取一條動漫相關的名言短句'),
        
    async execute(interaction) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: false });
        try {
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/一言`, "INFO");

            // 獲取短句
            const { hitokotoText, hitokotoFrom } = await getHitokoto();

            // 創建嵌入訊息
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR) // 設置顏色
                .setTitle(`${EMBED_EMOJI} ┃ 一言`)  // 標題
                .addFields({
                    name: hitokotoText, // 顯示短句
                    value: hitokotoFrom || '未知', // 顯示來源，如果沒有來源則顯示 '未知'
                })
                .setFooter({text: '使用 Hitokoto 語句 API' }); // 頁腳文字
                
            // 發送嵌入訊息
            await interaction.editReply({
                embeds: [embed],
            });
            
        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /一言 指令時發生錯誤：`, "ERROR", error); // 記錄錯誤日誌
            return errorReply(interaction, error, { context: '取得一言內容' });
        }
    }
};
