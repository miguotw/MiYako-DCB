const path = require('path');
const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));

const EMBED_COLOR = config.embed.color.default;
const STREAM_CONFIG = configCommands.admin.stream || {};
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

let accessToken = null;
let tokenExpiresAt = 0;
const streamStates = new Map();
let isChecking = false;

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
        checkInterval: Math.max(Number(STREAM_CONFIG.checkInterval) || 120000, 60000),
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

function getDisplayName(stream, user) {
    return user?.display_name || stream.user_name || stream.user_login;
}

function buildStreamEmbed(stream, user, twitchUserLogin) {
    const streamUrl = `https://www.twitch.tv/${twitchUserLogin}`;
    const displayName = getDisplayName(stream, user);
    const embed = new EmbedBuilder()
        .setAuthor({ name: `🍘 ┃ ${displayName} 開始直播了` })
        .setColor(EMBED_COLOR)
        .setTitle(stream.title || `${displayName} 開始直播了！`)
        .setURL(streamUrl)
        .addFields(
            { name: '直播分類', value: stream.game_name || '未設定', inline: true },
            { name: '目前觀看人數', value: `${stream.viewer_count ?? 0}`, inline: true },
            { name: '開播時間', value: stream.started_at ? `<t:${Math.floor(new Date(stream.started_at).getTime() / 1000)}:R>` : '未知', inline: true }
        )
        .setImage(buildPreviewUrl(stream))
        .setTimestamp();

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
    const targets = streamConfig.targets.filter(target => isFilled(target.guildID) && isFilled(target.channelID));
    if (!targets.length) {
        sendLog(client, '⚠️ Twitch 直播通知未設定任何有效伺服器與頻道，略過通知。', 'WARN');
        return;
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
            await channel.send({
                content: `${mention.content} **${displayName}** ${randomMessage}`,
                embeds: [embed],
                components: [row],
                allowedMentions: mention.allowedMentions
            });
            sendLog(client, `✅ 已發送 Twitch 開播通知至「${guild.name}」#${channel.name}`);
        } catch (error) {
            sendLog(client, '❌ 發送 Twitch 開播通知時發生錯誤：', 'ERROR', error);
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
                streamStates.set(stateKey, { initialized: true, isLive: currentlyLive });
                sendLog(client, `✅ Twitch 直播監聽已啟動：${twitchUserLogin} 目前${currentlyLive ? '正在直播' : '未直播'}`);

                if (currentlyLive && streamConfig.notifyOnStartupLive) {
                    await notifyTargets(client, stream, user, streamConfig);
                }
                continue;
            }

            if (!state.isLive && currentlyLive) {
                streamStates.set(stateKey, { initialized: true, isLive: true });
                await notifyTargets(client, stream, user, streamConfig);
                continue;
            }

            if (state.isLive && !currentlyLive) {
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
    });
};
