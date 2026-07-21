'use strict';

const crypto = require('node:crypto');

const PLATFORMS = Object.freeze(['hoyolab', 'skport']);
const NOTIFICATION_MODES = Object.freeze(['all', 'failures', 'off']);
const NOTIFICATION_CYCLE = Object.freeze({ all: 'failures', failures: 'off', off: 'all' });
const MAX_ATTEMPTS = 3;
const ATTEMPT_LEASE_MS = 20 * 60 * 1000;
const SIGN_RETRY_DELAYS_MS = Object.freeze([15 * 60 * 1000, 60 * 60 * 1000]);
const DM_RETRY_DELAYS_MS = Object.freeze([60 * 1000, 5 * 60 * 1000]);
const PANEL_INDEX_KEY = 'panels';
const MAX_PANELS = 100;

function assertPlatform(platform) {
    if (!PLATFORMS.includes(platform)) throw new TypeError(`不支援的遊戲簽到平台：${platform}`);
}

function normalizeCredential(value) {
    if (!value || value.format !== 'plain-v1' || typeof value.value !== 'string') return null;
    return {
        format: 'plain-v1',
        value: value.value,
        revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
    };
}

function normalizeDaily(value) {
    if (!value || typeof value !== 'object' || typeof value.date !== 'string') return null;
    return {
        date: value.date,
        generation: Number.isSafeInteger(value.generation) && value.generation > 0 ? value.generation : 1,
        platforms: value.platforms && typeof value.platforms === 'object' ? value.platforms : {},
        notificationQueued: value.notificationQueued === true
    };
}

function normalizeUserStore(value) {
    const notificationMode = NOTIFICATION_MODES.includes(value?.notificationMode)
        ? value.notificationMode
        : 'failures';
    return {
        credentials: {
            hoyolab: normalizeCredential(value?.credentials?.hoyolab),
            skport: normalizeCredential(value?.credentials?.skport)
        },
        notificationMode,
        daily: normalizeDaily(value?.daily),
        outbox: Array.isArray(value?.outbox) ? value.outbox : []
    };
}

function normalizePanelStore(value) {
    const panels = [];
    const seen = new Set();
    for (const item of Array.isArray(value?.panels) ? value.panels : []) {
        const channelID = String(item?.channelID || '');
        const messageID = String(item?.messageID || '');
        const locator = `${channelID}:${messageID}`;
        if (!channelID || !messageID || seen.has(locator)) continue;
        seen.add(locator);
        panels.push({
            channelID,
            messageID,
            updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString()
        });
    }
    return { panels };
}

function activePlatforms(store) {
    return PLATFORMS.filter(platform => Boolean(store.credentials[platform]));
}

function isFailureResult(result) {
    return (result?.outcomes || []).some(outcome => outcome.status === 'failure');
}

function shouldNotify(mode, result) {
    return mode === 'all' || (mode === 'failures' && isFailureResult(result));
}

function maybeQueueNotification(store, userID, idFactory, now) {
    const daily = store.daily;
    if (!daily || daily.notificationQueued) return false;
    const platforms = activePlatforms(store);
    if (!platforms.length) {
        daily.notificationQueued = true;
        return false;
    }

    const states = platforms.map(platform => daily.platforms[platform]);
    if (states.some((state, index) => state?.status !== 'complete'
        || state.credentialRevision !== store.credentials[platforms[index]].revision)) return false;

    const result = {
        date: daily.date,
        outcomes: states.flatMap(state => Array.isArray(state.result?.outcomes) ? state.result.outcomes : [])
    };
    daily.notificationQueued = true;
    if (!shouldNotify(store.notificationMode, result)) return false;
    if (store.outbox.some(item => item.date === daily.date && item.generation === daily.generation)) return false;
    store.outbox.push({
        id: idFactory(),
        userID: String(userID),
        date: daily.date,
        generation: daily.generation,
        result,
        attempts: 0,
        nextAttemptAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString()
    });
    return true;
}

function createGameCheckInRepository(jsonRepository, {
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID()
} = {}) {
    if (!jsonRepository) throw new TypeError('遊戲簽到 repository 缺少 JSON repository');

    async function readUser(userID) {
        return normalizeUserStore(await jsonRepository.read(String(userID)));
    }

    async function listUserIDs() {
        return (await jsonRepository.listKeys()).filter(key => key !== PANEL_INDEX_KEY);
    }

    async function savePanel(message) {
        const channelID = String(message?.channelId || '');
        const messageID = String(message?.id || '');
        if (!channelID || !messageID) throw new TypeError('遊戲簽到主面板缺少訊息 locator。');
        const panel = { channelID, messageID, updatedAt: new Date(now()).toISOString() };
        await jsonRepository.update(PANEL_INDEX_KEY, current => {
            const store = normalizePanelStore(current);
            store.panels = store.panels.filter(item =>
                item.channelID !== channelID || item.messageID !== messageID);
            store.panels.push(panel);
            store.panels = store.panels.slice(-MAX_PANELS);
            return store;
        });
        return panel;
    }

    async function listPanels() {
        return normalizePanelStore(await jsonRepository.read(PANEL_INDEX_KEY)).panels;
    }

    async function removePanel(channelID, messageID) {
        return jsonRepository.update(PANEL_INDEX_KEY, current => {
            const store = normalizePanelStore(current);
            store.panels = store.panels.filter(item =>
                item.channelID !== String(channelID) || item.messageID !== String(messageID));
            return store;
        });
    }

    async function setCredential(userID, platform, rawValue) {
        assertPlatform(platform);
        const value = String(rawValue || '').trim();
        let change;
        const record = await jsonRepository.update(String(userID), current => {
            const store = normalizeUserStore(current);
            const previous = store.credentials[platform];
            const wasActive = activePlatforms(store).length > 0;
            const changed = value ? previous?.value !== value : Boolean(previous);
            if (!changed) {
                change = { changed: false, firstActive: false, disabled: !value };
                return store;
            }

            store.credentials[platform] = value ? {
                format: 'plain-v1',
                value,
                revision: (previous?.revision || 0) + 1,
                updatedAt: new Date(now()).toISOString()
            } : null;
            if (store.daily) {
                store.daily.generation += 1;
                delete store.daily.platforms[platform];
                store.daily.notificationQueued = false;
                store.outbox = store.outbox.filter(item => item.date !== store.daily.date);
            }
            const isActive = activePlatforms(store).length > 0;
            change = { changed: true, firstActive: !wasActive && isActive, disabled: !value };
            return store;
        });
        return { ...change, record };
    }

    async function cycleNotification(userID) {
        let previousMode;
        const record = await jsonRepository.update(String(userID), current => {
            const store = normalizeUserStore(current);
            previousMode = store.notificationMode;
            store.notificationMode = NOTIFICATION_CYCLE[store.notificationMode];
            return store;
        });
        return { previousMode, mode: record.notificationMode, record };
    }

    function ensureDaily(store, date) {
        if (store.daily?.date === date) return store.daily;
        store.daily = { date, generation: 1, platforms: {}, notificationQueued: false };
        return store.daily;
    }

    async function reservePlatform(userID, platform, date) {
        assertPlatform(platform);
        let reservation = null;
        await jsonRepository.update(String(userID), current => {
            const store = normalizeUserStore(current);
            const credential = store.credentials[platform];
            if (!credential) return store;
            const daily = ensureDaily(store, date);
            const existing = daily.platforms[platform];
            const currentTime = now();
            if (existing?.credentialRevision === credential.revision) {
                if (existing.status === 'complete') return store;
                if (existing.status === 'running' && Date.parse(existing.leaseExpiresAt) > currentTime) return store;
                if (existing.status === 'retry_wait' && Date.parse(existing.nextAttemptAt) > currentTime) return store;
            }

            const attempts = existing?.credentialRevision === credential.revision
                ? Math.min(Number(existing.attempts) || 0, MAX_ATTEMPTS - 1) + 1
                : 1;
            reservation = {
                id: idFactory(),
                userID: String(userID),
                platform,
                date,
                generation: daily.generation,
                credentialRevision: credential.revision,
                credential: credential.value,
                attempts
            };
            daily.platforms[platform] = {
                status: 'running',
                reservationID: reservation.id,
                credentialRevision: credential.revision,
                attempts,
                startedAt: new Date(currentTime).toISOString(),
                leaseExpiresAt: new Date(currentTime + ATTEMPT_LEASE_MS).toISOString()
            };
            daily.notificationQueued = false;
            return store;
        });
        return reservation;
    }

    async function completePlatform(reservation, result) {
        let accepted = false;
        let retryAt = null;
        await jsonRepository.update(String(reservation.userID), current => {
            const store = normalizeUserStore(current);
            const credential = store.credentials[reservation.platform];
            const daily = store.daily;
            const state = daily?.platforms?.[reservation.platform];
            if (!credential || credential.revision !== reservation.credentialRevision
                || daily.date !== reservation.date || daily.generation !== reservation.generation
                || state?.reservationID !== reservation.id) return store;

            accepted = true;
            if (result?.retryable === true && state.attempts < MAX_ATTEMPTS) {
                retryAt = now() + SIGN_RETRY_DELAYS_MS[state.attempts - 1];
                daily.platforms[reservation.platform] = {
                    status: 'retry_wait',
                    credentialRevision: credential.revision,
                    attempts: state.attempts,
                    nextAttemptAt: new Date(retryAt).toISOString(),
                    result
                };
            } else {
                daily.platforms[reservation.platform] = {
                    status: 'complete',
                    credentialRevision: credential.revision,
                    attempts: state.attempts,
                    completedAt: new Date(now()).toISOString(),
                    result
                };
                maybeQueueNotification(store, reservation.userID, idFactory, now());
            }
            return store;
        });
        return { accepted, retryAt };
    }

    async function finalizeReady(date) {
        for (const userID of await listUserIDs()) {
            await jsonRepository.update(userID, current => {
                const store = normalizeUserStore(current);
                if (store.daily?.date === date) maybeQueueNotification(store, userID, idFactory, now());
                return store;
            });
        }
    }

    async function listDuePlatforms(date, scheduledAt) {
        const currentTime = now();
        if (currentTime < scheduledAt) return [];
        const due = [];
        for (const userID of await listUserIDs()) {
            const store = await readUser(userID);
            for (const platform of activePlatforms(store)) {
                const credential = store.credentials[platform];
                const state = store.daily?.date === date ? store.daily.platforms[platform] : null;
                if (!state || state.credentialRevision !== credential.revision
                    || (state.status === 'running' && Date.parse(state.leaseExpiresAt) <= currentTime)
                    || (state.status === 'retry_wait' && Date.parse(state.nextAttemptAt) <= currentTime)) {
                    due.push({ userID, platform });
                }
            }
        }
        return due;
    }

    async function earliestPending(date) {
        let earliest = null;
        const currentTime = now();
        for (const userID of await listUserIDs()) {
            const store = await readUser(userID);
            if (activePlatforms(store).length && store.daily?.date !== date) return currentTime;
            if (store.daily?.date !== date) continue;
            for (const platform of activePlatforms(store)) {
                const state = store.daily.platforms[platform];
                if (!state || state.credentialRevision !== store.credentials[platform].revision) return currentTime;
                const candidate = state.status === 'running' ? Date.parse(state.leaseExpiresAt)
                    : state.status === 'retry_wait' ? Date.parse(state.nextAttemptAt) : null;
                if (Number.isFinite(candidate) && (earliest === null || candidate < earliest)) earliest = candidate;
            }
        }
        return earliest;
    }

    async function listDueOutbox() {
        const items = [];
        const currentTime = now();
        for (const userID of await listUserIDs()) {
            const store = await readUser(userID);
            for (const item of store.outbox) {
                if (Date.parse(item.nextAttemptAt || 0) <= currentTime) items.push({ ...item, userID });
            }
        }
        return items;
    }

    async function prepareOutboxDelivery(userID, outboxID) {
        let selected = null;
        await jsonRepository.update(String(userID), current => {
            const store = normalizeUserStore(current);
            const item = store.outbox.find(entry => entry.id === outboxID);
            if (!item) return store;
            const currentGeneration = store.daily?.date === item.date ? store.daily.generation : item.generation;
            if (currentGeneration !== item.generation || !shouldNotify(store.notificationMode, item.result)) {
                store.outbox = store.outbox.filter(entry => entry.id !== outboxID);
                return store;
            }
            selected = structuredClone(item);
            return store;
        });
        return selected;
    }

    async function markOutboxDelivered(userID, outboxID) {
        return jsonRepository.update(String(userID), current => {
            const store = normalizeUserStore(current);
            store.outbox = store.outbox.filter(item => item.id !== outboxID);
            return store;
        });
    }

    async function markOutboxFailed(userID, outboxID, { permanent = false } = {}) {
        let retryAt = null;
        await jsonRepository.update(String(userID), current => {
            const store = normalizeUserStore(current);
            const item = store.outbox.find(entry => entry.id === outboxID);
            if (!item) return store;
            item.attempts = (Number(item.attempts) || 0) + 1;
            if (permanent || item.attempts >= MAX_ATTEMPTS) {
                store.outbox = store.outbox.filter(entry => entry.id !== outboxID);
            } else {
                retryAt = now() + DM_RETRY_DELAYS_MS[item.attempts - 1];
                item.nextAttemptAt = new Date(retryAt).toISOString();
            }
            return store;
        });
        return retryAt;
    }

    async function earliestOutbox() {
        let earliest = null;
        for (const userID of await listUserIDs()) {
            const store = await readUser(userID);
            for (const item of store.outbox) {
                const candidate = Date.parse(item.nextAttemptAt || 0);
                if (Number.isFinite(candidate) && (earliest === null || candidate < earliest)) earliest = candidate;
            }
        }
        return earliest;
    }

    return Object.freeze({
        readUser,
        listUserIDs,
        savePanel,
        listPanels,
        removePanel,
        setCredential,
        cycleNotification,
        reservePlatform,
        completePlatform,
        finalizeReady,
        listDuePlatforms,
        earliestPending,
        listDueOutbox,
        prepareOutboxDelivery,
        markOutboxDelivered,
        markOutboxFailed,
        earliestOutbox
    });
}

module.exports = {
    ATTEMPT_LEASE_MS,
    MAX_ATTEMPTS,
    MAX_PANELS,
    NOTIFICATION_MODES,
    PLATFORMS,
    SIGN_RETRY_DELAYS_MS,
    createGameCheckInRepository,
    normalizeUserStore
};
