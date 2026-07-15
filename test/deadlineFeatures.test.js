'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { loadConfig } = require('../core/config');
const { createRaffleDeadlineCoordinator } = require('../src/modules/event/raffle');
const { createDataCollectionDeadlineCoordinator } = require('../src/modules/event/data_collection');
const { createRaffleRepository } = require('../util/raffleRepository');
const { createDataCollectionRepository } = require('../util/dataCollectionRepository');

function schedulerStub() {
    const descriptors = [];
    return {
        descriptors,
        scheduleDeadline(descriptor) {
            descriptors.push(descriptor);
            return { reschedule() {}, async stop() {}, trigger: () => descriptor.run({ signal: new AbortController().signal }) };
        }
    };
}

test('抽選先持久化 winners，Discord 失敗重試與重啟不會重新抽選', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-raffle-deadline-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const json = createJsonRepository({ directory: path.join(root, 'raffle') });
    const repository = createRaffleRepository(json);
    const raffle = await repository.create('guild', {
        entryDeadline: Math.floor(Date.now() / 1000) - 1,
        autoDraw: true, participants: ['1', '2', '3'], winnerCount: 2,
        channelID: 'channel', messageID: 'message', description: 'raffle'
    });
    let edits = 0;
    const message = { edit: async () => { edits += 1; if (edits === 1) throw new Error('temporary Discord failure'); } };
    const channel = { messages: { fetch: async () => message } };
    const client = { channels: { fetch: async () => channel } };
    const scheduler = schedulerStub();
    const coordinator = createRaffleDeadlineCoordinator(loadConfig());
    await coordinator.start({ client, scheduler, store: { raffle: json } });
    const descriptor = scheduler.descriptors[0];
    await assert.rejects(descriptor.run(), /temporary Discord failure/);
    const pending = await repository.get('guild', raffle.id);
    assert.equal(pending.status, 'drawnPendingSync');
    const winners = [...pending.winners];
    await descriptor.run();
    assert.equal(await repository.get('guild', raffle.id), null);
    assert.equal(edits, 2);
    assert.equal(winners.length, 2);
    await coordinator.stop();
});

test('資料收集啟動時不為 closed 且無 pending 的紀錄呼叫 Discord API', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-collection-deadline-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const json = createJsonRepository({ directory: path.join(root, 'collections') });
    const repository = createDataCollectionRepository(json);
    const record = await repository.create('guild', { deadline: 1, adminSyncPending: false });
    await repository.update('guild', record.id, current => { current.status = 'closed'; });
    let fetches = 0;
    const client = { channels: { fetch: async () => { fetches += 1; } } };
    const scheduler = schedulerStub();
    const coordinator = createDataCollectionDeadlineCoordinator(loadConfig());
    await coordinator.start({ client, scheduler, store: { dataCollection: json } });
    assert.equal(scheduler.descriptors.length, 0);
    assert.equal(fetches, 0);
    await coordinator.stop();
});
