const path = require('path');
const axios = require('axios');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { getIPInfo } = require(path.join(process.cwd(), 'util/getIPInfo'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.ipQuery.emoji;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('網際協定位址資訊')
        .setDescription('查詢 IPv4 或 IPv6 位址的相關資訊')
        .addStringOption(option =>
            option.setName('位址')
                .setDescription('輸入 IPv4 或 IPv6 位址')
                .setRequired(true)),

    async execute(interaction) {

        //啟用延遲回覆
        await interaction.deferReply();

        try {
            const address = interaction.options.getString('位址');

            // 發送執行指令的摘要到 sendLog
            sendLog(interaction.client, `💾 ${interaction.user.tag} 執行了指令：/網際協定位址(${address})`, "INFO");

            // 使用 ip-api.com 查詢位址資訊
            const { IPInfoMobile, IPInfoHosting, IPInfoProxy, IPInfoCountry, IPInfoCity, IPInfoISP, IPInfoAS } = await getIPInfo(address);

            // 創建嵌入訊息
            const embed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 網際協定位址資訊 - ${address}`)
                .addFields(
                    { name: '是行動網路', value: IPInfoMobile, inline: true },
                    { name: '是託管服務', value: IPInfoHosting, inline: true },
                    { name: '是代理服務', value: IPInfoProxy, inline: true },
                    { name: '地理位置', value: `${IPInfoCountry}, ${IPInfoCity}`, inline: false },
                    { name: '服務供應商', value: IPInfoISP, inline: false },
                    { name: '自治系統', value: IPInfoAS, inline: false }
                );

            // 回覆訊息
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            // 錯誤處理
            sendLog(interaction.client, `❌ 在執行 /網際協定位址資訊 指令時發生錯誤：`, "ERROR", error); // 記錄錯誤日誌
            errorReply(interaction, `**無法獲取網際協定位址資訊，原因：${error.message || '未知錯誤'}**`); // 向用戶顯示錯誤訊息
        }
    }
};