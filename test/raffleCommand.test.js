const assert = require('node:assert/strict');
const test = require('node:test');
const { _test } = require('../src/commands/admin/raffle');
const { createRaffleEmbed, participationRow } = require('../util/raffleViews');
const command = require('../src/commands/admin/raffle');

test('抽選系統本身沒有建立抽選子指令', () => {
    const json = command.data.toJSON();
    assert.equal(json.name, '抽選系統');
    assert.equal(json.options.some(option => option.type === 1 || option.type === 2), false);
    assert.equal(json.options.some(option => option.name === '截止時間'), true);
    assert.equal(json.options.find(option => option.name === '提及身分組').required, false);
});

test('截止日期與時間先以本機時間解讀', () => {
    const timestamp = _test.parseDeadline('2026-08-01 20:30', 0);
    assert.equal(timestamp, 1785587400);
    assert.equal(new Date(timestamp * 1000).toISOString(), '2026-08-01T12:30:00.000Z');
});

test('log.timezone 以小時加減截止時間', () => {
    const base = _test.parseDeadline('2026-08-01 20:30', 0);
    assert.equal(_test.parseDeadline('2026-08-01 20:30', 1) - base, 3600);
    assert.equal(_test.parseDeadline('2026-08-01 20:30', -2) - base, -7200);
});

test('截止日期拒絕不存在的日期與錯誤格式', () => {
    assert.equal(_test.parseDeadline('2026-02-30 20:30', 0), null);
    assert.equal(_test.parseDeadline('2026/08/01 20:30', 0), null);
    assert.equal(_test.parseDeadline('2026-08-01 24:00', 0), null);
});

test('白黑名單只接受用戶或身分組提及並移除重複項目', () => {
    assert.deepEqual(
        _test.parseMentionTargets('<@12345678901234567>, <@12345678901234567> <@&23456789012345678>', '白名單'),
        [{ type: 'user', id: '12345678901234567' }, { type: 'role', id: '23456789012345678' }]
    );
    assert.throws(() => _test.parseMentionTargets('12345678901234567', '黑名單'), /不接受純數字 ID/);
});

test('公開公告以 footer 顯示唯一 ID 與時間，並顯示登記名單', () => {
    const raffle = {
        id: 'secret-id', description: '介紹', winnerCount: 2, autoDraw: true,
        entryDeadline: 1785587400, participants: ['12345678901234567'],
        qualifiedUserIDs: ['23456789012345678'], winners: [], createdAt: new Date().toISOString()
    };
    const json = createRaffleEmbed(raffle).toJSON();
    assert.equal(json.fields.some(field => ['抽選 ID', '狀態'].includes(field.name)), false);
    assert.equal(json.footer.text, 'secret-id');
    assert.ok(json.timestamp);
    assert.equal(json.fields.some(field => field.name === '自動抽選'), false);
    assert.equal(json.fields.find(field => field.name === '抽選人數').value, '2 位 `已啟用自動抽選`');
    assert.equal(json.fields.find(field => field.name === '截止倒數').value, '<t:1785587400:R>');
    assert.match(json.fields.find(field => field.name === '已登記抽選').value, /12345678901234567/);
    assert.equal(json.fields.some(field => field.name === '已具資格'), false);
    assert.equal(participationRow(raffle)[0].components[0].data.label, '參加/取消抽選');
});

test('公開公告一律不顯示已具資格欄位', () => {
    const json = createRaffleEmbed({
        id: 'id', description: '介紹', winnerCount: 1, autoDraw: false,
        entryDeadline: 1785587400, participants: [], qualifiedUserIDs: [], winners: [], createdAt: new Date().toISOString()
    }).toJSON();
    assert.equal(json.fields.some(field => field.name === '已具資格'), false);
});
