'use strict';

function normalize(value) {
    return {
        entrances: value?.entrances && typeof value.entrances === 'object' ? value.entrances : {},
        channels: value?.channels && typeof value.channels === 'object' ? value.channels : {}
    };
}

function createTemporaryVoiceRepository(jsonRepository) {
    async function readGuild(guildID) { return normalize(await jsonRepository.read(String(guildID))); }
    async function listGuildIDs() { return jsonRepository.listKeys(); }
    async function updateGuild(guildID, updater) {
        let result;
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            result = updater(store) || store;
            return store;
        });
        return result;
    }
    async function setEntrance(guildID, channelID, prefix = '') {
        return updateGuild(guildID, store => {
            store.entrances[String(channelID)] = {
                channelID: String(channelID), prefix: String(prefix), updatedAt: new Date().toISOString()
            };
        });
    }
    async function removeEntrance(guildID, channelID) {
        return updateGuild(guildID, store => { delete store.entrances[String(channelID)]; });
    }
    async function addChannel(guildID, channelID, data) {
        return updateGuild(guildID, store => {
            store.channels[String(channelID)] = {
                channelID: String(channelID), generation: 0, emptySince: null, retryAttempts: 0,
                createdAt: new Date().toISOString(), ...data
            };
        });
    }
    async function updateChannel(guildID, channelID, updater) {
        let result = null;
        await updateGuild(guildID, store => {
            const record = store.channels[String(channelID)];
            if (!record) return;
            result = updater(record) || record;
        });
        return result;
    }
    async function removeChannel(guildID, channelID) {
        return updateGuild(guildID, store => { delete store.channels[String(channelID)]; });
    }
    return Object.freeze({
        readGuild, listGuildIDs, updateGuild, setEntrance, removeEntrance,
        addChannel, updateChannel, removeChannel
    });
}

module.exports = { createTemporaryVoiceRepository };
