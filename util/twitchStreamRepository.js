'use strict';

function normalize(value) {
    return {
        subscriptions: Array.isArray(value?.subscriptions) ? value.subscriptions : [],
        notifications: Array.isArray(value?.notifications) ? value.notifications : []
    };
}

function createTwitchStreamRepository(jsonRepository) {
    async function readGuild(guildID) { return normalize(await jsonRepository.read(String(guildID))); }
    async function writeGuild(guildID, value) {
        const normalized = normalize(value);
        await jsonRepository.write(String(guildID), normalized);
        return normalized;
    }
    async function updateGuild(guildID, updater) {
        let result;
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            result = updater(store) || store;
            return store;
        });
        return result;
    }
    async function listSubscriptions(guildIDs = null) {
        const ids = guildIDs || await jsonRepository.listKeys();
        const result = [];
        for (const guildID of ids) {
            const store = await readGuild(guildID);
            result.push(...store.subscriptions.map(item => ({ ...item, guildID: String(guildID) })));
        }
        return result;
    }
    async function saveNotification(twitchUserLogin, message, stream) {
        const guildID = String(message.guildId || message.guild?.id || '');
        if (!guildID) return;
        const notification = {
            twitchUserLogin: String(twitchUserLogin).toLowerCase(),
            channelID: String(message.channelId), messageID: String(message.id), stream,
            updatedAt: new Date().toISOString()
        };
        await updateGuild(guildID, store => {
            const index = store.notifications.findIndex(item =>
                item.twitchUserLogin === notification.twitchUserLogin && item.messageID === notification.messageID);
            if (index < 0) store.notifications.push(notification);
            else store.notifications[index] = notification;
        });
    }
    async function removeNotifications(twitchUserLogin, guildIDs = null) {
        const login = String(twitchUserLogin).toLowerCase();
        const ids = guildIDs || await jsonRepository.listKeys();
        const removed = [];
        for (const guildID of ids) {
            await updateGuild(guildID, store => {
                removed.push(...store.notifications.filter(item => item.twitchUserLogin === login)
                    .map(item => ({ ...item, guildID: String(guildID) })));
                store.notifications = store.notifications.filter(item => item.twitchUserLogin !== login);
            });
        }
        return removed;
    }
    async function removeSubscription(guildID, twitchUserLogin) {
        const login = String(twitchUserLogin).toLowerCase();
        let found = false;
        let notifications = [];
        await updateGuild(guildID, store => {
            found = store.subscriptions.some(item => item.twitchUserLogin === login);
            store.subscriptions = store.subscriptions.filter(item => item.twitchUserLogin !== login);
            notifications = store.notifications.filter(item => item.twitchUserLogin === login)
                .map(item => ({ ...item, guildID: String(guildID) }));
            store.notifications = store.notifications.filter(item => item.twitchUserLogin !== login);
        });
        return { found, notifications };
    }
    return Object.freeze({
        readGuild, writeGuild, updateGuild, listSubscriptions,
        saveNotification, removeNotifications, removeSubscription
    });
}

module.exports = { createTwitchStreamRepository };
