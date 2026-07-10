const path = require('path');
const { Events } = require('discord.js');
const { configCommands } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { ffmpegPath, ensureYtDlp, checkFfmpeg } = require(path.join(process.cwd(), 'util/ytDlpManager'));

module.exports = client => {
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        const { handleVoiceStateUpdate } = require(path.join(process.cwd(), 'util/musicPlayer'));
        handleVoiceStateUpdate(oldState, newState);
    });
    client.once(Events.ClientReady, async () => {
        const music = configCommands.music || {};
        const options = {
            binaryPath: music.ytDlpPath || 'assets/music/yt-dlp',
            updateHours: Number(music.ytDlpUpdateHours) || 24
        };
        try {
            await checkFfmpeg();
            sendLog(client, `✅ ffmpeg-static 音樂播放依賴檢查完成：${ffmpegPath}`);
        } catch (error) {
            sendLog(client, '⚠️ ffmpeg-static 不可用，音樂播放將無法使用。', 'WARN', error);
        }
        try {
            const binary = await ensureYtDlp(options);
            sendLog(client, `✅ yt-dlp 已就緒：${binary}`);
            await client.commands.get('音樂')?.restorePersistedPlayback?.(client);
        } catch (error) {
            sendLog(client, '⚠️ yt-dlp 下載或檢查失敗，音樂點播暫時無法使用。', 'WARN', error);
        }
    });
};
