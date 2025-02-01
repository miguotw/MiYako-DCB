const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const yaml = require('yaml');

// 讀取 YAML 設定檔
const configFile = fs.readFileSync('./config.yml', 'utf8'); // 根據你的專案結構調整路徑
const config = yaml.parse(configFile);

const EMBED_COLOR = config.Embed_Color;  // 嵌入介面顏色

module.exports = {
    data: new SlashCommandBuilder()
        .setName('延遲')
        .setDescription('測試機器人延遲'),
    async execute(interaction) {
        
        const latency = Math.abs(Date.now() - interaction.createdTimestamp); // 計算延遲
        
        // 創建一個嵌入訊息
        const embed = new EmbedBuilder()
            .setColor(EMBED_COLOR) // 設置顏色
            .setTitle('🏓 ┃ Pong!')  // 標題
            .setDescription(`機器人延遲延遲: ${latency}ms`) // 顯示延遲時間
            .setTimestamp();  // 加入時間戳

        // 回應只對使用者可見
        await interaction.reply({
            embeds: [embed],
            ephemeral: true // 隱藏回應訊息
        });
    }
};
