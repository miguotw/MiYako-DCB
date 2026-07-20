const fs = require('fs');
/**
 * yt-dlp/ffmpeg 外部程序管理器。
 * 負責二進位下載與更新、metadata 抽取、播放清單展開、音訊下載及暫存清理。
 * extractor 類錯誤會強制更新 yt-dlp 後重試一次；私人影片、網路或輸入錯誤不重試。
 */
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const ffmpegPath = require('ffmpeg-static');
const { http } = require('../core/http');
const { PROJECT_ROOT } = require('../core/config');
const {
    isBilibiliShortUrl, musicValidationError, toYtDlpQuery, normalizeTrack,
    validateBilibiliUrl, validateMusicUrl, validateTrack, validateYouTubeUrl
} = require('./musicHelpers');

const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
let updatePromise = null;
let processManager = null;
let activeYtDlpProcesses = 0;
const ytDlpWaiters = [];
const protectedCachePaths = new Set();
const MAX_YTDLP_PROCESSES = 2;
const MAX_BILIBILI_REDIRECTS = 3;

const BINARY_PATH = path.join(PROJECT_ROOT, 'runtime', 'bin', 'yt-dlp');
const CACHE_DIRECTORY = path.join(PROJECT_ROOT, 'runtime', 'cache', 'music');

/** Runtime 注入集中程序管理器，確保 timeout、取消與關機都能終止完整程序樹。 */
function setProcessManager(manager) {
    if (manager == null) {
        processManager = null;
        return;
    }
    if (!manager || typeof manager.run !== 'function') throw new TypeError('processManager 必須提供 run。');
    processManager = manager;
}

/** 所有 yt-dlp 呼叫都忽略主機與使用者設定，避免部署環境偷偷擴大 extractor 或 proxy 行為。 */
function createYtDlpArgs(args) {
    return ['--ignore-config', ...args];
}

function resolveBinaryPath(overridePath) {
    return overridePath ? path.resolve(String(overridePath)) : BINARY_PATH;
}

/**
 * 將 spawn 包成 Promise，完整保留 stdout/stderr 供診斷，並以 timeout 強制終止
 * 不回應的子程序。args 必須是陣列，刻意不經 shell 以避免輸入注入。
 */
function runProcess(command, args, options = {}) {
    if (processManager) return processManager.run(command, args, options);
    return new Promise((resolve, reject) => {
        const {
            timeout = 30000, onStdout, onStderr, signal,
            maxStdoutBytes = 8 * 1024 * 1024, maxStderrBytes = 8 * 1024 * 1024,
            ...spawnOptions
        } = options;
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions,
            ...(process.platform === 'win32' ? {} : { detached: true })
        });
        const stdout = [];
        const stderr = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let cancelError = null;
        const terminate = error => {
            cancelError ||= error;
            try {
                if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
                else child.kill('SIGTERM');
            } catch {}
            setTimeout(() => {
                if (child.exitCode != null) return;
                try {
                    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
                    else child.kill('SIGKILL');
                } catch {}
            }, 3000).unref?.();
        };
        const timeoutTimer = setTimeout(() => {
            const error = new Error(`${command} 執行逾時。`);
            error.code = 'ETIMEDOUT';
            terminate(error);
        }, timeout);
        const abort = () => terminate(signal.reason || Object.assign(new Error('外部程序已取消。'), { code: 'ERR_CANCELED' }));
        signal?.addEventListener('abort', abort, { once: true });
        child.stdout?.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxStdoutBytes) return terminate(Object.assign(new Error('stdout 超過上限。'), { code: 'MAX_BUFFER' }));
            stdout.push(chunk); onStdout?.(chunk.toString());
        });
        child.stderr?.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes > maxStderrBytes) return terminate(Object.assign(new Error('stderr 超過上限。'), { code: 'MAX_BUFFER' }));
            stderr.push(chunk); onStderr?.(chunk.toString());
        });
        child.once('error', error => { clearTimeout(timeoutTimer); reject(error); });
        child.once('close', code => {
            clearTimeout(timeoutTimer);
            signal?.removeEventListener('abort', abort);
            const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
            if (cancelError) return reject(Object.assign(cancelError, result));
            if (code === 0) resolve(result);
            else reject(Object.assign(new Error(result.stderr.trim() || `${command} 結束，代碼 ${code}`), result));
        });
    });
}

async function acquireYtDlp(signal) {
    if (signal?.aborted) throw signal.reason || new Error('yt-dlp 工作已取消。');
    if (activeYtDlpProcesses < MAX_YTDLP_PROCESSES) {
        activeYtDlpProcesses += 1;
        return;
    }
    await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, abort: null };
        waiter.abort = () => {
            const index = ytDlpWaiters.indexOf(waiter);
            if (index >= 0) ytDlpWaiters.splice(index, 1);
            reject(signal.reason || new Error('yt-dlp 工作已取消。'));
        };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        ytDlpWaiters.push(waiter);
    });
}

function releaseYtDlp() {
    const waiter = ytDlpWaiters.shift();
    if (waiter) {
        waiter.signal?.removeEventListener('abort', waiter.abort);
        waiter.resolve();
        return;
    }
    activeYtDlpProcesses = Math.max(activeYtDlpProcesses - 1, 0);
}

async function runYtDlp(binaryPath, args, options = {}) {
    await acquireYtDlp(options.signal);
    try { return await runProcess(binaryPath, args, options); }
    finally { releaseYtDlp(); }
}

function getYtDlpConcurrencyStateForTests() {
    return { active: activeYtDlpProcesses, waiting: ytDlpWaiters.length };
}

/** 下載到 `.download` 後才原子 rename，避免未完成檔案被當成可執行檔。 */
async function downloadBinary(destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (process.platform !== 'win32') fs.chmodSync(path.dirname(destination), 0o700);
    const temporary = `${destination}.download`;
    try {
        const response = await http.get(DOWNLOAD_URL, { responseType: 'stream', maxRedirects: 5 });
        await pipeline(response.data, fs.createWriteStream(temporary, { mode: 0o755 }));
        fs.chmodSync(temporary, 0o755);
        fs.renameSync(temporary, destination);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}

function getMetadataPath(binaryPath) {
    return `${binaryPath}.update.json`;
}

function shouldCheckUpdate(binaryPath, intervalHours, now = Date.now()) {
    try {
        const metadata = JSON.parse(fs.readFileSync(getMetadataPath(binaryPath), 'utf8'));
        return now - Number(metadata.lastCheckedAt || 0) >= intervalHours * 3600000;
    } catch { return true; }
}

/**
 * 確保 yt-dlp 存在且未超過更新檢查間隔；updatePromise 合併同時發生的檢查，
 * 防止多個 guild 在啟動時一起下載或更新同一檔案。
 */
async function ensureYtDlp(options = {}, force = false) {
    if (updatePromise) return updatePromise;
    updatePromise = (async () => {
        const binaryPath = resolveBinaryPath(options.binaryPath);
        if (!fs.existsSync(binaryPath)) await downloadBinary(binaryPath);
        const intervalHours = Math.max(Number(options.updateHours) || 24, 1);
        if (force || shouldCheckUpdate(binaryPath, intervalHours)) {
            try { await runYtDlp(binaryPath, createYtDlpArgs(['-U']), { timeout: 120000, signal: options.signal }); }
            catch (error) {
                // 更新失敗時保留目前可執行版本；實際抽取仍會回報原始錯誤。
                if (!fs.existsSync(binaryPath)) throw error;
            }
            finally {
                fs.writeFileSync(getMetadataPath(binaryPath), JSON.stringify({ lastCheckedAt: Date.now() }, null, 2), { mode: 0o600 });
                if (process.platform !== 'win32') fs.chmodSync(getMetadataPath(binaryPath), 0o600);
            }
        }
        return binaryPath;
    })().finally(() => { updatePromise = null; });
    return updatePromise;
}

/** 只辨識「更新 extractor 可能解決」的錯誤，避免對永久錯誤做無效重試。 */
function isExtractorFailure(error) {
    const message = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
    if (/private video|video unavailable|members-only|sign in to confirm|unsupported url|timed out|network/.test(message)) return false;
    return /extract|signature|nsig|cipher|youtube said|requested format|unable to download video data: http error 403/.test(message);
}

/** 可預期的存取限制屬於輸入結果，不應建立系統事件或 ERROR 日誌。 */
function normalizeMediaError(error) {
    if (error?.code === 'MUSIC_VALIDATION') return error;
    const message = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
    if (/private|members.only|premium members|supporter.only|registered users|login required|log in|sign in|geo.?restrict|not available in your country|video unavailable|has been removed|does not exist/.test(message)) {
        return musicValidationError('此媒體無法公開存取，可能已失效、受地區限制或需要登入。');
    }
    return error;
}

function getResponseHeader(headers, name) {
    if (!headers) return undefined;
    if (typeof headers.get === 'function') return headers.get(name);
    return headers[name] ?? headers[name.toLowerCase()];
}

/**
 * b23.tv 必須先在應用層逐跳解析；遇到非官方目的地時，在送出下一個請求前拒絕，
 * 避免短網址或開放轉址繞過媒體 URL allowlist。
 */
async function resolveBilibiliShortUrl(input, options = {}) {
    const client = options.http;
    if (!client || typeof client.get !== 'function') throw new Error('解析 b23.tv 需要 HTTP client。');
    let current = validateBilibiliUrl(input);
    const visited = new Set();

    for (let redirects = 0; redirects < MAX_BILIBILI_REDIRECTS; redirects++) {
        if (visited.has(current)) throw musicValidationError('b23.tv 連結包含循環跳轉。');
        visited.add(current);
        let response;
        try {
            response = await client.get(current, {
                signal: options.signal,
                maxRedirects: 0,
                maxContentLength: 64 * 1024,
                maxBodyLength: 64 * 1024,
                validateStatus: status => status >= 200 && status < 400
            });
        } catch (error) {
            const status = Number(error?.response?.status);
            if (status >= 400 && status < 500) throw musicValidationError('b23.tv 連結已失效或無法存取。');
            throw error;
        }
        const status = Number(response?.status);
        const location = getResponseHeader(response?.headers, 'location');
        if ((status && (status < 300 || status >= 400)) || !location) {
            throw musicValidationError('b23.tv 未回傳有效的影片跳轉網址。');
        }

        let next;
        try { next = new URL(String(location), current).toString(); }
        catch { throw musicValidationError('b23.tv 回傳的跳轉網址格式不正確。'); }
        if (isBilibiliShortUrl(next)) {
            current = validateBilibiliUrl(next);
            continue;
        }
        return validateBilibiliUrl(next, { allowShort: false });
    }
    throw musicValidationError(`b23.tv 跳轉不可超過 ${MAX_BILIBILI_REDIRECTS} 次。`);
}

async function resolveMusicQuery(input, options = {}) {
    const descriptor = toYtDlpQuery(input);
    if (descriptor.source === 'bilibili' && isBilibiliShortUrl(descriptor.query)) {
        return { ...descriptor, query: await resolveBilibiliShortUrl(descriptor.query, options) };
    }
    return descriptor;
}

async function extractResolvedTrack(query, requestedBy, options = {}, retried = false) {
    const binaryPath = await ensureYtDlp(options);
    try {
        const result = await runYtDlp(binaryPath, createYtDlpArgs(['--dump-single-json', '--no-playlist', '--no-warnings', '--socket-timeout', '15', query]), { timeout: 45000, signal: options.signal });
        const data = JSON.parse(result.stdout);
        const item = data.entries?.[0] || data;
        return validateTrack(normalizeTrack(item, requestedBy), options.maxDurationSeconds, options.minDurationSeconds);
    } catch (error) {
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return extractResolvedTrack(query, requestedBy, options, true);
        }
        throw normalizeMediaError(error);
    }
}

async function extractTrack(input, requestedBy, options = {}) {
    const { query } = await resolveMusicQuery(input, options);
    return extractResolvedTrack(query, requestedBy, options);
}

function isYouTubePlaylist(input) {
    try {
        const url = new URL(validateYouTubeUrl(input));
        return url.pathname.includes('/playlist') || url.searchParams.has('list');
    } catch { return false; }
}

function getYouTubePlaylistEntryURL(entry) {
    const value = entry?.webpage_url || entry?.original_url || entry?.url || entry?.id;
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(value)}`;
}

async function extractYouTubePlaylist(input, requestedBy, options = {}, retried = false) {
    const binaryPath = await ensureYtDlp(options);
    try {
        const result = await runYtDlp(binaryPath, createYtDlpArgs([
            '--dump-single-json', '--flat-playlist', '--yes-playlist', '--no-warnings', '--socket-timeout', '15', validateYouTubeUrl(input)
        ]), { timeout: 60000, signal: options.signal });
        const data = JSON.parse(result.stdout);
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (!entries.length) throw musicValidationError('播放清單中沒有可加入的曲目。');
        const limit = Math.min(Math.max(Number(options.maxPlaylistTracks) || 25, 1), 100);
        const tracks = [];
        for (const entry of entries.slice(0, limit)) {
            const url = getYouTubePlaylistEntryURL(entry);
            if (!url) throw musicValidationError('播放清單包含無法解析的曲目。');
            tracks.push(await extractResolvedTrack(validateYouTubeUrl(url), requestedBy, options));
        }
        return tracks;
    } catch (error) {
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return extractYouTubePlaylist(input, requestedBy, options, true);
        }
        throw normalizeMediaError(error);
    }
}

function getBilibiliEntryURL(entry, input) {
    const inputUrl = new URL(validateBilibiliUrl(input, { allowShort: false }));
    const candidates = [entry?.webpage_url, entry?.original_url, entry?.url];
    for (const value of candidates) {
        if (!/^https?:\/\//i.test(String(value || ''))) continue;
        try {
            const candidate = new URL(validateBilibiliUrl(value, { allowShort: false }));
            if (candidate.pathname === inputUrl.pathname && candidate.searchParams.has('p')) return candidate.toString();
        }
        catch {}
    }
    throw musicValidationError('Bilibili 播放項目不是受支援的多 P 內容。');
}

async function extractBilibiliTracks(input, requestedBy, options = {}, retried = false) {
    const binaryPath = await ensureYtDlp(options);
    try {
        const result = await runYtDlp(binaryPath, createYtDlpArgs([
            '--dump-single-json', '--flat-playlist', '--yes-playlist', '--no-warnings', '--socket-timeout', '15', input
        ]), { timeout: 60000, signal: options.signal });
        const data = JSON.parse(result.stdout);
        if (!Array.isArray(data.entries)) {
            return [validateTrack(normalizeTrack(data, requestedBy), options.maxDurationSeconds, options.minDurationSeconds)];
        }
        if (!data.entries.length) throw musicValidationError('Bilibili 多 P 影片中沒有可加入的內容。');
        if (data.entries.length > 1 && !options.allowPlaylists) {
            throw musicValidationError('目前設定不允許點播 Bilibili 多 P 影片。');
        }

        const limit = Math.min(Math.max(Number(options.maxPlaylistTracks) || 25, 1), 100);
        const tracks = [];
        for (const entry of data.entries.slice(0, limit)) {
            const url = getBilibiliEntryURL(entry, input);
            tracks.push(await extractResolvedTrack(url, requestedBy, options));
        }
        return tracks;
    } catch (error) {
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return extractBilibiliTracks(input, requestedBy, options, true);
        }
        throw normalizeMediaError(error);
    }
}

/** 單曲直接抽取；YouTube 播放清單與 Bilibili 多 P 先 flat 展開。 */
async function extractTracks(input, requestedBy, options = {}) {
    const descriptor = await resolveMusicQuery(input, options);
    if (descriptor.source === 'youtube') {
        const playlistInput = descriptor.isUrl && isYouTubePlaylist(descriptor.query);
        if (playlistInput && !options.allowPlaylists) throw musicValidationError('目前設定不允許點播 YouTube 播放清單。');
        return playlistInput
            ? extractYouTubePlaylist(descriptor.query, requestedBy, options)
            : [await extractResolvedTrack(descriptor.query, requestedBy, options)];
    }

    const url = new URL(validateBilibiliUrl(descriptor.query, { allowShort: false }));
    if (url.searchParams.has('p')) return [await extractResolvedTrack(url.toString(), requestedBy, options)];
    return extractBilibiliTracks(url.toString(), requestedBy, options);
}

function ensureCacheDirectory() {
    fs.mkdirSync(CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(CACHE_DIRECTORY, 0o700);
}

function cacheFiles() {
    ensureCacheDirectory();
    return fs.readdirSync(CACHE_DIRECTORY, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => {
            const filePath = path.join(CACHE_DIRECTORY, entry.name);
            const stat = fs.statSync(filePath);
            return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
        });
}

function setProtectedCachePaths(paths = []) {
    protectedCachePaths.clear();
    for (const value of paths) {
        if (!value) continue;
        const resolved = path.resolve(value);
        if (resolved.startsWith(`${CACHE_DIRECTORY}${path.sep}`)) protectedCachePaths.add(resolved);
    }
}

function cleanupOrphanedCache(referencedPaths = []) {
    setProtectedCachePaths(referencedPaths);
    for (const file of cacheFiles()) {
        if (!protectedCachePaths.has(file.path)) fs.rmSync(file.path, { force: true });
    }
}

function ensureCacheCapacity(options = {}, requiredBytes = 0) {
    const maximum = Math.max(Number(options.maxCacheSizeBytes) || 2 * 1024 ** 3, 1);
    const files = cacheFiles();
    let used = files.reduce((sum, item) => sum + item.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (used + requiredBytes <= maximum) break;
        if (protectedCachePaths.has(file.path)) continue;
        fs.rmSync(file.path, { force: true });
        used -= file.size;
    }
    if (used + requiredBytes > maximum) throw musicValidationError('音樂快取空間已達上限，且現有檔案仍被播放序列使用。');
}

/**
 * 下載最佳音訊到唯一 cache 路徑；進度從 stderr 解析。
 * 失敗時會清除同 UUID 的殘檔，成功後由播放器在不再需要時呼叫 deleteTrackFile。
 */
async function downloadTrack(track, options = {}, onProgress = null, retried = false) {
    track.url = validateMusicUrl(track?.url, { allowShort: false });
    const binaryPath = await ensureYtDlp(options);
    ensureCacheDirectory();
    const maximumFileBytes = Math.max(Number(options.maxFileSizeBytes) || 256 * 1024 ** 2, 1);
    ensureCacheCapacity(options, maximumFileBytes);
    const outputTemplate = path.join(CACHE_DIRECTORY, `${crypto.randomUUID()}.%(ext)s`);
    try {
        const result = await runYtDlp(binaryPath, createYtDlpArgs([
            '--no-playlist', '--no-warnings', '--newline', '--progress', '--socket-timeout', '15',
            '--max-filesize', String(maximumFileBytes),
            '--ffmpeg-location', ffmpegPath, '-f', 'bestaudio/best',
            '--print', 'after_move:filepath', '-o', outputTemplate, track.url
        ]), {
            timeout: 15 * 60 * 1000,
            signal: options.signal,
            onStderr: output => {
                const matches = [...output.matchAll(/\[download\]\s+([\d.]+)%/g)];
                if (matches.length) onProgress?.(Math.min(Number(matches.at(-1)[1]) || 0, 100));
            }
        });
        const localPath = result.stdout.trim().split(/\r?\n/).at(-1);
        if (!localPath || !fs.existsSync(localPath)) throw new Error('yt-dlp 未產生可播放的音訊檔案。');
        const stat = fs.statSync(localPath);
        if (stat.size > maximumFileBytes) throw musicValidationError('下載的音訊檔案超過設定上限。');
        if (process.platform !== 'win32') fs.chmodSync(localPath, 0o600);
        protectedCachePaths.add(path.resolve(localPath));
        ensureCacheCapacity(options, 0);
        return { ...track, localPath, queueID: crypto.randomUUID() };
    } catch (error) {
        for (const file of fs.readdirSync(CACHE_DIRECTORY)) {
            if (file.startsWith(path.basename(outputTemplate).split('.')[0])) fs.rmSync(path.join(CACHE_DIRECTORY, file), { force: true });
        }
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return downloadTrack(track, options, onProgress, true);
        }
        throw normalizeMediaError(error);
    }
}

function deleteTrackFile(track) {
    if (!track?.localPath) return;
    protectedCachePaths.delete(path.resolve(track.localPath));
    try { fs.rmSync(track.localPath, { force: true }); } catch {}
    track.localPath = null;
}

async function checkFfmpeg() {
    if (!ffmpegPath) throw new Error('ffmpeg-static 不支援目前的平台或架構。');
    if (!fs.existsSync(ffmpegPath)) throw new Error(`找不到 ffmpeg-static 執行檔：${ffmpegPath}`);
    try {
        fs.accessSync(ffmpegPath, fs.constants.X_OK);
    } catch {
        throw new Error(`ffmpeg-static 執行檔不可執行：${ffmpegPath}`);
    }
    return runProcess(ffmpegPath, ['-version'], { timeout: 10000 });
}

module.exports = {
    ffmpegPath, CACHE_DIRECTORY, createYtDlpArgs, resolveBinaryPath, runProcess, runYtDlp,
    setProcessManager, shouldCheckUpdate, ensureYtDlp, isExtractorFailure, normalizeMediaError,
    resolveBilibiliShortUrl, extractTrack,
    extractTracks, downloadTrack, deleteTrackFile, checkFfmpeg,
    setProtectedCachePaths, cleanupOrphanedCache, ensureCacheCapacity,
    getYtDlpConcurrencyStateForTests
};
