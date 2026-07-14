const path = require('path');
/**
 * Twitch Helix 輪詢與 Discord 通知生命週期。
 * 直播中的通知會依伺服器持久化，讓程序重啟後能接續編輯原訊息。
 */
const { http } = require('../../../core/http');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');
const { getAllSubscriptions, readGuildStore, saveNotificationState, writeGuildStore } = require('../../../util/twitchStreamStore');

function createTwitchStreamFeature(config, {
    checkStreamStatusImpl = null,
    logTools = createLogTools(config)
} = {}) {
const { sendLog } = logTools;
const configCommands = config.commands;
const EMBED_COLOR = config.embed.color.default;
const STREAM_CONFIG = configCommands.stream || {};
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MINUTES = 2;
const DEFAULT_EDIT_INTERVAL_MINUTES = 5;
const MS_PER_MINUTE = 60000;

let accessToken = null;
let tokenExpiresAt = 0;
const streamStates = new Map();
let isEditing = false;
let activeCheck = null;
let forceNextCheck = false;

/** 管理指令透過模組 API 觸發 reconcile，不再把可變函式掛到 Discord Client。 */
function requestTwitchCheck() {
    forceNextCheck = true;
    return activeCheck ? activeCheck() : Promise.resolve(false);
}

/** 正規化寬鬆 YAML 輸入，並統一套用輪詢間隔下限。 */
function getStreamConfig() {
    return {
        twitchClientId: String(STREAM_CONFIG.twitchClientId || '').trim(),
        twitchClientSecret: String(STREAM_CONFIG.twitchClientSecret || '').trim(),
        checkInterval: Math.max((Number(STREAM_CONFIG.checkInterval) || DEFAULT_CHECK_INTERVAL_MINUTES) * MS_PER_MINUTE, MS_PER_MINUTE),
        editInterval: Math.max((Number(STREAM_CONFIG.editInterval) || DEFAULT_EDIT_INTERVAL_MINUTES) * MS_PER_MINUTE, MS_PER_MINUTE),
        notifyOnStartupLive: STREAM_CONFIG.notifyOnStartupLive === true,
        messages: Array.isArray(STREAM_CONFIG.message) ? STREAM_CONFIG.message : []
    };
}

function getRuntimeStreamConfig(client, streamConfig) {
    const subscriptions = getAllSubscriptions([...client.guilds.cache.keys()])
        .filter(item => isFilled(item.twitchUserLogin) && isFilled(item.channelID));
    return {
        ...streamConfig,
        twitchUserLogins: [...new Set(subscriptions.map(item => item.twitchUserLogin))],
        targets: subscriptions
    };
}

function isFilled(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function persistLiveState(state) {
    for (const message of state.notificationMessages) {
        saveNotificationState(state.twitchUserLogin, message, state.lastStream);
    }
}

function removePersistedState(twitchUserLogin, notificationMessages) {
    const stateKey = twitchUserLogin.toLowerCase();
    const guildIDs = new Set(notificationMessages
        .map(message => String(message.guildId || message.guild?.id || ''))
        .filter(isFilled));

    for (const guildID of guildIDs) {
        const store = readGuildStore(guildID);
        store.notifications = store.notifications.filter(item => item.twitchUserLogin !== stateKey);
        writeGuildStore(guildID, store);
    }
}

function getRandomMessage(messages) {
    if (!messages.length) return '直播現在開始！一起觀看吧！';
    return messages[Math.floor(Math.random() * messages.length)];
}

function buildPreviewUrl(stream) {
    // 加時間戳避免 Discord/CDN 沿用上一輪的直播縮圖快取。
    const thumbnailUrl = stream.thumbnail_url || `https://static-cdn.jtvnw.net/previews-ttv/live_user_${stream.user_login}-1280x720.jpg`;
    const sizedUrl = thumbnailUrl.replace('{width}', '1280').replace('{height}', '720');
    const separator = sizedUrl.includes('?') ? '&' : '?';
    return `${sizedUrl}${separator}r=${Date.now()}`;
}

function buildOfflineImageUrl(user) {
    if (!user?.offline_image_url) return null;
    const separator = user.offline_image_url.includes('?') ? '&' : '?';
    return `${user.offline_image_url}${separator}r=${Date.now()}`;
}

function getDisplayName(stream, user) {
    return user?.display_name || stream.user_name || stream.user_login;
}

function getEmbedColor(user) {
    return /^#[0-9a-f]{6}$/i.test(user?.twitchColor || '') ? user.twitchColor : EMBED_COLOR;
}

function buildStreamEmbed(stream, user, twitchUserLogin, isOffline = false) {
    const streamUrl = `https://www.twitch.tv/${twitchUserLogin}`;
    const displayName = getDisplayName(stream, user);
    const tags = (Array.isArray(stream.tags) ? stream.tags : [])
        .map(tag => String(tag || '').trim())
        .filter(isFilled);
    const tagFields = tags.length
        ? [{ name: '標籤', value: tags.map(tag => `\`${tag.replace(/`/g, "'")}\``).join('  '), inline: false }]
        : [];
    const startedAt = stream.started_at
        ? `<t:${Math.floor(new Date(stream.started_at).getTime() / 1000)}:R>${isOffline ? ' (已離線)' : ''}`
        : `未知${isOffline ? ' (已離線)' : ''}`;
    const embed = new EmbedBuilder()
        .setAuthor({ name: `🍘 ┃ ${displayName} 開始直播了` })
        .setColor(getEmbedColor(user))
        .setTitle(stream.title || `${displayName} 開始直播了！`)
        .setURL(streamUrl)
        .addFields(
            { name: '直播分類', value: stream.game_name || '未設定', inline: true },
            { name: '觀看人數', value: `${stream.viewer_count ?? 0}`, inline: true },
            { name: '開播時間', value: startedAt, inline: true },
            ...tagFields
        )
        .setTimestamp();

    const imageUrl = isOffline ? buildOfflineImageUrl(user) : buildPreviewUrl(stream);
    if (imageUrl) embed.setImage(imageUrl);

    if (user?.profile_image_url) {
        embed.setThumbnail(user.profile_image_url);
    }

    return embed;
}

function buildWatchButton(twitchUserLogin) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('前往觀看直播')
            .setURL(`https://www.twitch.tv/${twitchUserLogin}`)
            .setStyle(ButtonStyle.Link)
    );
}

async function getTwitchAccessToken(streamConfig, signal) {
    // 提前一分鐘視為過期，避免 API 請求途中 token 剛好失效。
    if (accessToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return accessToken;
    }

    const body = new URLSearchParams({
        client_id: streamConfig.twitchClientId,
        client_secret: streamConfig.twitchClientSecret,
        grant_type: 'client_credentials'
    });

    const response = await http.post('https://id.twitch.tv/oauth2/token', body, { signal });
    accessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (Number(response.data.expires_in) || 0) * 1000;

    return accessToken;
}

async function fetchStreams(streamConfig, signal) {
    const token = await getTwitchAccessToken(streamConfig, signal);
    const params = new URLSearchParams();
    for (const twitchUserLogin of streamConfig.twitchUserLogins) {
        params.append('user_login', twitchUserLogin);
    }

    const response = await http.get(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
        headers: {
            'Client-Id': streamConfig.twitchClientId,
            Authorization: `Bearer ${token}`
        },
        signal
    });

    return response.data.data || [];
}

async function fetchUsers(streamConfig, signal) {
    const token = await getTwitchAccessToken(streamConfig, signal);
    const params = new URLSearchParams();
    for (const twitchUserLogin of streamConfig.twitchUserLogins) {
        params.append('login', twitchUserLogin);
    }

    const response = await http.get(`https://api.twitch.tv/helix/users?${params.toString()}`, {
        headers: {
            'Client-Id': streamConfig.twitchClientId,
            Authorization: `Bearer ${token}`
        },
        signal
    });

    return response.data.data || [];
}

async function fetchUserColors(streamConfig, users, signal) {
    if (!users.length) return new Map();

    const token = await getTwitchAccessToken(streamConfig, signal);
    const params = new URLSearchParams();
    for (const user of users) params.append('user_id', user.id);

    const response = await http.get(`https://api.twitch.tv/helix/chat/color?${params.toString()}`, {
        headers: {
            'Client-Id': streamConfig.twitchClientId,
            Authorization: `Bearer ${token}`
        },
        signal
    });

    return new Map((response.data.data || []).map(item => [item.user_id, item.color]));
}

function getMentionForTarget(guild, target) {
    const roleID = String(target.roleID || '').trim();
    const role = isFilled(roleID) ? guild.roles.cache.get(roleID) : null;

    // @everyone 的身分組 ID 等同伺服器 ID，不能套用一般身分組 mention 格式。
    if (!roleID || roleID === guild.id) {
        return {
            content: '@everyone',
            allowedMentions: { parse: ['everyone'] }
        };
    }

    if (role) {
        return {
            content: `<@&${role.id}>`,
            allowedMentions: { roles: [role.id] }
        };
    }

    // role 不存在時，依既有通知規則退回 @everyone。
    return {
        content: '@everyone',
        allowedMentions: { parse: ['everyone'] }
    };
}

function buildNotificationContent(mentionContent, displayName, message) {
    const prefix = `${mentionContent} **${displayName}** `;
    return `${prefix}${String(message || '').slice(0, Math.max(2000 - prefix.length, 0))}`.slice(0, 2000);
}

async function getNotificationChannel(guild, channelID) {
    return guild.channels.cache.get(channelID) || await guild.channels.fetch(channelID).catch(() => null);
}

async function notifyTargets(client, stream, user, streamConfig) {
    const notificationMessages = [];
    const errors = [];
    const stateKey = String(stream.user_login || '').toLowerCase();
    const targets = streamConfig.targets.filter(target =>
        target.twitchUserLogin === stateKey && isFilled(target.guildID) && isFilled(target.channelID)
    );
    if (!targets.length) {
        sendLog(client, '⚠️ Twitch 直播通知未設定任何有效伺服器與頻道，略過通知。', 'WARN');
        return notificationMessages;
    }

    const twitchUserLogin = stream.user_login || streamConfig.twitchUserLogins[0];
    const displayName = getDisplayName(stream, user);
    const embed = buildStreamEmbed(stream, user, twitchUserLogin);
    const row = buildWatchButton(twitchUserLogin);
    const randomMessage = getRandomMessage(streamConfig.messages);

    for (const target of targets) {
        try {
            const guild = client.guilds.cache.get(String(target.guildID));
            if (!guild) {
                sendLog(client, `⚠️ 找不到 Twitch 通知目標伺服器：${target.guildID}`, 'WARN');
                continue;
            }

            const channel = await getNotificationChannel(guild, String(target.channelID));
            if (!channel || typeof channel.send !== 'function') {
                sendLog(client, `⚠️ 找不到 Twitch 通知目標頻道：${target.channelID}`, 'WARN');
                continue;
            }

            const mention = getMentionForTarget(guild, target);
            const notificationMessage = await channel.send({
                content: buildNotificationContent(mention.content, displayName, randomMessage),
                embeds: [embed],
                components: [row],
                allowedMentions: mention.allowedMentions
            });
            notificationMessages.push(notificationMessage);
            saveNotificationState(twitchUserLogin, notificationMessage, stream);
            sendLog(client, `✅ 已發送 Twitch 開播通知至「${guild.name}」#${channel.name}：${notificationMessage.url}`);
        } catch (error) {
            errors.push(error);
            sendLog(client, '❌ 發送 Twitch 開播通知時發生錯誤：', 'ERROR', error);
        }
    }

    if (errors.length && notificationMessages.length === 0) {
        throw new AggregateError(errors, `發送 Twitch 開播通知失敗：${twitchUserLogin}`);
    }
    return notificationMessages;
}

function createLiveState(stream, user, twitchUserLogin, notificationMessages = []) {
    return {
        initialized: true,
        isLive: true,
        notificationMessages,
        viewerCount: Number(stream.viewer_count) || 0,
        lastStream: { ...stream },
        user,
        twitchUserLogin
    };
}

function updateLiveState(state, stream, user) {
    const viewerCount = Number(stream.viewer_count) || 0;
    // 保留本場最高觀看數，避免離線摘要因定期刷新而顯示較低數字。
    const highestViewerCount = Math.max(state.viewerCount, viewerCount);

    state.viewerCount = highestViewerCount;
    state.lastStream = { ...stream, viewer_count: highestViewerCount };
    state.user = user;
}

async function updateNotifications(client, state) {
    const { lastStream, user, twitchUserLogin } = state;

    if (!state.notificationMessages.length || !lastStream) return;

    // 每次編輯都重新建立 Embed，讓帶有 cache-busting 參數的直播縮圖同步刷新。
    const embed = buildStreamEmbed(lastStream, user, twitchUserLogin);
    const editResults = await Promise.allSettled(
        state.notificationMessages.map(message => message.edit({ embeds: [embed] }))
    );

    const errors = [];
    for (const result of editResults) {
        if (result.status === 'rejected') {
            errors.push(result.reason);
            sendLog(client, `❌ 更新 Twitch 直播通知時發生錯誤：${twitchUserLogin}`, 'ERROR', result.reason);
        }
    }
    persistLiveState(state);
    if (errors.length) throw new AggregateError(errors, `更新 Twitch 直播通知失敗：${twitchUserLogin}`);
}

async function editLiveNotifications(client) {
    if (isEditing) return;
    isEditing = true;

    try {
        const liveStates = [...streamStates.values()].filter(state => state.isLive);
        await Promise.all(liveStates.map(state => updateNotifications(client, state)));
    } catch (error) {
        sendLog(client, '❌ 定時更新 Twitch 直播通知時發生錯誤：', 'ERROR', error);
        throw error;
    } finally {
        isEditing = false;
    }
}

async function markNotificationsOffline(client, state, user, twitchUserLogin) {
    if (!state.notificationMessages?.length || !state.lastStream) return;

    const embed = buildStreamEmbed(state.lastStream, user, twitchUserLogin, true);
    const editResults = await Promise.allSettled(
        state.notificationMessages.map(message => message.edit({ embeds: [embed] }))
    );

    const errors = [];
    for (const result of editResults) {
        if (result.status === 'rejected') {
            errors.push(result.reason);
            sendLog(client, `❌ 將 Twitch 直播通知標記為離線時發生錯誤：${twitchUserLogin}`, 'ERROR', result.reason);
        }
    }
    if (errors.length) throw new AggregateError(errors, `更新 Twitch 離線通知失敗：${twitchUserLogin}`);
}

async function restoreNotificationStates(client, streamConfig) {
    const configuredLogins = new Set(streamConfig.twitchUserLogins.map(login => login.toLowerCase()));
    const guildIDs = [...client.guilds.cache.keys()];

    for (const guildID of guildIDs) {
        const store = readGuildStore(guildID);
        const validNotifications = [];
        const guild = client.guilds.cache.get(guildID);

        if (!guild) continue;

        for (const saved of store.notifications) {
            const stateKey = String(saved.twitchUserLogin || '').toLowerCase();
            if (!configuredLogins.has(stateKey) || !isFilled(String(saved.channelID || '')) || !isFilled(String(saved.messageID || ''))) continue;

            const channel = await getNotificationChannel(guild, String(saved.channelID));
            const message = await channel?.messages?.fetch(String(saved.messageID)).catch(() => null);
            if (!message || !saved.stream) continue;

            validNotifications.push(saved);
            const existingState = streamStates.get(stateKey);
            if (existingState) {
                existingState.notificationMessages.push(message);
                continue;
            }

            const configuredLogin = streamConfig.twitchUserLogins.find(login => login.toLowerCase() === stateKey) || stateKey;
            streamStates.set(stateKey, createLiveState(saved.stream, null, configuredLogin, [message]));
        }

        if (validNotifications.length !== store.notifications.length) {
            writeGuildStore(guildID, { ...store, notifications: validNotifications });
        }
    }

    const restoredCount = [...streamStates.values()].reduce((count, state) => count + state.notificationMessages.length, 0);
    if (restoredCount) sendLog(client, `✅ 已恢復 ${restoredCount} 則 Twitch 直播通知，將接續更新。`);
}

async function checkStreamStatus(client, streamConfig, forceNotifyCurrentLive = false, signal) {
    try {
        streamConfig = getRuntimeStreamConfig(client, streamConfig);
        const configuredLogins = new Set(streamConfig.twitchUserLogins);
        for (const [stateKey, savedState] of streamStates) {
            if (!configuredLogins.has(stateKey)) savedState.isLive = false;
        }
        if (!streamConfig.twitchUserLogins.length) return;
        const [streams, users] = await Promise.all([
            fetchStreams(streamConfig, signal),
            fetchUsers(streamConfig, signal)
        ]);
        const userColors = await fetchUserColors(streamConfig, users, signal).catch(error => {
            if (signal?.aborted) throw error;
            sendLog(client, '⚠️ 無法取得 Twitch 使用者色彩，Embed 將使用預設顏色。', 'WARN', error);
            return new Map();
        });
        for (const user of users) user.twitchColor = userColors.get(user.id) || '';
        const liveStreams = new Map(streams.map(stream => [stream.user_login.toLowerCase(), stream]));
        const userProfiles = new Map(users.map(user => [user.login.toLowerCase(), user]));

        for (const twitchUserLogin of streamConfig.twitchUserLogins) {
            if (signal?.aborted) throw signal.reason || new Error('Twitch 檢查已取消。');
            const stateKey = twitchUserLogin.toLowerCase();
            const stream = liveStreams.get(stateKey);
            const user = userProfiles.get(stateKey);
            const currentlyLive = Boolean(stream);
            const state = streamStates.get(stateKey) || { initialized: false, isLive: false };

            if (!state.initialized) {
                sendLog(client, `✅ Twitch 直播監聽已啟動：${twitchUserLogin} 目前${currentlyLive ? '正在直播' : '未直播'}`);

                if (currentlyLive && (streamConfig.notifyOnStartupLive || forceNotifyCurrentLive)) {
                    const notificationMessages = await notifyTargets(client, stream, user, streamConfig);
                    streamStates.set(stateKey, createLiveState(stream, user, twitchUserLogin, notificationMessages));
                } else if (currentlyLive) {
                    streamStates.set(stateKey, createLiveState(stream, user, twitchUserLogin));
                } else {
                    streamStates.set(stateKey, { initialized: true, isLive: false });
                }
                continue;
            }

            if (!state.isLive && currentlyLive) {
                const notificationMessages = await notifyTargets(client, stream, user, streamConfig);
                streamStates.set(stateKey, createLiveState(stream, user, twitchUserLogin, notificationMessages));
                continue;
            }

            if (state.isLive && currentlyLive) {
                if (state.lastStream?.started_at && state.lastStream.started_at !== stream.started_at) {
                    await markNotificationsOffline(client, state, user, twitchUserLogin);
                    removePersistedState(twitchUserLogin, state.notificationMessages);
                    const notificationMessages = await notifyTargets(client, stream, user, streamConfig);
                    streamStates.set(stateKey, createLiveState(stream, user, twitchUserLogin, notificationMessages));
                    continue;
                }
                const targets = streamConfig.targets.filter(target => target.twitchUserLogin === stateKey);
                const allowedTargets = new Set(targets.map(target => `${target.guildID}:${target.channelID}`));
                state.notificationMessages = state.notificationMessages.filter(message =>
                    allowedTargets.has(`${message.guildId || message.guild?.id}:${message.channelId}`)
                );
                const existingTargets = new Set(state.notificationMessages.map(message =>
                    `${message.guildId || message.guild?.id}:${message.channelId}`
                ));
                const missingTargets = targets.filter(target => !existingTargets.has(`${target.guildID}:${target.channelID}`));
                if (missingTargets.length) {
                    const newMessages = await notifyTargets(client, stream, user, { ...streamConfig, targets: missingTargets });
                    state.notificationMessages.push(...newMessages);
                }
                updateLiveState(state, stream, user);
                continue;
            }

            if (state.isLive && !currentlyLive) {
                await markNotificationsOffline(client, state, user, twitchUserLogin);
                removePersistedState(twitchUserLogin, state.notificationMessages);
                streamStates.set(stateKey, { initialized: true, isLive: false });
                sendLog(client, `ℹ️ Twitch 主播 ${twitchUserLogin} 已結束直播。`);
            }
        }
    } catch (error) {
        sendLog(client, '❌ 檢查 Twitch 直播狀態時發生錯誤：', 'ERROR', error);
        throw error;
    }
}

const initializer = async (client, context = {}) => {
    const streamConfig = getStreamConfig();

    if (!isFilled(streamConfig.twitchClientId) || !isFilled(streamConfig.twitchClientSecret)) {
        activeCheck = null;
        sendLog(client, '⚠️ Twitch 憑證未設定，直播背景輪詢未啟動。', 'WARN');
        return;
    }
    if (!context.scheduler) throw new Error('Twitch feature 缺少 scheduler context。');

    try {
        await restoreNotificationStates(client, getRuntimeStreamConfig(client, streamConfig));
    } catch (error) {
        sendLog(client, '❌ 恢復 Twitch 直播通知暫存時發生錯誤：', 'ERROR', error);
    }
    const checkHandle = context.scheduler.register({
        name: 'twitchStream.check',
        intervalMs: streamConfig.checkInterval,
        timeoutMs: Math.min(streamConfig.checkInterval, 60000),
        immediate: true,
        run: async ({ signal }) => {
            const forceNotifyCurrentLive = forceNextCheck;
            forceNextCheck = false;
            try {
                const check = checkStreamStatusImpl || checkStreamStatus;
                return await check(client, streamConfig, forceNotifyCurrentLive, signal);
            } catch (error) {
                if (forceNotifyCurrentLive) forceNextCheck = true;
                throw error;
            }
        }
    });
    const editHandle = context.scheduler.register({
        name: 'twitchStream.edit',
        intervalMs: streamConfig.editInterval,
        timeoutMs: Math.min(streamConfig.editInterval, 60000),
        immediate: false,
        run: () => editLiveNotifications(client)
    });
    activeCheck = () => checkHandle.trigger();
    return async () => {
        activeCheck = null;
        forceNextCheck = false;
        await Promise.all([checkHandle.stop(), editHandle.stop()]);
    };
};

return { initializer, requestTwitchCheck, _test: { buildNotificationContent } };
}

module.exports = { createTwitchStreamFeature };
