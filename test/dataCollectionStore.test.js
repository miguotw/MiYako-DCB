const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const originalCwd = process.cwd();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-data-collection-'));
process.chdir(temporaryRoot);
const store = require('../util/dataCollectionStore');
process.chdir(originalCwd);

test.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

test('資料收集可建立、覆寫提交並刪除', () => {
    const record = store.createDataCollection('12345678901234567', {
        fieldLabels: ['姓名'], whitelistUserIDs: ['1']
    });
    store.updateDataCollection(record.guildID, record.id, current => {
        current.submissions['1'] = { values: ['第一次'], submittedAt: '2026-01-01T00:00:00.000Z' };
    });
    store.updateDataCollection(record.guildID, record.id, current => {
        current.submissions['1'].values = ['第二次'];
    });
    assert.deepEqual(store.getDataCollection(record.guildID, record.id).submissions['1'].values, ['第二次']);
    assert.equal(store.findDataCollection(record.id).id, record.id);
    assert.equal(store.deleteDataCollection(record.guildID, record.id).id, record.id);
    assert.equal(store.getDataCollection(record.guildID, record.id), null);
});

test('同一收集項目的鎖會依序執行', async () => {
    const order = [];
    await Promise.all([
        store.withCollectionLock('same', async () => { order.push(1); await new Promise(resolve => setTimeout(resolve, 10)); order.push(2); }),
        store.withCollectionLock('same', async () => { order.push(3); })
    ]);
    assert.deepEqual(order, [1, 2, 3]);
});
