const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../core/sendLog');
const { createReplyTools } = require('../../core/Reply');
const { getHitokoto } = require('../../util/getHitokoto');

// 導入設定檔內容
function createCommand(config) {
const { sendLog } = createLogTools(config);
const { errorReply } = createReplyTools(config);
const configCommands = config.commands;
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.hitokoto.emoji;

const command = {
    data: new SlashCommandBuilder()
        .setName('一言')
        .setDescription('獲取一條動漫相關的名言短句'),
        
    async execute(interaction, context) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: false });
        try {
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/一言`, "INFO");

            // 獲取短句
            const { hitokotoText, hitokotoFrom } = await getHitokoto({ http: context.http, signal: context.signal });

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
            return errorReply(interaction, error, { context: '取得一言內容' });
        }
    }
};
return command;
}

module.exports = { createCommand };
