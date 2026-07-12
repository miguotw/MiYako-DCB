const fs = require('fs');
const path = require('path');

const STORE_DIRECTORY = path.join(process.cwd(), 'assets', 'twitch_stream');

function getStorePath(guildID) {
    return path.join(STORE_DIRECTORY, `${guildID}.json`);
}

function normalizeStore(data = {}) {
    return {
        subscriptions: Array.isArray(data.subscriptions) ? data.subscriptions : [],
        notifications: Array.isArray(data.notifications) ? data.notifications : []
    };
}

function readGuildStore(guildID) {
    try {
        return normalizeStore(JSON.parse(fs.readFileSync(getStorePath(guildID), 'utf8')));
    } catch {
        return normalizeStore();
    }
}

function writeGuildStore(guildID, store) {
    fs.mkdirSync(STORE_DIRECTORY, { recursive: true });
    const storePath = getStorePath(guildID);
    const temporaryPath = `${storePath}.tmp`;
    const currentStore = readGuildStore(guildID);
    const nextStore = normalizeStore({
        subscriptions: store.subscriptions ?? currentStore.subscriptions,
        notifications: store.notifications ?? currentStore.notifications
    });
    fs.writeFileSync(temporaryPath, JSON.stringify(nextStore, null, 2), 'utf8');
    fs.renameSync(temporaryPath, storePath);
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
