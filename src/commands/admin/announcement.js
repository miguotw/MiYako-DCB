const path = require('path');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { getAdminCommandPath } = require(path.join(process.cwd(), 'core/commandPolicy'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.announcement.emoji;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('發送公告')
        .setDescription('發送公告到指定頻道並提及指定身分組')
        .addStringOption(option =>
            option.setName('訊息哀滴')
                .setDescription('請輸入要作為公告的訊息 ID')
                .setRequired(true)
        )
        .addChannelOption(option =>
            option.setName('選擇頻道')
                .setDescription('請選擇要發送公告的頻道')
                .setRequired(true)
        )
        .addRoleOption(option =>
            option.setName('選擇身分組')
                .setDescription('請選擇要提及的身分組')
                .setRequired(false) // 設為非必填
        ),
    async execute(interaction) {
        
        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: false });

        try {
            const messageId = interaction.options.getString('訊息哀滴'); // 使用者輸入的訊息 ID
            const channel = interaction.options.getChannel('選擇頻道'); // 使用者選擇的頻道
            const role = interaction.options.getRole('選擇身分組'); // 使用者選擇的身分組（可為空）

            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('發送公告')} 訊息哀滴(${messageId}) 選擇頻道(${channel}) 選擇身分組(${role})`, "INFO");

            // 嘗試獲取訊息內容
            try {
                const message = await interaction.channel.messages.fetch(messageId);
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
                infoReply(interaction, `**公告已發送到 ${channel}${role ? ` 並提及 ${role}` : ''}！**`);
            } catch (error) {
                sendLog(interaction.client, `❌ 在執行 ${getAdminCommandPath('發送公告')} 指令時發生錯誤`, "ERROR", error);
                return errorReply(interaction, '**無法找到該訊息 ID，請檢查以下內容！**\n 1. 機器人應具有 `讀取訊息歷史`、`檢視頻道`、`發送訊息`、`嵌入連結`、`提及身分組` 權限。\n 2. 確認訊息 ID 是否正確！');
            }
        } catch (error) {
            sendLog(interaction.client, `❌ 在執行 ${getAdminCommandPath('發送公告')} 指令時發生未預期的錯誤`, "ERROR", error);
            return errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**');
        }
    }
};
