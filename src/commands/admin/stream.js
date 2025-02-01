const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');
const axios = require('axios');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8'); // 根據你的專案結構調整路徑
const config = yaml.parse(configFile);

const TWITCH_CLIENT_ID = config.API.Twitch.Client_ID;
const TWITCH_ACCESS_TOKEN = config.API.Twitch.Access_Token;
const TWITCH_USER_LOGIN = config.Stream.User_Login;
const MESSAGE_STREAM = config.Message.Stream;
const TWITCH_USER_AVATAR = config.Stream.User_Avatar;
const EMBED_COLOR = config.Embed_Color;  // 嵌入介面顏色

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
        // 檢查使用者是否具有管理者權限
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: '你必須是伺服器的管理者才能使用此指令！',
                ephemeral: true
            });
        }

        const roleId = '1119629095437865042'; // 身分組 ID
        const streamTitle = interaction.options.getString('標題'); // 使用者輸入的標題
        const randomValue = Math.floor(100000 + Math.random() * 900000); // 生成隨機數以避免快取
        const randomMessage = MESSAGE_STREAM[Math.floor(Math.random() * MESSAGE_STREAM.length)]; // 隨機選擇一條訊息

        // 創建嵌入內容
        const embed = new EmbedBuilder()
            .setAuthor({ 
                name: '🍘 ┃ 直播通知'
            })
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
            content: `<@&${roleId}> ${randomMessage}`,
            embeds: [embed],
            components: [row],  // 添加按鈕
            allowedMentions: { roles: [roleId] }
        });

        // 提示已發送公告
        await interaction.reply({
            content: '公告已發送！',
            ephemeral: true
        });
    }
};