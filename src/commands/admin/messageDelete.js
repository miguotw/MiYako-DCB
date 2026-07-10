const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const LOADING_EMOJI = config.emoji.loading;
const EMBED_EMOJI = configCommands.admin.messageDelete.emoji;
const DELETE_LIMIT = Math.min(configCommands.admin.messageDelete.deleteLimit || 100, 100); //讀取最大刪除數量，當設定值超過 100 時，限制最大值為 100
const DISCORD_BULK_DELETE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;
const MESSAGE_DELETE_DELAY_MS = 1000;

async function deleteMessagesIndividually(interaction, messages) {
    let deletedCount = 0;

    for (const message of messages) {
        try {
            await message.delete();
            deletedCount++;

            await new Promise(resolve => setTimeout(resolve, MESSAGE_DELETE_DELAY_MS));
        } catch (error) {
            sendLog(interaction.client, `❌ 在執行 /刪除訊息 指令時發生錯誤，無法刪除訊息 ID: ${message.id}`, "ERROR", error);
            throw new Error(`無法刪除訊息 ID: ${message.id}`);
        }
    }

    return deletedCount;
}

async function getMessageChannel(interaction) {
    const channel = interaction.channel || await interaction.client.channels.fetch(interaction.channelId).catch(() => null);

    if (!channel?.messages) {
        throw new Error('無法取得目前頻道的訊息列表。');
    }

    return channel;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('刪除訊息')
        .setDescription('批量刪除訊息')
        .addIntegerOption(option =>
            option.setName('數量')
                .setDescription(`要刪除的訊息數量 (1~${DELETE_LIMIT})`)
                .setRequired(true)
        ),
    async execute(interaction) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: true });

        try {
            const isGuildCommand = interaction.inGuild();

            // 檢查使用者是否具有管理者權限，私訊中不需要伺服器權限。
            if (isGuildCommand && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return errorReply(interaction, '**你必須是伺服器的管理者才能使用此指令！**');
            }

            const amount = interaction.options.getInteger('數量');
            
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/刪除訊息 數量(${amount})`, "INFO");

            // 確保刪除的訊息數量在合理範圍內 (1-DELETE_LIMIT)
            if (amount < 1 || amount > DELETE_LIMIT) {
                return errorReply(interaction, `**請輸入一個介於 1 到 ${DELETE_LIMIT} 之間的數字！**`);
            }

            // 提示開始刪除
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR) // 設置顏色
                .setTitle(`${EMBED_EMOJI} ┃ 刪除訊息`)  // 標題
                .setDescription(`正在刪除 ${amount} 條訊息，這可能需要一些時間 ${LOADING_EMOJI}`)

            const progressMessage = await interaction.editReply({
                embeds: [embed],
                ephemeral: true
            });

            let deletedCount = 0;
            const channel = await getMessageChannel(interaction);

            // 私訊中只能刪除 Bot 自己發出的訊息。
            if (!isGuildCommand) {
                const messages = await channel.messages.fetch({ limit: 100 });
                const botMessages = messages
                    .filter(message => message.author.id === interaction.client.user.id)
                    .filter(message => message.id !== progressMessage.id)
                    .first(amount);

                deletedCount = await deleteMessagesIndividually(interaction, botMessages);

                const embed_done = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('🗑️ ┃ 刪除訊息')
                    .setDescription(`已成功刪除 ${deletedCount} 條由 Bot 發出的訊息！`)

                return interaction.editReply({
                    embeds: [embed_done],
                });
            }

            // 獲取頻道中的訊息
            const messages = await channel.messages.fetch({ limit: amount });

            // 分離 14 天內和超過 14 天的訊息
            const recentMessages = [];
            const oldMessages = [];

            messages.forEach(message => {
                if (Date.now() - message.createdTimestamp <= DISCORD_BULK_DELETE_LIMIT_MS) {
                    recentMessages.push(message);
                } else {
                    oldMessages.push(message);
                }
            });

            // 批量刪除 14 天內的訊息
            if (recentMessages.length > 0) {
                await channel.bulkDelete(recentMessages, true);
                deletedCount += recentMessages.length;
            }

            // 逐條刪除超過 14 天的訊息
            deletedCount += await deleteMessagesIndividually(interaction, oldMessages);

            // 提示刪除完成
            const embed_done = new EmbedBuilder()
                .setColor(EMBED_COLOR) // 設置顏色
                .setTitle('🗑️ ┃ 刪除訊息')  // 標題
                .setDescription(`已成功刪除 ${deletedCount} 條訊息！`)

            await interaction.editReply({
                embeds: [embed_done],
            });

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /刪除訊息 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
            return errorReply(interaction, `**${error.message || '發生未預期的錯誤，請向開發者回報！'}**`); // 向用戶顯示錯誤訊息
        }
    }
};
