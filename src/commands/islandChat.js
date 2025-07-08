const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { chatWithAI, getChatHistory, resetSessionCounter } = require(path.join(process.cwd(), 'util/getIslandChat'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI_LOADING = config.emoji.loading;
const EMBED_EMOJI = configCommands.islandChat.emoji;
const BOTNICKNAME = configCommands.islandChat.botNickname;
const INTRODUCE = configCommands.islandChat.introduce;
const MAX_LENGTH = configCommands.islandChat.limit.maxLength;

// 創建控制面板的 embed
function createChatPanelEmbed(botAvatar) {
    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 與「${BOTNICKNAME}」諮詢 (Beta2)`)
        .setThumbnail(botAvatar)
        .setDescription(INTRODUCE);
}

// 創建控制面板的按鈕
function createChatPanelButtons() {
    const startButton = new ButtonBuilder()
        .setCustomId('chat_start_button')
        .setLabel(`與「${BOTNICKNAME}」諮詢`)
        .setStyle(ButtonStyle.Primary);

    return new ActionRowBuilder().addComponents(startButton);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('諮詢')
        .setDescription('創建一個 AI 對話控制面板'),

    // 當指令被觸發時執行
    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            
            // 獲取機器人頭像
            const botAvatar = interaction.client.user.displayAvatarURL({ format: 'png', dynamic: true, size: 64 });
            
            // 發送控制面板
            const embed = createChatPanelEmbed(botAvatar);
            const buttons = createChatPanelButtons();
            
            await interaction.channel.send({
                embeds: [embed],
                components: [buttons]
            });
            
            infoReply(interaction, '**已創建 AI 對話控制面板！**');
            sendLog(interaction.client, `💬 ${interaction.user.tag} 執行了指令：/諮詢`, "INFO");
        } catch (error) {
            errorReply(interaction, `**諮詢 發生錯誤，原因：${error.message || '未知錯誤'}**`);
            sendLog(interaction.client, `❌ 在執行 諮詢 時發生錯誤：`, "ERROR", error);
        }
    },

    // 按鈕處理器
    buttonHandlers: {
        // 開始對話按鈕
        chat_start_button: async (interaction) => {
            try {
                const modal = new ModalBuilder()
                    .setCustomId('chat_modal')
                    .setTitle(`與「${BOTNICKNAME}」諮詢 (Beta2)`);

                const messageInput = new TextInputBuilder()
                    .setCustomId('message')
                    .setLabel("輸入您的疑問")
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('例如：我可以蓋生怪塔嗎？')
                    .setRequired(true)
                    .setMaxLength(MAX_LENGTH);

                const actionRow = new ActionRowBuilder().addComponents(messageInput);
                modal.addComponents(actionRow);
                
                await interaction.showModal(modal);
            } catch (error) {
                errorReply(interaction, `**諮詢 與「${BOTNICKNAME}」諮詢 發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 諮詢 與「${BOTNICKNAME}」諮詢 時發生錯誤：`, "ERROR", error);
            }
        }
    },

    // Modal 提交處理器
    modalSubmitHandlers: {
        chat_modal: async (interaction) => {
            try {
                // 顯示等待提示
                await interaction.deferReply({ ephemeral: true });
                const waitMsg = await interaction.followUp({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(EMBED_COLOR)
                            .setTitle(`${EMBED_EMOJI} ┃ 與「${BOTNICKNAME}」諮詢 (Beta2)`)
                            .setDescription(`正在努力思考 ${EMBED_EMOJI_LOADING}`)
                    ],
                    ephemeral: true
                });

                const message = interaction.fields.getTextInputValue('message');
                const userId = interaction.user.id;
                const username = interaction.user.username;
                
                sendLog(interaction.client, `💬 ${interaction.user.tag} 提交了 諮詢 互動視窗：\n${message}`, "INFO");

                // 獲取 AI 回應
                const startTime = Date.now();
                const chatResponse = await chatWithAI(userId, message);
                const endTime = Date.now();
                const duration = Math.round((endTime - startTime) / 1000);
                
                // 刪除等待訊息
                await waitMsg.delete().catch(() => {});
                
                // 創建回應 embed
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`${EMBED_EMOJI} ┃ 與「${BOTNICKNAME}」諮詢 (Beta2)`)
                    .addFields(
                        { name: `${username} 的訊息`, value: message, inline: false },
                        { name: `${BOTNICKNAME} 的回應`, value: chatResponse, inline: false }
                    )
                    .setFooter({ text: `耗時 ${duration} 秒 | 內容由 AI 進行回應，可能存在疏漏，請仔細甄別。` });
                
                // 發送回應
                await interaction.followUp({ embeds: [embed], ephemeral: true });
                sendLog(interaction.client, `💬 ${interaction.user.tag} 取得了 諮詢 回應內容：\n${chatResponse}`, "INFO");

            } catch (error) {
                if (error.message.includes('工作階段對話次數上限')) {
                    errorReply(interaction, `**${error.message}**\n-# 此限制會在工作階段結束後自動重置。\n`);
                    sendLog(interaction.client, `❌ ${interaction.user.tag} 嘗試取得 諮詢 回應內容，但工作階段對話次數達到上限：`, "ERROR", error);

                } else {
                    errorReply(interaction, `**諮詢 發生錯誤，原因：${error.message || '未知錯誤'}**`);
                    sendLog(interaction.client, `❌ 在執行 諮詢 時發生錯誤：`, "ERROR", error);
                }
            }
        }
    }
};
