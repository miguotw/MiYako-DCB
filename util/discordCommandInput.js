const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DISCORD_HOST_PATTERN = /^(?:canary\.|ptb\.)?discord(?:app)?\.com$/i;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** 為 Discord API 操作加上逾時，避免成員展開等請求無限等待。 */
function withTimeout(promise, message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    let timeout;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timeout));
}

/**
 * 將指定時區的日期時間轉成 Unix 秒數，不受部署主機所在時區影響。
 * 例如 UTC+8 的 20:00 等於 UTC 的 12:00，因此計算時要扣除 8 小時。
 * allowSeconds 用來區分截止時間（到分鐘）與時間戳工具（到秒）。
 */
function parseDateTimeToUnix(value, timezoneOffset = 0, { allowSeconds = false } = {}) {
    const timePattern = allowSeconds ? '([01]\\d|2[0-3]):([0-5]\\d):([0-5]\\d)' : '([01]\\d|2[0-3]):([0-5]\\d)';
    const match = String(value || '').trim().match(new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2}) ${timePattern}$`));
    if (!match) return null;
    const [, year, month, day, hour, minute, parsedSecond] = match.map(Number);
    const second = allowSeconds ? parsedSecond : 0;
    const utcMilliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
    const date = new Date(utcMilliseconds);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day || date.getUTCHours() !== hour
        || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;

    const offset = Number(timezoneOffset);
    if (!Number.isFinite(offset)) return null;
    return Math.floor((utcMilliseconds - offset * 60 * 60 * 1000) / 1000);
}

/** 截止時間固定使用到分鐘的格式，保留原本呼叫端使用的函式名稱。 */
function parseDeadline(value, timezoneOffset = 0) {
    return parseDateTimeToUnix(value, timezoneOffset);
}

/**
 * 解析用戶與身分組提及並去除重複項目。
 * required 可控制空值是否允許，fieldName 用於產生容易理解的錯誤訊息。
 */
function parseMentionTargets(value, fieldName, { required = false } = {}) {
    const tokens = String(value || '').trim().split(/[\s,，]+/).filter(Boolean);
    if (!tokens.length) {
        if (required) throw new Error(`${fieldName}不可留白。`);
        return [];
    }
    const targets = tokens.map(token => {
        const user = token.match(/^<@!?(\d{17,20})>$/);
        if (user) return { type: 'user', id: user[1] };
        const role = token.match(/^<@&(\d{17,20})>$/);
        if (role) return { type: 'role', id: role[1] };
        throw new Error(`${fieldName}僅接受 @用戶 或 @身分組，不接受純數字 ID。`);
    });
    return [...new Map(targets.map(target => [`${target.type}:${target.id}`, target])).values()];
}

/**
 * 從常見的 Discord 貼上格式解析訊息連結。
 * 支援網址前後的尖括號、Markdown 連結、尾端斜線、查詢參數與錨點；
 * 主機名稱仍嚴格限制為 Discord 官方網域，避免把外部網址當成訊息來源。
 */
function parseMessageLink(input) {
    let candidate = String(input || '').trim();
    const markdownLink = candidate.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i);
    if (markdownLink) candidate = markdownLink[1];
    if (candidate.startsWith('<') && candidate.endsWith('>')) candidate = candidate.slice(1, -1).trim();

    let url;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    if (!DISCORD_HOST_PATTERN.test(url.hostname)) return null;

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 4 || segments[0] !== 'channels') return null;
    const [, guildID, channelID, messageID] = segments;
    if (![guildID, channelID, messageID].every(value => SNOWFLAKE_PATTERN.test(value))) return null;
    return { guildID, channelID, messageID };
}

/** 依訊息 ID 或訊息連結取得來源訊息，並限制連結必須屬於目前伺服器。 */
async function fetchSourceMessage(interaction, input) {
    const normalizedInput = String(input).trim();
    const link = parseMessageLink(normalizedInput);
    if (link) {
        const { guildID, channelID, messageID } = link;
        if (guildID !== interaction.guildId) throw new Error('來源訊息連結必須屬於目前伺服器。');
        const channel = await interaction.guild.channels.fetch(channelID).catch(() => null);
        if (!channel?.messages) throw new Error('無法讀取來源訊息所在頻道。');
        return channel.messages.fetch(messageID);
    }
    if (!SNOWFLAKE_PATTERN.test(normalizedInput)) throw new Error('請輸入有效的 Discord 訊息 ID 或訊息連結。');
    if (!interaction.channel?.messages) throw new Error('目前頻道不支援讀取訊息。');
    return interaction.channel.messages.fetch(normalizedInput);
}

/**
 * 將用戶／身分組提及展開為真人成員 ID。
 * 身分組需要先完整抓取成員快取，因此部署時必須啟用 Server Members Intent。
 */
async function resolveMentionedUsers(interaction, targets, fieldName) {
    if (!targets.length) return [];
    const userIDs = new Set();
    if (targets.some(target => target.type === 'role')) {
        await withTimeout(
            interaction.guild.members.fetch(),
            `展開${fieldName}身分組逾時。請確認 Discord Developer Portal 已啟用 Server Members Intent。`
        );
    }
    for (const target of targets) {
        if (target.type === 'user') {
            const member = interaction.guild.members.cache.get(target.id) || await withTimeout(
                interaction.guild.members.fetch(target.id).catch(() => null),
                `查詢${fieldName}用戶逾時。`
            );
            if (!member || member.user.bot) throw new Error(`${fieldName}包含不在伺服器中的用戶或 Bot。`);
            userIDs.add(member.id);
            continue;
        }
        const role = interaction.guild.roles.cache.get(target.id);
        if (!role) throw new Error(`${fieldName}包含不存在的身分組。`);
        for (const member of role.members.values()) {
            if (!member.user.bot) userIDs.add(member.id);
        }
    }
    return [...userIDs];
}

module.exports = {
    fetchSourceMessage, parseDateTimeToUnix, parseDeadline, parseMentionTargets,
    parseMessageLink, resolveMentionedUsers, withTimeout
};
