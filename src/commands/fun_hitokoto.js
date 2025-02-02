const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');
const axios = require('axios');
const OpenCC = require('opencc-js');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8'); // 根據你的專案結構調整路徑
const config = yaml.parse(configFile);

const EMBED_COLOR = config.Embed_Color;  // 嵌入介面顏色
const HITOKOTO = config.API.Hitokoto; // 讀取 Hitokoto API 連結

module.exports = {
    data: new SlashCommandBuilder()
        .setName('一言')
        .setDescription('獲取一條動漫相關的名言短句'),
    async execute(interaction) {
        try {
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
                .setTitle('🍵 ┃ 一言')  // 標題
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
            console.error('❌ 無法獲取 Hitokoto API 資料：', error);
            await interaction.reply({
                content: '無法獲取短句，請稍後再試。',
                ephemeral: true,
            });
        }
    }
};
