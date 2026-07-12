const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'assets', 'raffle');
const GUILD_FILE_PATTERN = /^\d+\.json$/;

function emptyStore() { return { raffles: [] }; }
function normalizeStore(value) { return { raffles: Array.isArray(value?.raffles) ? value.raffles : [] }; }

function getGuildFile(guildID) {
    const id = String(guildID || '');
    if (!/^\d+$/.test(id)) throw new Error('無效的伺服器 ID。');
    return path.join(DATA_DIR, `${id}.json`);
}

function readGuildRaffles(guildID) {
    try { return normalizeStore(JSON.parse(fs.readFileSync(getGuildFile(guildID), 'utf8'))); }
    catch (error) {
        if (error.code === 'ENOENT') return emptyStore();
        throw error;
    }
}

function writeGuildRaffles(guildID, store) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = getGuildFile(guildID);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(normalizeStore(store), null, 2), 'utf8');
    fs.renameSync(temporary, file);
}

function updateGuildRaffles(guildID, updater) {
    const store = readGuildRaffles(guildID);
    const result = updater(store);
    writeGuildRaffles(guildID, store);
    return result;
}

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
    try {
        return fs.readdirSync(DATA_DIR).filter(name => GUILD_FILE_PATTERN.test(name)).flatMap(name => {
            const guildID = path.basename(name, '.json');
            return readGuildRaffles(guildID).raffles;
        });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
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
