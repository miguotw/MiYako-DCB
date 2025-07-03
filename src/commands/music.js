const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle, ButtonBuilder, ButtonStyle } = require('discord.js');
const { config, configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { getPlayer, searchMusic, playMusic, createProgressBar, getPlayerState, controlPlayer } = require(path.join(process.cwd(), 'util/getDiscordPlayer'));

// 導入設定檔內容
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = configCommands.music.emoji;
const BUTTONBAR_PLAY = configCommands.music.buttonBar.play;
const BUTTONBAR_REPEAT = configCommands.music.buttonBar.repeat;
const BUTTONBAR_PAUSE = configCommands.music.buttonBar.pause;
const BUTTONBAR_RESUME = configCommands.music.buttonBar.resume;
const BUTTONBAR_SKIP = configCommands.music.buttonBar.skip;

// 統一定義音樂控制面板的 embed
function createControlPanelEmbed(queue, isPlaying, isPaused) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ 音樂控制面板`)
        .setThumbnail(queue?.currentTrack?.thumbnail || null);

    if (isPlaying) {
        const progress = createProgressBar(queue);
        embed.setDescription(`**[${queue.currentTrack.title}](${queue.currentTrack.url})**\n${progress}`);
        
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
            embed.addFields({ name: '待播清單', value: queueList, inline: false });
        }
    } else {
        embed.setDescription('**目前沒有播放中的音樂**');
    }

    return embed;
}

// 統一定義音樂控制面板的按鈕
function createControlPanelButtons(repeatMode, isPaused) {
    const playButton = new ButtonBuilder()
        .setCustomId('music_play_button')
        .setLabel('點播音樂')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(BUTTONBAR_PLAY);

    const repeatButton = new ButtonBuilder()
        .setCustomId('music_repeat_button')
        .setLabel('重複播放')
        .setStyle(repeatMode === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji(BUTTONBAR_REPEAT);

    const pauseResumeButton = new ButtonBuilder()
        .setCustomId('music_pause_button')
        .setLabel(isPaused ? '繼續' : '暫停')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(isPaused ? BUTTONBAR_PAUSE : BUTTONBAR_RESUME);

    const skipButton = new ButtonBuilder()
        .setCustomId('music_skip_button')
        .setLabel('跳過')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji(BUTTONBAR_SKIP);

    return new ActionRowBuilder().addComponents(playButton, repeatButton, pauseResumeButton, skipButton);
}

// 音樂控制面板指令
module.exports = {
    data: new SlashCommandBuilder()
        .setName('音樂')
        .setDescription('召喚一個音樂控制面板到目前頻道'),

    // 儲存控制面板訊息和更新間隔
    controlPanelMessages: new Map(), 
    updateIntervals: new Map(),

    // 當指令被觸發時執行
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

    // 音樂控制面板：創建或更新控制面板
    async createControlPanel(interaction, isNewSong = false) {
        const { queue, isPlaying, isPaused, repeatMode } = getPlayerState(interaction.guildId);

        // 如果是新歌曲播放，先刪除舊的控制面板
        if (isNewSong) {
            await this.deleteOldControlPanel(interaction);
        }

        // 清除現有的更新間隔
        this.clearUpdateInterval(interaction.guildId);

        // 導入預先定義的音樂控制面板 embed 和按鈕
        const embed = createControlPanelEmbed(queue, isPlaying, isPaused);
        const buttons = createControlPanelButtons(repeatMode, isPaused);

        // 發送控制面板訊息
        const reply = await interaction.channel.send({
            embeds: [embed],
            components: [buttons]
        });

        // 儲存控制面板訊息 ID
        this.controlPanelMessages.set(interaction.guildId, reply.id);

        // 如果有音樂正在播放，啟動自動更新
        if (isPlaying) {
            this.startAutoUpdate(interaction);
        }

        sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：召喚音樂控制面板`, "INFO");
    },

    // 音樂控制面板：按鈕處理器
    buttonHandlers: {
        // 按鈕：點播音樂
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
                
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：點播音樂`, "INFO");
                await interaction.showModal(modal);
            } catch (error) {
                errorReply(interaction, `**開啟點播視窗時發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 開啟點播視窗 時發生錯誤：`, "ERROR", error);
                return;
            }
        },

        // 按鈕：重複播放
        music_repeat_button: async (interaction) => {
            try {
                const result = controlPlayer(interaction.guildId, 'repeat');
                if (!result.success) {
                    return interaction.deferUpdate();
                }
                
                const instance = require('./music');
                await instance.updateControlPanel(interaction);
                
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：重複播放`, "INFO");
                await interaction.deferUpdate();
            } catch (error) {
                errorReply(interaction, `**重複播放發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 重複播放 時發生錯誤：`, "ERROR", error);
                await interaction.deferUpdate();
            }
        },

        // 按鈕：暫停/繼續
        music_pause_button: async (interaction) => {
            try {
                const action = getPlayerState(interaction.guildId).isPaused ? 'resume' : 'pause';
                const result = controlPlayer(interaction.guildId, action);
                if (!result.success) {
                    return interaction.deferUpdate();
                }

                const instance = require('./music');
                await instance.updateControlPanel(interaction);
                
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：暫停/繼續`, "INFO");
                await interaction.deferUpdate();
            } catch (error) {
                errorReply(interaction, `**暫停/繼續 發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 暫停/繼續 時發生錯誤：`, "ERROR", error);
                await interaction.deferUpdate();
            }
        },

        // 按鈕：跳過
        music_skip_button: async (interaction) => {
            try {
                const result = controlPlayer(interaction.guildId, 'skip');
                if (!result.success) {
                    return interaction.deferUpdate();
                }

                const instance = require('./music');
                await instance.updateControlPanel(interaction);
                
                sendLog(interaction.client, `🎧 ${interaction.user.tag} 執行了互動：跳過`, "INFO");
                await interaction.deferUpdate();
            } catch (error) {
                errorReply(interaction, `**跳過 發生錯誤，原因：${error.message || '未知錯誤'}**`);
                sendLog(interaction.client, `❌ 在執行 音樂 跳過 時發生錯誤：`, "ERROR", error);
                await interaction.deferUpdate();
            }
        }
    },

    // 音樂控制面板：modal 提交處理器
    modalSubmitHandlers: {
        // modal：點播音樂
        music_play_modal: async (interaction) => {
            try {
                await interaction.deferReply({ ephemeral: true });

                const song = interaction.fields.getTextInputValue('songInput');
                const res = await searchMusic(song, interaction.member);

                if (!res?.tracks.length) {
                    return errorReply(interaction, `**沒有找到結果… 再試一次？**\n-# 由於機器人伺服器位置與您所在地可能不同，導致受到地區限制，建議更換關鍵字或使用其他連結。\n`);
                }

                try {
                    const { track } = await playMusic(interaction.member.voice.channel, song, interaction);
                    await infoReply(interaction, `**載入 [${track.title}](${track.url}) 到序列中…**`);

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
    },

    // 功能模組：刪除音樂控制面板
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

    // 功能模組：更新音樂控制面板
    async updateControlPanel(interaction) {
        const { queue, isPlaying, isPaused, repeatMode } = getPlayerState(interaction.guildId);
        const messageId = this.controlPanelMessages.get(interaction.guildId);

        if (!messageId) return;

        try {
            const message = await interaction.channel.messages.fetch(messageId);
            const embed = createControlPanelEmbed(queue, isPlaying, isPaused);
            const buttons = createControlPanelButtons(repeatMode, isPaused);

            await message.edit({
                embeds: [embed],
                components: [buttons]
            });

            if (!isPlaying) {
                this.clearUpdateInterval(interaction.guildId);
            }
        } catch (error) {
            this.clearUpdateInterval(interaction.guildId);
            sendLog(interaction.client, `❌ 在執行 音樂 更新控制面板 時發生錯誤：`, "ERROR", error);
        }
    },

    // 功能模組：自動更新音樂控制面板
    startAutoUpdate(interaction) {
        this.clearUpdateInterval(interaction.guildId);
        const interval = setInterval(async () => {
            await this.updateControlPanel(interaction);
        }, 2500);
        this.updateIntervals.set(interaction.guildId, interval);
    },

    // 功能模組：清除自動更新間隔
    clearUpdateInterval(guildId) {
        const interval = this.updateIntervals.get(guildId);
        if (interval) {
            clearInterval(interval);
            this.updateIntervals.delete(guildId);
        }
    }
};