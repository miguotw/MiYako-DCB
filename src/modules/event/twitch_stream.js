const path = require('path');
const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

const EMBED_COLOR = config.embed.color.default;
const STREAM_CONFIG = configCommands.admin.stream || {};
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const DEFAULT_CHECK_INTERVAL_MINUTES = 2;
const DEFAULT_EDIT_INTERVAL_MINUTES = 5;
const MS_PER_MINUTE = 60000;

let accessToken = null;
let tokenExpiresAt = 0;
const streamStates = new Map();
let isChecking = false;
let isEditing = false;

function getStreamConfig() {
    const twitchUserLoginConfig = STREAM_CONFIG.twitchUserLogin;
    const twitchUserLogins = Array.isArray(twitchUserLoginConfig)
        ? twitchUserLoginConfig
        : [twitchUserLoginConfig];

    return {
        enable: STREAM_CONFIG.enable === true,
        twitchUserLogins: [...new Set(twitchUserLogins.map(login => String(login || '').trim()).filter(isFilled))],
        twitchClientID: String(STREAM_CONFIG.twitchClientID || '').trim(),
        twitchClientSecret: String(STREAM_CONFIG.twitchClientSecret || '').trim(),
        checkInterval: Math.max((Number(STREAM_CONFIG.checkInterval) || DEFAULT_CHECK_INTERVAL_MINUTES) * MS_PER_MINUTE, MS_PER_MINUTE),
        editInterval: Math.max((Number(STREAM_CONFIG.editInterval) || DEFAULT_EDIT_INTERVAL_MINUTES) * MS_PER_MINUTE, MS_PER_MINUTE),
        notifyOnStartupLive: STREAM_CONFIG.notifyOnStartupLive === true,
        messages: Array.isArray(STREAM_CONFIG.message) ? STREAM_CONFIG.message : [],
        targets: Array.isArray(STREAM_CONFIG.targets) ? STREAM_CONFIG.targets : []
    };
}

function isFilled(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function getRandomMessage(messages) {
    if (!messages.length) return '直播現在開始！一起觀看吧！';
    return messages[Math.floor(Math.random() * messages.length)];
}

function buildPreviewUrl(stream) {
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

function buildStreamEmbed(stream, user, twitchUserLogin, isOffline = false) {
    const streamUrl = `https://www.twitch.tv/${twitchUserLogin}`;
    const displayName = getDisplayName(stream, user);
    const startedAt = stream.started_at
        ? `<t:${Math.floor(new Date(stream.started_at).getTime() / 1000)}:R>${isOffline ? ' (已離線)' : ''}`
        : `未知${isOffline ? ' (已離線)' : ''}`;
    const embed = new EmbedBuilder()
        .setAuthor({ name: `🍘 ┃ ${displayName} 開始直播了` })
        .setColor(EMBED_COLOR)
        .setTitle(stream.title || `${displayName} 開始直播了！`)
        .setURL(streamUrl)
        .addFields(
            { name: '直播分類', value: stream.game_name || '未設定', inline: true },
            { name: '觀看人數', value: `${stream.viewer_count ?? 0}`, inline: true },
            { name: '開播時間', value: startedAt, inline: true }
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

async function getTwitchAccessToken(streamConfig) {
    if (accessToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return accessToken;
    }

    const body = new URLSearchParams({
        client_id: streamConfig.twitchClientID,
        client_secret: streamConfig.twitchClientSecret,
        grant_type: 'client_credentials'
    });

    const response = await axios.post('https://id.twitch.tv/oauth2/token', body);
    accessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (Number(response.data.expires_in) || 0) * 1000;

    return accessToken;
}

async function fetchStreams(streamConfig) {
    const token = await getTwitchAccessToken(streamConfig);
    const params = new URLSearchParams();
    for (const twitchUserLogin of streamConfig.twitchUserLogins) {
        params.append('user_login', twitchUserLogin);
    }

    const response = await axios.get(`https://api.twitch.tv/helix/streams?${params.toString()}`, {
        headers: {
            'Client-Id': streamConfig.twitchClientID,
            Authorization: `Bearer ${token}`
        }
    });

    return response.data.data || [];
}

async function fetchUsers(streamConfig) {
    const token = await getTwitchAccessToken(streamConfig);
    const params = new URLSearchParams();
    for (const twitchUserLogin of streamConfig.twitchUserLogins) {
        params.append('login', twitchUserLogin);
    }

    const response = await axios.get(`https://api.twitch.tv/helix/users?${params.toString()}`, {
        headers: {
            'Client-Id': streamConfig.twitchClientID,
            Authorization: `Bearer ${token}`
        }
    });

    return response.data.data || [];
}

function getMentionForTarget(guild, target) {
    const roleID = String(target.roleID || '').trim();
    const role = isFilled(roleID) ? guild.roles.cache.get(roleID) : null;

    if (role) {
        return {
            content: `<@&${role.id}>`,
            allowedMentions: { roles: [role.id] }
        };
    }

    return {
        content: '@everyone',
        allowedMentions: { parse: ['everyone'] }
    };
}

async function getNotificationChannel(guild, channelID) {
    return guild.channels.cache.get(channelID) || await guild.channels.fetch(channelID).catch(() => null);
}

async function notifyTargets(client, stream, user, streamConfig) {
    const notificationMessages = [];
    const targets = streamConfig.targets.filter(target => isFilled(target.guildID) && isFilled(target.channelID));
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
                content: `${mention.content} **${displayName}** ${randomMessage}`,
                embeds: [embed],
                components: [row],
                allowedMentions: mention.allowedMentions
            });
            notificationMessages.push(notificationMessage);
            sendLog(client, `✅ 已發送 Twitch 開播通知至「${guild.name}」#${channel.name}`);
        } catch (error) {
            sendLog(client, '❌ 發送 Twitch 開播通知時發生錯誤：', 'ERROR', error);
        }
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

    for (const result of editResults) {
        if (result.status === 'rejected') {
            sendLog(client, `❌ 更新 Twitch 直播通知時發生錯誤：${twitchUserLogin}`, 'ERROR', result.reason);
        }
    }
}

async function editLiveNotifications(client) {
    if (isEditing) return;
    isEditing = true;

    try {
        const liveStates = [...streamStates.values()].filter(state => state.isLive);
        await Promise.all(liveStates.map(state => updateNotifications(client, state)));
    } catch (error) {
        sendLog(client, '❌ 定時更新 Twitch 直播通知時發生錯誤：', 'ERROR', error);
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

    for (const result of editResults) {
        if (result.status === 'rejected') {
            sendLog(client, `❌ 將 Twitch 直播通知標記為離線時發生錯誤：${twitchUserLogin}`, 'ERROR', result.reason);
        }
    }
}

async function checkStreamStatus(client, streamConfig) {
    if (isChecking) return;
    isChecking = true;

    try {
        const [streams, users] = await Promise.all([
            fetchStreams(streamConfig),
            fetchUsers(streamConfig)
        ]);
        const liveStreams = new Map(streams.map(stream => [stream.user_login.toLowerCase(), stream]));
        const userProfiles = new Map(users.map(user => [user.login.toLowerCase(), user]));

        for (const twitchUserLogin of streamConfig.twitchUserLogins) {
            const stateKey = twitchUserLogin.toLowerCase();
            const stream = liveStreams.get(stateKey);
            const user = userProfiles.get(stateKey);
            const currentlyLive = Boolean(stream);
            const state = streamStates.get(stateKey) || { initialized: false, isLive: false };

            if (!state.initialized) {
                sendLog(client, `✅ Twitch 直播監聽已啟動：${twitchUserLogin} 目前${currentlyLive ? '正在直播' : '未直播'}`);

                if (currentlyLive && streamConfig.notifyOnStartupLive) {
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
                updateLiveState(state, stream, user);
                continue;
            }

            if (state.isLive && !currentlyLive) {
                await markNotificationsOffline(client, state, user, twitchUserLogin);
                streamStates.set(stateKey, { initialized: true, isLive: false });
                sendLog(client, `ℹ️ Twitch 主播 ${twitchUserLogin} 已結束直播。`);
            }
        }
    } catch (error) {
        sendLog(client, '❌ 檢查 Twitch 直播狀態時發生錯誤：', 'ERROR', error);
    } finally {
        isChecking = false;
    }
}

module.exports = (client) => {
    const streamConfig = getStreamConfig();

    if (!streamConfig.enable) return;

    if (!streamConfig.twitchUserLogins.length || !isFilled(streamConfig.twitchClientID) || !isFilled(streamConfig.twitchClientSecret)) {
        sendLog(client, '⚠️ Twitch 直播監聽設定不完整，請檢查 twitchUserLogin、twitchClientID、twitchClientSecret。', 'WARN');
        return;
    }

    client.once(Events.ClientReady, () => {
        checkStreamStatus(client, streamConfig);
        setInterval(() => {
            checkStreamStatus(client, streamConfig);
        }, streamConfig.checkInterval);
        setInterval(() => {
            editLiveNotifications(client);
        }, streamConfig.editInterval);
    });
};
