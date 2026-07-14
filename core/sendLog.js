const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const DISCORD_TOKEN = /(?:mfa\.[\w-]{20,}|[\w-]{20,30}\.[\w-]{6}\.[\w-]{20,})/g;
const REDACTED = '[已遮罩]';

function createLogTools(config) {
const configCommands = config.commands;

const getTimePrefix = (level) => {
    const now = new Date();
    now.setHours(now.getHours() + config.log.timezone);
    const days = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    const day = days[now.getDay()];
    const time = now.toLocaleTimeString('zh-TW', { hour12: false });
    return `[${day} ${time} ${level} ]`;
};

function getConfiguredSecrets() {
    return [
        config.startup?.token,
        configCommands.packageTracking?.trackTwToken,
        configCommands.stream?.twitchClientSecret
    ];
}

/**
 * 清理所有終端與 Discord 共用的日誌內容。敏感值採精確取代，避免以廣泛規則
 * 誤遮罩 Discord ID；物流單號、IP 等執行期資料由呼叫端透過 sensitiveValues 宣告。
 */
function sanitizeLogText(value, sensitiveValues = []) {
    let output = String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARACTERS, '')
        .replace(/```/g, 'ˋˋˋ')
        .replace(DISCORD_TOKEN, REDACTED)
        .replace(/(["']?(?:authorization|access[_-]?token|api[_-]?token|client[_-]?secret|api[_-]?key)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)([^"'\s,}\]]+)/gi, `$1${REDACTED}`)
        .replace(/([?&](?:access[_-]?token|token|secret|key)=)[^&\s]+/gi, `$1${REDACTED}`);

    const secrets = [...getConfiguredSecrets(), ...sensitiveValues]
        .map(secret => String(secret ?? '').trim())
        .filter(secret => secret.length >= 3)
        .sort((a, b) => b.length - a.length);
    for (const secret of new Set(secrets)) output = output.split(secret).join(REDACTED);
    return output;
}

function formatError(error) {
    if (!error) return '';
    let output = error.stack || error.message || String(error);
    if (error.debugDetails) {
        try { output += `\nDebug details:\n${JSON.stringify(error.debugDetails, null, 2)}`; }
        catch { output += '\nDebug details: [無法安全序列化]'; }
    }
    return output;
}

/**
 * 同時寫入終端及設定的 Discord 日誌頻道。Discord 傳送永遠停用 mentions；
 * 頻道傳送失敗只落到終端，避免 sendLog 自我遞迴。
 */
const sendLog = (client, message, level = 'INFO', error = null, options = {}) => {
    let prefix = `[LOGGER ${level}]`;
    try {
        prefix = getTimePrefix(level);
        const sensitiveValues = Array.isArray(options?.sensitiveValues) ? options.sensitiveValues : [];
        let logMessage = `${prefix} ${message}`;
        const errorDetails = formatError(error);
        if (errorDetails) logMessage += `\n${errorDetails}`;
        logMessage = sanitizeLogText(logMessage, sensitiveValues);
        console.log(logMessage);

        if (!client?.isReady?.()) return null;
        const logChannel = client.channels?.cache?.get(config.log.channel);
        if (!logChannel?.send) {
            console.error(sanitizeLogText(`${prefix} ❌ 無法找到日誌頻道，請檢查 config.yml。`));
            return null;
        }

        const maxDiscordLogLength = 1900;
        const discordLogMessage = logMessage.length > maxDiscordLogLength
            ? `${logMessage.slice(0, maxDiscordLogLength)}\n...（內容過長，已截斷；完整內容請查看終端日誌）`
            : logMessage;
        const symbols = { INFO: ' ', WARN: '!', ERROR: '-' };
        return logChannel.send({
            content: `\`\`\`diff\n${symbols[level] || ' '} ${discordLogMessage}\n\`\`\``,
            allowedMentions: { parse: [] }
        }).catch(sendError => {
            console.error(sanitizeLogText(`${prefix} ❌ 無法發送日誌到頻道：\n${formatError(sendError)}`));
            return null;
        });
    } catch (sendLogError) {
        console.error(sanitizeLogText(`${prefix} ❌ 在 sendLog 函數中發生錯誤：\n${formatError(sendLogError)}`));
        return null;
    }
};

return { sanitizeLogText, sendLog };
}

module.exports = { createLogTools };
