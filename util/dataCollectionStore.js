const crypto = require('crypto');
const path = require('path');
// 共用程式以檔案自身位置載入；資料目錄仍依 process.cwd()，方便部署與測試隔離。
const { createGuildJsonStore } = require('./guildJsonStore');

const DATA_DIR = path.join(process.cwd(), 'assets', 'dataCollection');
const locks = new Map();

function emptyStore() { return { collections: [] }; }
function normalizeStore(value) { return { collections: Array.isArray(value?.collections) ? value.collections : [] }; }

// 資料收集功能只描述資料內容，檔案驗證與原子寫入由共用存取器處理。
const guildStore = createGuildJsonStore({ directory: DATA_DIR, createEmpty: emptyStore, normalize: normalizeStore });
const readGuildCollections = guildStore.read;
const writeGuildCollections = guildStore.write;
const updateGuildCollections = guildStore.update;

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
    return guildStore.listGuildIDs().flatMap(guildID => readGuildCollections(guildID).collections);
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
