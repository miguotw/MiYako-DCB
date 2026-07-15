const test = require('node:test');
const assert = require('node:assert/strict');
const {
    toYtDlpQuery, validateYouTubeUrl, normalizeTrack, validateTrack, formatDuration,
    getUploadYear, createProgressBar, paginateQueue
} = require('../util/musicHelpers');
const {
    ffmpegPath, checkFfmpeg, createYtDlpArgs, shouldCheckUpdate, isExtractorFailure,
    resolveBinaryPath, CACHE_DIRECTORY, runYtDlp, getYtDlpConcurrencyStateForTests
} = require('../util/ytDlpManager');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getGuildState, guildStates, shutdownAllPlayers } = require('../util/musicPlayer');
const { createJsonRepository } = require('../core/jsonRepository');
const { createMusicRepository } = require('../util/musicRepository');
const { PROJECT_ROOT, loadConfig } = require('../core/config');
const { createCommand: createMusicCommand } = require('../src/commands/music');

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
    assert.equal(resolveBinaryPath(), path.join(PROJECT_ROOT, 'runtime', 'bin', 'yt-dlp'));
    assert.equal(CACHE_DIRECTORY, path.join(PROJECT_ROOT, 'runtime', 'cache', 'music'));
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

test('每個伺服器使用獨立的 runtime 序列 envelope', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-music-repository-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = createMusicRepository({
        queueRepository: createJsonRepository({ directory: path.join(root, 'queues') }),
        panelRepository: createJsonRepository({ directory: path.join(root, 'panels') })
    });
    await repository.saveQueue('999999999999999999', { current: { title: 'Test' }, queue: [] });
    await repository.saveQueue('888888888888888888', { current: { title: 'Other' }, queue: [] });
    const snapshots = await repository.loadQueues();
    assert.equal(snapshots.find(item => item.guildID === '999999999999999999').current.title, 'Test');
    assert.equal(snapshots.find(item => item.guildID === '888888888888888888').current.title, 'Other');
});

test('graceful shutdown 先保存目前歌曲與序列且不刪 cache', async () => {
    const guildID = '888888888888888888';
    let snapshot;
    const state = getGuildState(guildID, {}, {
        persistSnapshot: async (_state, value) => { snapshot = structuredClone(value); }
    });
    state.voiceChannelID = '777777777777777777';
    state.current = { title: 'Current', url: 'https://youtu.be/current', localPath: '/tmp/current.webm' };
    state.queue = [{ title: 'Next', url: 'https://youtu.be/next', localPath: '/tmp/next.webm' }];

    await shutdownAllPlayers();
    assert.equal(snapshot.current.title, 'Current');
    assert.equal(snapshot.queue[0].title, 'Next');

    guildStates.delete(guildID);
});

test('快照 immediate flush 等待最新內容且寫入不重疊', async () => {
    const releases = [];
    const snapshots = [];
    let active = 0;
    let maximumActive = 0;
    const queueRepository = {
        write: async (_guildID, snapshot) => {
            snapshots.push(snapshot);
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => releases.push(resolve));
            active -= 1;
        }
    };
    const context = {
        store: {
            musicQueue: queueRepository,
            musicPanel: { write: async () => {} }
        }
    };
    const writer = createMusicCommand(loadConfig())._test.snapshotWriter(context);
    const first = writer.schedule('guild', { value: 'first' }, { immediate: true });
    const second = writer.schedule('guild', { value: 'latest' }, { immediate: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshots.length, 1);
    releases.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1].value, 'latest');
    releases.shift()();
    await Promise.all([first, second]);
    assert.equal(maximumActive, 1);
});

test('全域同時最多執行兩個 yt-dlp child', async () => {
    const tasks = Array.from({ length: 3 }, () => runYtDlp(process.execPath, [
        '-e', 'setTimeout(() => process.exit(0), 150)'
    ], { timeout: 2000 }));
    const deadline = Date.now() + 1000;
    while (getYtDlpConcurrencyStateForTests().waiting !== 1 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepEqual(getYtDlpConcurrencyStateForTests(), { active: 2, waiting: 1 });
    await Promise.all(tasks);
    assert.deepEqual(getYtDlpConcurrencyStateForTests(), { active: 0, waiting: 0 });
});
