'use strict';

const crypto = require('node:crypto');

const CREDENTIAL_FORMAT = 'aes-256-gcm-v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;

class GameCheckInCredentialCryptoError extends Error {
    constructor(message = '遊戲簽到憑證無法解密。', options) {
        super(message, options);
        this.name = 'GameCheckInCredentialCryptoError';
        this.code = 'GAME_CHECK_IN_CREDENTIAL_CRYPTO_ERROR';
    }
}

function decodeCanonicalBase64(value, expectedBytes = null) {
    if (typeof value !== 'string' || !value || value.length % 4 !== 0) return null;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) return null;
    if (expectedBytes !== null && decoded.length !== expectedBytes) return null;
    return decoded;
}

function normalizeEncryptedCredential(value) {
    if (!value || value.format !== CREDENTIAL_FORMAT) return null;
    const ciphertext = decodeCanonicalBase64(value.ciphertext);
    const iv = decodeCanonicalBase64(value.iv, IV_BYTES);
    const authTag = decodeCanonicalBase64(value.authTag, AUTH_TAG_BYTES);
    if (!ciphertext?.length || !iv || !authTag) return null;
    if (!Number.isSafeInteger(value.revision) || value.revision <= 0) return null;
    if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return null;
    return {
        format: CREDENTIAL_FORMAT,
        ciphertext: value.ciphertext,
        iv: value.iv,
        authTag: value.authTag,
        revision: value.revision,
        updatedAt: value.updatedAt
    };
}

function createAdditionalData({ userID, platform, revision, updatedAt }) {
    return Buffer.from(JSON.stringify({
        format: CREDENTIAL_FORMAT,
        userID: String(userID),
        platform: String(platform),
        revision,
        updatedAt
    }), 'utf8');
}

function assertEncryptionMetadata(metadata) {
    if (!String(metadata?.userID || '') || !String(metadata?.platform || '')) {
        throw new TypeError('遊戲簽到憑證加密缺少使用者或平台識別。');
    }
    if (!Number.isSafeInteger(metadata.revision) || metadata.revision <= 0) {
        throw new TypeError('遊戲簽到憑證 revision 必須是正整數。');
    }
    if (typeof metadata.updatedAt !== 'string' || !Number.isFinite(Date.parse(metadata.updatedAt))) {
        throw new TypeError('遊戲簽到憑證 updatedAt 必須是有效時間。');
    }
}

function createGameCheckInCredentialCodec(keyHex, {
    randomBytes = crypto.randomBytes
} = {}) {
    const normalizedKey = String(keyHex || '').trim();
    if (!KEY_HEX_PATTERN.test(normalizedKey)) {
        throw new TypeError('遊戲簽到憑證加密金鑰必須是 64 字元十六進位字串。');
    }
    const key = Buffer.from(normalizedKey, 'hex');

    function encrypt(value, metadata) {
        const plaintext = String(value || '');
        if (!plaintext) throw new TypeError('不能加密空白的遊戲簽到憑證。');
        assertEncryptionMetadata(metadata);
        const iv = randomBytes(IV_BYTES);
        if (!Buffer.isBuffer(iv) || iv.length !== IV_BYTES) {
            throw new TypeError(`遊戲簽到憑證 IV 必須是 ${IV_BYTES} bytes。`);
        }
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
        cipher.setAAD(createAdditionalData(metadata));
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return {
            format: CREDENTIAL_FORMAT,
            ciphertext: ciphertext.toString('base64'),
            iv: iv.toString('base64'),
            authTag: cipher.getAuthTag().toString('base64'),
            revision: metadata.revision,
            updatedAt: metadata.updatedAt
        };
    }

    function decrypt(value, metadata) {
        try {
            if (!String(metadata?.userID || '') || !String(metadata?.platform || '')) {
                throw new Error('credential identity is missing');
            }
            const credential = normalizeEncryptedCredential(value);
            if (!credential) throw new Error('encrypted credential envelope is invalid');
            const decipher = crypto.createDecipheriv(
                ALGORITHM,
                key,
                Buffer.from(credential.iv, 'base64'),
                { authTagLength: AUTH_TAG_BYTES }
            );
            decipher.setAAD(createAdditionalData({
                ...metadata,
                revision: credential.revision,
                updatedAt: credential.updatedAt
            }));
            decipher.setAuthTag(Buffer.from(credential.authTag, 'base64'));
            return Buffer.concat([
                decipher.update(Buffer.from(credential.ciphertext, 'base64')),
                decipher.final()
            ]).toString('utf8');
        } catch (error) {
            if (error instanceof GameCheckInCredentialCryptoError) throw error;
            throw new GameCheckInCredentialCryptoError(undefined, { cause: error });
        }
    }

    return Object.freeze({ encrypt, decrypt });
}

module.exports = {
    AUTH_TAG_BYTES,
    CREDENTIAL_FORMAT,
    IV_BYTES,
    KEY_HEX_PATTERN,
    GameCheckInCredentialCryptoError,
    createGameCheckInCredentialCodec,
    normalizeEncryptedCredential
};
