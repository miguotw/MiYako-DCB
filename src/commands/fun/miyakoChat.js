const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { chatWithDeepseek, exportChatHistory, deleteChatHistory, updateSystemPrompt, getChatHistory, saveChatHistory } = require(path.join(process.cwd(), 'util/getMiyakoChat'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.miyakoChat.emoji;
const PROMPT = configCommands.miyakoChat.prompt;
const BOTNICKNAME = configCommands.about.botNickname;

// 獲取語言模型選項
const models = configCommands.miyakoChat.models;
const modelChoices = Object.keys(models).map(key => ({
    name: models[key].name,
    value: key
}));

module.exports = {
    data: new SlashCommandBuilder()
        .setName(`與${BOTNICKNAME}聊天`)
        .setDescription(`與${BOTNICKNAME}進行聊天或管理聊天歷史`)
        .addSubcommand(subcommand =>
            subcommand
                .setName('傳送訊息')
                .setDescription(`與${BOTNICKNAME}進行聊天`)
                .addStringOption(option =>
                    option.setName('模型')
                        .setDescription('選擇要使用的語言模型')
                        .setRequired(true)
                        .addChoices(...modelChoices))
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
                            { name: '編輯最近的回應', value: 'editLastResponse' },
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
                const modelKey = interaction.options.getString('模型') || '01'; // 默認使用第一個模型
                const username = interaction.user.username; // 獲取用戶名
                        
                // 發送執行指令的摘要到 sendLog
                   sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/與${BOTNICKNAME}聊天 傳送訊息`, "INFO");
                        
                // 獲取 AI 回應
                const chatResponse = await chatWithDeepseek(userId, message, modelKey);
                        
                // 創建嵌入訊息
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`${EMBED_EMOJI} ┃ 與${BOTNICKNAME}聊天`)
                    .addFields(
                        { name: `${username} 的訊息`, value: message, inline: false },
                        { name: `${BOTNICKNAME}的回應`, value: chatResponse, inline: false },
                        { name:``, value: `-# 使用 ${models[modelKey].name} 模型`, inline: false }
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
                            existingPrompt = PROMPT;
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
                    
                    case 'editLastResponse': {
                        // 獲取用戶的聊天歷史
                        const chatHistory = getChatHistory(userId);

                        // 檢查是否有 AI 回應
                        const lastAssistantMsg = chatHistory.reverse().find(msg => msg.role === "assistant");
                        if (!lastAssistantMsg) {
                            return errorReply(interaction, '**找不到最近的 AI 回應！**');
                        }

                        // 建立 Modal
                        const modal = new ModalBuilder()
                            .setCustomId('editLastResponseModal')
                            .setTitle('編輯最近的回應');

                        const responseInput = new TextInputBuilder()
                            .setCustomId('newResponse')
                            .setLabel("編輯 AI 的回應內容")
                            .setStyle(TextInputStyle.Paragraph)
                            .setValue(lastAssistantMsg.content);

                        const actionRow = new ActionRowBuilder().addComponents(responseInput);
                        modal.addComponents(actionRow);

                        await interaction.showModal(modal);
                        break;
                    }

                    case 'export': {
                        // 啟用延遲回覆
                        await interaction.deferReply({ ephemeral: false });

                        // 匯出聊天歷史
                        const filePath = exportChatHistory(userId);
                        const file = new AttachmentBuilder(filePath, { name: `miyakoChat_${userId}.json` });
                            
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

    } else if (interaction.customId === 'editLastResponseModal') {
        try {
            const newResponse = interaction.fields.getTextInputValue('newResponse');
            const userId = interaction.user.id;
            const username = interaction.user.username;

            // 獲取聊天紀錄
            const chatHistory = getChatHistory(userId);

            // 找到最後一則 assistant 訊息的「正向索引」
            const lastAssistantIndex = chatHistory.reduce((acc, msg, index) => {
                if (msg.role === 'assistant') acc = index;
                return acc;
            }, -1);

            if (lastAssistantIndex === -1) {
                return errorReply(interaction, '**找不到可編輯的回應！**');
            }

            // 更新回應內容（保持 role 為 assistant）
            chatHistory[lastAssistantIndex].content = newResponse;
            saveChatHistory(userId, chatHistory);

            // 獲取對應的用戶訊息（最後一則 user 訊息）
            const lastUserMessage = chatHistory.slice(0, lastAssistantIndex)
                .reverse()
                .find(msg => msg.role === 'user')?.content || "找不到先前的用戶訊息";

            // 構建與「傳送訊息」相同格式的 Embed
            const embed = new EmbedBuilder()
                .setColor(config.embed.color.default)  // 使用 config 中的顏色設定
                .setTitle(`${configCommands.miyakoChat.emoji} ┃ 與${configCommands.about.botNickname}聊天`)
                .addFields(
                    { name: `${username} 的訊息`, value: lastUserMessage, inline: false },
                    { name: `${configCommands.about.botNickname}的回應`, value: newResponse, inline: false },
                    { name:``, value: `-# 已被 ${username} 編輯`, inline: false }
                );

            // 發送 Embed
            await interaction.reply({ embeds: [embed], ephemeral: false });
            
        } catch (error) {
            sendLog(interaction.client, '❌ 編輯最近回應失敗：', "ERROR", error);
            errorReply(interaction, `**更新失敗：${error.message}**`);
        }
    }
};