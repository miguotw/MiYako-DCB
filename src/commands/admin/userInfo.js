const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, escapeMarkdown } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { getAdminCommandPath } = require(path.join(process.cwd(), 'core/commandPolicy'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/Reply'));

const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.userInfo.emoji;

function displayValue(value) {
    return escapeMarkdown(String(value));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('擷取用戶資料')
        .setDescription('透過 Discord 用戶選項查詢用戶基本資料')
        .addUserOption(option =>
            option.setName('用戶')
                .setDescription('請選擇或提及要查詢的用戶')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        const selectedUser = interaction.options.getUser('用戶', true);
        sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：${getAdminCommandPath('擷取用戶資料')} 用戶(${selectedUser.id})`, 'INFO');

        try {
            // 重新取得完整 User，以便 Discord 有提供時一併取得 Banner 資料。
            const user = await interaction.client.users.fetch(selectedUser.id, { force: true });
            const member = interaction.options.getMember('用戶')
                || await interaction.guild.members.fetch(selectedUser.id).catch(() => null);
            const avatarURL = user.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: false });
            const bannerURL = user.bannerURL({ extension: 'png', size: 1024, forceStatic: false });
            const displayName = member?.displayName || user.globalName || user.username;
            const createdTimestamp = Math.floor(user.createdTimestamp / 1000);

            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ ${displayValue(displayName)} 的用戶資料`)
                .setThumbnail(avatarURL)
                .addFields(
                    { name: '名稱', value: displayValue(user.username), inline: true },
                    { name: '暱稱', value: displayValue(displayName), inline: true },
                    { name: '機器人', value: user.bot ? '是' : '否', inline: true },
                    { name: '用戶 ID', value: `||${user.id}||`, inline: false },
                    { name: '建立時間', value: `<t:${createdTimestamp}:F>（<t:${createdTimestamp}:R>）`, inline: false },
                    { name: '頭貼', value: `[開啟原圖](${avatarURL})`, inline: true },
                    { name: '背景圖', value: bannerURL ? `[開啟原圖](${bannerURL})` : '未設定', inline: true }
                )
                .setFooter({ text: `查詢者：${interaction.user.username}` })
                .setTimestamp();

            if (bannerURL) embed.setImage(bannerURL);
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            sendLog(interaction.client, `❌ 在執行 ${getAdminCommandPath('擷取用戶資料')} 指令時發生錯誤：`, 'ERROR', error);

            await errorReply(interaction, '**無法取得該用戶的資料，請稍後再試一次。**');
        }
    }
};
