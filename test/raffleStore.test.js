const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalCwd = process.cwd();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-raffle-'));
process.chdir(temporaryRoot);
const store = require('../util/raffleStore');
process.chdir(originalCwd);

test.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

test('drawWinners removes duplicates and respects the winner count', () => {
    const values = [0, 0, 0];
    const winners = store.drawWinners(['1', '2', '2', '3'], 2, () => values.shift() || 0);
    assert.equal(winners.length, 2);
    assert.equal(new Set(winners).size, 2);
});

test('drawWinners selects everyone when there are too few participants', () => {
    assert.deepEqual(new Set(store.drawWinners(['1', '2'], 5, () => 0)), new Set(['1', '2']));
});

test('raffle records persist, update, and delete per guild', () => {
    const raffle = store.createRaffle('12345678901234567', { creatorID: '9', qualifiedUserIDs: [] });
    assert.equal(store.getRaffle(raffle.guildID, raffle.id).creatorID, '9');
    store.updateRaffle(raffle.guildID, raffle.id, current => current.status = 'drawn');
    assert.equal(store.getRaffle(raffle.guildID, raffle.id).status, 'drawn');
    assert.equal(store.deleteRaffle(raffle.guildID, raffle.id).id, raffle.id);
    assert.equal(store.getRaffle(raffle.guildID, raffle.id), null);
});
