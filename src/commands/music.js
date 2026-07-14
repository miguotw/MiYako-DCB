/**
 * 音樂功能的 Discord 互動層。
 *
 * 本檔負責面板、互動驗證與下載流程；實際語音狀態由 `util/musicPlayer` 管理，
 * yt-dlp/ffmpeg 工作集中在 `util/ytDlpManager`。每個 guild 只有一個有效面板，
 * 舊面板會被停用，避免兩組按鈕同時修改同一播放序列。
 */
const {
    SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, StringSelectMenuBuilder
} = require('discord.js');
const { createReplyTools } = require('../../core/Reply');
const { createLogTools } = require('../../core/sendLog');
const {
    extractTracks, downloadTrack, deleteTrackFile, cleanupOrphanedCache
} = require('../../util/ytDlpManager');
const { getGuildState, enqueue, togglePause, skipCurrent, isCurrentPanel, elapsedSeconds, restoreGuildState, removeQueuedTracks, clearQueue, beginTrackPreparation, endTrackPreparation } = require('../../util/musicPlayer');
const { createMusicRepository } = require('../../util/musicRepository');
const {
    formatDuration, getUploadYear, createProgressBar, paginateQueue,
    isMusicValidationError, musicValidationError
} = require('../../util/musicHelpers');

function createCommand(config) {
const { errorReply, validationReply } = createReplyTools(config);
const { sendLog } = createLogTools(config);
const configCommands = config.commands;
const MUSIC_CONFIG = configCommands.music || {};
const configuredMaxDurationMinutes = Number(MUSIC_CONFIG.maxDurationMinutes);
const configuredMinDurationMinutes = Number(MUSIC_CONFIG.minDurationMinutes);
const configuredVolumePercent = Number(MUSIC_CONFIG.volumePercent);
const OPTIONS = {
    updateHours: Number(MUSIC_CONFIG.ytDlpUpdateHours) || 24,
    maxDurationSeconds: (Number.isFinite(configuredMaxDurationMinutes) ? Math.max(configuredMaxDurationMinutes, 0) : 120) * 60,
    minDurationSeconds: (Number.isFinite(configuredMinDurationMinutes) ? Math.max(configuredMinDurationMinutes, 0) : 0) * 60,
    allowPlaylists: MUSIC_CONFIG.allowPlaylists === true,
    maxPlaylistTracks: Math.min(Math.max(Number(MUSIC_CONFIG.maxPlaylistTracks) || 25, 1), 100),
    panelUpdateSeconds: Number(MUSIC_CONFIG.panelUpdateSeconds) || 10,
    inactivityTimeoutMinutes: Number(MUSIC_CONFIG.inactivityTimeoutMinutes) > 0 ? Number(MUSIC_CONFIG.inactivityTimeoutMinutes) : 5,
    volumePercent: Number.isFinite(configuredVolumePercent) ? Math.min(Math.max(configuredVolumePercent, 0), 100) : 50,
    maxQueueTracks: Number(MUSIC_CONFIG.maxQueueTracks) || 100,
    maxFileSizeBytes: (Number(MUSIC_CONFIG.maxFileSizeMiB) || 256) * 1024 ** 2,
    maxCacheSizeBytes: (Number(MUSIC_CONFIG.maxCacheSizeMiB) || 2048) * 1024 ** 2
};
const COLOR = config.embed.color.default;
const SUCCESS_COLOR = config.embed.color.success;
const ERROR_COLOR = config.embed.color.error;
const SUCCESS_EMOJI = config.emoji.success;
const ERROR_EMOJI = config.emoji.error;
const LOADING_EMOJI = config.emoji.loading;
const EMOJI = MUSIC_CONFIG.emoji || '🎵';
const QUEUE_TITLE_MAX_LENGTH = Math.min(Math.max(Number(MUSIC_CONFIG.queueTitleMaxLength) || 25, 1), 97);
const repositories = new WeakMap();
const snapshotWriters = new WeakMap();
const hooksByContext = new WeakMap();
const pendingUsers = new Set();
const guildOperations = new Map();

function repository(context) {
    const store = context?.store;
    if (!store?.musicQueue || !store?.musicPanel) throw new Error('音樂功能缺少 music repository context。');
    if (!repositories.has(store)) {
        repositories.set(store, createMusicRepository({
            queueRepository: store.musicQueue,
            panelRepository: store.musicPanel
        }));
    }
    return repositories.get(store);
}

function withGuildLock(guildID, operation) {
    const previous = guildOperations.get(guildID) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    guildOperations.set(guildID, current);
    return current.finally(() => { if (guildOperations.get(guildID) === current) guildOperations.delete(guildID); });
}

function snapshotWriter(context) {
    if (snapshotWriters.has(context.store)) return snapshotWriters.get(context.store);
    const states = new Map();
    const musicRepository = repository(context);
    async function flush(guildID) {
        const entry = states.get(guildID);
        if (!entry || !entry.dirty) return entry?.flushPromise;
        if (entry.flushPromise) return entry.flushPromise.then(() => entry.dirty ? flush(guildID) : undefined);
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.dirty = false;
        const revision = entry.revision;
        const snapshot = entry.snapshot;
        entry.flushPromise = (snapshot
            ? musicRepository.saveQueue(guildID, snapshot)
            : musicRepository.deleteQueue(guildID)
        ).then(() => {
            const settled = entry.waiters.filter(waiter => waiter.revision <= revision);
            entry.waiters = entry.waiters.filter(waiter => waiter.revision > revision);
            for (const waiter of settled) waiter.resolve();
        }).catch(error => {
            const settled = entry.waiters.filter(waiter => waiter.revision <= revision);
            entry.waiters = entry.waiters.filter(waiter => waiter.revision > revision);
            for (const waiter of settled) waiter.reject(error);
            throw error;
        }).finally(() => {
            entry.flushPromise = null;
        });
        return entry.flushPromise;
    }
    function schedule(guildID, snapshot, { immediate = false } = {}) {
        let entry = states.get(guildID);
        if (!entry) {
            entry = {
                snapshot: null,
                timer: null,
                dirty: false,
                revision: 0,
                flushPromise: null,
                waiters: []
            };
            states.set(guildID, entry);
        }
        entry.snapshot = snapshot;
        entry.dirty = true;
        entry.revision += 1;
        const completion = new Promise((resolve, reject) => {
            entry.waiters.push({ revision: entry.revision, resolve, reject });
        });
        if (immediate) void flush(guildID).catch(() => {});
        else if (!entry.timer) {
            entry.timer = setTimeout(() => {
                entry.timer = null;
                void flush(guildID).catch(() => {});
            }, 250);
            entry.timer.unref?.();
        }
        return completion;
    }
    const writer = { schedule, flushAll: () => Promise.all([...states.keys()].map(flush)) };
    snapshotWriters.set(context.store, writer);
    return writer;
}

// Discord 元件與主面板建構 --------------------------------------------------

/** 根據播放狀態建立主面板按鈕；disabled 用於讓被取代的舊面板失效。 */
function createButtons(state, disabled = false) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_request').setLabel('點播').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('music_play_next').setLabel('插播').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId('music_pause').setLabel(state?.paused ? '繼續' : '暫停').setStyle(ButtonStyle.Primary).setDisabled(disabled || !state?.current),
        new ButtonBuilder().setCustomId('music_skip').setLabel('跳過').setStyle(ButtonStyle.Danger).setDisabled(disabled || !state?.current),
        new ButtonBuilder().setCustomId('music_queue_open:0').setLabel('序列').setStyle(ButtonStyle.Secondary).setDisabled(disabled || !state?.queue?.length)
    )];
}

function createPanelEmbed(state) {
    const embed = new EmbedBuilder().setColor(COLOR).setTitle(`${EMOJI} ┃ 音樂 - 管理面板`);
    if (!state.current) return embed.setDescription('目前沒有播放中的音樂。使用下方按鈕加入歌曲。');
    const track = state.current;
    const elapsed = Math.min(elapsedSeconds(state), track.duration);
    const upcoming = state.queue.slice(0, 5).map((item, index) => `${String(index + 1).padStart(2, '0')}. [${truncateTitle(item.title)}](${item.url}) \`${formatDuration(item.duration)}\` · ${item.requestedBy ? `<@${item.requestedBy}>` : '未知點播者'}`).join('\n');
    embed.setDescription(`**[${track.title}](${track.url})** · ${track.requestedBy ? `<@${track.requestedBy}>` : '未知點播者'}`)
        .addFields(
            { name: state.paused ? '已暫停' : '播放進度', value: `\`${formatElapsedTime(elapsed)} ${createProgressBar(elapsed, track.duration, 27)} ${formatDuration(track.duration)}\`` },
            { name: '藝人', value: track.channel, inline: true },
            { name: '年份', value: getUploadYear(track.uploadDate), inline: true },
        );
    if (upcoming) embed.addFields({ name: '接下來', value: upcoming });
    if (track.thumbnail) embed.setImage(track.thumbnail);
    return embed;
}

/** 建立 player 反向更新 UI 的 hooks，避免底層播放器直接依賴指令模組。 */
function createHooks(client, context) {
    if (hooksByContext.has(context)) return hooksByContext.get(context);
    const uiStates = new WeakMap();
    async function editSingleFlight(state, operation) {
        let ui = uiStates.get(state);
        if (!ui) {
            ui = { running: false, pending: null, promise: Promise.resolve() };
            uiStates.set(state, ui);
        }
        ui.pending = operation;
        if (ui.running) return ui.promise;
        ui.running = true;
        ui.promise = (async () => {
            while (ui.pending) {
                const next = ui.pending;
                ui.pending = null;
                await next();
            }
        })().finally(() => { ui.running = false; });
        return ui.promise;
    }
    const hooks = {
        async replacePanel(state) {
            return editSingleFlight(state, async () => {
                if (state.panelMessage) await state.panelMessage.edit({ components: createButtons(state, true) }).catch(() => {});
                if (!state.panelChannel?.send) return;
                state.panelMessage = await state.panelChannel.send({ embeds: [createPanelEmbed(state)], components: createButtons(state) });
                await repository(context).savePanel(state.guildID, state.panelMessage);
            });
        },
        async updatePanel(state) {
            return editSingleFlight(state, async () => {
                if (!state.panelMessage) return;
                await state.panelMessage.edit({ embeds: [createPanelEmbed(state)], components: createButtons(state) }).catch(() => {});
            });
        },
        async notifyError(state, track, error) {
            sendLog(state.panelMessage?.client, `${ERROR_EMOJI} 播放歌曲失敗：${track.title}`, 'ERROR', error);
            await state.panelChannel?.send?.({ embeds: [createActionEmbed(`${ERROR_EMOJI} ┃ 播放歌曲失敗`, `無法播放 **${track.title}**，已嘗試播放下一首。`, ERROR_COLOR)] }).catch(() => {});
        },
        async notifyPlaybackStatus(state, type, message) {
            if (!state.panelChannel?.send) return;
            const colors = { success: SUCCESS_COLOR, warning: ERROR_COLOR, disconnect: SUCCESS_COLOR };
            const titles = {
                success: `${SUCCESS_EMOJI} ┃ 語音連線已恢復`,
                warning: `${ERROR_EMOJI} ┃ 音樂播放已暫停`,
                disconnect: '🚧 ┃ 已退出語音頻道'
            };
            await state.panelChannel.send({ embeds: [new EmbedBuilder().setColor(colors[type] || COLOR).setTitle(titles[type] || `${EMOJI} ┃ 音樂狀態`).setDescription(message)] }).catch(() => {});
        },
        async getVoiceChannel(state) {
            return client?.channels.fetch(state.voiceChannelID).catch(() => null);
        },
        persistSnapshot(state, snapshot, options) {
            return snapshotWriter(context).schedule(state.guildID, snapshot, options);
        },
        onPersistenceError(state, error) {
            sendLog(client, `${ERROR_EMOJI} 保存伺服器 ${state.guildID} 的音樂快照失敗。`, 'ERROR', error);
        }
    };
    hooksByContext.set(context, hooks);
    return hooks;
}

function getState(guildID, client, context) {
    return getGuildState(guildID, { ...OPTIONS, signal: context.signal }, createHooks(client, context));
}

/** Bot ready 後逐一恢復落盤序列；單一 guild 失敗不影響其他 guild。 */
async function restorePersistedPlayback(client, context) {
    const musicRepository = repository(context);
    const snapshots = await musicRepository.loadQueues();
    const references = snapshots.flatMap(snapshot => [snapshot.current, ...(snapshot.queue || [])])
        .map(track => track?.localPath).filter(Boolean);
    cleanupOrphanedCache(references);
    for (const snapshot of snapshots) {
        try {
            const voiceChannel = await client.channels.fetch(snapshot.voiceChannelID).catch(() => null);
            const panelChannel = await client.channels.fetch(snapshot.panelChannelID).catch(() => null);
            const panelMessage = panelChannel?.messages && snapshot.panelMessageID
                ? await panelChannel.messages.fetch(snapshot.panelMessageID).catch(() => null) : null;
            if (!voiceChannel || !panelChannel) throw new Error('找不到先前的語音或文字頻道。');
            await restoreGuildState(snapshot, voiceChannel, panelChannel, panelMessage,
                { ...OPTIONS, signal: context.signal }, createHooks(client, context));
            sendLog(client, `🎵 已恢復伺服器 ${snapshot.guildID} 的音樂播放。`);
        } catch (error) {
            sendLog(client, `${ERROR_EMOJI} 無法恢復伺服器 ${snapshot.guildID} 的音樂播放。`, 'WARN', error);
        }
    }
    // 沒有序列快照的最新面板也需要在重啟後同步按鈕狀態。
    for (const panel of await musicRepository.listPanels()) {
        try {
            const state = getState(panel.guildID, client, context);
            if (state.panelMessage) continue;
            const channel = await client.channels.fetch(panel.channelID).catch(() => null);
            const message = await channel?.messages?.fetch(panel.messageID).catch(() => null);
            if (!message) continue;
            state.panelChannel = channel;
            state.panelMessage = message;
            await message.edit({ embeds: [createPanelEmbed(state)], components: createButtons(state) });
        } catch (error) {
            sendLog(client, `${ERROR_EMOJI} 無法同步伺服器 ${panel.guildID} 的最新音樂面板。`, 'WARN', error);
        }
    }
}

// 互動前置條件：操作人必須在語音頻道，且舊面板不得再改動狀態。
function requireGuildVoice(interaction, state = null) {
    if (!interaction.inGuild()) throw musicValidationError('音樂功能僅能在伺服器中使用。');
    const channel = interaction.member?.voice?.channel;
    if (!channel) throw musicValidationError('請先加入語音頻道。');
    if (state?.voiceChannelID && state.voiceChannelID !== channel.id) throw musicValidationError('請先加入 Bot 所在的語音頻道。');
    return channel;
}

function requireCurrentPanel(interaction, state) {
    const messageID = interaction.message?.id;
    if (!isCurrentPanel(state, messageID)) throw musicValidationError('此面板已過期，請創建一個新的音樂面板。');
}

/** 建立指定頁面的序列、翻頁按鈕與多選移除選單。 */
function createQueuePayload(state, requestedPage) {
    const tracks = [...state.queue];
    const { items, page, totalPages } = paginateQueue(tracks, requestedPage);
    const offset = page * 10;
    const description = items.length
        ? items.map((track, index) => `${String(offset + index + 1).padStart(2, '0')}. [${truncateTitle(track.title)}](${track.url}) \`${formatDuration(track.duration)}\` · ${track.requestedBy ? `<@${track.requestedBy}>` : '未知點播者'}`).join('\n')
        : '目前序列為空。';
    const embed = new EmbedBuilder().setColor(COLOR).setTitle(`${EMOJI} ┃ 音樂 - 完整播放序列`).setDescription(description).setFooter({ text: `第 ${page + 1} / ${totalPages} 頁` });
    const components = totalPages > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`music_queue_page:${page - 1}`).setLabel('上一頁').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`music_queue_page:${page + 1}`).setLabel('下一頁').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
    )] : [];
    const pageQueueItems = items;
    if (pageQueueItems.length) components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`music_queue_remove:${page}`).setPlaceholder('選擇要從序列移除的歌曲')
            .setMinValues(1).setMaxValues(pageQueueItems.length)
            .addOptions(pageQueueItems.map(track => ({ label: truncateTitle(track.title), value: String(track.queueID).slice(0, 100) })))
    ));
    if (state.queue.length) components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_queue_clear').setLabel('移除所有序列').setStyle(ButtonStyle.Danger)
    ));
    return { embeds: [embed], components };
}

function createActionEmbed(title, description, color = COLOR) {
    return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

function truncateTitle(title, maxLength = QUEUE_TITLE_MAX_LENGTH) {
    const value = String(title || '未知標題');
    const characters = Array.from(value);
    return characters.length > maxLength ? `${characters.slice(0, maxLength).join('')}...` : value;
}

function formatElapsedTime(seconds) {
    const value = formatDuration(seconds);
    return value.includes(':') && value.split(':').length === 2 ? value.padStart(5, '0') : value;
}

function createDownloadEmbed(track, index, total, percent = 0) {
    const safePercent = Math.min(Math.max(Number(percent) || 0, 0), 100);
    return new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle(`${LOADING_EMOJI} ┃ 正在下載音樂`)
        .setDescription(`**${track?.title || '正在解析內容…'}**`)
        .addFields(
            { name: '下載項目', value: `${index} / ${total}`, inline: true },
            { name: '進度', value: `${safePercent.toFixed(1)}%`, inline: true }
        );
}

function createClearQueueModal(channelID, messageID) {
    return new ModalBuilder().setCustomId(`music_queue_clear_modal:${channelID}:${messageID}`).setTitle('確認清空所有序列').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('confirmation').setLabel('輸入 y 以清空所有待播歌曲')
            .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1))
    );
}

function createMusicRequestModal(insertNext = false) {
    return new ModalBuilder().setCustomId(insertNext ? 'music_request_modal:next' : 'music_request_modal').setTitle(insertNext ? '插播音樂' : '點播音樂').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('query').setLabel('YouTube 連結或歌曲標題').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1000))
    );
}

async function replyError(interaction, error) {
    const options = interaction.deferred
        ? {}
        : interaction.replied
            ? { method: 'followUp', ephemeral: true }
            : { method: 'reply', ephemeral: true };
    if (isMusicValidationError(error)) {
        return validationReply(interaction, `**${error.message}**`, options);
    }
    return errorReply(interaction, error, { ...options, context: '執行音樂功能' });
}

async function handleQueueOpen(interaction, context) {
    try {
        const state = getState(interaction.guildId, interaction.client, context);
        requireGuildVoice(interaction, state);
        requireCurrentPanel(interaction, state);
        const page = Number(interaction.customId.split(':')[1] || 0);
        const payload = createQueuePayload(state, page);
        return interaction.reply(payload);
    } catch (error) { return replyError(interaction, error); }
}

async function handleQueuePage(interaction, context) {
    try {
        const state = getState(interaction.guildId, interaction.client, context);
        requireGuildVoice(interaction, state);
        const page = Number(interaction.customId.split(':')[1] || 0);
        return interaction.update(createQueuePayload(state, page));
    } catch (error) { return replyError(interaction, error); }
}

// `index.js` 依下列 handler map 的 customId（冒號前綴）分派互動。
const command = {
    data: new SlashCommandBuilder().setName('音樂').setDescription('音樂播放相關功能')
        .setDMPermission(false)
        .addSubcommand(command => command.setName('管理面板').setDescription('開啟音樂管理面板')),
    async execute(interaction, context) {
        try {
            requireGuildVoice(interaction);
            const state = getState(interaction.guildId, interaction.client, context);
            state.panelChannel = interaction.channel;
            await interaction.reply({ embeds: [createPanelEmbed(state)], components: createButtons(state) });
            const message = await interaction.fetchReply();
            if (state.panelMessage && state.panelMessage.id !== message.id) await state.panelMessage.edit({ components: createButtons(state, true) }).catch(() => {});
            state.panelMessage = message;
            await repository(context).savePanel(interaction.guildId, message);
        } catch (error) { return replyError(interaction, error); }
    },
    buttonHandlers: {
        music_request: async (interaction, context) => {
            try {
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                requireCurrentPanel(interaction, state);
                await interaction.showModal(createMusicRequestModal(false));
            } catch (error) { return replyError(interaction, error); }
        },
        music_play_next: async (interaction, context) => {
            try {
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                requireCurrentPanel(interaction, state);
                await interaction.showModal(createMusicRequestModal(true));
            } catch (error) { return replyError(interaction, error); }
        },
        music_pause: async (interaction, context) => {
            try {
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                requireCurrentPanel(interaction, state);
                const paused = togglePause(state);
                if (paused === null) throw musicValidationError('目前沒有播放中的音樂。');
                await interaction.reply({ embeds: [createActionEmbed(paused ? '⏸️ ┃ 已暫停播放' : `${SUCCESS_EMOJI} ┃ 已繼續播放`, `<@${interaction.user.id}> ${paused ? '暫停了目前的音樂。' : '繼續播放目前的音樂。'}`, SUCCESS_COLOR)] });
            } catch (error) { return replyError(interaction, error); }
        },
        music_skip: async (interaction, context) => {
            try {
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                requireCurrentPanel(interaction, state);
                const skippedTitle = state.current?.title;
                if (!skipCurrent(state)) throw musicValidationError('目前沒有播放中的音樂。');
                await interaction.reply({ embeds: [createActionEmbed('⏭️ ┃ 已跳過歌曲', `<@${interaction.user.id}> 跳過了 **${skippedTitle}**。`, SUCCESS_COLOR)] });
            } catch (error) { return replyError(interaction, error); }
        },
        music_queue_open: handleQueueOpen,
        music_queue_page: handleQueuePage,
        music_queue_clear: async (interaction, context) => {
            try {
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                if (!state.queue.length) throw musicValidationError('目前沒有待播歌曲。');
                await interaction.showModal(createClearQueueModal(interaction.channelId, interaction.message.id));
            } catch (error) { return replyError(interaction, error); }
        }
    },
    componentHandlers: {
        music_queue_remove: async (interaction, context) => {
            try {
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                const removed = removeQueuedTracks(state, interaction.values);
                const page = Number(interaction.customId.split(':')[1] || 0);
                const payload = createQueuePayload(state, page);
                payload.content = removed.length ? `${SUCCESS_EMOJI} 已從序列移除 ${removed.length} 首歌曲。` : `${ERROR_EMOJI} 選擇的歌曲已不在序列中。`;
                await interaction.update(payload);
            } catch (error) { return replyError(interaction, error); }
        }
    },
    modalSubmitHandlers: {
        music_queue_clear_modal: async (interaction, context) => {
            try {
                if (interaction.fields.getTextInputValue('confirmation').trim().toLowerCase() !== 'y') throw musicValidationError('確認文字不正確，未清空序列。');
                const state = getState(interaction.guildId, interaction.client, context);
                requireGuildVoice(interaction, state);
                const removed = clearQueue(state);
                const [, channelID, messageID] = interaction.customId.split(':');
                const channel = await interaction.client.channels.fetch(channelID).catch(() => null);
                const message = await channel?.messages?.fetch(messageID).catch(() => null);
                await message?.edit(createQueuePayload(state, 0)).catch(() => {});
                await interaction.reply({ embeds: [createActionEmbed('🗑️ ┃ 已清空序列', `<@${interaction.user.id}> 已移除全部 **${removed.length}** 首待播歌曲。`, SUCCESS_COLOR)] });
            } catch (error) { return replyError(interaction, error); }
        },
        music_request_modal: async (interaction, context) => {
            // 點播／插播包含搜尋、下載進度與結果，僅讓操作使用者看見；
            // 暫停、跳過與序列等其他 handler 仍維持公開回覆。
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const downloadedTracks = [];
            const enqueuedTracks = new Set();
            let state = null;
            let preparationStarted = false;
            let userPendingAcquired = false;
            try {
                state = getState(interaction.guildId, interaction.client, context);
                const voiceChannel = requireGuildVoice(interaction, state);
                if (pendingUsers.has(interaction.user.id)) throw musicValidationError('你已有一個尚未完成的音樂點播。');
                if (state.preparingTracks > 0) throw musicValidationError('此伺服器已有一個音樂準備流程，請稍後再試。');
                pendingUsers.add(interaction.user.id);
                userPendingAcquired = true;
                beginTrackPreparation(state);
                preparationStarted = true;
                const insertNext = interaction.customId.endsWith(':next');
                const query = interaction.fields.getTextInputValue('query');
                await interaction.editReply({ embeds: [createDownloadEmbed(null, 0, 1, 0)] });
                const requestOptions = { ...OPTIONS, signal: context.signal };
                const metadataTracks = await extractTracks(query, interaction.user.id, requestOptions);
                if (state.queue.length + metadataTracks.length > OPTIONS.maxQueueTracks) {
                    throw musicValidationError(`播放序列最多只能有 ${OPTIONS.maxQueueTracks} 首歌曲。`);
                }
                let lastProgressUpdate = 0;
                let progressEdits = Promise.resolve();
                for (let index = 0; index < metadataTracks.length; index++) {
                    const metadata = metadataTracks[index];
                    await interaction.editReply({ embeds: [createDownloadEmbed(metadata, index + 1, metadataTracks.length, 0)] });
                    const downloaded = await downloadTrack(metadata, requestOptions, percent => {
                        const now = Date.now();
                        if (percent < 100 && now - lastProgressUpdate < 1000) return;
                        lastProgressUpdate = now;
                        progressEdits = progressEdits.then(() => interaction.editReply({ embeds: [createDownloadEmbed(metadata, index + 1, metadataTracks.length, percent)] })).catch(() => {});
                    });
                    downloadedTracks.push(downloaded);
                    await progressEdits;
                    await interaction.editReply({ embeds: [createDownloadEmbed(metadata, index + 1, metadataTracks.length, 100)] });
                }
                const refreshedMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
                if (refreshedMember?.voice?.channelId !== voiceChannel.id) {
                    throw musicValidationError('下載完成前你已離開原本的語音頻道，已取消點播。');
                }
                let firstPosition = null;
                let insertAhead;
                await withGuildLock(interaction.guildId, async () => {
                    if (state.queue.length + downloadedTracks.length > OPTIONS.maxQueueTracks) {
                        throw musicValidationError(`播放序列最多只能有 ${OPTIONS.maxQueueTracks} 首歌曲。`);
                    }
                    const latestMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
                    if (latestMember?.voice?.channelId !== voiceChannel.id) {
                        throw musicValidationError('你已離開原本的語音頻道，已取消點播。');
                    }
                    insertAhead = insertNext && Boolean(state.current);
                    const enqueueOrder = insertAhead ? [...downloadedTracks].reverse() : downloadedTracks;
                    for (const track of enqueueOrder) {
                        const position = await enqueue(state, track, voiceChannel, interaction.channel, insertAhead);
                        if (firstPosition === null) firstPosition = position;
                        enqueuedTracks.add(track);
                    }
                });
                const first = downloadedTracks[0];
                sendLog(interaction.client, `🎵 ${interaction.user.tag} ${insertNext ? '插播' : '點播'}：${first.title}${downloadedTracks.length > 1 ? ` 等 ${downloadedTracks.length} 首` : ''}`, 'INFO');
                const description = downloadedTracks.length === 1
                    ? `**[${first.title}](${first.url})** · <@${interaction.user.id}>\n-# 目前位於序列第 ${insertAhead ? 2 : firstPosition} 首`
                    : `**從播放清單${insertNext ? '插播' : '加入'}了 ${downloadedTracks.length} 首歌曲** · <@${interaction.user.id}>\n-# 第一首目前位於序列第 ${insertAhead ? 2 : firstPosition} 首`;
                await interaction.editReply({ embeds: [createActionEmbed(`${SUCCESS_EMOJI} ┃ ${insertNext ? '插播' : '點播'}成功`, description, SUCCESS_COLOR)] });
            } catch (error) {
                for (const track of downloadedTracks) if (!enqueuedTracks.has(track)) deleteTrackFile(track);
                await replyError(interaction, error);
            } finally {
                if (preparationStarted) endTrackPreparation(state);
                if (userPendingAcquired) pendingUsers.delete(interaction.user.id);
            }
        }
    },
    restorePersistedPlayback
};
command._test = { snapshotWriter };
return command;
}

module.exports = { createCommand };
