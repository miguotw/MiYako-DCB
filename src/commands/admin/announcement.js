const { ChannelType, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createCommandPolicy } = require('../../../core/commandPolicy');
const { createLogTools } = require('../../../core/sendLog');
const { createReplyTools } = require('../../../core/Reply');
const { fetchSourceMessage } = require('../../../util/discordCommandInput');

function createCommand(config) {
const { getAdminCommandPath } = createCommandPolicy(config);
const { sendLog } = createLogTools(config);
const { errorReply, infoReply, validationReply } = createReplyTools(config);
const configCommands = config.commands;
// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.announcement.emoji;

const command = {
    data: new SlashCommandBuilder()
        .setName('發送公告')
        .setDescription('發送公告到指定頻道並提及指定身分組')
        .addStringOption(option =>
            option.setName('訊息id或連結')
                .setDescription('請輸入要作為公告的訊息 ID 或訊息連結')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option.setName('選擇頻道')
                .setDescription('請選擇要發送公告的文字頻道')
                // 在 Discord 選項介面只顯示伺服器的一般文字頻道。
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .addRoleOption(option =>
            option.setName('選擇身分組')
                .setDescription('請選擇要提及的身分組')
                .setRequired(false) // 設為非必填
        ),
    async execute(interaction, _context) {
        
        // 公告本體會發送到目標頻道；操作結果僅需讓執行指令的管理員看見。
        await interaction.deferReply({ ephemeral: true });

        try {
            const messageInput = interaction.options.getString('訊息id或連結', true);
            const channel = interaction.options.getChannel('選擇頻道'); // 使用者選擇的頻道
            const role = interaction.options.getRole('選擇身分組'); // 使用者選擇的身分組（可為空）

            // 保留執行時檢查，避免舊版已註冊指令或偽造 Interaction 傳入其他頻道類型。
            if (channel?.type !== ChannelType.GuildText) {
                return validationReply(interaction, '**請選擇伺服器的一般文字頻道！**');
            }

            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('發送公告')} 訊息id或連結(${messageInput}) 選擇頻道(${channel}) 選擇身分組(${role})`, "INFO");

            // 嘗試獲取訊息內容
            try {
                // ID 會從目前頻道讀取；連結則可指向目前伺服器中 Bot 有權讀取的其他頻道。
                const message = await fetchSourceMessage(interaction, messageInput);
                const messageContent = message.content; // 獲取訊息的內容
                const imageUrl = message.attachments.first()?.url || null; // 如果有圖片則取第一張
                // const guildIcon = interaction.guild.iconURL(); // 取得伺服器圖標

                // 創建嵌入內容
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle(`${EMBED_EMOJI} ┃ 公告`)
                    .setDescription(messageContent)

                if (imageUrl) embed.setImage(imageUrl); // 設置圖片
                // if (guildIcon) embed.setThumbnail(guildIcon); // 設置伺服器圖標

                // 根據是否有提供身分組來設置 content
                const content = role ? `${role}` : null;

                // 發送公告到指定頻道
                await channel.send({
                    content: content, // 如果有身分組則提及，否則為 null
                    embeds: [embed],
                    allowedMentions: { roles: role ? [role.id] : [] } // 確保可以提及指定身分組
                });

                // 提示已發送公告
                return infoReply(interaction, `**公告已發送到 ${channel}${role ? ` 並提及 ${role}` : ''}！**`);
            } catch (error) {
                if (error.isValidationError) return validationReply(interaction, `**${error.message}**`);
                return errorReply(interaction, error, { context: '發送公告' });
            }
        } catch (error) {
            return errorReply(interaction, error, { context: '發送公告' });
        }
    }
};
return command;
}

module.exports = { createCommand };
