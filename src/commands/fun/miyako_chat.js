const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/errorReply'));
const { chatWithDeepseek, exportChatHistory, deleteChatHistory } = require(path.join(process.cwd(), 'util/getMiyakoChat'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.Miyako_Chat;
const BOTNICKNAME = config.About.Bot_Nicdname;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(`與${BOTNICKNAME}聊天`)
        .setDescription(`與${BOTNICKNAME}進行聊天或管理聊天歷史`)
        .addSubcommand(subcommand =>
            subcommand
                .setName('傳送訊息')
                .setDescription(`與${BOTNICKNAME}進行聊天`)
                .addStringOption(option =>
                    option.setName('訊息')
                        .setDescription(`輸入要發送給${BOTNICKNAME}的訊息（內容將由 AI 生成，請仔細甄別）`)
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('管理歷史紀錄')
                .setDescription('管理您的聊天歷史紀錄')
                .addStringOption(option =>
                    option.setName('操作')
                        .setDescription('選擇要執行的操作')
                        .setRequired(true)
                        .addChoices(
                            { name: '匯出紀錄', value: 'export' },
                            { name: '刪除紀錄', value: 'delete' }
                        ))),

    async execute(interaction) {
        // 啟用延遲回覆
        await interaction.deferReply();

        try {
            const userId = interaction.user.id; // 獲取用戶 ID
            const subcommand = interaction.options.getSubcommand(); // 獲取子指令名稱

            // 根據子指令執行相應的功能
            switch (subcommand) {
                case '傳送訊息': {
                    const message = interaction.options.getString('訊息');
                    const username = interaction.user.username; // 獲取用戶名

                    // 發送執行指令的摘要到 sendLog
                    sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/與${BOTNICKNAME}聊天 傳送訊息(${message})`, "INFO");

                    // 使用工具函數與 Deepseek AI 進行聊天
                    const chatResponse = await chatWithDeepseek(userId, message);

                    // 創建嵌入訊息
                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle(`${EMBED_EMOJI} ┃ 與${BOTNICKNAME}聊天`)
                        .addFields(
                            { name: `${username} 的訊息`, value: message, inline: false },
                            { name: `${BOTNICKNAME}的回應`, value: chatResponse, inline: false }
                        );

                    // 回覆訊息
                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                case '管理歷史紀錄': {
                    const operation = interaction.options.getString('操作');

                    switch (operation) {
                        case 'export': {
                            // 匯出聊天歷史
                            const filePath = exportChatHistory(userId);
                            const file = new AttachmentBuilder(filePath, { name: `miyako_chat_${userId}.json` });

                            await interaction.editReply({ content: '這是您的聊天歷史紀錄：', files: [file] });
                            break;
                        }

                        case 'delete': {
                            // 刪除聊天歷史
                            deleteChatHistory(userId);
                            await interaction.editReply({ content: '已刪除您的聊天歷史紀錄！' });
                            break;
                        }
                    }
                    break;
                }
            }

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /與${BOTNICKNAME}聊天 指令時發生錯誤：`, "ERROR", error); // 記錄錯誤日誌
            errorReply(interaction, `**無法完成操作，原因：${error.message || '未知錯誤'}**`); // 向用戶顯示錯誤訊息
        }
    }
};