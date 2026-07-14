'use strict';

const { ChannelType, Events } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');
const { createTemporaryVoiceRepository } = require('../../../util/temporaryVoiceRepository');

function createInitializer(config) {
const { sendLog } = createLogTools(config);
const DELETE_DELAY_MS = config.modules.temporaryVoice.deleteAfterMinutes * 60_000;
const UNKNOWN_CHANNEL = 10003;
const locks = new Map();
const deletionJobs = new Map();
const stoppingDeletionJobs = new Map();
let repository;
let runtimeContext;

function key(guildID, channelID) { return `${guildID}:${channelID}`; }

async function withLock(lockKey, operation) {
    const previous = locks.get(lockKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(lockKey, current);
    try { return await current; }
    finally { if (locks.get(lockKey) === current) locks.delete(lockKey); }
}

function buildChannelName(member, prefix) {
    const memberName = member.nickname || member.user.displayName || member.id;
    return `${prefix || ''}${memberName}`.slice(0, 100);
}

function serializePermissionOverwrites(channel) {
    return channel.permissionOverwrites.cache.map(overwrite => ({
        id: overwrite.id, type: overwrite.type,
        allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield
    }));
}

function isTransient(error) {
    if (!error) return false;
    if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(error.code)) return true;
    return error.status === 429 || error.status >= 500 || error.rawError?.retry_after !== undefined;
}

async function fetchGuildChannel(guild, channelID) {
    const cached = guild.channels.cache.get(channelID);
    if (cached) return { channel: cached, missing: false };
    try {
        const channel = await guild.channels.fetch(channelID);
        return { channel, missing: !channel };
    } catch (error) {
        return { channel: null, missing: error.code === UNKNOWN_CHANNEL, error };
    }
}

function scheduleDeletion(client, guildID, channelID, generation, deadlineAt) {
    const jobKey = key(guildID, channelID);
    const stoppingJob = stoppingDeletionJobs.get(jobKey);
    if (stoppingJob) {
        void stoppingJob.then(() => {
            if (runtimeContext) scheduleDeletion(client, guildID, channelID, generation, deadlineAt);
        });
        return;
    }
    const current = deletionJobs.get(jobKey);
    if (current) {
        current.generation = generation;
        current.handle.reschedule(deadlineAt);
        return;
    }
    const entry = { generation, handle: null };
    entry.handle = runtimeContext.scheduler.scheduleDeadline({
        name: `temporaryVoice.delete.${guildID}.${channelID}`,
        deadlineAt,
        timeoutMs: 20_000,
        run: () => deleteIfStillEmpty(client, guildID, channelID, entry)
    });
    deletionJobs.set(jobKey, entry);
}

function cancelDeletion(guildID, channelID) {
    const jobKey = key(guildID, channelID);
    const entry = deletionJobs.get(jobKey);
    if (!entry) return;
    deletionJobs.delete(jobKey);
    // stop 會立即取消 timer/signal；不可在 channel mutex 內等待，避免與正等鎖的 job 互鎖。
    const stoppingJob = entry.handle.stop().catch(error => {
        sendLog(runtimeContext?.client, `⚠️ 取消臨時語音頻道 ${channelID} 的刪除工作失敗。`, 'WARN', error);
    }).finally(() => {
        if (stoppingDeletionJobs.get(jobKey) === stoppingJob) stoppingDeletionJobs.delete(jobKey);
    });
    stoppingDeletionJobs.set(jobKey, stoppingJob);
}

async function markOccupied(guildID, channelID, cancelJob = true) {
    await repository.updateChannel(guildID, channelID, record => {
        record.generation = Number(record.generation || 0) + 1;
        record.emptySince = null;
        record.retryAttempts = 0;
    });
    if (cancelJob) cancelDeletion(guildID, channelID);
}

async function markEmpty(client, guildID, channelID) {
    const now = new Date().toISOString();
    const record = await repository.updateChannel(guildID, channelID, current => {
        current.generation = Number(current.generation || 0) + 1;
        current.emptySince = now;
        current.retryAttempts = 0;
    });
    if (record) scheduleDeletion(client, guildID, channelID, record.generation, Date.parse(now) + DELETE_DELAY_MS);
}

async function deleteIfStillEmpty(client, guildID, channelID, job) {
    return withLock(key(guildID, channelID), async () => {
        const guild = client.guilds.cache.get(String(guildID));
        if (!guild) return;
        const store = await repository.readGuild(guildID);
        const record = store.channels[channelID];
        if (!record || Number(record.generation) !== Number(job.generation) || !record.emptySince) return;

        const result = await fetchGuildChannel(guild, channelID);
        if (result.missing || (result.channel && result.channel.type !== ChannelType.GuildVoice)) {
            await repository.removeChannel(guildID, channelID);
            return;
        }
        if (!result.channel) {
            if (isTransient(result.error)) {
                const updated = await repository.updateChannel(guildID, channelID, current => {
                    current.retryAttempts = Number(current.retryAttempts || 0) + 1;
                });
                const delay = Math.min(5_000 * (2 ** Math.max(updated.retryAttempts - 1, 0)), 5 * 60_000);
                scheduleDeletion(client, guildID, channelID, updated.generation, Date.now() + delay);
                return;
            }
            sendLog(client, `⚠️ 無法確認臨時語音頻道 ${channelID} 是否存在。`, 'WARN', result.error);
            return;
        }
        if (result.channel.members.size > 0) {
            // 目前就是該 deadline job，不能在自身執行期間等待 stop。
            await markOccupied(guildID, channelID, false);
            return;
        }

        // delete 前再次讀取 generation，關閉 fetch 與 delete 之間成員事件造成的競態。
        const latest = (await repository.readGuild(guildID)).channels[channelID];
        if (!latest || Number(latest.generation) !== Number(job.generation) || result.channel.members.size > 0) return;
        try {
            await result.channel.delete('臨時語音頻道已空置逾時');
            await repository.removeChannel(guildID, channelID);
            sendLog(client, `🗑️ 已刪除空置的臨時語音頻道「${result.channel.name}」。`);
        } catch (error) {
            if (!isTransient(error)) {
                sendLog(client, `❌ 無法刪除臨時語音頻道 ${channelID}：`, 'ERROR', error);
                return;
            }
            const updated = await repository.updateChannel(guildID, channelID, current => {
                current.retryAttempts = Number(current.retryAttempts || 0) + 1;
            });
            const delay = Math.min(5_000 * (2 ** Math.max(updated.retryAttempts - 1, 0)), 5 * 60_000);
            scheduleDeletion(client, guildID, channelID, updated.generation, Date.now() + delay);
        }
    });
}

async function createTemporaryChannel(client, entrance, member, prefix) {
    return withLock(`create:${entrance.guild.id}:${member.id}`, async () => {
        let temporaryChannel;
        try {
            if (member.voice.channelId !== entrance.id) return;
            temporaryChannel = await entrance.guild.channels.create({
                name: buildChannelName(member, prefix), type: ChannelType.GuildVoice,
                parent: entrance.parentId,
                permissionOverwrites: serializePermissionOverwrites(entrance),
                reason: `為 ${member.user.tag} 建立臨時語音頻道`
            });
            await repository.addChannel(entrance.guild.id, temporaryChannel.id, {
                entranceChannelID: entrance.id, ownerID: member.id
            });
            if (member.voice.channelId !== entrance.id) throw new Error('成員已離開入口頻道，取消移動。');
            await member.voice.setChannel(temporaryChannel, '移入新建立的臨時語音頻道');
        } catch (error) {
            if (temporaryChannel) {
                await repository.removeChannel(entrance.guild.id, temporaryChannel.id).catch(() => {});
                if (temporaryChannel.members.size === 0) await temporaryChannel.delete('清理建立失敗的空頻道').catch(() => {});
            }
            sendLog(client, `❌ 無法為 ${member.user.tag} 建立臨時語音頻道：`, 'ERROR', error);
        }
    });
}

async function handleVoiceStateUpdate(client, oldState, newState) {
    const guild = newState.guild || oldState.guild;
    const store = await repository.readGuild(guild.id);
    if (oldState.channelId && oldState.channelId !== newState.channelId && store.channels[oldState.channelId]
        && oldState.channel?.members?.size === 0) {
        await withLock(key(guild.id, oldState.channelId), () => markEmpty(client, guild.id, oldState.channelId));
    }
    if (newState.channelId && store.channels[newState.channelId]) {
        await withLock(key(guild.id, newState.channelId), () => markOccupied(guild.id, newState.channelId));
    }
    const entrance = newState.channelId ? store.entrances[newState.channelId] : null;
    if (entrance && oldState.channelId !== newState.channelId && !newState.member.user.bot) {
        await createTemporaryChannel(client, newState.channel, newState.member, entrance.prefix);
    }
}

async function reconcileGuild(client, guildID) {
    const guild = client.guilds.cache.get(String(guildID));
    if (!guild) return;
    const store = await repository.readGuild(guildID);
    for (const entranceID of Object.keys(store.entrances)) {
        const result = await fetchGuildChannel(guild, entranceID);
        if (result.missing || (result.channel && result.channel.type !== ChannelType.GuildVoice)) {
            await repository.removeEntrance(guildID, entranceID);
        }
    }
    const refreshed = await repository.readGuild(guildID);
    for (const [channelID, record] of Object.entries(refreshed.channels)) {
        const result = await fetchGuildChannel(guild, channelID);
        if (result.missing || (result.channel && result.channel.type !== ChannelType.GuildVoice)) {
            await repository.removeChannel(guildID, channelID);
        } else if (!result.channel) {
            if (isTransient(result.error)) scheduleDeletion(client, guildID, channelID, record.generation, Date.now() + 5_000);
        } else if (result.channel.members.size > 0) await markOccupied(guildID, channelID);
        else {
            const emptySince = record.emptySince || new Date().toISOString();
            const updated = record.emptySince ? record : await repository.updateChannel(guildID, channelID, current => {
                current.emptySince = emptySince;
                current.generation = Number(current.generation || 0) + 1;
            });
            scheduleDeletion(client, guildID, channelID, updated.generation,
                Math.max(Date.parse(emptySince) + DELETE_DELAY_MS, Date.now()));
        }
    }
}

const initializer = async (client, context) => {
    if (typeof context.scheduler?.scheduleDeadline !== 'function') throw new Error('臨時語音功能缺少 deadline scheduler。');
    runtimeContext = context;
    repository = createTemporaryVoiceRepository(context.store.temporaryVoice);
    for (const guildID of await repository.listGuildIDs()) await reconcileGuild(client, guildID);

    const voiceListener = (oldState, newState) => handleVoiceStateUpdate(client, oldState, newState)
        .catch(error => sendLog(client, '❌ 處理臨時語音頻道事件時發生錯誤：', 'ERROR', error));
    const channelDeleteListener = channel => {
        if (!channel.guildId) return;
        repository.updateGuild(channel.guildId, store => {
            delete store.entrances[channel.id];
            delete store.channels[channel.id];
        }).catch(error => sendLog(client, `❌ 同步已刪除的頻道 ${channel.id} 時發生錯誤：`, 'ERROR', error));
    };
    client.on(Events.VoiceStateUpdate, voiceListener);
    client.on(Events.ChannelDelete, channelDeleteListener);
    return async () => {
        client.off(Events.VoiceStateUpdate, voiceListener);
        client.off(Events.ChannelDelete, channelDeleteListener);
        await Promise.all([...deletionJobs.values()].map(entry => entry.handle.stop()));
        await Promise.all([...stoppingDeletionJobs.values()]);
        deletionJobs.clear();
        stoppingDeletionJobs.clear();
        locks.clear();
        runtimeContext = null;
        repository = null;
    };
};

initializer.buildChannelName = buildChannelName;
initializer._test = { deleteIfStillEmpty, handleVoiceStateUpdate, isTransient };
return initializer;
}

module.exports = { createInitializer };
