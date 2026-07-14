const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createCommandPolicy } = require('../../../core/commandPolicy');
const { createLogTools } = require('../../../core/sendLog');
const { createReplyTools } = require('../../../core/Reply');

function createCommand(config) {
const { getAdminCommandPath } = createCommandPolicy(config);
const { sendLog } = createLogTools(config);
const { errorReply, infoReply, validationReply } = createReplyTools(config);
const configCommands = config.commands;
// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const LOADING_EMOJI = config.emoji.loading;
const EMBED_EMOJI = configCommands.messageDelete.emoji;
const DELETE_LIMIT = Math.min(configCommands.messageDelete.deleteLimit || 100, 100); //讀取最大刪除數量，當設定值超過 100 時，限制最大值為 100
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
            sendLog(interaction.client, `❌ 在執行 ${getAdminCommandPath('刪除訊息')} 指令時發生錯誤，無法刪除訊息 ID: ${message.id}`, "ERROR", error);
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

const command = {
    data: new SlashCommandBuilder()
        .setName('刪除訊息')
        .setDescription('批量刪除訊息')
        .addIntegerOption(option =>
            option.setName('數量')
                .setDescription(`要刪除的訊息數量 (1~${DELETE_LIMIT})`)
                .setRequired(true)
        ),
    async execute(interaction, _context) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: true });

        try {
            const isGuildCommand = interaction.inGuild();

            const amount = interaction.options.getInteger('數量');
            
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('刪除訊息')} 數量(${amount})`, "INFO");

            // 確保刪除的訊息數量在合理範圍內 (1-DELETE_LIMIT)
            if (amount < 1 || amount > DELETE_LIMIT) {
                return validationReply(interaction, `**請輸入一個介於 1 到 ${DELETE_LIMIT} 之間的數字！**`);
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

                return infoReply(interaction, `**已成功刪除 ${deletedCount} 條由 Bot 發出的訊息！**`);
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

            // 完成狀態使用全專案一致的成功回覆樣式。
            return infoReply(interaction, `**已成功刪除 ${deletedCount} 條訊息！**`);

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 ${getAdminCommandPath('刪除訊息')} 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
            return errorReply(interaction, error, { context: '刪除 Discord 訊息' });
        }
    }
};
return command;
}

module.exports = { createCommand };
