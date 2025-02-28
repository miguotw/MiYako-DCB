const path = require('path');
const axios = require('axios');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/log'));
const { errorReply } = require(path.join(process.cwd(), 'core/error_reply'));

// 導入設定檔內容
const EMBED_COLOR = config.Embed_Color;
const EMBED_EMOJI = config.Emoji.Commands.IP_Query;
const IP_API = config.API.IP_API;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('網際協定位址資訊')
        .setDescription('查詢 IPv4 或 IPv6 位址的相關資訊')
        .addStringOption(option =>
            option.setName('位址')
                .setDescription('輸入 IPv4 或 IPv6 位址')
                .setRequired(true)),

    async execute(interaction) {
        try {
            const address = interaction.options.getString('位址');

            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/網際協定位址(${address})`, "INFO");

            // 使用 ip-api.com 查詢位址資訊
            const response = await axios.get(`${IP_API}/json/${address}?fields=status,message,country,city,isp,as,mobile,proxy,hosting`);
            const data = response.data;

            // 如果 API 返回錯誤
            if (data.status !== 'success') {
                return errorReply(interaction, `**無法查詢位址 ${address}，原因：${data.message || '未知錯誤'}**`);
            }

            // 創建嵌入訊息
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 網際協定位址資訊 - ${address}`)
                .addFields(
                    { name: '是行動網路', value: data.mobile ? '是' : '否', inline: true },
                    { name: '是託管服務', value: data.hosting ? '是' : '否', inline: true },
                    { name: '是代理服務', value: data.proxy ? '是' : '否', inline: true },
                    { name: '地理位置', value: `${data.country}, ${data.city}` || '無', inline: false },
                    { name: '服務供應商', value: data.isp || '無', inline: false },
                    { name: '自治系統', value: data.as || '無', inline: false }
                );

            // 回覆訊息
            await interaction.reply({ embeds: [embed] });

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /網際協定位址 指令時發生錯誤`, "ERROR", error); // 記錄錯誤日誌
            errorReply(interaction, '**發生未預期的錯誤，請向開發者回報！**'); // 向用戶顯示錯誤訊息
        }
    }
};