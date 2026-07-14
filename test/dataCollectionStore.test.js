'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { createDataCollectionRepository } = require('../util/dataCollectionRepository');

test('資料收集以 runtime repository 建立、覆寫提交並刪除', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-data-collection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repository = createDataCollectionRepository(createJsonRepository({ directory: path.join(root, 'data') }));
    const record = await repository.create('12345678901234567', {
        fieldLabels: ['姓名'], whitelistUserIDs: ['1']
    });
    await repository.update(record.guildID, record.id, current => {
        current.submissions['1'] = { values: ['第一次'], submittedAt: '2026-01-01T00:00:00.000Z' };
    });
    await repository.update(record.guildID, record.id, current => { current.submissions['1'].values = ['第二次']; });
    assert.deepEqual((await repository.get(record.guildID, record.id)).submissions['1'].values, ['第二次']);
    assert.equal((await repository.find(record.id)).id, record.id);
    assert.equal((await repository.remove(record.guildID, record.id)).id, record.id);
    assert.equal(await repository.get(record.guildID, record.id), null);
});
