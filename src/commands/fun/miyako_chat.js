const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { chatWithDeepseek, exportChatHistory, deleteChatHistory, updateSystemPrompt, getChatHistory } = require(path.join(process.cwd(), 'util/getMiyakoChat'));

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
                            { name: '編輯系統提示詞', value: 'edit' },
                            { name: '匯出聊天紀錄', value: 'export' },
                            { name: '刪除聊天紀錄', value: 'delete' }
                        ))),

    async execute(interaction) {
        try {
            const userId = interaction.user.id; // 獲取用戶 ID
            const subcommand = interaction.options.getSubcommand(); // 獲取子指令名稱

            // 根據子指令執行相應的功能
            switch (subcommand) {
                case '傳送訊息': {
                    // 啟用延遲回覆
                    await interaction.deferReply({ ephemeral: false });

                    const message = interaction.options.getString('訊息');
                    const username = interaction.user.username; // 獲取用戶名

                    // 發送執行指令的摘要到 sendLog
                    sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/與${BOTNICKNAME}聊天 傳送訊息`, "INFO");

                    // 獲取 AI 回應
                    const chatResponse = await chatWithDeepseek(userId, message);

                    // 創建嵌入訊息
                    const embed = new EmbedBuilder()
                        .setColor(EMBED_COLOR)
                        .setTitle(`${EMBED_EMOJI} ┃ 與${BOTNICKNAME}聊天`)
                        .addFields(
                            { name: `${username} 的訊息`, value: message, inline: false },
                            { name: `${BOTNICKNAME}的回應`, value: chatResponse, inline: false }
                        );

                    await interaction.editReply({ embeds: [embed] });
                    break;
                }

                case '管理歷史紀錄': {
                    const operation = interaction.options.getString('操作');

                    switch (operation) {
                        case 'edit': {
                            // 讀取用戶的聊天歷史，若有系統提示詞則預設為現有值，否則使用 config 裡的預設提示詞
                            let chatHistory = getChatHistory(userId);
                            let existingPrompt = '';
                            if (chatHistory.length > 0 && chatHistory[0].role === "system") {
                                existingPrompt = chatHistory[0].content;
                            } else {
                                const { config } = require(path.join(process.cwd(), 'core/config'));
                                existingPrompt = config.Commands.Miyako_Chat.prompt;
                            }
                            
                            // 建立一個 Modal 供用戶輸入新的系統提示詞
                            const modal = new ModalBuilder()
                                .setCustomId('editSystemPromptModal')
                                .setTitle('編輯系統提示詞');
                            
                            const promptInput = new TextInputBuilder()
                                .setCustomId('systemPrompt')
                                .setLabel("請編輯系統提示詞")
                                .setStyle(TextInputStyle.Paragraph)
                                .setValue(existingPrompt);
                            
                            const actionRow = new ActionRowBuilder().addComponents(promptInput);
                            modal.addComponents(actionRow);
                            
                            // 顯示 Modal
                            await interaction.showModal(modal);
                            break;
                        }

                        case 'export': {
                            // 啟用延遲回覆
                            await interaction.deferReply({ ephemeral: false });

                            // 匯出聊天歷史
                            const filePath = exportChatHistory(userId);
                            const file = new AttachmentBuilder(filePath, { name: `miyako_chat_${userId}.json` });
                            
                            infoReply(interaction, '**已匯出您的聊天歷史紀錄！**', [file]);
                            break;
                        }

                        case 'delete': {
                            // 啟用延遲回覆
                            await interaction.deferReply({ ephemeral: false });

                            // 刪除聊天歷史
                            deleteChatHistory(userId);
                            infoReply(interaction, '**已刪除您的聊天歷史紀錄！**');
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

// 處理 Modal 提交的函式
module.exports.modalSubmit = async (interaction) => {
    if (interaction.customId === 'editSystemPromptModal') {
        try {
            const newPrompt = interaction.fields.getTextInputValue('systemPrompt');
            const userId = interaction.user.id;

            // 更新系統提示詞
            updateSystemPrompt(userId, newPrompt);

            // 回覆用戶
            infoReply(interaction, '**系統提示詞已更新！**');
        } catch (error) {
            // 捕獲並記錄錯誤
            sendLog(interaction.client, '❌ 在更新系統提示詞時發生錯誤：', "ERROR", error);
            errorReply(interaction, `**更新失敗，原因：${error.message}**`);
        }
    }
};