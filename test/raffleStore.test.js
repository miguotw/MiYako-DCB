'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { createRaffleRepository, drawWinners } = require('../util/raffleRepository');

test('drawWinners 去重並遵守中選數量', () => {
    const values = [0, 0, 0];
    const winners = drawWinners(['1', '2', '2', '3'], 2, () => values.shift() || 0);
    assert.equal(winners.length, 2);
    assert.equal(new Set(winners).size, 2);
    assert.deepEqual(new Set(drawWinners(['1', '2'], 5, () => 0)), new Set(['1', '2']));
});

test('抽選紀錄以 guild repository 建立、更新與刪除', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-raffle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = createRaffleRepository(createJsonRepository({ directory: path.join(root, 'data') }));
    const raffle = await repository.create('12345678901234567', { creatorID: '9' });
    assert.equal((await repository.get(raffle.guildID, raffle.id)).creatorID, '9');
    await repository.update(raffle.guildID, raffle.id, current => { current.status = 'drawn'; });
    assert.equal((await repository.get(raffle.guildID, raffle.id)).status, 'drawn');
    assert.equal((await repository.remove(raffle.guildID, raffle.id)).id, raffle.id);
});
