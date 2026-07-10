const MAX_QUEUE_PAGE_SIZE = 10;

function toYtDlpQuery(input) {
    const value = String(input || '').trim();
    if (!value) throw new Error('請輸入 YouTube 連結或歌曲標題。');
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        return { query: value, isUrl: true };
    } catch {
        return { query: `ytsearch1:${value}`, isUrl: false };
    }
}

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

function validateTrack(track, maxDurationSeconds = 7200, minDurationSeconds = 0) {
    if (track.isLive) throw new Error('目前不支援直播內容。');
    if (!track.url) throw new Error('無法取得此媒體的播放網址。');
    if (maxDurationSeconds > 0 && track.duration > maxDurationSeconds) {
        throw new Error(`歌曲長度不可超過 ${formatDuration(maxDurationSeconds)}。`);
    }
    if (minDurationSeconds > 0 && track.duration < minDurationSeconds) {
        throw new Error(`歌曲長度不可短於 ${formatDuration(minDurationSeconds)}。`);
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

module.exports = { MAX_QUEUE_PAGE_SIZE, toYtDlpQuery, normalizeTrack, validateTrack, formatDuration, getUploadYear, createProgressBar, paginateQueue };
