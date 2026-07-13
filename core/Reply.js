const crypto = require('crypto');
const path = require('path');
const { EmbedBuilder, MessageFlags } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

const STATUS_STYLE = {
    success: {
        title: `${config.emoji.success} ┃ 操作成功`,
        color: config.embed.color.success
    },
    validation: {
        title: `${config.emoji.error} ┃ 無法完成操作`,
        color: config.embed.color.error
    },
    error: {
        title: `${config.emoji.error} ┃ 系統錯誤`,
        color: config.embed.color.error
    }
};
const REPLY_METHODS = new Set(['auto', 'reply', 'editReply', 'update', 'followUp']);

/**
 * 建立統一的互動狀態 Embed。系統錯誤刻意不接受原始錯誤文字，避免把憑證、
 * 外部回應或內部路徑洩漏給使用者；事件 ID 是使用者回報與伺服器日誌的關聯鍵。
 */
function createStatusEmbed({ status, message, eventId } = {}) {
    const style = STATUS_STYLE[status];
    if (!style) throw new TypeError(`不支援的回覆狀態：${status}`);

    let description;
    if (status === 'error') {
        if (!eventId) throw new TypeError('系統錯誤回覆必須包含事件 ID。');
        description = `**處理請求時發生未預期的錯誤，請稍後再試。**\n事件 ID：\`${eventId}\``;
    } else {
        const safeMessage = String(message || '').trim();
        if (!safeMessage) throw new TypeError('狀態回覆訊息不可為空。');
        description = safeMessage;
    }

    return new EmbedBuilder()
        .setTitle(style.title)
        .setColor(style.color)
        .setDescription(description);
}

/**
 * 依 Interaction 生命週期送出狀態回覆。`auto` 只負責相容一般 reply/deferReply；
 * 元件在 deferUpdate 後需要私密錯誤時，呼叫端必須明確指定 followUp。
 */
async function sendStatusReply(interaction, embed, options = {}) {
    const {
        method = 'auto',
        content,
        files,
        components,
        ephemeral = false,
        context = '互動狀態回覆'
    } = options;

    if (!REPLY_METHODS.has(method)) throw new TypeError(`不支援的回覆方法：${method}`);
    const resolvedMethod = method === 'auto'
        ? (interaction.deferred || interaction.replied ? 'editReply' : 'reply')
        : method;
    if (ephemeral && !['reply', 'followUp'].includes(resolvedMethod)) {
        throw new TypeError(`${resolvedMethod} 無法在 acknowledgement 後改變回覆可見性。`);
    }
    if (typeof interaction?.[resolvedMethod] !== 'function') {
        throw new TypeError(`Interaction 不支援 ${resolvedMethod}。`);
    }

    const payload = { embeds: [embed] };
    if (content !== undefined) payload.content = content;
    if (files !== undefined) payload.files = files;
    if (components !== undefined) payload.components = components;
    if (ephemeral) payload.flags = MessageFlags.Ephemeral;

    try {
        return await interaction[resolvedMethod](payload);
    } catch (replyError) {
        sendLog(interaction?.client, `❌ ${context}傳送失敗。`, 'ERROR', replyError);
        throw replyError;
    }
}

/** 回覆成功狀態；功能內容 Embed 不應使用此 helper。 */
function infoReply(interaction, message, options = {}) {
    return sendStatusReply(interaction, createStatusEmbed({ status: 'success', message }), options);
}

/** 回覆可預期的驗證或業務失敗，不附上 Issue 連結或事件 ID。 */
function validationReply(interaction, message, options = {}) {
    return sendStatusReply(interaction, createStatusEmbed({ status: 'validation', message }), options);
}

/**
 * 回覆未知系統錯誤。原始 Error 只寫入已遮罩的日誌；Discord 僅顯示通用訊息與事件 ID。
 */
function errorReply(interaction, error, options = {}) {
    const eventId = crypto.randomUUID();
    const normalizedError = error instanceof Error ? error : new Error(String(error || '未知錯誤'));
    const context = options.context || '處理 Discord 互動';
    sendLog(interaction?.client, `❌ ${context}失敗（事件 ID：${eventId}）。`, 'ERROR', normalizedError);
    return sendStatusReply(
        interaction,
        createStatusEmbed({ status: 'error', eventId }),
        { ...options, context: `${context}的系統錯誤回覆` }
    );
}

module.exports = { createStatusEmbed, errorReply, infoReply, validationReply };
