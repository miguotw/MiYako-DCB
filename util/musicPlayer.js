const fs = require('fs');
const path = require('path');
const prism = require('prism-media');
const {
    AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, StreamType,
    createAudioPlayer, createAudioResource, entersState, joinVoiceChannel
} = require('@discordjs/voice');
const { deleteTrackFile } = require('./ytDlpManager');
const { saveGuildQueue, deleteGuildQueue } = require('./musicQueueStore');

const guildStates = new Map();

function createGuildState(guildID, options, hooks) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const state = {
        guildID, options, hooks, player, connection: null, voiceChannelID: null,
        current: null, queue: [], resource: null, panelMessage: null, panelChannel: null,
        progressTimer: null, recoveryTimer: null, starting: false, paused: false, resumeOffsetSeconds: 0
    };
    player.on(AudioPlayerStatus.Idle, () => finishCurrent(state));
    player.on('error', error => failCurrent(state, error));
    player.on('stateChange', (_, nextState) => {
        // 若在 Buffering 階段收到無人／斷線暫停，進入 Playing 後再次落實暫停。
        if (state.paused && nextState.status === AudioPlayerStatus.Playing) player.pause(true);
    });
    guildStates.set(guildID, state);
    return state;
}

function getGuildState(guildID, options = {}, hooks = {}) {
    const state = guildStates.get(guildID) || createGuildState(guildID, options, hooks);
    state.options = options;
    state.hooks = hooks;
    return state;
}

function elapsedSeconds(state) {
    return state.resumeOffsetSeconds + (state.resource?.playbackDuration || 0) / 1000;
}

function persistState(state) {
    if (!state.current && !state.queue.length) return deleteGuildQueue(state.guildID);
    saveGuildQueue(state.guildID, {
        voiceChannelID: state.voiceChannelID,
        panelChannelID: state.panelChannel?.id || state.panelMessage?.channelId || null,
        panelMessageID: state.panelMessage?.id || null,
        paused: state.paused,
        progressSeconds: elapsedSeconds(state),
        current: state.current,
        queue: state.queue
    });
}

async function connect(state, voiceChannel) {
    if (state.connection && state.voiceChannelID === voiceChannel.id) return state.connection;
    if (state.connection) state.connection.destroy();
    state.connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id, adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: true });
    state.voiceChannelID = voiceChannel.id;
    state.connection.subscribe(state.player);
    state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        pauseForReason(state, '語音連線意外中斷，已自動暫停播放並嘗試重新連線。');
        try {
            await Promise.race([
                entersState(state.connection, VoiceConnectionStatus.Signalling, 5000),
                entersState(state.connection, VoiceConnectionStatus.Connecting, 5000)
            ]);
        } catch {
            try { state.connection.destroy(); } catch {}
            state.connection = null;
            scheduleRecovery(state);
        }
    });
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
    persistState(state);
    return state.connection;
}

function scheduleRecovery(state) {
    if (state.recoveryTimer) return;
    pauseForReason(state, '語音連線意外中斷，已自動暫停播放並嘗試重新連線。');
    persistState(state);
    state.recoveryTimer = setTimeout(async () => {
        state.recoveryTimer = null;
        try {
            const channel = await state.hooks.getVoiceChannel?.(state);
            if (!channel) return;
            await connect(state, channel);
            await state.hooks.notifyPlaybackStatus?.(state, 'success', '語音連線已恢復，播放維持暫停；請按「繼續」恢復播放。');
            persistState(state);
        } catch { scheduleRecovery(state); }
    }, 5000);
    state.recoveryTimer.unref?.();
}

async function enqueue(state, track, voiceChannel, panelChannel, insertNext = false) {
    await connect(state, voiceChannel);
    state.panelChannel = panelChannel;
    if (insertNext) state.queue.unshift(track);
    else state.queue.push(track);
    persistState(state);
    const position = insertNext ? (state.current ? 2 : 1) : (state.current ? state.queue.length + 1 : state.queue.length);
    if (!state.current && !state.starting) await playNext(state);
    else await state.hooks.updatePanel?.(state);
    return position;
}

async function playNext(state) {
    if (state.starting || state.current) return;
    const track = state.queue.shift();
    if (!track) {
        persistState(state);
        await state.hooks.replacePanel?.(state);
        return;
    }
    state.starting = true;
    state.current = track;
    state.paused = false;
    state.resumeOffsetSeconds = Number(track.resumeSeconds) || 0;
    try {
        await state.hooks.replacePanel?.(state);
        if (!track.localPath || !fs.existsSync(track.localPath)) throw new Error('找不到已下載的音訊檔案。');
        if (state.resumeOffsetSeconds > 0) {
            const transcoder = new prism.FFmpeg({ args: ['-ss', String(state.resumeOffsetSeconds), '-i', track.localPath, '-analyzeduration', '0', '-loglevel', '0', '-f', 's16le', '-ar', '48000', '-ac', '2'] });
            state.resource = createAudioResource(transcoder, { inputType: StreamType.Raw, metadata: track, inlineVolume: true });
        } else state.resource = createAudioResource(track.localPath, { metadata: track, inlineVolume: true });
        state.resource.volume?.setVolume((Number(state.options.volumePercent) || 0) / 100);
        state.player.play(state.resource);
        startProgressUpdates(state);
        persistState(state);
    } catch (error) {
        state.starting = false;
        await failCurrent(state, error);
        return;
    }
    state.starting = false;
}

async function finishCurrent(state) {
    if (!state.current || state.starting) return;
    stopProgressUpdates(state);
    deleteTrackFile(state.current);
    state.current = null; state.resource = null; state.paused = false; state.resumeOffsetSeconds = 0;
    persistState(state);
    await playNext(state);
}

async function failCurrent(state, error) {
    if (!state.current) return;
    const failed = state.current;
    stopProgressUpdates(state);
    state.current = null; state.resource = null; state.starting = false; state.resumeOffsetSeconds = 0;
    deleteTrackFile(failed);
    persistState(state);
    await state.hooks.notifyError?.(state, failed, error);
    await playNext(state);
}

function togglePause(state) {
    if (!state.current) return null;
    if (state.paused || state.player.state.status === AudioPlayerStatus.Paused) { state.paused = false; state.player.unpause(); }
    else { state.player.pause(true); state.paused = true; }
    state.hooks.updatePanel?.(state); persistState(state); return state.paused;
}
function pauseForReason(state, reason) {
    if (!state.current || state.paused) return false;
    state.player.pause(true);
    state.paused = true;
    state.hooks.updatePanel?.(state);
    state.hooks.notifyPlaybackStatus?.(state, 'warning', reason);
    persistState(state);
    return true;
}
function handleVoiceStateUpdate(oldState, newState) {
    const state = guildStates.get(oldState.guild.id);
    if (!state?.current || !state.voiceChannelID) return;
    if (oldState.channelId !== state.voiceChannelID && newState.channelId !== state.voiceChannelID) return;
    setTimeout(() => {
        const humanCount = oldState.guild.voiceStates.cache.filter(voiceState =>
            voiceState.channelId === state.voiceChannelID && !voiceState.member?.user.bot
        ).size;
        if (humanCount === 0) pauseForReason(state, '語音頻道內已沒有使用者，已自動暫停播放。');
    }, 250).unref?.();
}
function removeQueuedTracks(state, identifiers) {
    const wanted = new Set(identifiers);
    const removed = [];
    state.queue = state.queue.filter(track => {
        const identifier = track.queueID || track.localPath;
        if (!wanted.has(identifier)) return true;
        removed.push(track);
        deleteTrackFile(track);
        return false;
    });
    persistState(state);
    state.hooks.updatePanel?.(state);
    return removed;
}
function clearQueue(state) {
    const removed = [...state.queue];
    for (const track of removed) deleteTrackFile(track);
    state.queue = [];
    persistState(state);
    state.hooks.updatePanel?.(state);
    return removed;
}
function skipCurrent(state) { if (!state.current) return false; state.player.stop(true); return true; }
function startProgressUpdates(state) {
    stopProgressUpdates(state);
    const delay = Math.max(Number(state.options.panelUpdateSeconds) || 10, 5) * 1000;
    state.progressTimer = setInterval(() => { persistState(state); state.hooks.updatePanel?.(state); }, delay);
    state.progressTimer.unref?.();
}
function stopProgressUpdates(state) { if (state.progressTimer) clearInterval(state.progressTimer); state.progressTimer = null; }

async function restoreGuildState(snapshot, voiceChannel, panelChannel, panelMessage, options, hooks) {
    const state = getGuildState(snapshot.guildID, options, hooks);
    state.panelChannel = panelChannel; state.panelMessage = panelMessage; state.voiceChannelID = null;
    state.queue = [
        ...(snapshot.current ? [{ ...snapshot.current, resumeSeconds: Number(snapshot.progressSeconds) || 0 }] : []),
        ...(Array.isArray(snapshot.queue) ? snapshot.queue : [])
    ].filter(track => track.localPath && fs.existsSync(track.localPath))
        .map(track => ({ ...track, queueID: track.queueID || path.basename(track.localPath) }));
    if (!state.queue.length) { deleteGuildQueue(snapshot.guildID); return null; }
    await connect(state, voiceChannel);
    await playNext(state);
    if (!state.current) throw new Error('保存的歌曲無法恢復播放。');
    if (snapshot.paused) togglePause(state);
    return state;
}

function cleanupState(state, remove = false) {
    stopProgressUpdates(state);
    if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
    state.player.stop(true); state.connection?.destroy(); state.connection = null;
    deleteTrackFile(state.current); for (const track of state.queue) deleteTrackFile(track);
    state.current = null; state.queue = []; deleteGuildQueue(state.guildID);
    if (remove) guildStates.delete(state.guildID);
}
function isCurrentPanel(state, messageID) { return Boolean(state.panelMessage?.id && state.panelMessage.id === messageID); }
module.exports = { guildStates, getGuildState, enqueue, togglePause, skipCurrent, cleanupState, isCurrentPanel, elapsedSeconds, restoreGuildState, handleVoiceStateUpdate, removeQueuedTracks, clearQueue };
