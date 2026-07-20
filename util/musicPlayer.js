const fs = require('fs');
/**
 * 每個 Discord guild 的音樂播放狀態機。
 *
 * 本模組擁有 VoiceConnection、AudioPlayer、目前歌曲、待播序列與所有計時器；
 * 指令層只能透過公開函式操作狀態，UI 更新則由 hooks 反向通知 `commands/music.js`。
 * 播放序列與目前進度透過 hooks 寫入 runtime repository，讓 Bot 重啟後續播。
 */
const path = require('path');
const prism = require('prism-media');
const {
    AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, StreamType,
    createAudioPlayer, createAudioResource, entersState, joinVoiceChannel
} = require('@discordjs/voice');
const { deleteTrackFile, refreshLiveTrack, startLivePipeline } = require('./ytDlpManager');
const { musicValidationError, validateYouTubeUrl } = require('./musicHelpers');

const guildStates = new Map();

/** 建立 guild 專屬 AudioPlayer，並把 Idle/Error 事件接回換曲狀態機。 */
function createGuildState(guildID, options, hooks) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const state = {
        guildID, options, hooks, player, connection: null, voiceChannelID: null,
        current: null, queue: [], resource: null, panelMessage: null, panelChannel: null,
        progressTimer: null, recoveryTimer: null, inactivityTimer: null,
        liveRetryTimer: null, liveRetryStartedAt: 0, liveRetryAttempt: 0,
        voiceChannel: null, starting: false, preparingTracks: 0, playbackGeneration: 0,
        paused: false, resumeAfterRecovery: false, resumeOffsetSeconds: 0,
        livePipeline: null, liveAbortController: null, liveStatus: null,
        liveHandlingKeys: new Set(), controlOperation: Promise.resolve(),
        shuttingDown: false
    };
    player.on('error', error => {
        const generation = error?.resource?.metadata?.playbackGeneration;
        if (state.current?.playbackType === 'live') void handleLiveInterruption(state, error, generation);
        else void failCurrent(state, error, generation);
    });
    player.on('stateChange', (oldState, nextState) => {
        if (nextState.status === AudioPlayerStatus.Idle) {
            const generation = oldState?.resource?.metadata?.playbackGeneration;
            if (state.current?.playbackType !== 'live') void finishCurrent(state, generation);
        }
        const nextGeneration = nextState?.resource?.metadata?.playbackGeneration;
        if (nextState.status === AudioPlayerStatus.Playing
            && state.current?.playbackType === 'live'
            && nextGeneration === state.playbackGeneration) {
            state.liveStatus = 'playing';
            state.liveRetryStartedAt = 0;
            state.liveRetryAttempt = 0;
            state.hooks.updatePanel?.(state);
            persistState(state);
        }
        // 若在 Buffering 階段收到無人／斷線暫停，進入 Playing 後再次落實暫停。
        if (state.paused && nextState.status === AudioPlayerStatus.Playing) player.pause(true);
    });
    guildStates.set(guildID, state);
    return state;
}

function getGuildState(guildID, options = {}, hooks = {}) {
    // options/hooks 每次取用都更新，讓重新載入設定或面板後不沿用舊閉包。
    const state = guildStates.get(guildID) || createGuildState(guildID, options, hooks);
    state.options = options;
    state.hooks = hooks;
    return state;
}

function elapsedSeconds(state) {
    return state.resumeOffsetSeconds + (state.resource?.playbackDuration || 0) / 1000;
}

function sanitizeLiveTrack(track) {
    const provider = track?.provider;
    const url = provider === 'youtube' ? validateYouTubeUrl(track.url) : null;
    if (!url) throw new Error('live track 缺少受支援的 provider。');
    return {
        id: String(track.id || ''),
        title: String(track.title || '未知直播'),
        url,
        channel: String(track.channel || '未知頻道'),
        uploadDate: /^\d{8}$/.test(String(track.uploadDate || '')) ? String(track.uploadDate) : null,
        thumbnail: typeof track.thumbnail === 'string' ? track.thumbnail : null,
        duration: null,
        isLive: true,
        liveStatus: 'is_live',
        playbackType: 'live',
        provider,
        requestedBy: track.requestedBy ? String(track.requestedBy) : null,
        queueID: String(track.queueID || track.id || url)
    };
}

function snapshotTrack(track) {
    if (!track) return null;
    if (track.playbackType !== 'live') return track;
    try { return sanitizeLiveTrack(track); }
    catch { return null; }
}

/**
 * 保存足以重建播放的最小快照；序列完全為空時刪除舊檔，避免下次啟動誤恢復。
 * localPath 也會落盤，恢復時仍會再次確認檔案確實存在。
 */
function persistState(state, immediate = false) {
    const current = snapshotTrack(state.current);
    const queue = state.queue.map(snapshotTrack).filter(Boolean);
    const snapshot = !current && !queue.length ? null : {
        guildID: state.guildID,
        voiceChannelID: state.voiceChannelID,
        panelChannelID: state.panelChannel?.id || state.panelMessage?.channelId || null,
        panelMessageID: state.panelMessage?.id || null,
        paused: state.paused,
        progressSeconds: current?.playbackType === 'live' ? null : elapsedSeconds(state),
        current,
        queue
    };
    const result = state.hooks.persistSnapshot?.(state, snapshot, { immediate });
    if (!immediate) result?.catch?.(error => state.hooks.onPersistenceError?.(state, error));
    return result;
}

/**
 * 連入指定語音頻道並訂閱 player。斷線先嘗試 Discord 自身重連狀態，失敗後才進入
 * 五秒一次的應用層 recovery；播放會先暫停，防止連線恢復後進度已經漂移。
 */
async function connect(state, voiceChannel) {
    const waitForState = state.options.entersState || entersState;
    if (state.connection && state.voiceChannelID === voiceChannel.id) {
        state.voiceChannel = voiceChannel;
        await waitForState(state.connection, VoiceConnectionStatus.Ready, 20000);
        refreshInactivityTimer(state);
        return state.connection;
    }
    if (state.connection) state.connection.destroy();
    // 閒置退出後若先前已開啟的點播流程才完成下載，重新連線時要把狀態放回索引。
    guildStates.set(state.guildID, state);
    const join = state.options.joinVoiceChannel || joinVoiceChannel;
    state.connection = join({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id, adapterCreator: voiceChannel.guild.voiceAdapterCreator, selfDeaf: true });
    state.voiceChannelID = voiceChannel.id;
    state.voiceChannel = voiceChannel;
    state.connection.subscribe(state.player);
    state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        const disconnectedConnection = state.connection;
        pauseForRecovery(state);
        try {
            await Promise.race([
                waitForState(disconnectedConnection, VoiceConnectionStatus.Signalling, 5000),
                waitForState(disconnectedConnection, VoiceConnectionStatus.Connecting, 5000)
            ]);
            await waitForState(disconnectedConnection, VoiceConnectionStatus.Ready, 20000);
            const resumed = await resumeRecoveredPlayback(state);
            await state.hooks.notifyPlaybackStatus?.(
                state,
                'success',
                resumed ? '語音連線已恢復，已自動繼續播放。' : '語音連線已恢復。'
            );
        } catch {
            try { disconnectedConnection.destroy(); } catch {}
            if (state.connection === disconnectedConnection) state.connection = null;
            scheduleRecovery(state);
        }
    });
    await waitForState(state.connection, VoiceConnectionStatus.Ready, 20000);
    persistState(state);
    refreshInactivityTimer(state);
    return state.connection;
}

/**
 * 從管理面板主動召喚 Bot。跨頻道搬移只允許完全空閒的播放器，避免其他頻道的
 * 播放或下載流程被使用者搶走；同頻道則等待現有連線 Ready 後冪等成功。
 */
async function summonToVoiceChannel(state, voiceChannel) {
    if (!state || !voiceChannel?.id || !voiceChannel.guild?.id) {
        throw new TypeError('召喚音樂播放器缺少有效的語音頻道。');
    }
    const previousChannelID = state.voiceChannelID;
    const movingChannels = Boolean(previousChannelID && previousChannelID !== voiceChannel.id);
    const busy = Boolean(state.current || state.starting || state.preparingTracks > 0 || state.queue.length);
    if (movingChannels && busy) {
        throw musicValidationError('Bot 正在其他語音頻道播放或準備歌曲，請先加入 Bot 所在的語音頻道。');
    }
    await connect(state, voiceChannel);
    if (previousChannelID === voiceChannel.id) return 'alreadyConnected';
    return previousChannelID ? 'moved' : 'joined';
}

/** Bot 不計入聽眾；頻道內至少一位真人才視為有人使用。 */
function hasHumanListener(state) {
    if (!state.voiceChannel || !state.voiceChannelID) return false;
    return state.voiceChannel.guild.voiceStates.cache.some(voiceState =>
        voiceState.channelId === state.voiceChannelID && !voiceState.member?.user.bot
    );
}

function isInactive(state) {
    if (!state.connection) return false;
    const queueIsEmpty = !state.current && !state.starting && state.preparingTracks === 0 && state.queue.length === 0;
    return queueIsEmpty || !hasHumanListener(state);
}

function clearInactivityTimer(state) {
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
}

/**
 * 空序列或無真人時啟動單一退出倒數；狀態恢復活躍便取消。
 * preparingTracks 可防止下載尚未完成時被當作空序列退出。
 */
function refreshInactivityTimer(state) {
    if (!isInactive(state)) {
        clearInactivityTimer(state);
        return;
    }
    if (state.inactivityTimer) return;

    const timeoutMinutes = Number(state.options.inactivityTimeoutMinutes) > 0
        ? Number(state.options.inactivityTimeoutMinutes)
        : 5;
    state.inactivityTimer = setTimeout(async () => {
        state.inactivityTimer = null;
        if (!isInactive(state)) return;

        cleanupState(state, true);
        await state.hooks.updatePanel?.(state);
        await state.hooks.notifyPlaybackStatus?.(
            state,
            'disconnect',
            '頻道內沒有使用者或播放序列為空。'
        );
    }, timeoutMinutes * 60 * 1000);
    state.inactivityTimer.unref?.();
}

// 下載/解析可能比閒置期限久，command 必須用這對函式包住準備流程。
function beginTrackPreparation(state) {
    state.preparingTracks += 1;
    refreshInactivityTimer(state);
}

function endTrackPreparation(state) {
    state.preparingTracks = Math.max(state.preparingTracks - 1, 0);
    refreshInactivityTimer(state);
}

function livePlaybackMatches(state, generation, queueID) {
    return !state.shuttingDown
        && state.playbackGeneration === generation
        && state.current?.playbackType === 'live'
        && state.current.queueID === queueID;
}

function clearLiveRetryTimer(state) {
    if (!state.liveRetryTimer) return;
    const clearTimer = state.options.clearTimeout || clearTimeout;
    clearTimer(state.liveRetryTimer);
    state.liveRetryTimer = null;
}

function liveSignal(state, controller, timeoutMs = null) {
    const signals = [controller.signal];
    if (state.options.signal) signals.push(state.options.signal);
    if (Number(timeoutMs) > 0) signals.push(AbortSignal.timeout(Math.ceil(Number(timeoutMs))));
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

async function stopLiveWork(state, reason, { clearRetry = true } = {}) {
    if (clearRetry) clearLiveRetryTimer(state);
    const controller = state.liveAbortController;
    const livePipeline = state.livePipeline;
    state.liveAbortController = null;
    state.livePipeline = null;
    if (controller && !controller.signal.aborted) controller.abort(reason);
    if (livePipeline) await livePipeline.stop(reason).catch(() => {});
}

function updateLiveStatus(state, status) {
    state.liveStatus = status;
    state.hooks.updatePanel?.(state);
    persistState(state);
}

async function startLivePlayback(state, track, generation, retrying = false) {
    const queueID = track.queueID;
    if (!livePlaybackMatches(state, generation, queueID) || state.paused) return false;
    const controller = new AbortController();
    state.liveAbortController = controller;
    const now = state.options.now || Date.now;
    const reconnectWindowMs = Math.max(Number(state.options.liveReconnectWindowSeconds) || 120, 10) * 1000;
    const remainingRetryMs = retrying && state.liveRetryStartedAt
        ? reconnectWindowMs - (now() - state.liveRetryStartedAt)
        : null;
    if (remainingRetryMs !== null && remainingRetryMs <= 0) {
        throw musicValidationError('直播來源中斷超過重連期限。');
    }
    const signal = liveSignal(state, controller, remainingRetryMs);
    updateLiveStatus(state, retrying ? 'reconnecting' : 'connecting');

    const pipeline = await startLivePipeline(state.current, {
        ...state.options,
        signal,
        prepareTrack: async () => {
            const refreshed = await refreshLiveTrack(track, {
                ...state.options,
                allowLiveStreams: state.options.allowLiveStreams !== false,
                signal
            });
            if (!livePlaybackMatches(state, generation, queueID) || state.paused) {
                throw signal.reason || new Error('直播狀態已變更。');
            }
            if (refreshed.playbackType !== 'live') throw musicValidationError('此直播已結束。');
            if (retrying && state.liveRetryStartedAt && now() - state.liveRetryStartedAt >= reconnectWindowMs) {
                throw musicValidationError('直播來源中斷超過重連期限。');
            }
            state.current = sanitizeLiveTrack({ ...refreshed, queueID });
            return state.current;
        }
    });
    if (!livePlaybackMatches(state, generation, queueID) || state.paused) {
        await pipeline.stop(new Error('直播狀態已變更。')).catch(() => {});
        return false;
    }

    state.livePipeline = pipeline;
    state.resource = createAudioResource(pipeline.audioStream, {
        inputType: StreamType.OggOpus,
        metadata: { ...state.current, playbackGeneration: generation }
    });
    state.player.play(state.resource);
    startProgressUpdates(state);
    persistState(state);
    pipeline.completion.then(
        result => handleLiveInterruption(state, new Error(`直播 ${result.source} 已結束。`), generation),
        error => handleLiveInterruption(state, error, generation)
    ).catch(() => {});
    return true;
}

async function finishLiveCurrent(state, error, generation) {
    if (!livePlaybackMatches(state, generation, state.current?.queueID)) return;
    const failed = state.current;
    const finishingGeneration = ++state.playbackGeneration;
    await stopLiveWork(state, error);
    if (state.playbackGeneration !== finishingGeneration || state.current !== failed) return;
    stopProgressUpdates(state);
    state.player.stop(true);
    state.current = null;
    state.resource = null;
    state.starting = false;
    state.paused = false;
    state.liveStatus = null;
    state.liveRetryStartedAt = 0;
    state.liveRetryAttempt = 0;
    persistState(state);
    await state.hooks.notifyError?.(state, failed, error);
    await playNext(state);
}

/** 直播來源失敗時重新解析 canonical URL；確認離線或超過窗口才前進序列。 */
async function handleLiveInterruption(state, error, generation = state.playbackGeneration) {
    const queueID = state.current?.queueID;
    const handlingKey = `${generation}:${queueID}`;
    if (!livePlaybackMatches(state, generation, queueID)
        || state.paused
        || state.liveRetryTimer !== null
        || state.liveHandlingKeys.has(handlingKey)) return;
    state.liveHandlingKeys.add(handlingKey);
    try {
        await stopLiveWork(state, error, { clearRetry: false });
        if (!livePlaybackMatches(state, generation, queueID) || state.paused) return;
        if (error?.code === 'MUSIC_VALIDATION') {
            await finishLiveCurrent(state, error, generation);
            return;
        }

        const now = state.options.now || Date.now;
        const reconnectWindowMs = Math.max(Number(state.options.liveReconnectWindowSeconds) || 120, 10) * 1000;
        if (!state.liveRetryStartedAt) state.liveRetryStartedAt = now();
        const elapsed = now() - state.liveRetryStartedAt;
        if (elapsed >= reconnectWindowMs) {
            await finishLiveCurrent(state, musicValidationError('直播來源中斷超過重連期限。'), generation);
            return;
        }

        const retryDelays = Array.isArray(state.options.liveRetryDelaysSeconds)
            ? state.options.liveRetryDelaysSeconds
            : [1, 2, 4, 8, 20];
        const configuredDelay = Number(retryDelays[Math.min(state.liveRetryAttempt, retryDelays.length - 1)]);
        const delaySeconds = Number.isFinite(configuredDelay) ? Math.max(configuredDelay, 0) : 1;
        state.liveRetryAttempt += 1;
        updateLiveStatus(state, 'reconnecting');
        if (state.liveRetryAttempt === 1) {
            state.hooks.notifyPlaybackStatus?.(state, 'warning', '直播來源中斷，正在重新連線。');
        }
        const setTimer = state.options.setTimeout || setTimeout;
        const remainingMs = reconnectWindowMs - elapsed;
        state.liveRetryTimer = setTimer(() => {
            state.liveRetryTimer = null;
            if (!livePlaybackMatches(state, generation, queueID) || state.paused) return;
            const retryGeneration = ++state.playbackGeneration;
            startLivePlayback(state, state.current, retryGeneration, true)
                .catch(retryError => handleLiveInterruption(state, retryError, retryGeneration));
        }, Math.min(delaySeconds * 1000, remainingMs));
        state.liveRetryTimer?.unref?.();
    } finally {
        state.liveHandlingKeys.delete(handlingKey);
    }
}

/** 應用層重連採固定五秒重試；同一 guild 同時間只允許一個 recovery timer。 */
function scheduleRecovery(state) {
    if (state.recoveryTimer) return;
    pauseForRecovery(state);
    persistState(state);
    state.recoveryTimer = setTimeout(async () => {
        state.recoveryTimer = null;
        try {
            const channel = await state.hooks.getVoiceChannel?.(state);
            if (!channel) return;
            await connect(state, channel);
            const resumed = await resumeRecoveredPlayback(state);
            await state.hooks.notifyPlaybackStatus?.(
                state,
                'success',
                resumed ? '語音連線已恢復，已自動繼續播放。' : '語音連線已恢復。'
            );
            persistState(state);
        } catch { scheduleRecovery(state); }
    }, 5000);
    state.recoveryTimer.unref?.();
}

/** 加入已下載歌曲；insertNext 只插到待播首位，不會中斷目前歌曲。 */
async function enqueue(state, track, voiceChannel, panelChannel, insertNext = false) {
    if (state.shuttingDown) throw new Error('音樂播放器正在關閉，無法加入新的歌曲。');
    await connect(state, voiceChannel);
    if (state.shuttingDown) throw new Error('音樂播放器正在關閉，無法加入新的歌曲。');
    state.panelChannel = panelChannel;
    if (insertNext) state.queue.unshift(track);
    else state.queue.push(track);
    refreshInactivityTimer(state);
    persistState(state);
    const position = insertNext ? (state.current ? 2 : 1) : (state.current ? state.queue.length + 1 : state.queue.length);
    if (!state.current && !state.starting) await playNext(state);
    else await state.hooks.updatePanel?.(state);
    return position;
}

/**
 * 待播序列的唯一消費入口。starting 與 current 是防重入鎖，避免 Idle、enqueue 和
 * error handler 同時啟動兩首歌曲；恢復播放時以 ffmpeg `-ss` 從快照秒數開始。
 */
async function playNext(state) {
    if (state.starting || state.current) return;
    const track = state.queue.shift();
    if (!track) {
        persistState(state);
        await state.hooks.replacePanel?.(state);
        refreshInactivityTimer(state);
        return;
    }
    state.starting = true;
    track.playbackType ||= 'file';
    state.current = track;
    const generation = ++state.playbackGeneration;
    state.paused = track.playbackType === 'live' && track.resumePaused === true;
    delete track.resumePaused;
    state.resumeOffsetSeconds = track.playbackType === 'live' ? 0 : Number(track.resumeSeconds) || 0;
    try {
        await state.hooks.replacePanel?.(state);
        if (generation !== state.playbackGeneration || state.current !== track) return;
        if (track.playbackType === 'live') {
            state.starting = false;
            if (state.paused) {
                updateLiveStatus(state, 'paused');
                return;
            }
            persistState(state);
            startLivePlayback(state, track, generation)
                .catch(error => handleLiveInterruption(state, error, generation));
            return;
        }
        if (!track.localPath || !fs.existsSync(track.localPath)) throw new Error('找不到已下載的音訊檔案。');
        if (state.resumeOffsetSeconds > 0) {
            const transcoder = new prism.FFmpeg({ args: ['-ss', String(state.resumeOffsetSeconds), '-i', track.localPath, '-analyzeduration', '0', '-loglevel', '0', '-f', 's16le', '-ar', '48000', '-ac', '2'] });
            state.resource = createAudioResource(transcoder, {
                inputType: StreamType.Raw,
                metadata: { ...track, playbackGeneration: generation },
                inlineVolume: true
            });
        } else {
            state.resource = createAudioResource(track.localPath, {
                metadata: { ...track, playbackGeneration: generation },
                inlineVolume: true
            });
        }
        state.resource.volume?.setVolume((Number(state.options.volumePercent) || 0) / 100);
        if (generation !== state.playbackGeneration || state.current !== track) return;
        state.player.play(state.resource);
        startProgressUpdates(state);
        persistState(state);
    } catch (error) {
        state.starting = false;
        await failCurrent(state, error, generation);
        return;
    }
    state.starting = false;
}

/** 正常 Idle：清理音訊檔、重設 current，再消費下一首。 */
async function finishCurrent(state, eventGeneration) {
    if (state.shuttingDown) return;
    if (eventGeneration !== state.playbackGeneration) return;
    if (!state.current || state.starting) return;
    stopProgressUpdates(state);
    deleteTrackFile(state.current);
    state.current = null; state.resource = null; state.paused = false; state.resumeOffsetSeconds = 0;
    persistState(state);
    await playNext(state);
}

/** 播放失敗不阻塞序列：通知面板、刪除失敗曲目後繼續下一首。 */
async function failCurrent(state, error, eventGeneration = state.playbackGeneration) {
    if (state.shuttingDown) return;
    if (eventGeneration !== state.playbackGeneration) return;
    if (!state.current) return;
    const failed = state.current;
    stopProgressUpdates(state);
    state.current = null; state.resource = null; state.starting = false; state.resumeOffsetSeconds = 0;
    deleteTrackFile(failed);
    persistState(state);
    await state.hooks.notifyError?.(state, failed, error);
    await playNext(state);
}

async function togglePauseNow(state, target) {
    if (!state.current || state.current !== target) return null;
    if (target.playbackType === 'live') {
        if (state.paused) {
            state.paused = false;
            state.liveRetryStartedAt = 0;
            state.liveRetryAttempt = 0;
            const generation = ++state.playbackGeneration;
            updateLiveStatus(state, 'connecting');
            startLivePlayback(state, state.current, generation)
                .catch(error => handleLiveInterruption(state, error, generation));
            return false;
        }
        const reason = new Error('使用者暫停直播。');
        const generation = ++state.playbackGeneration;
        state.paused = true;
        state.player.stop(true);
        await stopLiveWork(state, reason);
        if (state.playbackGeneration !== generation || state.current !== target || !state.paused) return state.paused;
        state.resource = null;
        updateLiveStatus(state, 'paused');
        return true;
    }
    if (state.paused || state.player.state.status === AudioPlayerStatus.Paused) { state.paused = false; state.player.unpause(); }
    else { state.player.pause(true); state.paused = true; }
    state.hooks.updatePanel?.(state); persistState(state); return state.paused;
}

/** 同一 guild 的暫停／繼續依序執行，並綁定呼叫當下的 track，避免操作落到下一首。 */
function togglePause(state) {
    const target = state.current;
    const operation = state.controlOperation.catch(() => {}).then(() => togglePauseNow(state, target));
    state.controlOperation = operation.catch(() => {});
    return operation;
}
function pauseForReason(state, reason) {
    if (!state.current || state.paused) return false;
    if (state.current.playbackType === 'live') {
        state.playbackGeneration += 1;
        state.player.stop(true);
        void stopLiveWork(state, new Error(reason));
        state.resource = null;
        state.liveStatus = 'paused';
    } else {
        state.player.pause(true);
    }
    state.paused = true;
    state.hooks.updatePanel?.(state);
    state.hooks.notifyPlaybackStatus?.(state, 'warning', reason);
    persistState(state);
    return true;
}
/** 記錄「由斷線自動暫停」，只有這種暫停會在重連後自動恢復。 */
function pauseForRecovery(state) {
    const pausedByRecovery = pauseForReason(state, '語音連線意外中斷，已自動暫停播放並嘗試重新連線。');
    if (pausedByRecovery) state.resumeAfterRecovery = true;
    return pausedByRecovery;
}
async function resumeRecoveredPlayback(state) {
    if (!state.resumeAfterRecovery) return false;
    state.resumeAfterRecovery = false;
    if (!state.current) return false;
    state.paused = false;
    if (state.current.playbackType === 'live') {
        state.liveRetryStartedAt = 0;
        state.liveRetryAttempt = 0;
        const generation = ++state.playbackGeneration;
        updateLiveStatus(state, 'connecting');
        startLivePlayback(state, state.current, generation)
            .catch(error => handleLiveInterruption(state, error, generation));
    } else {
        state.player.unpause();
    }
    state.hooks.updatePanel?.(state);
    persistState(state);
    return true;
}
/**
 * 語音事件 cache 需要短時間才穩定，因此延後 250ms 重算真人數量。
 * 無人時立即暫停，真正斷線與清理仍由 inactivity timer 處理。
 */
function handleVoiceStateUpdate(oldState, newState) {
    const state = guildStates.get(oldState.guild.id);
    if (!state?.voiceChannelID) return;
    if (oldState.channelId !== state.voiceChannelID && newState.channelId !== state.voiceChannelID) return;
    setTimeout(() => {
        const humanCount = oldState.guild.voiceStates.cache.filter(voiceState =>
            voiceState.channelId === state.voiceChannelID && !voiceState.member?.user.bot
        ).size;
        if (humanCount === 0) pauseForReason(state, '語音頻道內已沒有使用者，已自動暫停播放。');
        refreshInactivityTimer(state);
    }, 250).unref?.();
}
/** 以不會因翻頁而改變的 queueID 移除歌曲，並同步刪除其 cache 音訊。 */
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
function skipCurrent(state) {
    if (!state.current) return false;
    const skipped = state.current;
    state.playbackGeneration += 1;
    if (skipped.playbackType === 'live') void stopLiveWork(state, new Error('直播已被跳過。'));
    state.starting = false;
    state.current = null;
    state.resource = null;
    state.paused = false;
    state.liveStatus = null;
    state.liveRetryStartedAt = 0;
    state.liveRetryAttempt = 0;
    stopProgressUpdates(state);
    state.player.stop(true);
    deleteTrackFile(skipped);
    persistState(state);
    playNext(state).catch(error => state.hooks.notifyError?.(state, skipped, error));
    return true;
}
/** 定期保存播放秒數並更新面板；最短五秒以控制磁碟與 Discord API 負載。 */
function startProgressUpdates(state) {
    stopProgressUpdates(state);
    const delay = Math.max(Number(state.options.panelUpdateSeconds) || 10, 5) * 1000;
    state.progressTimer = setInterval(() => { persistState(state); state.hooks.updatePanel?.(state); }, delay);
    state.progressTimer.unref?.();
}
function stopProgressUpdates(state) { if (state.progressTimer) clearInterval(state.progressTimer); state.progressTimer = null; }

/**
 * 將快照 current 放回序列首位並附加 resumeSeconds；缺少本機檔案的歌曲直接略過。
 * 只有成功連線且真正開始播放後才算恢復完成。
 */
async function restoreGuildState(snapshot, voiceChannel, panelChannel, panelMessage, options, hooks) {
    const state = getGuildState(snapshot.guildID, options, hooks);
    state.panelChannel = panelChannel; state.panelMessage = panelMessage; state.voiceChannelID = null;
    const restoredTracks = [
        ...(snapshot.current ? [{
            ...snapshot.current,
            ...(snapshot.current.playbackType === 'live'
                ? { resumePaused: snapshot.paused === true }
                : { resumeSeconds: Number(snapshot.progressSeconds) || 0 })
        }] : []),
        ...(Array.isArray(snapshot.queue) ? snapshot.queue : [])
    ];
    state.queue = restoredTracks.map(track => {
        if (track.playbackType === 'live') {
            if (options.allowLiveStreams === false) return null;
            try {
                const restored = sanitizeLiveTrack(track);
                if (track.resumePaused === true) restored.resumePaused = true;
                return restored;
            } catch { return null; }
        }
        if (!track.localPath || !fs.existsSync(track.localPath)) return null;
        return {
            ...track,
            playbackType: 'file',
            queueID: track.queueID || path.basename(track.localPath)
        };
    }).filter(Boolean);
    if (!state.queue.length) { await state.hooks.persistSnapshot?.(state, null, { immediate: true }); return null; }
    await connect(state, voiceChannel);
    await playNext(state);
    if (!state.current) throw new Error('保存的歌曲無法恢復播放。');
    if (snapshot.paused && state.current.playbackType !== 'live') await togglePause(state);
    return state;
}

/**
 * 終止所有 timer/連線並刪除 current、queue 的暫存音訊與快照。
 * remove=true 也會移出 guildStates，供閒置退出後完整釋放狀態。
 */
function cleanupState(state, remove = false) {
    state.playbackGeneration += 1;
    void stopLiveWork(state, new Error('音樂播放器已清理。'));
    stopProgressUpdates(state);
    if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
    clearInactivityTimer(state);
    state.player.stop(true); state.connection?.destroy(); state.connection = null;
    state.voiceChannel = null; state.voiceChannelID = null;
    deleteTrackFile(state.current); for (const track of state.queue) deleteTrackFile(track);
    state.current = null; state.queue = []; state.resumeAfterRecovery = false;
    state.paused = false; state.liveStatus = null; state.liveRetryStartedAt = 0; state.liveRetryAttempt = 0;
    state.liveHandlingKeys.clear();
    state.hooks.persistSnapshot?.(state, null, { immediate: true });
    if (remove) guildStates.delete(state.guildID);
}

/** 在關閉語音前同步保存所有 guild 的 current、queue 與播放進度。 */
async function snapshotAllGuildStates() {
    await Promise.all([...guildStates.values()].map(state => persistState(state, true)));
}

/** 先凍結播放器狀態再保存，避免取消 child 產生的 Idle/Error 在快照前換曲。 */
async function prepareAllPlayersForShutdown() {
    for (const state of guildStates.values()) {
        state.shuttingDown = true;
        clearLiveRetryTimer(state);
    }
    await snapshotAllGuildStates();
}

/**
 * 關機專用清理：先設 shuttingDown 阻止 AudioPlayer Idle 消費序列，再停止 timer、
 * player 與語音連線。此流程刻意保留 cache 與 snapshot，供下次啟動恢復。
 */
async function shutdownAllPlayers() {
    await prepareAllPlayersForShutdown();
    await Promise.all([...guildStates.values()].map(state => (
        stopLiveWork(state, new Error('應用程式正在關閉。')).catch(() => {})
    )));
    for (const state of guildStates.values()) {
        stopProgressUpdates(state);
        if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
        state.recoveryTimer = null;
        clearInactivityTimer(state);
        state.player.stop(true);
        state.resource?.playStream?.destroy?.();
        state.connection?.destroy();
        state.connection = null;
        state.voiceChannel = null;
    }
}
function isCurrentPanel(state, messageID) { return Boolean(state.panelMessage?.id && state.panelMessage.id === messageID); }
module.exports = { guildStates, getGuildState, enqueue, summonToVoiceChannel, togglePause, skipCurrent, cleanupState, snapshotAllGuildStates, prepareAllPlayersForShutdown, shutdownAllPlayers, isCurrentPanel, elapsedSeconds, restoreGuildState, handleVoiceStateUpdate, removeQueuedTracks, clearQueue, beginTrackPreparation, endTrackPreparation };
