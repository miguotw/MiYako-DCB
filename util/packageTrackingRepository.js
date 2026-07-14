'use strict';

const crypto = require('node:crypto');

function emptyOwnerStore() {
    return { packages: [], reservations: [], outbox: [] };
}

function normalizeOwnerStore(value) {
    return {
        packages: Array.isArray(value?.packages) ? value.packages : [],
        reservations: Array.isArray(value?.reservations) ? value.reservations : [],
        outbox: Array.isArray(value?.outbox) ? value.outbox : []
    };
}

function packageLimitError(limit) {
    const error = new Error(`已達每位使用者最多 ${limit} 筆追蹤中包裹的上限。`);
    error.code = 'PACKAGE_ACTIVE_LIMIT';
    error.isValidationError = true;
    return error;
}

/** 以 owner JSON 為交易邊界，所有 package 更新都不需要掃描其他使用者檔案。 */
function createPackageTrackingRepository(jsonRepository, { maxActivePackages = 20 } = {}) {
    if (!jsonRepository) throw new TypeError('package repository 缺少 JSON repository');

    async function readOwner(ownerID) {
        return normalizeOwnerStore(await jsonRepository.read(String(ownerID)));
    }

    async function listOwnerIDs() { return jsonRepository.listKeys(); }

    async function listPackages({ ownerID, status = 'all' } = {}) {
        const stores = ownerID
            ? [[String(ownerID), await readOwner(ownerID)]]
            : await Promise.all((await listOwnerIDs()).map(async id => [id, await readOwner(id)]));
        return stores.flatMap(([, store]) => store.packages).filter(record =>
            (status === 'all' || record.status === status)
            && (!ownerID || String(record.userID) === String(ownerID))
        );
    }

    async function getPackage(ownerID, packageID) {
        const store = await readOwner(ownerID);
        return store.packages.find(record => String(record.userPackageID) === String(packageID)) || null;
    }

    async function findDuplicate(ownerID, carrierID, trackingNumber) {
        const normalizedNumber = String(trackingNumber).toLowerCase();
        const store = await readOwner(ownerID);
        return store.packages.find(record =>
            record.status !== 'deleted'
            && String(record.carrierID) === String(carrierID)
            && String(record.trackingNumber).toLowerCase() === normalizedNumber
        ) || null;
    }

    function assertCapacity(store) {
        const used = store.packages.filter(item => item.status === 'active').length + store.reservations.length;
        if (used >= maxActivePackages) throw packageLimitError(maxActivePackages);
    }

    async function reserveImport(ownerID, data = {}) {
        const reservationID = data.reservationID || crypto.randomUUID();
        let reservation;
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            assertCapacity(store);
            const duplicate = store.packages.find(record =>
                record.status !== 'deleted'
                && String(record.carrierID) === String(data.carrierID)
                && String(record.trackingNumber).toLowerCase() === String(data.trackingNumber).toLowerCase()
            );
            const duplicateReservation = store.reservations.some(item =>
                item.kind === 'import'
                && String(item.carrierID) === String(data.carrierID)
                && String(item.trackingNumber).toLowerCase() === String(data.trackingNumber).toLowerCase()
            );
            if (duplicate || duplicateReservation) {
                const error = new Error('這筆物流單已存在。');
                error.code = 'PACKAGE_DUPLICATE';
                error.isValidationError = true;
                throw error;
            }
            reservation = {
                id: reservationID,
                kind: 'import',
                carrierID: String(data.carrierID),
                trackingNumber: String(data.trackingNumber),
                createdAt: new Date().toISOString()
            };
            store.reservations.push(reservation);
            return store;
        });
        return reservation;
    }

    async function reserveWake(ownerID, packageID) {
        const reservationID = crypto.randomUUID();
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            assertCapacity(store);
            const record = store.packages.find(item => String(item.userPackageID) === String(packageID));
            if (!record || record.status !== 'archived') {
                const error = new Error('找不到可喚醒的已封存包裹。');
                error.code = 'PACKAGE_NOT_ARCHIVED';
                error.isValidationError = true;
                throw error;
            }
            if (store.reservations.some(item => item.kind === 'wake' && String(item.packageID) === String(packageID))) {
                const error = new Error('這筆包裹已有進行中的喚醒操作。');
                error.code = 'PACKAGE_WAKE_PENDING';
                error.isValidationError = true;
                throw error;
            }
            store.reservations.push({
                id: reservationID,
                kind: 'wake',
                packageID: String(packageID),
                createdAt: new Date().toISOString()
            });
            return store;
        });
        return { id: reservationID };
    }

    async function releaseReservation(ownerID, reservationID) {
        return jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            store.reservations = store.reservations.filter(item => item.id !== reservationID);
            return store;
        });
    }

    async function commitImport(ownerID, reservationID, record) {
        let saved;
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            const reservation = store.reservations.find(item => item.id === reservationID && item.kind === 'import');
            if (!reservation) throw new Error('物流匯入 reservation 已不存在。');
            saved = {
                ...record,
                userID: String(ownerID),
                userPackageID: String(record.userPackageID),
                updatedAt: new Date().toISOString()
            };
            const index = store.packages.findIndex(item => String(item.userPackageID) === saved.userPackageID);
            if (index === -1) store.packages.push(saved);
            else store.packages[index] = { ...store.packages[index], ...saved };
            store.reservations = store.reservations.filter(item => item.id !== reservationID);
            return store;
        });
        return saved;
    }

    async function commitWake(ownerID, packageID, reservationID) {
        return updatePackage(ownerID, packageID, record => {
            record.status = 'active';
            record.lastHistoryChangedAt = new Date().toISOString();
            return record;
        }, reservationID);
    }

    async function updatePackage(ownerID, packageID, updater, reservationID = null) {
        let updated = null;
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            const index = store.packages.findIndex(record => String(record.userPackageID) === String(packageID));
            if (index === -1) return store;
            const draft = structuredClone(store.packages[index]);
            const changes = typeof updater === 'function' ? updater(draft) : { ...draft, ...updater };
            updated = {
                ...(changes || draft),
                userID: String(ownerID),
                userPackageID: String(packageID),
                updatedAt: new Date().toISOString()
            };
            store.packages[index] = updated;
            if (reservationID) store.reservations = store.reservations.filter(item => item.id !== reservationID);
            return store;
        });
        return updated;
    }

    async function deletePackage(ownerID, packageID) {
        let deleted = null;
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            const index = store.packages.findIndex(record => String(record.userPackageID) === String(packageID));
            if (index >= 0) [deleted] = store.packages.splice(index, 1);
            store.outbox = store.outbox.filter(item => String(item.packageID) !== String(packageID));
            return store;
        });
        return deleted;
    }

    async function stageNotification(ownerID, packageID, { signature, packageData }) {
        let item;
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            const record = store.packages.find(entry => String(entry.userPackageID) === String(packageID));
            if (!record) return store;
            const now = new Date().toISOString();
            record.lastPackageData = packageData;
            record.lastHistoryChangedAt = now;
            record.observedHistorySignature = signature;
            const existing = store.outbox.find(entry => String(entry.packageID) === String(packageID));
            item = {
                id: existing?.id || crypto.randomUUID(),
                packageID: String(packageID),
                signature,
                packageData,
                attempts: existing?.attempts || 0,
                nextAttemptAt: existing?.nextAttemptAt || now,
                createdAt: existing?.createdAt || now,
                updatedAt: now
            };
            if (existing) Object.assign(existing, item);
            else store.outbox.push(item);
            return store;
        });
        return item;
    }

    async function listDueOutbox(now = Date.now()) {
        const result = [];
        for (const ownerID of await listOwnerIDs()) {
            const store = await readOwner(ownerID);
            for (const item of store.outbox) {
                if (Date.parse(item.nextAttemptAt || 0) <= now) result.push({ ownerID, ...item });
            }
        }
        return result;
    }

    async function markOutboxFailed(ownerID, outboxID) {
        return jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            const item = store.outbox.find(entry => entry.id === outboxID);
            if (!item) return store;
            item.attempts = (item.attempts || 0) + 1;
            const delay = Math.min(60_000 * (2 ** (item.attempts - 1)), 3_600_000);
            item.nextAttemptAt = new Date(Date.now() + delay).toISOString();
            item.updatedAt = new Date().toISOString();
            return store;
        });
    }

    async function markOutboxDelivered(ownerID, outboxID, locator, expectedSignature = null) {
        let previous = null;
        let stale = false;
        await jsonRepository.update(String(ownerID), current => {
            const store = normalizeOwnerStore(current);
            const item = store.outbox.find(entry => entry.id === outboxID);
            if (!item) return store;
            if (expectedSignature !== null && item.signature !== expectedSignature) {
                stale = true;
                return store;
            }
            const record = store.packages.find(entry => String(entry.userPackageID) === String(item.packageID));
            if (record) {
                previous = record.lastNotificationChannelID && record.lastNotificationMessageID ? {
                    channelID: record.lastNotificationChannelID,
                    messageID: record.lastNotificationMessageID
                } : null;
                record.lastHistorySignature = item.signature;
                record.lastPackageData = item.packageData;
                record.lastNotificationChannelID = locator.channelID;
                record.lastNotificationMessageID = locator.messageID;
                record.updatedAt = new Date().toISOString();
            }
            store.outbox = store.outbox.filter(entry => entry.id !== outboxID);
            return store;
        });
        return stale ? false : previous;
    }

    return Object.freeze({
        readOwner,
        listOwnerIDs,
        listPackages,
        getPackage,
        findDuplicate,
        reserveImport,
        reserveWake,
        releaseReservation,
        commitImport,
        commitWake,
        updatePackage,
        deletePackage,
        stageNotification,
        listDueOutbox,
        markOutboxFailed,
        markOutboxDelivered
    });
}

module.exports = { createPackageTrackingRepository, normalizeOwnerStore, packageLimitError };
