const path = require('path');
const { createGuildJsonStore } = require('./guildJsonStore');

const STORE_DIRECTORY = path.join(process.cwd(), 'assets', 'twitch_stream');

function normalizeStore(data = {}) {
    return {
        subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
        notifications: Array.isArray(data.notifications) ? data.notifications : []
    };
}

function createEmptyStore() {
    return normalizeStore();
}

// Twitch 設定與通知狀態沿用每個 Guild 一份 JSON，底層安全讀寫由共用存取器處理。
const guildStore = createGuildJsonStore({
    directory: STORE_DIRECTORY,
    createEmpty: createEmptyStore,
    normalize: normalizeStore
});

function readGuildStore(guildID) {
    try {
        return guildStore.read(guildID);
    } catch {
        // Twitch 排程不應因單一舊檔損壞而阻止其他伺服器啟動。
        return normalizeStore();
    }
}

function writeGuildStore(guildID, store) {
    const currentStore = readGuildStore(guildID);
    const nextStore = normalizeStore({
        subscriptions: store.subscriptions ?? currentStore.subscriptions,
        notifications: store.notifications ?? currentStore.notifications
    });
    guildStore.write(guildID, nextStore);
}

function getGuildSubscriptions(guildID) {
    return readGuildStore(guildID).subscriptions;
}

function getAllSubscriptions(guildIDs) {
    return guildIDs.flatMap(guildID => getGuildSubscriptions(guildID).map(subscription => ({
        guildID: String(guildID),
        twitchUserLogin: String(subscription.twitchUserLogin || '').toLowerCase(),
        channelID: String(subscription.channelID || ''),
        roleID: String(subscription.roleID || '')
    })));
}

function saveNotificationState(twitchUserLogin, message, stream) {
    const guildID = String(message.guildId || message.guild?.id || '');
    if (!guildID) return;
    const store = readGuildStore(guildID);
    const stateKey = twitchUserLogin.toLowerCase();
    const notification = {
        twitchUserLogin: stateKey,
        channelID: String(message.channelId),
        messageID: String(message.id),
        stream
    };
    const index = store.notifications.findIndex(item =>
        item.twitchUserLogin === stateKey && item.messageID === notification.messageID
    );
    if (index === -1) store.notifications.push(notification);
    else store.notifications[index] = notification;
    writeGuildStore(guildID, store);
}

module.exports = { getAllSubscriptions, getGuildSubscriptions, readGuildStore, saveNotificationState, writeGuildStore };
