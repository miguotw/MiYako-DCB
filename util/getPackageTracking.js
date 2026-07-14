const path = require('path');
/**
 * Track.TW API adapter、物流 record repository 與共用 Embed builder。
 *
 * 每位 Discord 使用者各有一個 `assets/packageTracking/<userID>.json`，避免不同使用者
 * 的面板互相看見資料。遠端 user_package_id 是 record 的主鍵；tracking number 只用於
 * 顯示與重複檢查。此模組使用同步檔案 I/O，呼叫端應避免高頻並行寫入同一使用者檔案。
 */
const fs = require('fs');
const { http } = require('../core/http');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
function createPackageTrackingTools(config) {
const configCommands = config.commands;

const PACKAGE_CONFIG = configCommands.packageTracking || {};
const DATA_DIR = path.join(process.cwd(), 'assets', 'packageTracking');
const API_BASE_URL = 'https://track.tw/api/v1';
const EMBED_COLOR = config.embed.color.default;
const EMBED_EMOJI = PACKAGE_CONFIG.emoji || '📦';
const DEFAULT_HISTORY_STATUS_MAX_LENGTH = 25;
const DEFAULT_ARCHIVE_AFTER_DAYS = 14;
const DEFAULT_CHECK_INTERVAL_MINUTES = 30;
const MS_PER_DAY = 86400000;
const MS_PER_MINUTE = 60000;

// 共用 Discord 元件 ---------------------------------------------------------

function createAddPackageButton(customId = 'package_panel_add') {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel('新增包裹')
        .setStyle(ButtonStyle.Success);
}

function createAddPackageRow(customId) {
    return new ActionRowBuilder().addComponents(createAddPackageButton(customId));
}

function createPackageActionButton(customId, label, style) {
    return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style);
}

/** 將包裹 ID 放入通知按鈕，使操作不依賴管理面板內的記憶體選取狀態。 */
function createScopedPackageCustomId(customId, record) {
    // 狀態訊息上的操作按鈕需要帶上包裹 ID，避免依賴管理面板的暫存選取狀態。
    return record?.userPackageID ? `${customId}:${record.userPackageID}` : customId;
}

function createPackageNotificationActionsRows(record) {
    // 物流狀態訊息上的新增按鈕使用 detached 模式，避免新增流程覆蓋原本的物流狀態訊息。
    return withAddPackageRow([
        new ActionRowBuilder().addComponents(
            createPackageActionButton(
                createScopedPackageCustomId('package_panel_refresh', record),
                '立即更新',
                ButtonStyle.Primary
            ),
            createPackageActionButton(
                createScopedPackageCustomId('package_panel_note', record),
                '修改備註',
                ButtonStyle.Secondary
            ),
            createPackageActionButton(
                createScopedPackageCustomId('package_panel_archive', record),
                '封存',
                ButtonStyle.Secondary
            )
        )
    ], 'package_panel_add:detached');
}

function withAddPackageRow(rows = [], addPackageCustomId = 'package_panel_add') {
    const outputRows = [...rows];
    const lastRow = outputRows[outputRows.length - 1];
    const lastRowComponents = lastRow?.components || [];
    const canAppendToLastRow = lastRowComponents.length > 0 &&
        lastRowComponents.length < 5 &&
        lastRowComponents.every(component => component.data?.type === 2);

    if (canAppendToLastRow) {
        // Discord 一列最多 5 個按鈕；能塞進既有按鈕列時就直接補在最後。
        lastRow.addComponents(createAddPackageButton(addPackageCustomId));
        return outputRows;
    }

    return [...outputRows, createAddPackageRow(addPackageCustomId)];
}

// 本機 repository -----------------------------------------------------------

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/** 損壞或不存在的使用者檔視為空資料，讓單一檔案不阻止整個 Bot 啟動。 */
function readPackageFile(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return { packages: Array.isArray(data.packages) ? data.packages : [] };
    } catch {
        return { packages: [] };
    }
}

function writePackageFile(filePath, store) {
    ensureDataDir();
    fs.writeFileSync(filePath, JSON.stringify({ packages: store.packages || [] }, null, 2), 'utf8');
}

/** 僅接受 Discord snowflake 的數字字串，防止路徑穿越。 */
function getUserPackageFile(userID) {
    const normalizedUserID = String(userID || '').trim();
    if (!/^\d+$/.test(normalizedUserID)) {
        throw new Error('無效的使用者 ID。');
    }

    return path.join(DATA_DIR, `${normalizedUserID}.json`);
}

function isUserPackageFile(fileName) {
    return /^\d+\.json$/.test(fileName);
}

function loadUserPackageStore(userID) {
    ensureDataDir();

    const userFile = getUserPackageFile(userID);
    if (!fs.existsSync(userFile)) return { packages: [] };
    return readPackageFile(userFile);
}

function saveUserPackageStore(userID, store) {
    const userFile = getUserPackageFile(userID);
    writePackageFile(userFile, store);
}

function getUserPackageStores() {
    ensureDataDir();

    return fs.readdirSync(DATA_DIR)
        .filter(isUserPackageFile)
        .map(fileName => {
            const userID = path.basename(fileName, '.json');
            return {
                userID,
                store: readPackageFile(path.join(DATA_DIR, fileName))
            };
        });
}

// 設定與 Track.TW HTTP adapter ---------------------------------------------

function getTrackTwToken() {
    const token = String(PACKAGE_CONFIG.trackTwToken || '').trim();
    if (!token) {
        throw new Error('Track.TW API Token 尚未設定。');
    }
    return token;
}

function hasTrackTwToken() {
    return String(PACKAGE_CONFIG.trackTwToken || '').trim() !== '';
}

function getHistoryStatusMaxLength() {
    return Math.max(Number(PACKAGE_CONFIG.historyStatusMaxLength) || DEFAULT_HISTORY_STATUS_MAX_LENGTH, 1);
}

function getArchiveAfterDays() {
    const days = Number(PACKAGE_CONFIG.archiveAfterDays);
    if (days > 0) return days;

    const archiveAfterMilliseconds = Number(PACKAGE_CONFIG.archiveAfter);
    if (archiveAfterMilliseconds > 0) return Math.max(archiveAfterMilliseconds / MS_PER_DAY, 1 / 1440);

    return DEFAULT_ARCHIVE_AFTER_DAYS;
}

function getPackageTrackingConfig() {
    const archiveAfterDays = getArchiveAfterDays();

    return {
        emoji: EMBED_EMOJI,
        checkInterval: Math.max((Number(PACKAGE_CONFIG.checkInterval) || DEFAULT_CHECK_INTERVAL_MINUTES) * MS_PER_MINUTE, MS_PER_MINUTE),
        historyStatusMaxLength: getHistoryStatusMaxLength(),
        archiveAfterDays,
        archiveAfter: Math.max(archiveAfterDays * MS_PER_DAY, 60000)
    };
}

function createTrackTwRequestConfig() {
    return { headers: { Authorization: `Bearer ${getTrackTwToken()}` } };
}

async function getAvailableCarriers() {
    const response = await http.get(`${API_BASE_URL}/carrier/available`, createTrackTwRequestConfig());
    return response.data || [];
}

async function detectCarrier(trackingNumbers) {
    const response = await http.post(`${API_BASE_URL}/carrier/detect`, {
        tracking_numbers: trackingNumbers
    }, createTrackTwRequestConfig());
    return response.data.carriers || [];
}

async function importPackage(carrierID, trackingNumber, note = '', extraFields = null) {
    const trackingValue = note ? `${trackingNumber},${note.replace(/,/g, '，')}` : trackingNumber;
    const body = {
        carrier_id: carrierID,
        tracking_number: [trackingValue],
        notify_state: 'inactive'
    };

    if (extraFields) {
        body.extra_fields = {
            [trackingNumber]: extraFields
        };
    }

    const response = await http.post(`${API_BASE_URL}/package/import`, body, createTrackTwRequestConfig());
    return response.data;
}

async function trackingPackage(userPackageID, { signal } = {}) {
    const response = await http.get(`${API_BASE_URL}/package/tracking/${encodeURIComponent(userPackageID)}`, {
        ...createTrackTwRequestConfig(),
        signal
    });
    return response.data;
}

async function changePackageState(userPackageID, state) {
    const response = await http.patch(
        `${API_BASE_URL}/package/state/${encodeURIComponent(userPackageID)}/${encodeURIComponent(state)}`,
        undefined,
        createTrackTwRequestConfig()
    );
    return response.data;
}

function findCarrier(carriers, carrierID) {
    return carriers.find(carrier => carrier.id === carrierID);
}

function getLatestHistory(packageData) {
    const histories = Array.isArray(packageData?.package_history) ? packageData.package_history : [];
    if (!histories.length) return null;

    return histories
        .slice()
        .sort((a, b) => {
            const timeA = Number(a.time) || Date.parse(a.created_at || 0) / 1000 || 0;
            const timeB = Number(b.time) || Date.parse(b.created_at || 0) / 1000 || 0;
            return timeB - timeA;
        })[0];
}

/**
 * 將排序後的貨態歷史轉成穩定簽章，排程用它判斷是否真的出現新進度；
 * 不直接比較 API 回應，避免觀看數或非貨態欄位造成假更新。
 */
function createHistorySignature(packageData) {
    const latestHistory = getLatestHistory(packageData);
    if (!latestHistory) return 'no-history';

    return [
        latestHistory.status || '',
        latestHistory.delivery_stage || '',
        latestHistory.checkpoint_status || '',
        latestHistory.time || '',
        latestHistory.created_at || ''
    ].join('|');
}

function formatHistoryTime(history) {
    if (!history) return '未知';
    if (Number(history.time) > 0) return `<t:${history.time}:F>`;
    if (history.created_at) return `<t:${Math.floor(Date.parse(history.created_at) / 1000)}:F>`;
    return '未知';
}

function sanitizeHistoryText(text) {
    return String(text || '尚無貨態資料')
        .replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[|｜]/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim() || '尚無貨態資料';
}

function formatHistoryStatusText(text) {
    const maxLength = getHistoryStatusMaxLength();
    return text.length > maxLength
        ? `${text.slice(0, maxLength)}...`
        : text;
}

function formatHistoryLine(history) {
    if (!history) return '尚無貨態資料';
    return `${formatHistoryStatusText(sanitizeHistoryText(history.status))} | ${formatHistoryTime(history)}`.slice(0, 1024);
}

function getSortedHistories(packageData) {
    const histories = Array.isArray(packageData?.package_history) ? packageData.package_history : [];
    return histories
        .slice()
        .sort((a, b) => {
            const timeA = Number(a.time) || Date.parse(a.created_at || 0) / 1000 || 0;
            const timeB = Number(b.time) || Date.parse(b.created_at || 0) / 1000 || 0;
            return timeB - timeA;
        });
}

function formatRecordStatus(status) {
    if (status === 'active') return '追蹤中';
    if (status === 'archived') return '已封存';
    return status || '未知';
}

function formatArchiveAfterDays(days) {
    return Number.isInteger(days) ? String(days) : days.toFixed(1).replace(/\.0$/, '');
}

function getArchiveHintFooter() {
    return `${formatArchiveAfterDays(getArchiveAfterDays())} 天沒有更新將自動封存`;
}

// 顯示格式 ------------------------------------------------------------------

function createPackageEmbed(record, packageData, title = '包裹貨態') {
    const latestHistory = getLatestHistory(packageData);
    const historyLines = getSortedHistories(packageData)
        .slice(1, 11)
        .map(history => `- ${formatHistoryLine(history)}`);
    const carrierName = packageData?.carrier?.name || record.carrierName || '未知物流';
    const trackingNumber = packageData?.tracking_number || record.trackingNumber;
    const shortUrl = packageData?.short_url?.identifier ? `https://track.tw/u/${packageData.short_url.identifier}` : null;
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ ${title}`)
        .addFields(
            { name: '物流商', value: carrierName || '未知', inline: true },
            { name: '物流單號', value: `\`${trackingNumber}\``, inline: true },
            { name: '追蹤狀態', value: formatRecordStatus(record.status), inline: true },
            { name: '最新貨態', value: formatHistoryLine(latestHistory), inline: false },
            { name: '歷史貨態', value: historyLines.length ? historyLines.join('\n').slice(0, 1024) : '- 尚無貨態資料', inline: false }
        )
        .setFooter({ text: getArchiveHintFooter() })
        .setTimestamp();

    if (record.note) {
        embed.setDescription(record.note);
    }

    if (shortUrl) {
        embed.setURL(shortUrl);
    }

    return embed;
}

function createStoredPackageEmbed(record, title = '包裹貨態') {
    if (record.lastPackageData) {
        return createPackageEmbed(record, record.lastPackageData, title);
    }

    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`${EMBED_EMOJI} ┃ ${title}`)
        .setDescription(record.note || '尚無本機貨態快照。')
        .addFields(
            { name: '物流商', value: record.carrierName || '未知', inline: true },
            { name: '物流單號', value: `\`${record.trackingNumber}\``, inline: true },
            { name: '追蹤狀態', value: formatRecordStatus(record.status), inline: true },
            { name: '最新貨態', value: '尚無本機貨態快照', inline: false },
            { name: '歷史貨態', value: '- 尚無本機貨態快照', inline: false }
        )
        .setFooter({ text: getArchiveHintFooter() })
        .setTimestamp();
}

// Record 查詢與異動 ---------------------------------------------------------

function findPackageRecord(userID, trackingNumber) {
    const normalizedUserID = String(userID);
    const store = loadUserPackageStore(userID);
    return store.packages.find(record =>
        String(record.userID) === normalizedUserID &&
        record.trackingNumber.toLowerCase() === trackingNumber.toLowerCase()
    );
}

function findDuplicatePackage(userID, carrierID, trackingNumber) {
    const normalizedUserID = String(userID);
    const store = loadUserPackageStore(userID);
    return store.packages.find(record =>
        String(record.userID) === normalizedUserID &&
        record.carrierID === carrierID &&
        record.trackingNumber.toLowerCase() === trackingNumber.toLowerCase() &&
        record.status !== 'deleted'
    );
}

/** 以 userPackageID upsert；新資料插在前方，讓面板優先顯示最近操作項目。 */
function upsertPackageRecord(record) {
    const normalizedRecord = {
        ...record,
        userID: String(record.userID),
        userPackageID: String(record.userPackageID)
    };
    const store = loadUserPackageStore(normalizedRecord.userID);
    const index = store.packages.findIndex(item => String(item.userPackageID) === normalizedRecord.userPackageID);

    if (index === -1) {
        store.packages.push(normalizedRecord);
    } else {
        store.packages[index] = { ...store.packages[index], ...normalizedRecord };
    }

    saveUserPackageStore(normalizedRecord.userID, store);
    return normalizedRecord;
}

/** 以 owner 與遠端包裹 ID 直接定位，避免互動熱路徑掃描其他使用者資料。 */
function getPackageRecord(userID, userPackageID) {
    const normalizedUserID = String(userID);
    return loadUserPackageStore(normalizedUserID).packages.find(record =>
        String(record.userID) === normalizedUserID && String(record.userPackageID) === String(userPackageID)
    ) || null;
}

/** 只更新指定 owner 檔案內的包裹，owner 不符時不得跨檔搜尋。 */
function updatePackageRecord(userID, userPackageID, updates) {
    const normalizedUserID = String(userID);
    const store = loadUserPackageStore(normalizedUserID);
    const index = store.packages.findIndex(record =>
        String(record.userID) === normalizedUserID && String(record.userPackageID) === String(userPackageID)
    );
    if (index === -1) return null;

    store.packages[index] = {
        ...store.packages[index],
        ...updates,
        userID: normalizedUserID,
        userPackageID: String(userPackageID),
        updatedAt: new Date().toISOString()
    };
    saveUserPackageStore(normalizedUserID, store);
    return store.packages[index];
}

/** 只刪除指定 owner 檔案內的包裹，避免以外部 ID 操作其他使用者資料。 */
function deletePackageRecord(userID, userPackageID) {
    const normalizedUserID = String(userID);
    const store = loadUserPackageStore(normalizedUserID);
    const index = store.packages.findIndex(record =>
        String(record.userID) === normalizedUserID && String(record.userPackageID) === String(userPackageID)
    );
    if (index === -1) return null;

    const [deletedRecord] = store.packages.splice(index, 1);
    saveUserPackageStore(normalizedUserID, store);
    return deletedRecord;
}

function getPackageRecords(filter = {}) {
    const records = filter.userID
        ? loadUserPackageStore(filter.userID).packages
        : getUserPackageStores().flatMap(({ store }) => store.packages);

    return records.filter(record => {
        if (filter.status && filter.status !== 'all' && record.status !== filter.status) return false;
        if (filter.userID && String(record.userID) !== String(filter.userID)) return false;
        return true;
    });
}

/** 將 Discord interaction、carrier 與首份 API 快照正規化成可落盤 record。 */
function createPackageRecord({ interaction, carrier, trackingNumber, note, userPackageID, packageData }) {
    const now = new Date().toISOString();
    return {
        userPackageID: String(userPackageID),
        userID: interaction.user.id,
        username: interaction.user.tag,
        guildID: interaction.guildId || null,
        channelID: interaction.channelId || null,
        carrierID: carrier.id,
        carrierName: carrier.name,
        trackingNumber,
        note: note || '',
        status: 'active',
        lastHistorySignature: createHistorySignature(packageData),
        lastHistoryChangedAt: now,
        lastPackageData: packageData,
        createdAt: now,
        updatedAt: now
    };
}

return {
    getPackageTrackingConfig,
    hasTrackTwToken,
    getAvailableCarriers,
    detectCarrier,
    importPackage,
    trackingPackage,
    changePackageState,
    findCarrier,
    getLatestHistory,
    createHistorySignature,
    createPackageEmbed,
    createStoredPackageEmbed,
    createAddPackageButton,
    createAddPackageRow,
    createPackageNotificationActionsRows,
    withAddPackageRow,
    findPackageRecord,
    findDuplicatePackage,
    getPackageRecord,
    upsertPackageRecord,
    updatePackageRecord,
    deletePackageRecord,
    getPackageRecords,
    createPackageRecord
};
}

module.exports = { createPackageTrackingTools };
