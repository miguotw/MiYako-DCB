const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'assets', 'dataCollection');
const FILE_PATTERN = /^\d+\.json$/;
const locks = new Map();

function emptyStore() { return { collections: [] }; }
function normalizeStore(value) { return { collections: Array.isArray(value?.collections) ? value.collections : [] }; }

function getGuildFile(guildID) {
    const id = String(guildID || '');
    if (!/^\d+$/.test(id)) throw new Error('無效的伺服器 ID。');
    return path.join(DATA_DIR, `${id}.json`);
}

function readGuildCollections(guildID) {
    try { return normalizeStore(JSON.parse(fs.readFileSync(getGuildFile(guildID), 'utf8'))); }
    catch (error) {
        if (error.code === 'ENOENT') return emptyStore();
        throw error;
    }
}

function writeGuildCollections(guildID, store) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = getGuildFile(guildID);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(normalizeStore(store), null, 2), 'utf8');
    fs.renameSync(temporary, file);
}

function updateGuildCollections(guildID, updater) {
    const store = readGuildCollections(guildID);
    const result = updater(store);
    writeGuildCollections(guildID, store);
    return result;
}

function createDataCollection(guildID, data) {
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
    updateGuildCollections(guildID, store => store.collections.push(record));
    return record;
}

function getDataCollection(guildID, collectionID) {
    return readGuildCollections(guildID).collections.find(item => item.id === String(collectionID)) || null;
}

function updateDataCollection(guildID, collectionID, updater) {
    return updateGuildCollections(guildID, store => {
        const record = store.collections.find(item => item.id === String(collectionID));
        if (!record) return null;
        updater(record);
        return record;
    });
}

function deleteDataCollection(guildID, collectionID) {
    return updateGuildCollections(guildID, store => {
        const index = store.collections.findIndex(item => item.id === String(collectionID));
        if (index < 0) return null;
        return store.collections.splice(index, 1)[0];
    });
}

function getAllDataCollections() {
    try {
        return fs.readdirSync(DATA_DIR).filter(name => FILE_PATTERN.test(name)).flatMap(name => {
            const guildID = path.basename(name, '.json');
            return readGuildCollections(guildID).collections;
        });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function findDataCollection(collectionID) {
    return getAllDataCollections().find(item => item.id === String(collectionID)) || null;
}

async function withCollectionLock(collectionID, operation) {
    const key = String(collectionID);
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    locks.set(key, current);
    try { return await current; }
    finally { if (locks.get(key) === current) locks.delete(key); }
}

module.exports = {
    createDataCollection, deleteDataCollection, findDataCollection, getAllDataCollections, getDataCollection,
    readGuildCollections, updateDataCollection, withCollectionLock, writeGuildCollections
};
