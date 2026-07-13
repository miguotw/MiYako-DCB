const assert = require('node:assert/strict');
const test = require('node:test');
const command = require('../src/commands/packageTracking');
const { createPackageNotificationActionsRows } = require('../util/getPackageTracking');

test('所有既有包裹操作按鈕都攜帶 package ID', () => {
    const record = { userPackageID: 'package-1' };
    const activeIDs = createPackageNotificationActionsRows(record)
        .flatMap(row => row.components.map(component => component.data.custom_id))
        .filter(id => id && id !== 'package_panel_add:detached');
    assert.deepEqual(activeIDs, [
        'package_panel_refresh:package-1',
        'package_panel_note:package-1',
        'package_panel_archive:package-1'
    ]);

    const archivedIDs = command._test.createArchivedActionsRows(record)
        .flatMap(row => row.components.map(component => component.data.custom_id))
        .filter(id => id && id !== 'package_panel_add:detached');
    assert.deepEqual(archivedIDs, ['package_panel_wake:package-1', 'package_panel_delete:package-1']);
});

test('物流 action customId 必須包含 package ID 並通過 owner 驗證', () => {
    const interaction = {
        customId: 'package_panel_refresh:package-1',
        user: { id: '11111111111111111' }
    };
    const ownerRecord = { userID: interaction.user.id, userPackageID: 'package-1', status: 'active' };
    assert.equal(
        command._test.getTargetRecord(interaction, 'package_panel_refresh', ['active'], () => ownerRecord),
        ownerRecord
    );
    assert.equal(
        command._test.getTargetRecord(interaction, 'package_panel_refresh', ['active'], () => ({ ...ownerRecord, userID: '22222222222222222' })),
        null
    );
    assert.equal(
        command._test.getTargetRecord({ ...interaction, customId: 'package_panel_refresh' }, 'package_panel_refresh', ['active'], () => ownerRecord),
        null
    );
});

test('非 owner 與舊按鈕在 acknowledgement 前只收到私密驗證回覆', async () => {
    for (const customId of ['package_panel_refresh:missing-package', 'package_panel_refresh']) {
        const calls = [];
        const interaction = {
            customId,
            user: { id: '99999999999999999' },
            deferred: false,
            replied: false,
            reply: async payload => calls.push(['reply', payload]),
            deferUpdate: async () => calls.push(['deferUpdate']),
            update: async payload => calls.push(['update', payload]),
            editReply: async payload => calls.push(['editReply', payload])
        };
        await command.buttonHandlers.package_panel_refresh(interaction);
        assert.equal(calls[0][0], 'reply');
        assert.equal(calls[0][1].flags, 64);
        assert.equal(calls.some(([method]) => ['deferUpdate', 'update', 'editReply'].includes(method)), false);
    }
});
