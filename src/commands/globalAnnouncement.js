const crypto = require('node:crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    escapeMarkdown
} = require('discord.js');
const { createLogTools } = require('../../core/sendLog');
const { createReplyTools } = require('../../core/Reply');
const { commandInputError, fetchSourceMessage } = require('../../util/discordCommandInput');

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const BROADCAST_CONCURRENCY = 5;
const MAX_PROBLEM_GUILDS = 20;
const REQUIRED_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
];
const PERMISSION_ERROR_CODES = new Set([50001, 50013]);
const IMAGE_EXTENSION = /\.(?:apng|avif|gif|jpe?g|png|webp)(?:$|[?#])/i;

function isImageAttachment(attachment) {
    if (!attachment?.url) return false;
    if (String(attachment.contentType || '').toLowerCase().startsWith('image/')) return true;
    return IMAGE_EXTENSION.test(String(attachment.url));
}

function findBannerURL(message) {
    const attachments = message?.attachments;
    if (!attachments) return null;
    const values = typeof attachments.values === 'function'
        ? attachments.values()
        : Array.isArray(attachments) ? attachments : [];
    for (const attachment of values) {
        if (isImageAttachment(attachment)) return attachment.url;
    }
    return null;
}

function createInstallRow(clientId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('新增應用程式')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}`)
    );
}

function createConfirmationRow(token) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`global_announcement_confirm:${token}`)
            .setLabel('確認發布')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`global_announcement_cancel:${token}`)
            .setLabel('取消')
            .setStyle(ButtonStyle.Secondary)
    );
}

function createAnnouncementPayload(config, botUser, content, bannerURL = null) {
    const embed = new EmbedBuilder()
        .setColor(config.embed.color.default)
        .setTitle(`${config.commands.globalAnnouncement.emoji} ┃ ${botUser.username} 最新消息`)
        .setThumbnail(botUser.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: false }))
        .setDescription(content)
        .setFooter({ text: `這是一則自動消息，旨在傳達 ${botUser.username} 的最新消息或服務狀態。` });
    if (bannerURL) embed.setImage(bannerURL);

    return {
        embeds: [embed.toJSON()],
        components: [createInstallRow(config.startup.clientId).toJSON()],
        allowedMentions: { parse: [] }
    };
}

function hasRequiredPermissions(channel, guild) {
    if (channel?.type !== ChannelType.GuildText || typeof channel.permissionsFor !== 'function') return false;
    const permissions = channel.permissionsFor(guild.members?.me);
    return Boolean(permissions && REQUIRED_PERMISSIONS.every(permission => permissions.has(permission)));
}

function findFallbackChannel(guild, excludedChannelId = null) {
    return [...(guild.channels?.cache?.values?.() || [])]
        .filter(channel => channel.id !== excludedChannelId
            && channel.type === ChannelType.GuildText
            && channel.nsfw !== true
            && hasRequiredPermissions(channel, guild))
        .sort((left, right) => (Number(left.rawPosition) || 0) - (Number(right.rawPosition) || 0)
            || String(left.id).localeCompare(String(right.id)))[0] || null;
}

function isPermissionError(error) {
    const code = Number(error?.code ?? error?.rawError?.code);
    return PERMISSION_ERROR_CODES.has(code);
}

async function sendToGuild(guild, payload) {
    const systemChannel = hasRequiredPermissions(guild.systemChannel, guild) ? guild.systemChannel : null;
    let channel = systemChannel || findFallbackChannel(guild, guild.systemChannel?.id);
    let target = systemChannel ? 'system' : 'fallback';
    if (!channel) return { guild, status: 'noTarget' };

    try {
        await channel.send(payload);
        return { guild, status: target, channelId: channel.id };
    } catch (error) {
        if (target === 'system' && isPermissionError(error)) {
            channel = findFallbackChannel(guild, systemChannel.id);
            if (!channel) return { guild, status: 'noTarget' };
            target = 'fallback';
            try {
                await channel.send(payload);
                return { guild, status: target, channelId: channel.id };
            } catch (fallbackError) {
                return { guild, status: 'failed', channelId: channel.id, error: fallbackError };
            }
        }
        return { guild, status: 'failed', channelId: channel.id, error };
    }
}

async function broadcastToGuilds(guilds, payload, signal) {
    const results = new Array(guilds.length);
    let nextIndex = 0;
    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= guilds.length) return;
            if (signal?.aborted) {
                results[index] = { guild: guilds[index], status: 'failed', error: signal.reason || new Error('全域消息發布已取消。') };
                continue;
            }
            results[index] = await sendToGuild(guilds[index], payload);
        }
    };
    const workerCount = Math.min(BROADCAST_CONCURRENCY, guilds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

function safeGuildName(guild) {
    return escapeMarkdown(String(guild?.name || '未知伺服器').replace(/[\r\n]+/g, ' ').slice(0, 80));
}

function summarizeResults(results) {
    const counts = { total: results.length, system: 0, fallback: 0, noTarget: 0, failed: 0 };
    const problems = [];
    for (const result of results) {
        counts[result.status] += 1;
        if (result.status === 'noTarget' || result.status === 'failed') {
            problems.push(`- ${safeGuildName(result.guild)}（${result.guild?.id || '未知 ID'}）：${result.status === 'noTarget' ? '沒有安全的可發送頻道' : '發送失敗'}`);
        }
    }
    const success = counts.system + counts.fallback;
    const lines = [
        `共檢查 **${counts.total}** 個伺服器。`,
        `系統頻道成功：**${counts.system}**`,
        `備援頻道成功：**${counts.fallback}**`,
        `無可用頻道：**${counts.noTarget}**`,
        `發送失敗：**${counts.failed}**`
    ];
    if (problems.length) {
        lines.push('', '問題伺服器：', ...problems.slice(0, MAX_PROBLEM_GUILDS));
        if (problems.length > MAX_PROBLEM_GUILDS) lines.push(`- 其餘 ${problems.length - MAX_PROBLEM_GUILDS} 個伺服器`);
    }
    return { counts, success, message: lines.join('\n') };
}

function createCommand(config, dependencies = {}) {
    const { sendLog } = createLogTools(config);
    const { createStatusEmbed, errorReply, infoReply, validationReply } = createReplyTools(config);
    const now = dependencies.now || Date.now;
    const randomUUID = dependencies.randomUUID || crypto.randomUUID;
    const sessions = new Map();
    let broadcasting = false;

    function getSession(interaction) {
        const token = String(interaction.customId || '').split(':')[1] || '';
        const session = sessions.get(String(interaction.user?.id || ''));
        if (!session || session.token !== token || session.expiresAt <= now()) {
            if (session?.expiresAt <= now()) sessions.delete(String(interaction.user?.id || ''));
            return null;
        }
        return session;
    }

    async function rejectComponent(interaction, message) {
        return validationReply(interaction, `**${message}**`, { method: 'update', components: [] });
    }

    async function confirm(interaction, context) {
        const session = getSession(interaction);
        if (!session) return rejectComponent(interaction, '這份全域消息預覽已失效，請重新執行指令。');
        if (broadcasting) return rejectComponent(interaction, '目前已有一則全域消息正在發布，請稍後再試。');

        sessions.delete(String(interaction.user.id));
        broadcasting = true;
        try {
            await interaction.deferUpdate();
            const guilds = [...interaction.client.guilds.cache.values()];
            await sendLog(interaction.client, `📢 ${interaction.user.tag} 確認發布全域消息，來源訊息 ID：${session.sourceMessageId}，目標伺服器：${guilds.length}。`);
            const results = await broadcastToGuilds(guilds, session.payload, context?.signal);
            const summary = summarizeResults(results);
            const problemResults = results.filter(result => result.status === 'noTarget' || result.status === 'failed');
            if (problemResults.length) {
                const warning = new Error('部分伺服器未收到全域消息。');
                warning.debugDetails = {
                    counts: summary.counts,
                    problems: problemResults.slice(0, MAX_PROBLEM_GUILDS).map(result => ({
                        guildId: result.guild?.id,
                        status: result.status,
                        error: result.error?.message
                    }))
                };
                await sendLog(interaction.client, `📢 全域消息發布完成，但有 ${problemResults.length} 個伺服器未成功。`, 'WARN', warning);
            } else {
                await sendLog(interaction.client, `📢 全域消息發布完成，成功發送至 ${summary.success} 個伺服器。`);
            }
            return interaction.editReply({
                embeds: [createStatusEmbed({ status: summary.success > 0 ? 'success' : 'validation', message: summary.message })],
                components: [],
                allowedMentions: { parse: [] }
            });
        } catch (error) {
            return errorReply(interaction, error, { context: '發布全域消息', components: [] });
        } finally {
            broadcasting = false;
        }
    }

    async function cancel(interaction) {
        const session = getSession(interaction);
        if (!session) return rejectComponent(interaction, '這份全域消息預覽已失效，請重新執行指令。');
        sessions.delete(String(interaction.user.id));
        return infoReply(interaction, '**已取消發布全域消息。**', { method: 'update', components: [] });
    }

    const command = {
        data: new SlashCommandBuilder()
            .setName('發送全域消息')
            .setDescription('預覽並發布 Bot 最新消息到所有伺服器')
            .setDMPermission(false)
            .addStringOption(option => option
                .setName('訊息id或連結')
                .setDescription('請輸入要作為最新消息的 Discord 訊息 ID 或連結')
                .setRequired(true)),
        async execute(interaction, _context) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                if (broadcasting) throw commandInputError('目前已有一則全域消息正在發布，請稍後再試。');
                const input = interaction.options.getString('訊息id或連結', true);
                const sourceMessage = await fetchSourceMessage(interaction, input);
                const content = String(sourceMessage.content || '').trim();
                if (!content) throw commandInputError('來源訊息必須包含主要文字內容。');
                const token = randomUUID();
                const payload = createAnnouncementPayload(config, interaction.client.user, content, findBannerURL(sourceMessage));
                sessions.set(String(interaction.user.id), {
                    token,
                    expiresAt: now() + CONFIRMATION_TTL_MS,
                    sourceMessageId: String(sourceMessage.id),
                    payload
                });
                return interaction.editReply({
                    ...payload,
                    components: [...payload.components, createConfirmationRow(token).toJSON()]
                });
            } catch (error) {
                if (error.isValidationError) return validationReply(interaction, `**${error.message}**`, { components: [] });
                return errorReply(interaction, error, { context: '建立全域消息預覽', components: [] });
            }
        },
        buttonHandlers: {
            global_announcement_confirm: confirm,
            global_announcement_cancel: cancel
        }
    };
    command._test = {
        broadcastToGuilds,
        createAnnouncementPayload,
        findBannerURL,
        findFallbackChannel,
        get broadcasting() { return broadcasting; },
        isPermissionError,
        sendToGuild,
        sessions,
        summarizeResults
    };
    return command;
}

module.exports = { createCommand };
