'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    CREDENTIAL_FORMAT,
    GameCheckInCredentialCryptoError,
    createGameCheckInCredentialCodec,
    normalizeEncryptedCredential
} = require('../util/gameCheckInCredentialCodec');

const KEY = '12'.repeat(32);
const OTHER_KEY = '34'.repeat(32);
const METADATA = Object.freeze({
    userID: '123456789012345678',
    platform: 'hoyolab',
    revision: 3,
    updatedAt: '2026-07-22T01:02:03.000Z'
});

function mutateBase64(value) {
    const bytes = Buffer.from(value, 'base64');
    bytes[0] ^= 1;
    return bytes.toString('base64');
}

test('AES-256-GCM codec 可往返兩平台憑證且每次使用不同 IV', () => {
    const codec = createGameCheckInCredentialCodec(KEY.toUpperCase());
    const first = codec.encrypt('cookie-secret', METADATA);
    const second = codec.encrypt('cookie-secret', METADATA);
    const skportMetadata = { ...METADATA, platform: 'skport' };
    const skport = codec.encrypt('account-token', skportMetadata);

    assert.equal(first.format, CREDENTIAL_FORMAT);
    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
    assert.equal(codec.decrypt(first, METADATA), 'cookie-secret');
    assert.equal(codec.decrypt(skport, skportMetadata), 'account-token');
    assert.doesNotMatch(JSON.stringify([first, second, skport]), /cookie-secret|account-token/);
    assert.deepEqual(normalizeEncryptedCredential(first), first);
    assert.equal(normalizeEncryptedCredential({ format: 'plain-v1', value: 'secret' }), null);
});

test('AES-256-GCM codec 拒絕錯誤金鑰、AAD 變更及任何密文欄位篡改', () => {
    const codec = createGameCheckInCredentialCodec(KEY);
    const encrypted = codec.encrypt('private-value', METADATA);
    const attempts = [
        () => createGameCheckInCredentialCodec(OTHER_KEY).decrypt(encrypted, METADATA),
        () => codec.decrypt(encrypted, { ...METADATA, userID: '222222222222222222' }),
        () => codec.decrypt(encrypted, { ...METADATA, platform: 'skport' }),
        () => codec.decrypt({ ...encrypted, revision: encrypted.revision + 1 }, METADATA),
        () => codec.decrypt({ ...encrypted, updatedAt: '2026-07-22T01:02:04.000Z' }, METADATA),
        () => codec.decrypt({ ...encrypted, ciphertext: mutateBase64(encrypted.ciphertext) }, METADATA),
        () => codec.decrypt({ ...encrypted, iv: mutateBase64(encrypted.iv) }, METADATA),
        () => codec.decrypt({ ...encrypted, authTag: mutateBase64(encrypted.authTag) }, METADATA)
    ];
    for (const attempt of attempts) {
        assert.throws(attempt, error => {
            assert.ok(error instanceof GameCheckInCredentialCryptoError);
            assert.doesNotMatch(error.message, /private-value|^[0-9a-f]{64}$/i);
            return true;
        });
    }
});

test('AES-256-GCM codec 嚴格驗證金鑰、空值與密文 envelope', () => {
    for (const key of ['', 'ab', 'z'.repeat(64)]) {
        assert.throws(() => createGameCheckInCredentialCodec(key), /64 字元十六進位/);
    }
    const codec = createGameCheckInCredentialCodec(KEY);
    assert.throws(() => codec.encrypt('', METADATA), /不能加密空白/);
    assert.throws(() => codec.encrypt('secret', { ...METADATA, revision: 0 }), /revision/);
    assert.throws(() => codec.encrypt('secret', { ...METADATA, updatedAt: 'invalid' }), /updatedAt/);
    assert.throws(
        () => codec.decrypt({ format: CREDENTIAL_FORMAT, ciphertext: 'bad', iv: '', authTag: '' }, METADATA),
        GameCheckInCredentialCryptoError
    );
});
