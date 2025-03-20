const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const LOADING_EMOJI = config.emoji.loading;
const EMBED_EMOJI = configCommands.deepseek.emoji;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('deepseek')
        .setDescription('向機器人提出需要思考的問題')
        .addStringOption(option =>
            option.setName('問題')
                .setDescription('輸入您要詢問的內容')
                .setRequired(false)),

    async execute(interaction) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: false });

        try {
            const question = interaction.options.getString('問題'); // 獲取使用者輸入的問題

            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/deepseek 問題(${question})`, "INFO");

            // 創建嵌入訊息
            const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR) // 設置顏色
            .setTitle(`${EMBED_EMOJI} ┃ DeepSeek`)  // 標題
            .setDescription(`思考中 ${LOADING_EMOJI}`)

            // 發送初始 Embed
            await interaction.editReply({
                embeds: [embed],
            });

            // 5 秒後更新 Embed
            setTimeout(async () => {
                try {
                    const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR) // 設置顏色
                    .setTitle(`${EMBED_EMOJI} ┃ DeepSeek`)  // 標題
                    .setDescription('服务器繁忙，请稍后再试。')

                    await interaction.editReply({
                        embeds: [embed]
                    });
                } catch (error) {
                    sendLog(interaction.client, `❌ 更新 Embed 時發生錯誤：`, "ERROR", error); // 記錄錯誤日誌
                    errorReply(interaction, '**更新 Embed 時發生錯誤**'); // 向用戶顯示錯誤訊息
                }
            }, 5000);

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 執行指令時發生錯誤：`, "ERROR", error); // 記錄錯誤日誌
            errorReply(interaction, '**執行指令時發生錯誤**'); // 向用戶顯示錯誤訊息
        }
    }
};
