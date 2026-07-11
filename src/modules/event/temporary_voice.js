const path = require('path');
const { ChannelType, Events } = require('discord.js');
const { configModules } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const {
    addManagedChannel,
    listStoredGuildIDs,
    loadGuildStore,
    removeEntrance,
    removeManagedChannel,
    updateManagedChannel
} = require(path.join(process.cwd(), 'util/temporaryVoiceStore'));

const timers = new Map();
const UNKNOWN_CHANNEL_ERROR_CODE = 10003;
const MINUTE = 60 * 1000;
const MAX_TIMEOUT = 2 ** 31 - 1;

function getDeleteDelay() {
    const minutes = Number(configModules.temporaryVoice?.deleteAfterMinutes);
    return Math.max(Number.isFinite(minutes) ? minutes : 5, 1) * MINUTE;
}

function getTimerKey(guildID, channelID) {
    return `${guildID}:${channelID}`;
}

function clearDeleteTimer(guildID, channelID) {
    const key = getTimerKey(guildID, channelID);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
}

function buildChannelName(member, prefix) {
    const memberName = member.nickname || member.user.displayName || member.id;
    return `${prefix || ''}${memberName}`.slice(0, 100);
}

function serializePermissionOverwrites(channel) {
    return channel.permissionOverwrites.cache.map(overwrite => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield,
        deny: overwrite.deny.bitfield
    }));
}

async function fetchGuildChannel(guild, channelID) {
    const cached = guild.channels.cache.get(channelID);
    if (cached) return { channel: cached, missing: false };

    try {
        const channel = await guild.channels.fetch(channelID);
        return { channel, missing: !channel };
    } catch (error) {
        return { channel: null, missing: error.code === UNKNOWN_CHANNEL_ERROR_CODE, error };
    }
}

async function deleteIfStillEmpty(client, guildID, channelID) {
    clearDeleteTimer(guildID, channelID);
    const guild = client.guilds.cache.get(guildID);
    if (!guild) return;

    const store = loadGuildStore(guildID);
    const record = store.channels[channelID];
    if (!record) return;

    const result = await fetchGuildChannel(guild, channelID);
    if (!result.channel || result.channel.type !== ChannelType.GuildVoice) {
        if (result.missing) removeManagedChannel(guildID, channelID);
        else if (result.channel) removeManagedChannel(guildID, channelID);
        else sendLog(client, `⚠️ 無法確認臨時語音頻道 ${channelID} 是否存在。`, 'WARN', result.error);
        return;
    }

    if (result.channel.members.size > 0) {
        updateManagedChannel(guildID, channelID, { emptySince: null });
        return;
    }

    try {
        await result.channel.delete('臨時語音頻道已空置逾時');
        removeManagedChannel(guildID, channelID);
        sendLog(client, `🗑️ 已刪除空置的臨時語音頻道「${result.channel.name}」。`);
    } catch (error) {
        sendLog(client, `❌ 無法刪除臨時語音頻道 ${channelID}：`, 'ERROR', error);
        scheduleDelete(client, guildID, channelID, new Date().toISOString());
    }
}

function scheduleDelete(client, guildID, channelID, emptySince) {
    clearDeleteTimer(guildID, channelID);
    const elapsed = Date.now() - Date.parse(emptySince);
    const remaining = Math.max(getDeleteDelay() - (Number.isFinite(elapsed) ? elapsed : 0), 0);
    const delay = Math.min(remaining, MAX_TIMEOUT);
    const key = getTimerKey(guildID, channelID);

    timers.set(key, setTimeout(() => {
        if (remaining > MAX_TIMEOUT) {
            scheduleDelete(client, guildID, channelID, emptySince);
            return;
        }
        deleteIfStillEmpty(client, guildID, channelID).catch(error => {
            sendLog(client, `❌ 檢查臨時語音頻道 ${channelID} 時發生錯誤：`, 'ERROR', error);
        });
    }, delay));
}

async function reconcileManagedChannel(client, guild, channelID, record) {
    const result = await fetchGuildChannel(guild, channelID);
    if (!result.channel || result.channel.type !== ChannelType.GuildVoice) {
        if (result.missing) {
            removeManagedChannel(guild.id, channelID);
            clearDeleteTimer(guild.id, channelID);
        } else if (result.channel) {
            removeManagedChannel(guild.id, channelID);
            clearDeleteTimer(guild.id, channelID);
        } else {
            sendLog(client, `⚠️ 無法載入臨時語音頻道 ${channelID}。`, 'WARN', result.error);
        }
        return;
    }

    if (result.channel.members.size > 0) {
        clearDeleteTimer(guild.id, channelID);
        if (record.emptySince) updateManagedChannel(guild.id, channelID, { emptySince: null });
        return;
    }

    const emptySince = record.emptySince || new Date().toISOString();
    if (!record.emptySince) updateManagedChannel(guild.id, channelID, { emptySince });
    scheduleDelete(client, guild.id, channelID, emptySince);
}

async function reconcileGuild(client, guild) {
    const store = loadGuildStore(guild.id);

    for (const entranceID of Object.keys(store.entrances)) {
        const result = await fetchGuildChannel(guild, entranceID);
        if (result.missing || (result.channel && result.channel.type !== ChannelType.GuildVoice)) {
            removeEntrance(guild.id, entranceID);
            sendLog(client, `⚠️ 臨時語音入口 ${entranceID} 已不存在，已移除設定。`, 'WARN');
        } else if (!result.channel) {
            sendLog(client, `⚠️ 無法確認臨時語音入口 ${entranceID}。`, 'WARN', result.error);
        }
    }

    const refreshedStore = loadGuildStore(guild.id);
    for (const [channelID, record] of Object.entries(refreshedStore.channels)) {
        await reconcileManagedChannel(client, guild, channelID, record);
    }
}

async function createTemporaryChannel(client, entrance, member, prefix) {
    let temporaryChannel = null;
    try {
        temporaryChannel = await entrance.guild.channels.create({
            name: buildChannelName(member, prefix),
            type: ChannelType.GuildVoice,
            parent: entrance.parentId,
            permissionOverwrites: serializePermissionOverwrites(entrance),
            reason: `為 ${member.user.tag} 建立臨時語音頻道`
        });

        await temporaryChannel.setPosition(entrance.rawPosition + 1).catch(error => {
            sendLog(client, `⚠️ 無法將臨時語音頻道排在入口 ${entrance.id} 下方。`, 'WARN', error);
        });

        addManagedChannel(entrance.guild.id, temporaryChannel.id, {
            entranceChannelID: entrance.id,
            ownerID: member.id
        });
        if (member.voice.channelId !== entrance.id) {
            throw new Error('成員已離開入口頻道，取消移動。');
        }
        await member.voice.setChannel(temporaryChannel, '移入新建立的臨時語音頻道');
        sendLog(client, `🔊 已為 ${member.user.tag} 建立臨時語音頻道「${temporaryChannel.name}」。`);
    } catch (error) {
        if (temporaryChannel) {
            removeManagedChannel(entrance.guild.id, temporaryChannel.id);
            if (temporaryChannel.members.size === 0) {
                await temporaryChannel.delete('建立或移動成員失敗，清理空頻道').catch(() => {});
            }
        }
        sendLog(client, `❌ 無法為 ${member.user.tag} 建立臨時語音頻道：`, 'ERROR', error);
    }
}

async function handleVoiceStateUpdate(client, oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const store = loadGuildStore(guild.id);

    if (oldState.channelId && oldState.channelId !== newState.channelId && store.channels[oldState.channelId]) {
        const oldChannel = oldState.channel;
        if (oldChannel && oldChannel.members.size === 0) {
            const emptySince = new Date().toISOString();
            updateManagedChannel(guild.id, oldState.channelId, { emptySince });
            scheduleDelete(client, guild.id, oldState.channelId, emptySince);
        }
    }

    if (newState.channelId && store.channels[newState.channelId]) {
        clearDeleteTimer(guild.id, newState.channelId);
        if (store.channels[newState.channelId].emptySince) {
            updateManagedChannel(guild.id, newState.channelId, { emptySince: null });
        }
    }

    const entrance = newState.channelId ? store.entrances[newState.channelId] : null;
    if (entrance && oldState.channelId !== newState.channelId && !newState.member.user.bot) {
        await createTemporaryChannel(client, newState.channel, newState.member, entrance.prefix);
    }
}

module.exports = client => {
    client.once(Events.ClientReady, async () => {
        for (const guildID of listStoredGuildIDs()) {
            const guild = client.guilds.cache.get(guildID);
            if (!guild) continue;
            try {
                await reconcileGuild(client, guild);
            } catch (error) {
                sendLog(client, `❌ 恢復伺服器 ${guildID} 的臨時語音頻道時發生錯誤：`, 'ERROR', error);
            }
        }
        sendLog(client, '✅ 臨時語音頻道管理已啟動。');
    });

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        handleVoiceStateUpdate(client, oldState, newState).catch(error => {
            sendLog(client, '❌ 處理臨時語音頻道事件時發生錯誤：', 'ERROR', error);
        });
    });

    client.on(Events.ChannelDelete, channel => {
        if (!channel.guildId) return;
        try {
            const store = loadGuildStore(channel.guildId);
            if (store.entrances[channel.id]) removeEntrance(channel.guildId, channel.id);
            if (store.channels[channel.id]) removeManagedChannel(channel.guildId, channel.id);
            clearDeleteTimer(channel.guildId, channel.id);
        } catch (error) {
            sendLog(client, `❌ 同步已刪除的頻道 ${channel.id} 時發生錯誤：`, 'ERROR', error);
        }
    });
};

module.exports.buildChannelName = buildChannelName;
