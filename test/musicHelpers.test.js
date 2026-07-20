const test = require('node:test');
const assert = require('node:assert/strict');
const {
    toYtDlpQuery, validateBilibiliUrl, validateYouTubeUrl, normalizeTrack, validateTrack,
    formatDuration, getUploadYear, createProgressBar, paginateQueue
} = require('../util/musicHelpers');
const {
    ffmpegPath, checkFfmpeg, createYtDlpArgs, shouldCheckUpdate, isExtractorFailure,
    normalizeMediaError, resolveBilibiliShortUrl, resolveBinaryPath, CACHE_DIRECTORY,
    extractTracks, prepareLiveTrack, startLivePipeline, runYtDlp, setProcessManager,
    getYtDlpConcurrencyStateForTests, getLiveConcurrencyStateForTests
} = require('../util/ytDlpManager');
const { PassThrough } = require('node:stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getGuildState, guildStates, shutdownAllPlayers } = require('../util/musicPlayer');
const { createJsonRepository } = require('../core/jsonRepository');
const { createMusicRepository } = require('../util/musicRepository');
const { PROJECT_ROOT, loadConfig } = require('../core/config');
const { createCommand: createMusicCommand } = require('../src/commands/music');

function installFakeYtDlp(t, run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-bilibili-'));
    const binaryPath = path.join(root, 'yt-dlp');
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(`${binaryPath}.update.json`, JSON.stringify({ lastCheckedAt: Date.now() }), { mode: 0o600 });
    setProcessManager({ run });
    t.after(() => {
        setProcessManager(null);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return binaryPath;
}

function fakeStreamingHandle() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let resolveCompletion;
    let rejectCompletion;
    let stopPromise = null;
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    return {
        stdin, stdout, completion,
        stop(reason = new Error('stopped')) {
            if (!stopPromise) {
                stopPromise = Promise.resolve().then(() => rejectCompletion(reason));
            }
            return stopPromise;
        },
        finish(result = { code: 0, signal: null, stderr: '' }) { resolveCompletion(result); }
    };
}

test('網址原樣傳入，標題使用 ytsearch1', () => {
    assert.deepEqual(toYtDlpQuery('https://youtu.be/abc'), { query: 'https://youtu.be/abc', isUrl: true, source: 'youtube' });
    assert.deepEqual(toYtDlpQuery('歌曲名稱'), { query: 'ytsearch1:歌曲名稱', isUrl: false, source: 'youtube' });
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
        'https://www.twitch.tv/channel',
        'https://vimeo.com/123'
    ];
    for (const url of rejected) assert.throws(() => toYtDlpQuery(url));
});

test('只接受並正規化一般 Bilibili 影片、分 P 與官方短網址', () => {
    assert.equal(
        validateBilibiliUrl('https://m.bilibili.com/video/BV1xx411c7mD/?share_source=copy_web&p=2#reply'),
        'https://www.bilibili.com/video/BV1xx411c7mD?p=2'
    );
    assert.equal(validateBilibiliUrl('https://bilibili.com/video/av1074402'), 'https://www.bilibili.com/video/av1074402');
    assert.equal(validateBilibiliUrl('https://b23.tv/Abc_123?share=true'), 'https://b23.tv/Abc_123');
    assert.deepEqual(toYtDlpQuery('https://www.bilibili.com/video/BV1xx411c7mD'), {
        query: 'https://www.bilibili.com/video/BV1xx411c7mD', isUrl: true, source: 'bilibili'
    });

    const rejected = [
        'http://www.bilibili.com/video/BV1xx411c7mD',
        'https://user@www.bilibili.com/video/BV1xx411c7mD',
        'https://www.bilibili.com:444/video/BV1xx411c7mD',
        'https://www.bilibili.com.evil.test/video/BV1xx411c7mD',
        'https://www.bilibili.com/bangumi/play/ep123',
        'https://www.bilibili.com/list/watchlater',
        'https://live.bilibili.com/123',
        'https://www.bilibili.com/video/not-a-video',
        'https://www.bilibili.com/video/BV1xx411c7mD?p=0',
        'https://www.bilibili.com/video/BV1xx411c7mD?p=1&p=2',
        'https://b23.tv/a/b'
    ];
    for (const url of rejected) assert.throws(() => toYtDlpQuery(url), undefined, url);
});

test('b23.tv 僅逐跳跟隨官方短網址並驗證最終 Bilibili 影片', async t => {
    const calls = [];
    const http = {
        async get(url, options) {
            calls.push([url, options]);
            if (url === 'https://b23.tv/first') return { status: 302, headers: { location: '/second' } };
            return { status: 301, headers: { location: 'https://m.bilibili.com/video/BV1xx411c7mD?p=3&share_source=copy' } };
        }
    };
    assert.equal(
        await resolveBilibiliShortUrl('https://b23.tv/first', { http }),
        'https://www.bilibili.com/video/BV1xx411c7mD?p=3'
    );
    assert.equal(calls.length, 2);
    assert.equal(calls.every(([, options]) => options.maxRedirects === 0), true);

    await t.test('外部目的地不會被請求', async () => {
        let requests = 0;
        const externalHttp = { get: async () => {
            requests += 1;
            return { status: 302, headers: { location: 'https://example.com/video' } };
        } };
        await assert.rejects(resolveBilibiliShortUrl('https://b23.tv/external', { http: externalHttp }), /YouTube 或 Bilibili/);
        assert.equal(requests, 1);
    });

    await t.test('拒絕缺少目的地、循環與過多跳轉', async () => {
        await assert.rejects(resolveBilibiliShortUrl('https://b23.tv/missing', {
            http: { get: async () => ({ status: 302, headers: {} }) }
        }), /未回傳有效/);
        await assert.rejects(resolveBilibiliShortUrl('https://b23.tv/a', {
            http: { get: async url => ({ status: 302, headers: { location: url.endsWith('/a') ? '/b' : '/a' } }) }
        }), /循環/);
        let requests = 0;
        await assert.rejects(resolveBilibiliShortUrl('https://b23.tv/one', {
            http: { get: async () => ({ status: 302, headers: { location: `/${++requests + 1}` } }) }
        }), /不可超過 3 次/);
        assert.equal(requests, 3);
    });
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

test('只允許直接公開 URL 建立 YouTube live track', () => {
    const youtube = normalizeTrack({
        id: 'live-id', title: 'Live', webpage_url: 'https://youtu.be/live-id',
        uploader: 'Channel', is_live: true, live_status: 'is_live'
    }, 'user', 'youtube');
    assert.equal(youtube.duration, null);
    assert.equal(youtube.playbackType, 'live');
    assert.equal(validateTrack(youtube, 1, 9999, { allowLiveStreams: true, directInput: true }), youtube);
    assert.throws(() => validateTrack({ ...youtube }, 7200, 0, { allowLiveStreams: true, directInput: false }), /直接貼上/);
    assert.throws(() => validateTrack({ ...youtube }, 7200, 0, { allowLiveStreams: false, directInput: true }), /設定不允許/);

    const upcoming = normalizeTrack({
        webpage_url: 'https://youtu.be/upcoming', live_status: 'is_upcoming'
    }, 'user', 'youtube');
    assert.throws(() => validateTrack(upcoming, 7200, 0, { allowLiveStreams: true, directInput: true }), /尚未開始/);
    const postLive = normalizeTrack({
        webpage_url: 'https://youtu.be/post-live', live_status: 'post_live'
    }, 'user', 'youtube');
    assert.throws(() => validateTrack(postLive, 7200, 0, { allowLiveStreams: true, directInput: true }), /轉檔中/);
    const finished = normalizeTrack({
        webpage_url: 'https://youtu.be/finished', live_status: 'was_live', duration: 3600
    }, 'user', 'youtube');
    assert.equal(validateTrack(finished, 7200, 0, { allowLiveStreams: true, directInput: true }).playbackType, 'file');
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
    assert.equal(normalizeMediaError(new Error('This video is only available for registered users')).code, 'MUSIC_VALIDATION');
    assert.equal(normalizeMediaError(new Error('unexpected parser bug')).code, undefined);
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

test('直播管線以獨立兩路 FIFO slot 串接 yt-dlp、FFmpeg 並完整釋放', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-live-pipeline-'));
    const binaryPath = path.join(root, 'yt-dlp');
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(`${binaryPath}.update.json`, JSON.stringify({ lastCheckedAt: Date.now() }));
    const calls = [];
    setProcessManager({
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        spawnStreaming(command, args) {
            const handle = fakeStreamingHandle();
            calls.push({ command, args, handle });
            return handle;
        }
    });
    t.after(() => {
        setProcessManager(null);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const track = prepareLiveTrack({
        id: 'live', title: 'Live', url: 'https://youtu.be/live', channel: 'Channel',
        duration: null, isLive: true, liveStatus: 'is_live', playbackType: 'live',
        provider: 'youtube', requestedBy: 'user'
    });

    const first = await startLivePipeline(track, { binaryPath, maxConcurrentLiveStreams: 2, volumePercent: 20 });
    const second = await startLivePipeline(track, { binaryPath, maxConcurrentLiveStreams: 2, volumePercent: 20 });
    const thirdPromise = startLivePipeline(track, { binaryPath, maxConcurrentLiveStreams: 2, volumePercent: 20 });
    assert.deepEqual(getLiveConcurrencyStateForTests(), { active: 2, waiting: 1 });
    assert.equal(calls.length, 4);
    assert.equal(calls[0].args.includes('--no-live-from-start'), true);
    assert.equal(calls[0].args.includes('-o'), true);
    assert.equal(calls[1].command, ffmpegPath);
    assert.equal(calls[1].args.includes('volume=0.2'), true);
    assert.equal(calls[1].args.includes('libopus'), true);

    const piped = new Promise(resolve => calls[1].handle.stdin.once('data', resolve));
    calls[0].handle.stdout.write('media-bytes');
    assert.equal((await piped).toString(), 'media-bytes');
    assert.equal(first.audioStream, calls[1].handle.stdout);

    await first.stop(new Error('release first'));
    await assert.rejects(first.completion, /release first/);
    const third = await thirdPromise;
    assert.deepEqual(getLiveConcurrencyStateForTests(), { active: 2, waiting: 0 });
    assert.equal(calls.length, 6);

    await Promise.all([second.stop(new Error('release second')), third.stop(new Error('release third'))]);
    await Promise.allSettled([second.completion, third.completion]);
    assert.deepEqual(getLiveConcurrencyStateForTests(), { active: 0, waiting: 0 });
});

test('Bilibili 單片、多 P、指定分 P 與展開上限皆使用受控 yt-dlp 流程', async t => {
    const multiUrl = 'https://www.bilibili.com/video/BV1xx411c7mD';
    const singleUrl = 'https://www.bilibili.com/video/BV1ab411c7mD';
    const interactiveUrl = 'https://www.bilibili.com/video/BV1cd411c7mD';
    const calls = [];
    const binaryPath = installFakeYtDlp(t, async (_command, args) => {
        calls.push(args);
        const query = args.at(-1);
        if (args.includes('--flat-playlist')) {
            if (query === singleUrl) {
                return { code: 0, stderr: '', stdout: JSON.stringify({
                    id: 'single', title: 'Single', webpage_url: singleUrl,
                    uploader: 'Uploader', upload_date: '20250101', duration: 120
                }) };
            }
            if (query === interactiveUrl) {
                return { code: 0, stderr: '', stdout: JSON.stringify({ entries: [{ id: 'branch-1' }] }) };
            }
            return { code: 0, stderr: '', stdout: JSON.stringify({
                entries: [1, 2, 3].map(part => ({
                    id: `p${part}`, url: `${multiUrl}?p=${part}`
                }))
            }) };
        }
        const part = new URL(query).searchParams.get('p') || '1';
        return { code: 0, stderr: '', stdout: JSON.stringify({
            id: `part-${part}`, title: `Part ${part}`, webpage_url: query,
            uploader: 'Uploader', upload_date: '20250101', duration: 120
        }) };
    });
    const options = {
        binaryPath, updateHours: 24, allowPlaylists: true, maxPlaylistTracks: 2,
        maxDurationSeconds: 7200, minDurationSeconds: 0
    };

    const multi = await extractTracks(multiUrl, 'user', options);
    assert.deepEqual(multi.map(track => track.url), [`${multiUrl}?p=1`, `${multiUrl}?p=2`]);
    assert.equal(multi.every(track => track.requestedBy === 'user'), true);

    const single = await extractTracks(singleUrl, 'user', options);
    assert.equal(single.length, 1);
    assert.equal(single[0].url, singleUrl);

    const callsBeforeExplicitPart = calls.length;
    const explicitPart = await extractTracks(`${multiUrl}?p=3`, 'user', { ...options, allowPlaylists: false });
    assert.equal(explicitPart[0].url, `${multiUrl}?p=3`);
    assert.equal(calls.slice(callsBeforeExplicitPart).some(args => args.includes('--flat-playlist')), false);

    await assert.rejects(
        extractTracks(multiUrl, 'user', { ...options, allowPlaylists: false }),
        /不允許點播 Bilibili 多 P/
    );
    await assert.rejects(extractTracks(interactiveUrl, 'user', options), /不是受支援的多 P/);
});
