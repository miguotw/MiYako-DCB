const crypto = require('crypto');
const path = require('path');
// 共用程式以檔案自身位置載入；資料目錄仍依 process.cwd()，方便部署與測試隔離。
const { createGuildJsonStore } = require('./guildJsonStore');

const DATA_DIR = path.join(process.cwd(), 'assets', 'raffle');

function emptyStore() { return { raffles: [] }; }
function normalizeStore(value) { return { raffles: Array.isArray(value?.raffles) ? value.raffles : [] }; }
// 抽選功能只保留業務操作，通用的 JSON 安全讀寫交給共用資料存取器。
const guildStore = createGuildJsonStore({ directory: DATA_DIR, createEmpty: emptyStore, normalize: normalizeStore });
const readGuildRaffles = guildStore.read;
const writeGuildRaffles = guildStore.write;
const updateGuildRaffles = guildStore.update;

function createRaffle(guildID, data) {
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
    updateGuildRaffles(guildID, store => store.raffles.push(raffle));
    return raffle;
}

function getRaffle(guildID, raffleID) {
    return readGuildRaffles(guildID).raffles.find(item => item.id === String(raffleID)) || null;
}

function updateRaffle(guildID, raffleID, updater) {
    return updateGuildRaffles(guildID, store => {
        const raffle = store.raffles.find(item => item.id === String(raffleID));
        if (!raffle) return null;
        updater(raffle);
        return raffle;
    });
}

function deleteRaffle(guildID, raffleID) {
    return updateGuildRaffles(guildID, store => {
        const index = store.raffles.findIndex(item => item.id === String(raffleID));
        if (index < 0) return null;
        return store.raffles.splice(index, 1)[0];
    });
}

function getAllRaffles() {
    return guildStore.listGuildIDs().flatMap(guildID => readGuildRaffles(guildID).raffles);
}

function drawWinners(participants, count, randomInt = crypto.randomInt) {
    const shuffled = [...new Set(participants.map(String))];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const swapIndex = randomInt(index + 1);
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

module.exports = {
    createRaffle, deleteRaffle, drawWinners, getAllRaffles, getRaffle,
    readGuildRaffles, updateRaffle, writeGuildRaffles
};
