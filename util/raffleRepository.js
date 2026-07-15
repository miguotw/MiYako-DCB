'use strict';

const crypto = require('node:crypto');

function normalize(value) { return { raffles: Array.isArray(value?.raffles) ? value.raffles : [] }; }

function createRaffleRepository(jsonRepository) {
    async function create(guildID, data) {
        const raffle = {
            id: crypto.randomBytes(6).toString('hex'),
            guildID: String(guildID),
            status: 'open',
            participants: [],
            winners: [],
            createdAt: new Date().toISOString(),
            drawnAt: null,
            ...data
        };
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            store.raffles.push(raffle);
            return store;
        });
        return raffle;
    }

    async function get(guildID, raffleID) {
        return normalize(await jsonRepository.read(String(guildID))).raffles
            .find(item => item.id === String(raffleID)) || null;
    }

    async function update(guildID, raffleID, updater) {
        let result = null;
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            const record = store.raffles.find(item => item.id === String(raffleID));
            if (!record) return store;
            const value = updater(record);
            result = value || record;
            return store;
        });
        return result;
    }

    async function remove(guildID, raffleID) {
        let removed = null;
        await jsonRepository.update(String(guildID), current => {
            const store = normalize(current);
            const index = store.raffles.findIndex(item => item.id === String(raffleID));
            if (index >= 0) [removed] = store.raffles.splice(index, 1);
            return store;
        });
        return removed;
    }

    async function list() {
        const result = [];
        for (const guildID of await jsonRepository.listKeys()) {
            result.push(...normalize(await jsonRepository.read(guildID)).raffles);
        }
        return result;
    }

    return Object.freeze({ create, get, update, remove, list });
}

function drawWinners(participants, count, randomInt = crypto.randomInt) {
    const shuffled = [...new Set(participants.map(String))];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const swapIndex = randomInt(index + 1);
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

module.exports = { createRaffleRepository, drawWinners };
