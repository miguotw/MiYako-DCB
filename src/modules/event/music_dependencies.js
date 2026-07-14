const path = require('path');
/**
 * 音樂子系統的啟動橋接器。
 * VoiceStateUpdate 交給 player 維護連線；ClientReady 才檢查外部執行檔，
 * 讓依賴失敗只停用音樂功能，不阻止 Discord Client 啟動。
 */
const { Events } = require('discord.js');
const { createLogTools } = require('../../../core/sendLog');
const { ffmpegPath, ensureYtDlp, checkFfmpeg, setProcessManager } = require('../../../util/ytDlpManager');

function createInitializer(config, { musicCommand } = {}) {
const { sendLog } = createLogTools(config);
const configCommands = config.commands;

const initializer = async (client, context = {}) => {
    if (context.processManager) setProcessManager(context.processManager);
    const voiceListener = (oldState, newState) => {
        const { handleVoiceStateUpdate } = require('../../../util/musicPlayer');
        handleVoiceStateUpdate(oldState, newState);
    };
    client.on(Events.VoiceStateUpdate, voiceListener);

    const music = configCommands.music || {};
    const options = {
        updateHours: Number(music.ytDlpUpdateHours) || 24,
        signal: context.signal
    };
    // yt-dlp 可自行下載/更新；ffmpeg-static 必須已由 npm 正確安裝。
    try {
        await checkFfmpeg();
        sendLog(client, `✅ ffmpeg-static 音樂播放依賴檢查完成：${ffmpegPath}`);
    } catch (error) {
        sendLog(client, '⚠️ ffmpeg-static 不可用，音樂播放將無法使用。', 'WARN', error);
    }
    try {
        const binary = await ensureYtDlp(options);
        sendLog(client, `✅ yt-dlp 已就緒：${binary}`);
    } catch (error) {
        sendLog(client, '⚠️ yt-dlp 下載或檢查失敗，音樂點播暫時無法使用。', 'WARN', error);
    }
    try {
        await musicCommand.restorePersistedPlayback?.(client, context);
    } catch (error) {
        sendLog(client, '⚠️ 無法清理或恢復音樂快照。', 'WARN', error);
    }
    return () => client.off(Events.VoiceStateUpdate, voiceListener);
};
return initializer;
}

module.exports = { createInitializer };
