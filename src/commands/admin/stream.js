const path = require('path');
const axios = require('axios');
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

// 導入設定檔內容
const TWITCH_CLIENT_ID = config.API.Twitch.Client_ID;
const TWITCH_ACCESS_TOKEN = config.API.Twitch.Access_Token;
const MESSAGE_STREAM = config.Message.Stream;
const TWITCH_USER_AVATAR = config.Stream.User_Avatar;
const TWITCH_USER_LOGIN = config.Stream.User_Login;
const ROLE = config.Stream.Role;
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.Stream;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('直播')
        .setDescription('發送直播通知')
        .addStringOption(option =>
            option.setName('標題')
                .setDescription('請輸入直播標題')
                .setRequired(true)
        ),
    async execute(interaction) {

        //啟用延遲回覆
        await interaction.deferReply({ ephemeral: false });

        try {
            // 檢查使用者是否具有管理者權限
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return errorReply(interaction, '**你必須是伺服器的管理者才能使用此指令！**');
            }

            const streamTitle = interaction.options.getString('標題'); // 使用者輸入的標題

            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/直播 標題(${streamTitle})`, "INFO");


            const roleId = ROLE && ROLE.trim() !== '' ? `<@&${ROLE}>` : '@everyone'; // 若 ROLE 為空則提及 everyone
            const randomValue = Math.floor(100000 + Math.random() * 900000); // 生成隨機數以避免快取
            const randomMessage = MESSAGE_STREAM[Math.floor(Math.random() * MESSAGE_STREAM.length)]; // 隨機選擇一條訊息

            // 創建嵌入內容
            const embed = new EmbedBuilder()
                .setAuthor({ name: `🍘 ┃ 直播通知`})
                .setColor(EMBED_COLOR)
                .setTitle(streamTitle)
                .setURL(`https://www.twitch.tv/${TWITCH_USER_LOGIN}`)
                .setThumbnail(TWITCH_USER_AVATAR)
                .setImage(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${TWITCH_USER_LOGIN}-1280x720.jpg?r=${randomValue}`)
                .setTimestamp();

            // 創建觀看直播的按鈕
            const watchButton = new ButtonBuilder()
                .setLabel('前往觀看直播')  // 按鈕顯示的文字
                .setURL(`https://www.twitch.tv/${TWITCH_USER_LOGIN}`)  // 按鈕點擊後的跳轉網址
                .setStyle(ButtonStyle.Link);  // 設定為鏈接樣式

            // 將按鈕放進行動列
            const row = new ActionRowBuilder().addComponents(watchButton);
            
            // 發送消息，包含嵌入內容和按鈕
            await interaction.channel.send({
                content: `${roleId} ${randomMessage}`,
                embeds: [embed],
                components: [row],  // 添加按鈕
                allowedMentions: { parse: ['everyone', 'roles'] } // 確保可提及 everyone 或 roles
            });

            // 提示已發送公告
            await interaction.editReply({
                content: '公告已發送！',
                ephemeral: true
            });

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /直播 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
            return errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**'); // 向用戶顯示錯誤訊息
        }
    }
};