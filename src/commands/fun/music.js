const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require('discord.js');
const { QueryType, useMainPlayer } = require('discord-player');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.music.emoji;
const PROGRESSBAR_LENGTH = configCommands.music.progressBar.length;
const PROGRESSBAR_INDICATOR = configCommands.music.progressBar.indicator;
const PROGRESSBAR_LEFTCHAR = configCommands.music.progressBar.leftChar;
const PROGRESSBAR_RIGHTCHAR = configCommands.music.progressBar.rightChar;
const BUTTONBAR_PLAY = configCommands.music.buttonBar.play;
const BUTTONBAR_REPEAT = configCommands.music.buttonBar.repeat;
const BUTTONBAR_PAUSE = configCommands.music.buttonBar.pause;
const BUTTONBAR_RESUME = configCommands.music.buttonBar.resume;
const BUTTONBAR_SKIP = configCommands.music.buttonBar.skip;

// 音樂控制面板指令，此指令用於創建音樂播放控制面板，並提供音樂
module.exports = {
    data: new SlashCommandBuilder()
        .setName('音樂')
        .setDescription('召喚一個音樂控制面板到目前頻道'),

    // 儲存控制面板訊息和更新間隔
    controlPanelMessages: new Map(),
    updateIntervals: new Map(),

    // 錯誤處理
    async execute(interaction) {
        try {
            await interaction.deferReply({ ephemeral: true });
            await this.createControlPanel(interaction);
            await infoReply(interaction, `**已召喚一個音樂控制面板到目前頻道！**`);
        } catch (error) {
            errorReply(interaction, `**執行時發生錯誤，原因：${error.message || '未知錯誤'}**`);
            sendLog(interaction.client, `❌ 在執行 音樂 時發生錯誤：`, "ERROR", error);
            return;
        }
    },

    // 創建音樂控制面板
    async createControlPanel(interaction, isNewSong = false) {
        const player = useMainPlayer();
        const queue = player.nodes.get(interaction.guildId);

        // 如果是新歌曲播放，先刪除舊的控制面板
        if (isNewSong) {
            await this.deleteOldControlPanel(interaction);
        }

        // 清除現有的更新間隔
        this.clearUpdateInterval(interaction.guildId);

        // 定義面板 embed 樣式
        const controlEmbed = new EmbedBuilder()
            .setColor(EMBED_COLOR)
            .setTitle(`${EMBED_EMOJI} ┃ 音樂控制面板`)
            .setThumbnail(queue?.currentTrack?.thumbnail || null);

        // 如果有音樂正在播放，顯示當前曲目和進度條
        if (queue && queue.currentTrack) {
            // 定義進度條樣式
            const progress = queue.node.createProgressBar({
                length: PROGRESSBAR_LENGTH,
                indicator: PROGRESSBAR_INDICATOR,
                leftChar: PROGRESSBAR_LEFTCHAR,
                rightChar: PROGRESSBAR_RIGHTCHAR
            });
            controlEmbed.setDescription(`**[${queue.currentTrack.title}](${queue.currentTrack.url})**\n${progress}`);
            
            // 如果有待播清單，顯示前五首歌曲
            if (queue.tracks.size > 0) {
                const tracks = queue.tracks.toArray();
                const displayCount = Math.min(5, tracks.length);
                let queueList = '';
                for (let i = 0; i < displayCount; i++) {
                    queueList += `- [${tracks[i].title}](${tracks[i].url})\n`;
                }
                if (tracks.length > 5) {
                    queueList += `-# 還有 ${tracks.length - 5} 首歌曲在序列中…`;
                }
                controlEmbed.addFields(
                    { name: '待播清單', value: queueList, inline: false }
                );
            }
        } else {
            // 如果沒有音樂播放，顯示提示訊息
            controlEmbed.setDescription('**目前沒有播放中的音樂**');
        }

        // 創建按鈕
        const playButton = new ButtonBuilder()
            .setCustomId('music_play_button')
            .setLabel('點播音樂')
            .setStyle(ButtonStyle.Primary)
            .setEmoji(BUTTONBAR_PLAY);

        const repeatButton = new ButtonBuilder()
            .setCustomId('music_repeat_button')
            .setLabel('重複播放')
            .setStyle(queue?.repeatMode === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji(BUTTONBAR_REPEAT);

        const pauseResumeButton = new ButtonBuilder()
            .setCustomId('music_pause_button')
            .setLabel(queue?.node.isPaused() ? '繼續' : '暫停')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(queue?.node.isPaused() ? BUTTONBAR_PAUSE : BUTTONBAR_RESUME);

        const skipButton = new ButtonBuilder()
            .setCustomId('music_skip_button')
            .setLabel('跳過')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(BUTTONBAR_SKIP);

        const buttonRow = new ActionRowBuilder().addComponents(playButton, repeatButton, pauseResumeButton, skipButton);

        // 發送控制面板訊息
        const reply = await interaction.channel.send({
            embeds: [controlEmbed],
            components: [buttonRow]
        });

        // 儲存控制面板訊息 ID
        this.controlPanelMessages.set(interaction.guildId, reply.id);

        // 如果有音樂正在播放，啟動自動更新
        if (queue && queue.currentTrack) {
            this.startAutoUpdate(interaction);
        }

        // 回覆用戶與日誌記錄
        sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：召喚音樂控制面板`, "INFO");
    },

    // 刪除舊的控制面板訊息
    async deleteOldControlPanel(interaction) {
        const messageId = this.controlPanelMessages.get(interaction.guildId);
        if (!messageId) return;

        try {
            const message = await interaction.channel.messages.fetch(messageId);
            await message.delete();
        } catch (error) {
            sendLog(interaction.client, `❌ 在執行 音樂 刪除舊控制面板 時發生錯誤：`, "ERROR", error);
        }
    },

    // 更新控制面板
    async updateControlPanel(interaction) {
        const player = useMainPlayer();
        const queue = player.nodes.get(interaction.guildId);
        const messageId = this.controlPanelMessages.get(interaction.guildId);

        // 如果沒有控制面板訊息 ID，則不進行更新
        if (!messageId) return;

        try {
            // 獲取控制面板訊息
            const message = await interaction.channel.messages.fetch(messageId);
            
            // 定義面板 embed 樣式
            const controlEmbed = new EmbedBuilder()
                .setColor(EMBED_COLOR)
                .setTitle(`${EMBED_EMOJI} ┃ 音樂控制面板`)
                .setThumbnail(queue?.currentTrack?.thumbnail || null);
            
            // 如果有音樂正在播放，顯示當前曲目和進度條
            if (queue && queue.currentTrack) {
                // 定義進度條樣式
                const progress = queue.node.createProgressBar({
                    length: PROGRESSBAR_LENGTH,
                    indicator: PROGRESSBAR_INDICATOR,
                    leftChar: PROGRESSBAR_LEFTCHAR,
                    rightChar: PROGRESSBAR_RIGHTCHAR
                });
                controlEmbed.setDescription(`**[${queue.currentTrack.title}](${queue.currentTrack.url})**\n${progress}`);
                
                // 如果有待播清單，顯示前五首歌曲
                if (queue.tracks.size > 0) {
                    const tracks = queue.tracks.toArray();
                    const displayCount = Math.min(5, tracks.length);
                    let queueList = '';
                    for (let i = 0; i < displayCount; i++) {
                        queueList += `- [${tracks[i].title}](${tracks[i].url})\n`;
                    }
                    if (tracks.length > 5) {
                        queueList += `-# 還有 ${tracks.length - 5} 首歌曲在序列中…`;
                    }
                    controlEmbed.addFields(
                        { name: '待播清單', value: queueList, inline: false }
                    );
                }
            } else {
                // 如果沒有音樂播放，顯示提示訊息
                controlEmbed.setDescription('**目前沒有播放中的音樂**');

                // 如果沒有音樂播放，清除更新間隔
                this.clearUpdateInterval(interaction.guildId);
            }

            // 更新按鈕狀態
            const playButton = new ButtonBuilder()
                .setCustomId('music_play_button')
                .setLabel('點播音樂')
                .setStyle(ButtonStyle.Primary)
                .setEmoji(BUTTONBAR_PLAY);

            const repeatButton = new ButtonBuilder()
                .setCustomId('music_repeat_button')
                .setLabel('重複播放')
                .setStyle(queue?.repeatMode === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji(BUTTONBAR_REPEAT);

            const pauseResumeButton = new ButtonBuilder()
                .setCustomId('music_pause_button')
                .setLabel(queue?.node.isPaused() ? '繼續' : '暫停')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(queue?.node.isPaused() ? BUTTONBAR_PAUSE : BUTTONBAR_RESUME);

            const skipButton = new ButtonBuilder()
                .setCustomId('music_skip_button')
                .setLabel('跳過')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(BUTTONBAR_SKIP);

            const buttonRow = new ActionRowBuilder().addComponents(playButton, repeatButton, pauseResumeButton, skipButton);

            // 更新控制面板訊息
            await message.edit({
                embeds: [controlEmbed],
                components: [buttonRow]
            });
        } catch (error) {
            // 如果更新失敗，清除更新間隔
            this.clearUpdateInterval(interaction.guildId);
            sendLog(interaction.client, `❌ 在執行 音樂 更新控制面板 時發生錯誤：`, "ERROR", error);
        }
    },

    // 啟動自動更新
    startAutoUpdate(interaction) {
        // 如果已經有更新間隔，先清除
        this.clearUpdateInterval(interaction.guildId);

        // 每 2.5 秒更新一次控制面板
        const interval = setInterval(async () => {
            await this.updateControlPanel(interaction);
        }, 2500);

        // 儲存更新間隔
        this.updateIntervals.set(interaction.guildId, interval);
    },

    // 清除更新間隔
    clearUpdateInterval(guildId) {
        const interval = this.updateIntervals.get(guildId);
        if (interval) {
            clearInterval(interval);
            this.updateIntervals.delete(guildId);
        }
    },

    // 按鈕和模態提交處理器
    buttonHandlers: {
        // 點播音樂按鈕，當用戶點擊時，顯示 Modal 讓用戶提交音樂
        music_play_button: async (interaction) => {
            try {
                const modal = new ModalBuilder()
                    .setCustomId('music_play_modal')
                    .setTitle('點播音樂');

                const songInput = new TextInputBuilder()
                    .setCustomId('songInput')
                    .setLabel('音樂連結或關鍵字')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('例如: https://youtu.be/... 或 歌曲名稱')
                    .setRequired(true)
                    .setMaxLength(100);

                const firstRow = new ActionRowBuilder().addComponents(songInput);
                modal.addComponents(firstRow);
                
                // 回覆用戶與日誌記錄
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：點播音樂`, "INFO");
                await interaction.showModal(modal);
            } catch (error) {
                errorReply(interaction, `**開啟點播視窗時發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 開啟點播視窗 時發生錯誤：`, "ERROR", error);
                return;
            }
        },

        // 重複播放按鈕，當用戶點擊時，循環切換重複撥放模式
        music_repeat_button: async (interaction) => {
            try {
                // 獲取音樂播放器和當前佇列
                const player = useMainPlayer();
                const queue = player.nodes.get(interaction.guildId);

                // 如果沒有音樂正在播放，則不進行操作
                if (!queue || !queue.currentTrack) {
                    return interaction.deferUpdate();
                }

                // 切換重複模式
                queue.setRepeatMode(queue.repeatMode === 1 ? 0 : 1);
                
                // 更新控制面板
                const instance = require('./music');
                await instance.updateControlPanel(interaction);
                
                // 回覆用戶與日誌記錄
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：重複播放`, "INFO");
                await interaction.deferUpdate();
            } catch (error) {
                errorReply(interaction, `**重複播放發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 重複播放 時發生錯誤：`, "ERROR", error);
                await interaction.deferUpdate();
            }
        },

        // 暫停或繼續播放按鈕，當用戶點擊時，循環切換狀態
        music_pause_button: async (interaction) => {
            try {
                // 獲取音樂播放器和當前佇列
                const player = useMainPlayer();
                const queue = player.nodes.get(interaction.guildId);

                // 如果沒有音樂正在播放，則不進行操作
                if (!queue || !queue.currentTrack) {
                    return interaction.deferUpdate();
                }

                // 切換暫停狀態
                if (queue.node.isPaused()) {
                    queue.node.resume();
                } else {
                    queue.node.pause();
                }

                // 更新控制面板
                const instance = require('./music');
                await instance.updateControlPanel(interaction);
                
                // 回覆用戶與日誌記錄
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：暫停/繼續`, "INFO");
                await interaction.deferUpdate();
            } catch (error) {
                errorReply(interaction, `**暫停/繼續 發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 暫停/繼續 時發生錯誤：`, "ERROR", error);
                await interaction.deferUpdate();
            }
        },

        // 跳過按鈕，當用戶點擊時，跳過當前播放的音樂
        music_skip_button: async (interaction) => {
            try {
                // 獲取音樂播放器和當前佇列
                const player = useMainPlayer();
                const queue = player.nodes.get(interaction.guildId);
                
                // 如果沒有音樂正在播放，則不進行操作
                if (!queue || !queue.currentTrack) {
                    return interaction.deferUpdate();
                }

                // 跳過當前曲目
                queue.node.skip();
                
                // 回覆用戶與日誌記錄
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：跳過`, "INFO");
                await interaction.deferUpdate();
            } catch (error) {
                errorReply(interaction, `**跳過 發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 跳過 時發生錯誤：`, "ERROR", error);
                await interaction.deferUpdate();
            }
        }
    },

    // Modal 提交處理器
    modalSubmitHandlers: {
        // 音樂播放 Modal，當用戶提交音樂連結或關鍵字時，開始播放音樂
        music_play_modal: async (interaction) => {
            try {
                await interaction.deferReply({ ephemeral: true });

                const player = useMainPlayer();
                const song = interaction.fields.getTextInputValue('songInput');
                const res = await player.search(song, {
                    requestedBy: interaction.member,
                    searchEngine: QueryType.AUTO
                });

                if (!res?.tracks.length) {
                    return errorReply(interaction, `**沒有找到結果… 再試一次？**\n-# 由於機器人伺服器位置與您所在地可能不同，導致受到地區限制，建議更換關鍵字或使用其他連結。\n`);
                }

                try {
                    const { track } = await player.play(interaction.member.voice.channel, song, {
                        nodeOptions: {
                            metadata: {
                                channel: interaction.channel,
                                client: interaction.client
                            },
                            volume: 20,
                            leaveOnEmpty: true,
                            leaveOnEmptyCooldown: 300000,
                            leaveOnEnd: true,
                            leaveOnEndCooldown: 300000,
                        }
                    });
                    await infoReply(interaction, `**載入 [${track.title}](${track.url}) 到序列中…**`);

                    // 當新歌曲開始播放時，重新創建控制面板
                    const instance = require('./music');
                    await instance.createControlPanel(interaction, true);

                } catch (error) {
                    console.log(`Play error: ${error}`);
                    return errorReply(interaction, `**我無法加入語音頻道… 再試一次？**`);
                }
            } catch (error) {
                errorReply(interaction, `**執行時發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 時發生錯誤：`, "ERROR", error);
                return;
            }
        }
    }
};
