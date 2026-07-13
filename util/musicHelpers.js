const MAX_QUEUE_PAGE_SIZE = 10;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
/**
 * 音樂資料的純函式集合，不持有 Discord 或播放器狀態，適合單獨測試。
 * yt-dlp 原始 metadata 會先 normalize、再 validate，通過後才可進入下載序列。
 */

/** 建立可安全顯示給點播者的音樂輸入／狀態錯誤。 */
function musicValidationError(message) {
    return Object.assign(new Error(message), { code: 'MUSIC_VALIDATION' });
}

/** 區分可公開的音樂驗證錯誤與必須隱藏細節的系統例外。 */
function isMusicValidationError(error) {
    return error?.code === 'MUSIC_VALIDATION';
}

/**
 * 驗證可交給 yt-dlp 的 YouTube URL。完整 host/path allowlist 可阻止 yt-dlp 被當成
 * 任意 URL 下載器，`URL` 解析後再比對也能拒絕 userinfo 與相似網域混淆。
 */
function validateYouTubeUrl(input) {
    let url;
    try { url = new URL(String(input || '').trim()); }
    catch { throw musicValidationError('只接受 YouTube 連結或歌曲標題。'); }

    if (url.protocol !== 'https:') throw musicValidationError('YouTube 連結必須使用 HTTPS。');
    if (url.username || url.password || url.port) throw musicValidationError('YouTube 連結不可包含帳密或自訂連接埠。');
    if (!YOUTUBE_HOSTS.has(url.hostname)) throw musicValidationError('只接受 YouTube 或 youtu.be 連結。');

    const pathSegments = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'youtu.be') {
        if (pathSegments.length !== 1) throw musicValidationError('youtu.be 連結必須直接指定一部影片。');
        return url.toString();
    }

    const isWatch = url.pathname === '/watch' && Boolean(url.searchParams.get('v'));
    const isPlaylist = url.pathname === '/playlist' && Boolean(url.searchParams.get('list'));
    const isDirectMedia = pathSegments.length === 2
        && ['shorts', 'live', 'embed'].includes(pathSegments[0])
        && Boolean(pathSegments[1]);
    if (!isWatch && !isPlaylist && !isDirectMedia) {
        throw musicValidationError('不支援這種 YouTube 連結格式。');
    }
    return url.toString();
}

/** URL 通過精確 allowlist 後交給 yt-dlp；其餘文字轉為只取第一筆的 YouTube 搜尋語法。 */
function toYtDlpQuery(input) {
    const value = String(input || '').trim();
    if (!value) throw musicValidationError('請輸入 YouTube 連結或歌曲標題。');
    try {
        new URL(value);
        return { query: validateYouTubeUrl(value), isUrl: true };
    } catch (error) {
        if (/^[a-z][a-z\d+.-]*:/i.test(value)) throw error;
        return { query: `ytsearch1:${value}`, isUrl: false };
    }
}

/** 將 yt-dlp 多種 extractor 回應收斂成播放器使用的固定 Track shape。 */
function normalizeTrack(data, requestedBy = null) {
    const duration = Number(data?.duration || 0);
    const isLive = Boolean(data?.is_live) || data?.live_status === 'is_live' || duration <= 0;
    return {
        id: String(data?.id || ''),
        title: String(data?.title || '未知標題'),
        url: String(data?.webpage_url || data?.original_url || data?.url || ''),
        channel: String(data?.channel || data?.uploader || '未知藝人'),
        uploadDate: /^\d{8}$/.test(String(data?.upload_date || '')) ? String(data.upload_date) : null,
        thumbnail: data?.thumbnail || data?.thumbnails?.at?.(-1)?.url || null,
        duration,
        isLive,
        requestedBy
    };
}

/** 拒絕直播、缺少 URL 及超出設定長度範圍的媒體。 */
function validateTrack(track, maxDurationSeconds = 7200, minDurationSeconds = 0) {
    if (track.isLive) throw musicValidationError('目前不支援直播內容。');
    if (!track.url) throw musicValidationError('無法取得此媒體的播放網址。');
    track.url = validateYouTubeUrl(track.url);
    if (maxDurationSeconds > 0 && track.duration > maxDurationSeconds) {
        throw musicValidationError(`歌曲長度不可超過 ${formatDuration(maxDurationSeconds)}。`);
    }
    if (minDurationSeconds > 0 && track.duration < minDurationSeconds) {
        throw musicValidationError(`歌曲長度不可短於 ${formatDuration(minDurationSeconds)}。`);
    }
    return track;
}

function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function getUploadYear(uploadDate) {
    return uploadDate ? uploadDate.slice(0, 4) : '未知年份';
}

/** 回傳固定字元寬度的文字進度條；● 代表目前播放位置。 */
function createProgressBar(elapsedSeconds, durationSeconds, width = 16) {
    const ratio = durationSeconds > 0 ? Math.min(Math.max(elapsedSeconds / durationSeconds, 0), 1) : 0;
    const position = Math.min(Math.floor(ratio * width), width - 1);
    return Array.from({ length: width }, (_, index) => index === position ? '●' : index < position ? '━' : '─').join('');
}

function paginateQueue(tracks, page = 0, pageSize = MAX_QUEUE_PAGE_SIZE) {
    const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
    return { items: tracks.slice(safePage * pageSize, (safePage + 1) * pageSize), page: safePage, totalPages };
}

module.exports = {
    MAX_QUEUE_PAGE_SIZE,
    formatDuration,
    getUploadYear,
    isMusicValidationError,
    musicValidationError,
    normalizeTrack,
    paginateQueue,
    createProgressBar,
    toYtDlpQuery,
    validateTrack,
    validateYouTubeUrl
};
