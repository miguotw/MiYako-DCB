const net = require('net');
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../core/sendLog');
const { createReplyTools } = require('../../core/Reply');
const { getIPInfo } = require('../../util/getIPInfo');

// 導入設定檔內容
function createCommand(config) {
const { sendLog } = createLogTools(config);
const { errorReply, validationReply } = createReplyTools(config);
const configCommands = config.commands;
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.ipQuery.emoji;
const IP_RATE_LIMIT_WINDOW_MS = 60000;
const IP_RATE_LIMIT_MAX_REQUESTS = 5;
const ipRequestWindows = new Map();
const pendingIPRequests = new Set();
let lastIPWindowSweep = 0;

/** 同一使用者只允許一筆進行中查詢，並以滑動視窗限制對明文 IP provider 的流量。 */
function reserveIPRequest(userID, now = Date.now()) {
    if (now - lastIPWindowSweep >= IP_RATE_LIMIT_WINDOW_MS) {
        lastIPWindowSweep = now;
        for (const [storedUserID, timestamps] of ipRequestWindows) {
            const activeTimestamps = timestamps.filter(timestamp => now - timestamp < IP_RATE_LIMIT_WINDOW_MS);
            if (activeTimestamps.length) ipRequestWindows.set(storedUserID, activeTimestamps);
            else if (!pendingIPRequests.has(storedUserID)) ipRequestWindows.delete(storedUserID);
        }
    }
    if (pendingIPRequests.has(userID)) return { allowed: false, reason: 'pending' };
    const recent = (ipRequestWindows.get(userID) || []).filter(timestamp => now - timestamp < IP_RATE_LIMIT_WINDOW_MS);
    if (recent.length >= IP_RATE_LIMIT_MAX_REQUESTS) {
        ipRequestWindows.set(userID, recent);
        return { allowed: false, reason: 'rate' };
    }
    recent.push(now);
    ipRequestWindows.set(userID, recent);
    pendingIPRequests.add(userID);
    return { allowed: true };
}

/** 無論 provider 成功或失敗都釋放 single-flight，否則使用者會被永久鎖住。 */
function releaseIPRequest(userID) {
    pendingIPRequests.delete(userID);
}

const command = {
    data: new SlashCommandBuilder()
        .setName('網際協定位址資訊')
        .setDescription('查詢 IPv4 或 IPv6 位址的相關資訊')
        .addStringOption(option =>
            option.setName('位址')
                .setDescription('輸入 IPv4 或 IPv6 位址')
                .setRequired(true)),

    async execute(interaction, _context) {
        const address = interaction.options.getString('位址').trim();
        if (!net.isIP(address)) {
            return validationReply(interaction, '**請輸入有效的 IPv4 或 IPv6 位址。**', { ephemeral: true });
        }
        const reservation = reserveIPRequest(interaction.user.id);
        if (!reservation.allowed) {
            const message = reservation.reason === 'pending'
                ? '**你已有一筆 IP 查詢正在處理，請等待完成後再試。**'
                : '**IP 查詢過於頻繁，請在一分鐘後再試。**';
            return validationReply(interaction, message, { ephemeral: true });
        }

        try {
            await interaction.deferReply();
            // 發送執行指令的摘要到 sendLog
            sendLog(
                interaction.client,
                `💾 ${interaction.user.tag} 執行了指令：/網際協定位址(${address})`,
                'INFO',
                null,
                { sensitiveValues: [address] }
            );

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
            return errorReply(interaction, error, { context: '查詢 IP 位址資訊' });
        } finally {
            releaseIPRequest(interaction.user.id);
        }
    }
};

command._test = { releaseIPRequest, reserveIPRequest };
return command;
}

module.exports = { createCommand };
