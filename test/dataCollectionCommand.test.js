const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../core/config');
const config = loadConfig();
const command = require('../src/commands/admin/dataCollection').createCommand(config);
const { createMentionBatches, paginateLines, sanitizeCell } = require('../util/dataCollectionViews').createDataCollectionViews(config);

test('/admin 資料收集參數結構正確', () => {
    const json = command.data.toJSON();
    const options = Object.fromEntries(json.options.map(option => [option.name, option]));
    assert.equal(json.name, '資料收集');
    assert.equal(options['訊息id或連結'].required, true);
    assert.equal(options['選擇頻道'].required, true);
    assert.equal(options['截止時間'].required, true);
    assert.equal(options['白名單'].required, true);
    assert.equal(options['資料1'].required, true);
    assert.equal(options['管理面板'].required, true);
    assert.deepEqual(options['管理面板'].choices.map(({ name, value }) => ({ name, value })), [
        { name: '目前頻道', value: 'channel' },
        { name: '私信我', value: 'dm' }
    ]);
    assert.equal(options['資料2'].required, false);
    assert.equal(options['資料5'].max_length, 10);
    assert.ok(json.options.findIndex(option => option.name === '管理面板') < json.options.findIndex(option => option.name === '資料1'));
});

test('資料標題與提交長度設定會套用安全範圍', () => {
    assert.deepEqual(command._test.getDataCollectionLimits({}), { titleMaxLength: 10, submissionMaxLength: 20 });
    assert.deepEqual(command._test.getDataCollectionLimits({ titleMaxLength: 20, submissionMaxLength: 500 }), {
        titleMaxLength: 20, submissionMaxLength: 500
    });
    assert.deepEqual(command._test.getDataCollectionLimits({ titleMaxLength: 99, submissionMaxLength: 9999 }), {
        titleMaxLength: 45, submissionMaxLength: 700
    });
});

test('截止時間先按主機本機時間解析，再扣除人工校正量', () => {
    const base = command._test.parseDeadline('2026-08-01 20:30', 0);
    assert.equal(base, new Date(2026, 7, 1, 20, 30).getTime() / 1000);
    assert.equal(command._test.parseDeadline('2026-08-01 20:30', 1) - base, -3600);
    assert.equal(command._test.parseDeadline('2026-08-01 20:30', -2) - base, 7200);
    assert.equal(command._test.parseDeadline('2026-02-30 20:30', 0), null);
});

test('白名單只接受提及並去重', () => {
    assert.deepEqual(command._test.parseMentionTargets('<@12345678901234567> <@&23456789012345678> <@12345678901234567>'), [
        { type: 'user', id: '12345678901234567' },
        { type: 'role', id: '23456789012345678' }
    ]);
    assert.throws(() => command._test.parseMentionTargets('12345678901234567'), /不接受純數字 ID/);
});

test('建立流程同時保留原始提及目標與展開後用戶', async () => {
    const result = await command._test.buildWhitelist(null, '<@12345678901234567> <@&23456789012345678>', async (_interaction, targets) => {
        assert.equal(targets.length, 2);
        return ['12345678901234567', '34567890123456789'];
    });
    assert.deepEqual(result, {
        targets: [
            { type: 'user', id: '12345678901234567' },
            { type: 'role', id: '23456789012345678' }
        ],
        userIDs: ['12345678901234567', '34567890123456789']
    });
});

test('白名單提及會依一般訊息長度分批', () => {
    const batches = createMentionBatches(
        [{ type: 'user', id: '12345678901234567' }, { type: 'role', id: '23456789012345678' }], 25
    );
    assert.deepEqual(batches, [
        { content: '<@12345678901234567>', userIDs: ['12345678901234567'], roleIDs: [] },
        { content: '<@&23456789012345678>', userIDs: [], roleIDs: ['23456789012345678'] }
    ]);
});

test('管理面板內容會逸出並依長度分頁', () => {
    assert.equal(sanitizeCell('**粗體** | 下一欄'), '\\*\\*粗體\\*\\* ｜ 下一欄');
    const pages = paginateLines(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)], 65);
    assert.deepEqual(pages.map(page => page.length), [61, 30]);
    assert.deepEqual(paginateLines(['x'.repeat(80)], 30).map(page => page.length), [30, 30, 20]);
});
