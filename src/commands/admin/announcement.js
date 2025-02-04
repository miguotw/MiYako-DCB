const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { sendLog } = require('../../../log');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8');
const config = yaml.parse(configFile);

const EMBED_COLOR = config.Embed_Color;  // 嵌入介面顏色

module.exports = {
    data: new SlashCommandBuilder()
        .setName('公告')
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
        try {
            // 檢查使用者是否具有管理者權限
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({
                    content: '你必須是伺服器的管理者才能使用此指令！',
                    ephemeral: true
                });
            }

            const messageId = interaction.options.getString('訊息哀滴'); // 使用者輸入的訊息 ID
            const channel = interaction.options.getChannel('選擇頻道'); // 使用者選擇的頻道
            const role = interaction.options.getRole('選擇身分組'); // 使用者選擇的身分組（可為空）

            // 嘗試獲取訊息內容
            try {
                const message = await interaction.channel.messages.fetch(messageId);
                const messageContent = message.content; // 獲取訊息的內容

                // 創建嵌入內容
                const embed = new EmbedBuilder()
                    .setColor(EMBED_COLOR)
                    .setTitle('📢 ┃ 公告')
                    .setDescription(messageContent)
                    .setTimestamp();

                // 根據是否有提供身分組來設置 content
                const content = role ? `${role}` : null;

                // 發送公告到指定頻道
                await channel.send({
                    content: content, // 如果有身分組則提及，否則為 null
                    embeds: [embed],
                    allowedMentions: { roles: role ? [role.id] : [] } // 確保可以提及指定身分組
                });

                // 提示已發送公告
                await interaction.reply({
                    content: `公告已發送到 ${channel.name}${role ? ` 並提及 ${role.name}` : ''}！`,
                    ephemeral: true
                });
            } catch (error) {
                sendLog(interaction.client, `❌ 在執行 /公告 指令時發生錯誤`, "ERROR", error);
                await interaction.reply({
                    content: '無法找到該訊息 ID，請確認訊息 ID 是否正確！',
                    ephemeral: true
                });
            }
        } catch (error) {
            sendLog(interaction.client, `❌ 在執行 /公告 指令時發生未預期的錯誤`, "ERROR", error);
            await interaction.reply({
                content: '發生未預期的錯誤，請稍後再試！',
                ephemeral: true
            });
        }
    }
};