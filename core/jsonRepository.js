'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class RepositoryBlockedError extends Error {
    constructor(key) {
        super(`JSON repository key「${key}」已封鎖，必須先人工處理 quarantine 資料。`);
        this.name = 'RepositoryBlockedError';
        this.code = 'REPOSITORY_BLOCKED';
        this.key = key;
    }
}

function validateKey(key) {
    if (typeof key !== 'string' || !SAFE_KEY.test(key)) {
        throw new TypeError('repository key 必須是安全且非空的單一路徑片段');
    }
    return key;
}

function validateSchemaVersion(schemaVersion) {
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
        throw new TypeError('schemaVersion 必須是正整數');
    }
}

/**
 * 單程序 JSON repository。每個 key 各自排隊，既避免不相關資料互相阻塞，也確保
 * read-modify-write 在同一程序內不會遺失更新；跨程序鎖不在此階段支援範圍。
 */
function createJsonRepository({ directory, schemaVersion = 1 } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
        throw new TypeError('directory 必須是絕對路徑');
    }
    validateSchemaVersion(schemaVersion);

    const blockedDirectory = path.join(directory, '.blocked');
    const quarantineDirectory = path.join(directory, '.quarantine');
    const locks = new Map();
    let directoriesPromise;

    async function secureDirectory(target) {
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') await fs.chmod(target, 0o700);
    }

    async function ensureDirectories() {
        if (!directoriesPromise) {
            directoriesPromise = Promise.all([
                secureDirectory(directory),
                secureDirectory(blockedDirectory),
                secureDirectory(quarantineDirectory)
            ]).then(() => undefined).catch(error => {
                directoriesPromise = undefined;
                throw error;
            });
        }
        return directoriesPromise;
    }

    function dataPath(key) { return path.join(directory, `${key}.json`); }
    function blockedPath(key) { return path.join(blockedDirectory, `${key}.json`); }

    async function exists(target) {
        try {
            await fs.access(target);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
    }

    async function flushDirectory(target) {
        let handle;
        try {
            handle = await fs.open(target, 'r');
            await handle.sync();
        } catch {
            // best-effort：部分檔案系統不允許 fsync 目錄；檔案仍已完成 flush 與 atomic rename。
        } finally {
            await handle?.close().catch(() => {});
        }
    }

    async function atomicWriteFile(target, contents) {
        await ensureDirectories();
        const temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
        let handle;
        try {
            handle = await fs.open(temporaryPath, 'wx', 0o600);
            await handle.writeFile(contents, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            if (process.platform !== 'win32') await fs.chmod(temporaryPath, 0o600);
            await fs.rename(temporaryPath, target);
            if (process.platform !== 'win32') await fs.chmod(target, 0o600);
            await flushDirectory(path.dirname(target));
        } catch (error) {
            await handle?.close().catch(() => {});
            await fs.rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    async function withKeyLock(key, operation) {
        const previous = locks.get(key) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => current);
        locks.set(key, tail);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (locks.get(key) === tail) locks.delete(key);
        }
    }

    function parseEnvelope(source) {
        const envelope = JSON.parse(source);
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('envelope 必須是物件');
        const keys = Object.keys(envelope).sort();
        if (keys.join(',') !== 'data,schemaVersion,updatedAt') throw new Error('envelope 欄位不正確');
        if (envelope.schemaVersion !== schemaVersion) throw new Error('schemaVersion 不相容');
        if (typeof envelope.updatedAt !== 'string' || !Number.isFinite(Date.parse(envelope.updatedAt))) {
            throw new Error('updatedAt 不合法');
        }
        return envelope.data;
    }

    async function assertNotBlocked(key) {
        await ensureDirectories();
        if (await exists(blockedPath(key))) throw new RepositoryBlockedError(key);
    }

    async function quarantine(key, error) {
        const sourcePath = dataPath(key);
        const quarantineName = `${key}.${Date.now()}.${crypto.randomUUID()}.json`;
        const quarantinePath = path.join(quarantineDirectory, quarantineName);
        const marker = {
            key,
            blockedAt: new Date().toISOString(),
            quarantineFile: quarantineName,
            reason: error?.name || 'InvalidRepositoryData'
        };

        // marker 必須先落盤；即使程序在搬檔前中止，後續寫入也不會覆蓋壞資料。
        if (!await exists(blockedPath(key))) {
            await atomicWriteFile(blockedPath(key), `${JSON.stringify(marker, null, 2)}\n`);
        }
        try {
            await fs.rename(sourcePath, quarantinePath);
            if (process.platform !== 'win32') await fs.chmod(quarantinePath, 0o600);
            await flushDirectory(quarantineDirectory);
        } catch (moveError) {
            if (moveError?.code !== 'ENOENT') throw moveError;
        }
        throw new RepositoryBlockedError(key);
    }

    async function readUnlocked(key) {
        await assertNotBlocked(key);
        let source;
        try {
            source = await fs.readFile(dataPath(key), 'utf8');
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        try {
            return parseEnvelope(source);
        } catch (error) {
            return quarantine(key, error);
        }
    }

    function serialize(value) {
        const serializedData = JSON.stringify(value);
        if (serializedData === undefined) throw new TypeError('repository value 必須可序列化為 JSON');
        const jsonData = JSON.parse(serializedData);
        const source = JSON.stringify({
            schemaVersion,
            updatedAt: new Date().toISOString(),
            data: jsonData
        }, null, 2);
        return `${source}\n`;
    }

    async function read(key) {
        validateKey(key);
        return withKeyLock(key, () => readUnlocked(key));
    }

    async function write(key, value) {
        validateKey(key);
        return withKeyLock(key, async () => {
            // 先驗證現有檔案，禁止直接用新資料蓋掉尚未被讀取過的壞檔。
            await readUnlocked(key);
            await atomicWriteFile(dataPath(key), serialize(value));
            return value;
        });
    }

    async function update(key, updater) {
        validateKey(key);
        if (typeof updater !== 'function') throw new TypeError('updater 必須是函式');
        return withKeyLock(key, async () => {
            const current = await readUnlocked(key);
            const next = updater(current === null ? null : structuredClone(current));
            if (next && typeof next.then === 'function') throw new TypeError('repository updater 必須是同步函式');
            await atomicWriteFile(dataPath(key), serialize(next));
            return next;
        });
    }

    async function listKeys() {
        await ensureDirectories();
        const result = new Set();
        for (const [target, isBlocked] of [[directory, false], [blockedDirectory, true]]) {
            const entries = await fs.readdir(target, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
                const key = entry.name.slice(0, -5);
                if (!SAFE_KEY.test(key)) continue;
                result.add(key);
                if (isBlocked) continue;
            }
        }
        return [...result].sort();
    }

    return Object.freeze({ read, write, update, listKeys, directory, schemaVersion });
}

module.exports = { RepositoryBlockedError, createJsonRepository };
