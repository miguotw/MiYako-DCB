const assert = require('node:assert/strict');
const test = require('node:test');
const command = require('../src/commands/ipQuery');
const { getIPInfo } = require('../util/getIPInfo');

test('IP provider 前置驗證拒絕 hostname 與 URL', async () => {
    await assert.rejects(getIPInfo('localhost'), /有效的 IPv4 或 IPv6/);
    await assert.rejects(getIPInfo('http://127.0.0.1'), /有效的 IPv4 或 IPv6/);
});

test('IP 查詢限制同時一筆且每分鐘五次', () => {
    const userID = 'ip-rate-limit-test-user';
    assert.equal(command._test.reserveIPRequest(userID, 1000).allowed, true);
    assert.equal(command._test.reserveIPRequest(userID, 1000).reason, 'pending');
    command._test.releaseIPRequest(userID);

    for (let index = 1; index < 5; index++) {
        assert.equal(command._test.reserveIPRequest(userID, 1000 + index).allowed, true);
        command._test.releaseIPRequest(userID);
    }
    assert.equal(command._test.reserveIPRequest(userID, 2000).reason, 'rate');
});
