const test = require('node:test');
const assert = require('node:assert/strict');
const {
    toYtDlpQuery, validateYouTubeUrl, normalizeTrack, validateTrack, formatDuration,
    getUploadYear, createProgressBar, paginateQueue
} = require('../util/musicHelpers');
const { ffmpegPath, checkFfmpeg, createYtDlpArgs, shouldCheckUpdate, isExtractorFailure } = require('../util/ytDlpManager');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveGuildQueue, loadAllGuildQueues, deleteGuildQueue } = require('../util/musicQueueStore');

test('網址原樣傳入，標題使用 ytsearch1', () => {
    assert.deepEqual(toYtDlpQuery('https://youtu.be/abc'), { query: 'https://youtu.be/abc', isUrl: true });
    assert.deepEqual(toYtDlpQuery('歌曲名稱'), { query: 'ytsearch1:歌曲名稱', isUrl: false });
});

test('只接受精確且安全的 YouTube URL', () => {
    const accepted = [
        'https://www.youtube.com/watch?v=abc',
        'https://youtube.com/shorts/abc',
        'https://m.youtube.com/live/abc',
        'https://music.youtube.com/playlist?list=abc',
        'https://www.youtube.com/embed/abc',
        'https://youtu.be/abc'
    ];
    for (const url of accepted) assert.doesNotThrow(() => validateYouTubeUrl(url));

    const rejected = [
        'http://youtube.com/watch?v=abc',
        'https://user@youtube.com/watch?v=abc',
        'https://youtube.com:444/watch?v=abc',
        'https://youtube.com.evil.test/watch?v=abc',
        'https://youtu.be.evil.test/abc',
        'https://localhost/watch?v=abc',
        'https://127.0.0.1/watch?v=abc',
        'https://192.168.1.1/watch?v=abc',
        'https://www.youtube.com/redirect?q=http://127.0.0.1',
        'https://vimeo.com/123'
    ];
    for (const url of rejected) assert.throws(() => toYtDlpQuery(url));
});

test('所有 yt-dlp 參數都強制忽略本機設定', () => {
    assert.deepEqual(createYtDlpArgs(['--dump-single-json', 'query']), ['--ignore-config', '--dump-single-json', 'query']);
});

test('metadata 正規化並取得年份', () => {
    const track = normalizeTrack({ id: 'a', title: 'Song', webpage_url: 'https://youtu.be/a', uploader: 'Artist', upload_date: '20250709', duration: 123, thumbnail: 'x' }, 'user');
    assert.equal(track.channel, 'Artist');
    assert.equal(getUploadYear(track.uploadDate), '2025');
    assert.equal(getUploadYear(null), '未知年份');
    assert.equal(validateTrack(track, 7200), track);
});

test('拒絕直播與超長內容', () => {
    const url = 'https://youtu.be/abc';
    assert.throws(() => validateTrack({ isLive: true, url, duration: 1 }, 7200), /直播/);
    assert.throws(() => validateTrack({ isLive: false, url, duration: 7201 }, 7200), /2:00:00/);
    assert.throws(() => validateTrack({ isLive: false, url, duration: 30 }, 7200, 60), /1:00/);
    assert.doesNotThrow(() => validateTrack({ isLive: false, url, duration: 999999 }, 0, 0));
});

test('格式化時間、進度與佇列分頁', () => {
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(7200), '2:00:00');
    assert.equal(createProgressBar(50, 100, 10).length, 10);
    const tracks = Array.from({ length: 21 }, (_, id) => ({ id }));
    assert.deepEqual(paginateQueue(tracks, 1), { items: tracks.slice(10, 20), page: 1, totalPages: 3 });
    assert.equal(paginateQueue(tracks, 99).page, 2);
});

test('yt-dlp 更新檢查依時間節流', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-music-'));
    const binary = path.join(directory, 'yt-dlp');
    assert.equal(shouldCheckUpdate(binary, 24, 1000), true);
    fs.writeFileSync(`${binary}.update.json`, JSON.stringify({ lastCheckedAt: 1000 }));
    assert.equal(shouldCheckUpdate(binary, 24, 2000), false);
    assert.equal(shouldCheckUpdate(binary, 24, 1000 + 24 * 3600000), true);
});

test('只將抽取機制錯誤分類為可更新重試', () => {
    assert.equal(isExtractorFailure(new Error('Unable to extract nsig function')), true);
    assert.equal(isExtractorFailure(new Error('unable to download video data: HTTP Error 403: Forbidden')), true);
    assert.equal(isExtractorFailure(new Error('Private video')), false);
    assert.equal(isExtractorFailure(new Error('HTTP Error 429')), false);
});

test('ffmpeg-static 提供可執行的 FFmpeg', async () => {
    assert.ok(ffmpegPath);
    assert.equal(fs.existsSync(ffmpegPath), true);
    const result = await checkFfmpeg();
    assert.match(result.stdout, /ffmpeg version/i);
});

test('每個伺服器使用獨立的序列 JSON', () => {
    const guildID = '999999999999999999';
    saveGuildQueue(guildID, { current: { title: 'Test' }, queue: [] });
    const snapshot = loadAllGuildQueues().find(item => item.guildID === guildID);
    assert.equal(snapshot.current.title, 'Test');
    deleteGuildQueue(guildID);
});
