'use strict';

const crypto = require('node:crypto');

function createPackageSessionManager({ ttlMs = 10 * 60 * 1000, maxPerUser = 5, clock = Date } = {}) {
    const sessions = new Map();

    function prune(now = clock.now()) {
        for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    }

    function create({ userID, guildID, messageID = null, data = {} }) {
        prune();
        const owned = [...sessions.values()].filter(item => item.userID === String(userID));
        if (owned.length >= maxPerUser) {
            const error = new Error(`每位使用者最多只能同時進行 ${maxPerUser} 個物流新增流程。`);
            error.code = 'PACKAGE_SESSION_LIMIT';
            error.isValidationError = true;
            throw error;
        }
        const id = crypto.randomUUID();
        const session = {
            id,
            userID: String(userID),
            guildID: guildID ? String(guildID) : null,
            messageID: messageID ? String(messageID) : null,
            data,
            createdAt: clock.now(),
            expiresAt: clock.now() + ttlMs
        };
        sessions.set(id, session);
        return structuredClone(session);
    }

    function get(id, { userID, guildID, messageID = null } = {}) {
        prune();
        const session = sessions.get(id);
        if (!session) return null;
        if (String(userID) !== session.userID) return null;
        if ((guildID ? String(guildID) : null) !== session.guildID) return null;
        if (session.messageID && messageID && String(messageID) !== session.messageID) return null;
        // detached reply 的第一個元件可在此綁定實際 ephemeral message，之後不得換訊息。
        if (!session.messageID && messageID) session.messageID = String(messageID);
        return session;
    }

    function update(id, binding, updater) {
        const session = get(id, binding);
        if (!session) return null;
        const next = updater(structuredClone(session.data));
        session.data = next;
        return structuredClone(session);
    }

    function consume(id, binding) {
        const session = get(id, binding);
        if (!session) return null;
        sessions.delete(id);
        return structuredClone(session);
    }

    function remove(id) { return sessions.delete(id); }
    function clear() { sessions.clear(); }

    return Object.freeze({ create, get, update, consume, remove, clear, prune });
}

module.exports = { createPackageSessionManager };
