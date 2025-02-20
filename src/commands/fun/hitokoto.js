const path = require('path');
const axios = require('axios');
const OpenCC = require('opencc-js');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));
const { errorReply } = require(path.join(process.cwd(), 'core/error_reply'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.Hitokoto;
const HITOKOTO = config.API.Hitokoto;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('一言')
        .setDescription('獲取一條動漫相關的名言短句'),
    async execute(interaction) {
        try {
            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/一言`, "INFO");

            // 請求短句 API
            const response = await axios.get(HITOKOTO);
            const { hitokoto, from } = response.data;

            // 使用 OpenCC 將簡體中文轉為繁體中文
            const converter = OpenCC.Converter({ from: 'cn', to: 'twp' });
            hitokotoText = converter(hitokoto);
            hitokotoFrom = converter(from);

            // 創建嵌入訊息
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR) // 設置顏色
                .setTitle(`${EMBED_EMOJI} ┃ 一言`)  // 標題
                .setDescription(hitokotoText) // 顯示短句
                .addFields({
                    name: '　',
                    value: hitokotoFrom || '未知', // 顯示來源，如果沒有來源則顯示 '未知'
                })
                .setFooter({text: '使用 Hitokoto 語句 API' }); // 頁腳文字
                
            // 發送嵌入訊息
            await interaction.reply({
                embeds: [embed],
            });
            
        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 無法獲取 Hitokoto API 資料：`, "ERROR", error); // 記錄錯誤日誌
            errorReply(interaction, '**無法獲取短句，請稍後再試！**\n- 原因：連線至 Hitokoto API 時出現錯誤。'); // 向用戶顯示錯誤訊息
        }
    }
};
