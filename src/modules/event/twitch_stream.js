'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { http } = require('../../../core/http');
const { createLogTools } = require('../../../core/sendLog');
const { createTwitchStreamRepository } = require('../../../util/twitchStreamRepository');

function createTwitchStreamFeature(config, {
    checkStreamStatusImpl = null,
    logTools = createLogTools(config),
    httpClient = http,
    repositoryFactory = createTwitchStreamRepository
} = {}) {
const { sendLog } = logTools;
const STREAM_CONFIG = config.commands.stream || {};
const EMBED_COLOR = config.embed.color.default;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MS_PER_MINUTE = 60_000;
const streamStates = new Map();
let accessToken = null;
let tokenExpiresAt = 0;
let tokenRequest = null;
let activeCheck = null;
let forceNextCheck = false;
let repository = null;

function requestTwitchCheck() {
    forceNextCheck = true;
    return activeCheck ? activeCheck() : Promise.resolve(false);
}

function getStreamConfig() {
    return {
        twitchClientId: String(STREAM_CONFIG.twitchClientId || '').trim(),
        twitchClientSecret: String(STREAM_CONFIG.twitchClientSecret || '').trim(),
        checkInterval: Math.max(Number(STREAM_CONFIG.checkInterval || 2) * MS_PER_MINUTE, MS_PER_MINUTE),
        editInterval: Math.max(Number(STREAM_CONFIG.editInterval || 5) * MS_PER_MINUTE, MS_PER_MINUTE),
        notifyOnStartupLive: STREAM_CONFIG.notifyOnStartupLive === true,
        messages: Array.isArray(STREAM_CONFIG.message) ? STREAM_CONFIG.message : []
    };
}

function isFilled(value) { return typeof value === 'string' && value.trim() !== ''; }
function chunks(values, size = 100) {
    const result = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
}

async function getRuntimeStreamConfig(client, base) {
    const subscriptions = (await repository.listSubscriptions([...client.guilds.cache.keys()]))
        .filter(item => isFilled(item.twitchUserLogin) && isFilled(item.channelID));
    return {
        ...base,
        twitchUserLogins: [...new Set(subscriptions.map(item => item.twitchUserLogin.toLowerCase()))],
        targets: subscriptions
    };
}

async function getTwitchAccessToken(streamConfig, signal, force = false) {
    if (!force && accessToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return accessToken;
    if (tokenRequest) return tokenRequest;
    tokenRequest = (async () => {
        const body = new URLSearchParams({
            client_id: streamConfig.twitchClientId,
            client_secret: streamConfig.twitchClientSecret,
            grant_type: 'client_credentials'
        });
        const response = await httpClient.post('https://id.twitch.tv/oauth2/token', body, { signal });
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + Number(response.data.expires_in || 0) * 1000;
        return accessToken;
    })().finally(() => { tokenRequest = null; });
    return tokenRequest;
}

function isUnauthorized(error) { return error?.response?.status === 401 || error?.status === 401; }

async function helixBatch(streamConfig, endpoint, parameter, values, signal) {
    const output = [];
    for (const batch of chunks(values, 100)) {
        let completed = false;
        for (let attempt = 0; attempt < 2 && !completed; attempt++) {
            const token = await getTwitchAccessToken(streamConfig, signal, attempt === 1);
            const params = new URLSearchParams();
            for (const value of batch) params.append(parameter, value);
            try {
                const response = await httpClient.get(`https://api.twitch.tv/helix/${endpoint}?${params}`, {
                    headers: { 'Client-Id': streamConfig.twitchClientId, Authorization: `Bearer ${token}` },
                    signal
                });
                output.push(...(response.data.data || []));
                completed = true;
            } catch (error) {
                if (attempt === 0 && isUnauthorized(error)) {
                    accessToken = null;
                    tokenExpiresAt = 0;
                    continue;
                }
                throw error;
            }
        }
    }
    return output;
}

function fetchStreams(streamConfig, signal) {
    return helixBatch(streamConfig, 'streams', 'user_login', streamConfig.twitchUserLogins, signal);
}
function fetchUsers(streamConfig, signal) {
    return helixBatch(streamConfig, 'users', 'login', streamConfig.twitchUserLogins, signal);
}
async function fetchUserColors(streamConfig, users, signal) {
    if (!users.length) return new Map();
    const values = await helixBatch(streamConfig, 'chat/color', 'user_id', users.map(user => user.id), signal);
    return new Map(values.map(item => [item.user_id, item.color]));
}

function getRandomMessage(messages) {
    return messages.length ? messages[Math.floor(Math.random() * messages.length)] : '直播現在開始！一起觀看吧！';
}
function getDisplayName(stream, user) { return user?.display_name || stream.user_name || stream.user_login; }
function getEmbedColor(user) { return /^#[0-9a-f]{6}$/i.test(user?.twitchColor || '') ? user.twitchColor : EMBED_COLOR; }
function buildPreviewUrl(stream) {
    const raw = stream.thumbnail_url || `https://static-cdn.jtvnw.net/previews-ttv/live_user_${stream.user_login}-1280x720.jpg`;
    const sized = raw.replace('{width}', '1280').replace('{height}', '720');
    return `${sized}${sized.includes('?') ? '&' : '?'}r=${Date.now()}`;
}

function buildStreamEmbed(stream, user, twitchUserLogin, isOffline = false) {
    const displayName = getDisplayName(stream, user);
    const startedAt = stream.started_at
        ? `<t:${Math.floor(new Date(stream.started_at).getTime() / 1000)}:R>${isOffline ? ' (已離線)' : ''}`
        : `未知${isOffline ? ' (已離線)' : ''}`;
    const embed = new EmbedBuilder()
        .setAuthor({ name: `🍘 ┃ ${displayName} 開始直播了` })
        .setColor(getEmbedColor(user))
        .setTitle(stream.title || `${displayName} 開始直播了！`)
        .setURL(`https://www.twitch.tv/${twitchUserLogin}`)
        .addFields(
            { name: '直播分類', value: stream.game_name || '未設定', inline: true },
            { name: '觀看人數', value: `${stream.viewer_count ?? 0}`, inline: true },
            { name: '開播時間', value: startedAt, inline: true }
        ).setTimestamp();
    const tags = (Array.isArray(stream.tags) ? stream.tags : []).filter(isFilled);
    if (tags.length) embed.addFields({ name: '標籤', value: tags.map(tag => `\`${String(tag).replace(/`/g, "'")}\``).join('  ') });
    const image = isOffline ? user?.offline_image_url : buildPreviewUrl(stream);
    if (image) embed.setImage(`${image}${isOffline ? `${image.includes('?') ? '&' : '?'}r=${Date.now()}` : ''}`);
    if (user?.profile_image_url) embed.setThumbnail(user.profile_image_url);
    return embed;
}

function buildWatchButton(login) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setLabel('前往觀看直播').setURL(`https://www.twitch.tv/${login}`).setStyle(ButtonStyle.Link));
}

function getMentionForTarget(guild, target) {
    const roleID = String(target.roleID || '').trim();
    const role = roleID && roleID !== guild.id ? guild.roles.cache.get(roleID) : null;
    if (role) return { content: `<@&${role.id}>`, allowedMentions: { parse: [], roles: [role.id], users: [] } };
    return { content: '', allowedMentions: { parse: [], roles: [], users: [] } };
}

function buildNotificationContent(mentionContent, displayName, message) {
    const prefix = `${mentionContent ? `${mentionContent} ` : ''}**${displayName}** `;
    return `${prefix}${String(message || '').slice(0, Math.max(2000 - prefix.length, 0))}`.slice(0, 2000);
}

async function getNotificationChannel(guild, channelID) {
    const cached = guild.channels.cache.get(channelID);
    if (cached) return cached;
    try { return await guild.channels.fetch(channelID); }
    catch (error) {
        if (error?.code === 10003) return null;
        throw error;
    }
}

async function getNotificationMessage(channel, messageID) {
    if (!channel?.messages) return null;
    try { return await channel.messages.fetch(String(messageID)); }
    catch (error) {
        if (error?.code === 10003 || error?.code === 10008) return null;
        throw error;
    }
}

async function notifyTargets(client, stream, user, streamConfig) {
    const login = String(stream.user_login).toLowerCase();
    const targets = streamConfig.targets.filter(item => item.twitchUserLogin === login);
    const messages = [];
    const errors = [];
    for (const target of targets) {
        try {
            const guild = client.guilds.cache.get(String(target.guildID));
            const channel = guild && await getNotificationChannel(guild, String(target.channelID));
            if (!guild || !channel || typeof channel.send !== 'function') continue;
            const mention = getMentionForTarget(guild, target);
            const message = await channel.send({
                content: buildNotificationContent(mention.content, getDisplayName(stream, user), getRandomMessage(streamConfig.messages)),
                embeds: [buildStreamEmbed(stream, user, login)],
                components: [buildWatchButton(login)],
                allowedMentions: mention.allowedMentions
            });
            messages.push(message);
            await repository.saveNotification(login, message, stream);
        } catch (error) {
            errors.push(error);
            sendLog(client, '❌ 發送 Twitch 開播通知時發生錯誤：', 'ERROR', error);
        }
    }
    if (errors.length && !messages.length) throw new AggregateError(errors, `發送 Twitch 開播通知失敗：${login}`);
    return messages;
}

function createLiveState(stream, user, login, notificationMessages = []) {
    return {
        initialized: true, isLive: true, notificationMessages,
        viewerCount: Number(stream.viewer_count) || 0,
        lastStream: { ...stream }, user, twitchUserLogin: login
    };
}

function updateLiveState(state, stream, user) {
    state.viewerCount = Math.max(state.viewerCount || 0, Number(stream.viewer_count) || 0);
    state.lastStream = { ...stream, viewer_count: state.viewerCount };
    state.user = user;
}

async function removePersistedState(login, messages) {
    const guildIDs = [...new Set(messages.map(message => String(message.guildId || message.guild?.id || '')).filter(isFilled))];
    await repository.removeNotifications(login, guildIDs);
}

async function updateNotifications(client, state) {
    if (!state.notificationMessages.length || !state.lastStream) return;
    const embed = buildStreamEmbed(state.lastStream, state.user, state.twitchUserLogin);
    const results = await Promise.allSettled(state.notificationMessages.map(message => message.edit({ embeds: [embed] })));
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    for (const message of state.notificationMessages) {
        await repository.saveNotification(state.twitchUserLogin, message, state.lastStream);
    }
    if (errors.length) throw new AggregateError(errors, `更新 Twitch 直播通知失敗：${state.twitchUserLogin}`);
}

async function editLiveNotifications(client) {
    const results = await Promise.allSettled([...streamStates.values()]
        .filter(state => state.isLive).map(state => updateNotifications(client, state)));
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, '更新 Twitch 直播通知失敗。');
}

async function markOffline(state) {
    if (!state.notificationMessages?.length || !state.lastStream) return;
    const embed = buildStreamEmbed(state.lastStream, state.user, state.twitchUserLogin, true);
    const results = await Promise.allSettled(state.notificationMessages.map(message => message.edit({ embeds: [embed] })));
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, `更新 Twitch 離線通知失敗：${state.twitchUserLogin}`);
}

async function restoreNotificationStates(client, streamConfig) {
    const configured = new Set(streamConfig.twitchUserLogins);
    for (const guildID of client.guilds.cache.keys()) {
        const store = await repository.readGuild(guildID);
        const valid = [];
        const guild = client.guilds.cache.get(guildID);
        for (const saved of store.notifications) {
            if (!configured.has(saved.twitchUserLogin) || !saved.stream) continue;
            const channel = await getNotificationChannel(guild, String(saved.channelID));
            const message = await getNotificationMessage(channel, saved.messageID);
            if (!message) continue;
            valid.push(saved);
            const state = streamStates.get(saved.twitchUserLogin);
            if (state) state.notificationMessages.push(message);
            else streamStates.set(saved.twitchUserLogin, createLiveState(saved.stream, null, saved.twitchUserLogin, [message]));
        }
        if (valid.length !== store.notifications.length) await repository.writeGuild(guildID, { ...store, notifications: valid });
    }
}

async function checkStreamStatus(client, baseConfig, forceNotifyCurrentLive = false, signal) {
    const streamConfig = await getRuntimeStreamConfig(client, baseConfig);
    if (!streamConfig.twitchUserLogins.length) return;
    const [streams, users] = await Promise.all([fetchStreams(streamConfig, signal), fetchUsers(streamConfig, signal)]);
    const colors = await fetchUserColors(streamConfig, users, signal).catch(() => new Map());
    for (const user of users) user.twitchColor = colors.get(user.id) || '';
    const live = new Map(streams.map(item => [item.user_login.toLowerCase(), item]));
    const profiles = new Map(users.map(item => [item.login.toLowerCase(), item]));

    for (const login of streamConfig.twitchUserLogins) {
        if (signal?.aborted) throw signal.reason;
        const stream = live.get(login);
        const user = profiles.get(login);
        const state = streamStates.get(login) || { initialized: false, isLive: false };
        if (!state.initialized) {
            if (stream && (streamConfig.notifyOnStartupLive || forceNotifyCurrentLive)) {
                streamStates.set(login, createLiveState(stream, user, login, await notifyTargets(client, stream, user, streamConfig)));
            } else if (stream) streamStates.set(login, createLiveState(stream, user, login));
            else streamStates.set(login, { initialized: true, isLive: false });
            continue;
        }
        if (!state.isLive && stream) {
            streamStates.set(login, createLiveState(stream, user, login, await notifyTargets(client, stream, user, streamConfig)));
        } else if (state.isLive && stream
            && state.lastStream?.started_at && stream.started_at
            && state.lastStream.started_at !== stream.started_at) {
            await markOffline(state);
            await removePersistedState(login, state.notificationMessages);
            streamStates.set(login, createLiveState(stream, user, login,
                await notifyTargets(client, stream, user, streamConfig)));
        } else if (state.isLive && stream) {
            updateLiveState(state, stream, user);
            const allowed = new Set(streamConfig.targets.filter(item => item.twitchUserLogin === login)
                .map(item => `${item.guildID}:${item.channelID}`));
            state.notificationMessages = state.notificationMessages.filter(message =>
                allowed.has(`${message.guildId || message.guild?.id}:${message.channelId}`));
            const existing = new Set(state.notificationMessages.map(message =>
                `${message.guildId || message.guild?.id}:${message.channelId}`));
            const missing = streamConfig.targets.filter(item => item.twitchUserLogin === login
                && !existing.has(`${item.guildID}:${item.channelID}`));
            if (missing.length) state.notificationMessages.push(...await notifyTargets(client, stream, user, { ...streamConfig, targets: missing }));
        } else if (state.isLive && !stream) {
            await markOffline(state);
            await removePersistedState(login, state.notificationMessages);
            streamStates.set(login, { initialized: true, isLive: false });
        }
    }
}

async function reconcileRemovedSubscription(client, guildID, login, notifications = []) {
    const state = streamStates.get(String(login).toLowerCase());
    for (const saved of notifications) {
        const guild = client.guilds.cache.get(String(guildID));
        const channel = guild && await getNotificationChannel(guild, String(saved.channelID));
        const message = await getNotificationMessage(channel, saved.messageID).catch(error => {
            sendLog(client, '⚠️ 讀取已移除的 Twitch 通知失敗。', 'WARN', error);
            return null;
        });
        if (!message) continue;
        const payload = {
            content: `**${login}** 的直播通知已停止追蹤。`,
            allowedMentions: { parse: [], roles: [], users: [] }
        };
        if (saved.stream) payload.embeds = [buildStreamEmbed(saved.stream, null, login, true)];
        await message.edit(payload).catch(error => sendLog(client, '⚠️ 更新已移除的 Twitch 通知失敗。', 'WARN', error));
    }
    if (state) state.notificationMessages = state.notificationMessages.filter(message =>
        String(message.guildId || message.guild?.id) !== String(guildID));
}

function createMemoryRepository() {
    return {
        listSubscriptions: async () => [], readGuild: async () => ({ subscriptions: [], notifications: [] }),
        writeGuild: async () => {}, saveNotification: async () => {}, removeNotifications: async () => []
    };
}

const initializer = async (client, context = {}) => {
    repository = context.store?.twitchStream
        ? repositoryFactory(context.store.twitchStream)
        : createMemoryRepository();
    const streamConfig = getStreamConfig();
    if (!isFilled(streamConfig.twitchClientId) || !isFilled(streamConfig.twitchClientSecret)) {
        activeCheck = null;
        sendLog(client, '⚠️ Twitch 憑證未設定，直播背景輪詢未啟動。', 'WARN');
        return;
    }
    if (!context.scheduler) throw new Error('Twitch feature 缺少 scheduler context。');
    if (!checkStreamStatusImpl) {
        await restoreNotificationStates(client, await getRuntimeStreamConfig(client, streamConfig));
    }
    const checkHandle = context.scheduler.register({
        name: 'twitchStream.check', intervalMs: streamConfig.checkInterval,
        timeoutMs: Math.min(streamConfig.checkInterval, 60_000), immediate: true,
        run: async ({ signal }) => {
            const force = forceNextCheck;
            forceNextCheck = false;
            try { return await (checkStreamStatusImpl || checkStreamStatus)(client, streamConfig, force, signal); }
            catch (error) { if (force) forceNextCheck = true; throw error; }
        }
    });
    const editHandle = context.scheduler.register({
        name: 'twitchStream.edit', intervalMs: streamConfig.editInterval,
        timeoutMs: Math.min(streamConfig.editInterval, 60_000), immediate: false,
        run: () => editLiveNotifications(client)
    });
    activeCheck = () => checkHandle.trigger();
    return async () => {
        activeCheck = null;
        forceNextCheck = false;
        await Promise.all([checkHandle.stop(), editHandle.stop()]);
    };
};

return {
    initializer, requestTwitchCheck, reconcileRemovedSubscription,
    _test: { buildNotificationContent, getMentionForTarget, helixBatch, chunks }
};
}

module.exports = { createTwitchStreamFeature };
