const fs = require('fs');
/**
 * yt-dlp/ffmpeg 外部程序管理器。
 * 負責二進位下載與更新、metadata 抽取、播放清單展開、音訊下載及暫存清理。
 * extractor 類錯誤會強制更新 yt-dlp 後重試一次；私人影片、網路或輸入錯誤不重試。
 */
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');
const { toYtDlpQuery, normalizeTrack, validateTrack } = require('./musicHelpers');

const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
let updatePromise = null;

function resolveBinaryPath(value = 'assets/music/yt-dlp') {
    return path.resolve(process.cwd(), value);
}

/**
 * 將 spawn 包成 Promise，完整保留 stdout/stderr 供診斷，並以 timeout 強制終止
 * 不回應的子程序。args 必須是陣列，刻意不經 shell 以避免輸入注入。
 */
function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { timeout = 30000, onStdout, onStderr, ...spawnOptions } = options;
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
        const stdout = [];
        const stderr = [];
        const timeoutTimer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout?.on('data', chunk => { stdout.push(chunk); onStdout?.(chunk.toString()); });
        child.stderr?.on('data', chunk => { stderr.push(chunk); onStderr?.(chunk.toString()); });
        child.once('error', error => { clearTimeout(timeoutTimer); reject(error); });
        child.once('close', code => {
            clearTimeout(timeoutTimer);
            const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
            if (code === 0) resolve(result);
            else reject(Object.assign(new Error(result.stderr.trim() || `${command} 結束，代碼 ${code}`), result));
        });
    });
}

/** 下載到 `.download` 後才原子 rename，避免未完成檔案被當成可執行檔。 */
function downloadBinary(destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.download`;
    return new Promise((resolve, reject) => {
        const request = url => https.get(url, response => {
            if ([301, 302, 307, 308].includes(response.statusCode)) return request(new URL(response.headers.location, url));
            if (response.statusCode !== 200) return reject(new Error(`下載 yt-dlp 失敗：HTTP ${response.statusCode}`));
            const output = fs.createWriteStream(temporary, { mode: 0o755 });
            response.pipe(output);
            output.once('finish', () => {
                output.close();
                fs.chmodSync(temporary, 0o755);
                fs.renameSync(temporary, destination);
                resolve();
            });
            output.once('error', reject);
        }).once('error', reject);
        request(DOWNLOAD_URL);
    }).finally(() => { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); });
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
            try { await runProcess(binaryPath, ['-U'], { timeout: 120000 }); }
            catch (error) {
                // 更新失敗時保留目前可執行版本；實際抽取仍會回報原始錯誤。
                if (!fs.existsSync(binaryPath)) throw error;
            }
            finally {
                fs.writeFileSync(getMetadataPath(binaryPath), JSON.stringify({ lastCheckedAt: Date.now() }, null, 2));
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

async function extractTrack(input, requestedBy, options = {}, retried = false) {
    const binaryPath = await ensureYtDlp(options);
    const { query } = toYtDlpQuery(input);
    try {
        const result = await runProcess(binaryPath, ['--dump-single-json', '--no-playlist', '--no-warnings', '--socket-timeout', '15', query], { timeout: 45000 });
        const data = JSON.parse(result.stdout);
        const item = data.entries?.[0] || data;
        return validateTrack(normalizeTrack(item, requestedBy), options.maxDurationSeconds, options.minDurationSeconds);
    } catch (error) {
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return extractTrack(input, requestedBy, options, true);
        }
        throw error;
    }
}

function isPlaylistInput(input) {
    try {
        const url = new URL(String(input).trim());
        return url.pathname.includes('/playlist') || url.searchParams.has('list');
    } catch { return false; }
}

function getPlaylistEntryURL(entry) {
    const value = entry?.webpage_url || entry?.original_url || entry?.url || entry?.id;
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    return `https://www.youtube.com/watch?v=${encodeURIComponent(value)}`;
}

/** 單曲直接抽取；播放清單先 flat 展開，再逐曲取得完整 metadata 與驗證。 */
async function extractTracks(input, requestedBy, options = {}, retried = false) {
    const playlistInput = isPlaylistInput(input);
    if (playlistInput && !options.allowPlaylists) throw new Error('目前設定不允許點播 YouTube 播放清單。');
    if (!playlistInput) return [await extractTrack(input, requestedBy, options)];
    const binaryPath = await ensureYtDlp(options);
    try {
        const result = await runProcess(binaryPath, [
            '--dump-single-json', '--flat-playlist', '--yes-playlist', '--no-warnings', '--socket-timeout', '15', String(input).trim()
        ], { timeout: 60000 });
        const data = JSON.parse(result.stdout);
        const entries = Array.isArray(data.entries) ? data.entries : [];
        if (!entries.length) throw new Error('播放清單中沒有可加入的曲目。');
        const limit = Math.min(Math.max(Number(options.maxPlaylistTracks) || 25, 1), 100);
        const tracks = [];
        for (const entry of entries.slice(0, limit)) {
            const url = getPlaylistEntryURL(entry);
            if (!url) throw new Error('播放清單包含無法解析的曲目。');
            tracks.push(await extractTrack(url, requestedBy, options));
        }
        return tracks;
    } catch (error) {
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return extractTracks(input, requestedBy, options, true);
        }
        throw error;
    }
}

/**
 * 下載最佳音訊到唯一 cache 路徑；進度從 stderr 解析。
 * 失敗時會清除同 UUID 的殘檔，成功後由播放器在不再需要時呼叫 deleteTrackFile。
 */
async function downloadTrack(track, options = {}, onProgress = null, retried = false) {
    const binaryPath = await ensureYtDlp(options);
    const cacheDirectory = path.join(process.cwd(), 'assets', 'music', 'cache');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const outputTemplate = path.join(cacheDirectory, `${crypto.randomUUID()}.%(ext)s`);
    try {
        const result = await runProcess(binaryPath, [
            '--no-playlist', '--no-warnings', '--newline', '--progress', '--socket-timeout', '15',
            '--ffmpeg-location', ffmpegPath, '-f', 'bestaudio/best',
            '--print', 'after_move:filepath', '-o', outputTemplate, track.url
        ], {
            timeout: 15 * 60 * 1000,
            onStderr: output => {
                const matches = [...output.matchAll(/\[download\]\s+([\d.]+)%/g)];
                if (matches.length) onProgress?.(Math.min(Number(matches.at(-1)[1]) || 0, 100));
            }
        });
        const localPath = result.stdout.trim().split(/\r?\n/).at(-1);
        if (!localPath || !fs.existsSync(localPath)) throw new Error('yt-dlp 未產生可播放的音訊檔案。');
        return { ...track, localPath, queueID: crypto.randomUUID() };
    } catch (error) {
        for (const file of fs.readdirSync(cacheDirectory)) {
            if (file.startsWith(path.basename(outputTemplate).split('.')[0])) fs.rmSync(path.join(cacheDirectory, file), { force: true });
        }
        if (!retried && isExtractorFailure(error)) {
            await ensureYtDlp(options, true);
            return downloadTrack(track, options, onProgress, true);
        }
        throw error;
    }
}

function deleteTrackFile(track) {
    if (!track?.localPath) return;
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

module.exports = { ffmpegPath, resolveBinaryPath, runProcess, shouldCheckUpdate, ensureYtDlp, isExtractorFailure, extractTrack, extractTracks, downloadTrack, deleteTrackFile, checkFfmpeg };
