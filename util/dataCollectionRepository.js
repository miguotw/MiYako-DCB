'use strict';

const crypto = require('node:crypto');

function normalize(value) { return { collections: Array.isArray(value?.collections) ? value.collections : [] }; }

function createDataCollectionRepository(jsonRepository) {
    async function create(guildID, data) {
        const record = {
            id: crypto.randomBytes(6).toString('hex'),
            guildID: String(guildID),
            status: 'open',
            publicMessageID: null,
            adminPageMessageIDs: [],
            submissions: {},
            createdAt: new Date().toISOString(),
            closedAt: null,
            ...data
        };
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            store.collections.push(record);
            return store;
        });
        return record;
    }

    async function get(guildID, collectionID) {
        return normalize(await jsonRepository.read(String(guildID))).collections
            .find(item => item.id === String(collectionID)) || null;
    }

    async function find(collectionID) {
        for (const guildID of await jsonRepository.listKeys()) {
            const record = await get(guildID, collectionID);
            if (record) return record;
        }
        return null;
    }

    async function update(guildID, collectionID, updater) {
        let result = null;
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            const record = store.collections.find(item => item.id === String(collectionID));
            if (!record) return store;
            const value = updater(record);
            result = value || record;
            return store;
        });
        return result;
    }

    async function remove(guildID, collectionID) {
        let removed = null;
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            const index = store.collections.findIndex(item => item.id === String(collectionID));
            if (index >= 0) [removed] = store.collections.splice(index, 1);
            return store;
        });
        return removed;
    }

    async function list({ actionableOnly = false } = {}) {
        const result = [];
        for (const guildID of await jsonRepository.listKeys()) {
            const records = normalize(await jsonRepository.read(guildID)).collections;
            result.push(...records.filter(record => !actionableOnly
                || record.status === 'open'
                || record.status === 'closing'
                || record.adminSyncPending));
        }
        return result;
    }

    return Object.freeze({ create, get, find, update, remove, list });
}

module.exports = { createDataCollectionRepository };
