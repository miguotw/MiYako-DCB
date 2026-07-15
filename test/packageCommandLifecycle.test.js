'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../core/config');
const { createHttpClient, setDefaultHttpClient } = require('../core/http');
const { createStoreRegistry } = require('../core/storeRegistry');
const { createPackageTrackingRepository } = require('../util/packageTrackingRepository');
const { createPackageTrackingTools } = require('../util/getPackageTracking');
const { createCommand } = require('../src/commands/packageTracking');

function createInteraction() {
    const calls = [];
    const fields = { trackingNumber: 'TRACK123', note: '測試備註' };
    return {
        client: { isReady: () => false },
        user: { id: 'package-owner', tag: 'owner#0001' },
        guildId: 'package-guild', channelId: 'package-channel',
        message: { id: 'package-panel' },
        customId: '', values: [], deferred: false, replied: false, calls,
        fields: { getTextInputValue: id => fields[id] ?? '' },
        setFields(values) { Object.assign(fields, values); },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); return payload; },
        async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
        async deferUpdate() { this.deferred = true; calls.push(['deferUpdate']); },
        async editReply(payload) { calls.push(['editReply', payload]); return payload; },
        async followUp(payload) { calls.push(['followUp', payload]); return payload; },
        async update(payload) { calls.push(['update', payload]); return payload; },
        async showModal(payload) { calls.push(['showModal', payload]); return payload; }
    };
}

function packageData(status = '運送中') {
    return {
        tracking_number: 'TRACK123', carrier: { name: '測試物流' }, short_url: { identifier: 'short' },
        package_history: [
            { status, delivery_stage: 'shipping', checkpoint_status: 'moving', time: 1_720_000_000 },
            { status: '[已收件](https://unsafe.example)', created_at: '2026-07-13T00:00:00.000Z' }
        ]
    };
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => {
    setDefaultHttpClient(createHttpClient({ transport: async () => { throw new Error('測試結束後禁止 HTTP'); } }));
    test.mock.restoreAll();
});

test('物流多步互動從新增到刪除皆以 owner ID 與 package ID 直接定位', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-package-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const context = { store };
    const localConfig = structuredClone(loadConfig());
    localConfig.commands.packageTracking.trackTwToken = 'test-track-token';
    let latestStatus = '運送中';
    const stateChanges = [];
    setDefaultHttpClient(createHttpClient({ transport: async request => {
        if (request.url.endsWith('/carrier/available')) {
            return { data: [{ id: 'carrier-1', name: '測試物流', requirements: [] }] };
        }
        if (request.url.endsWith('/carrier/detect')) return { data: { carriers: ['carrier-1'] } };
        if (request.url.endsWith('/package/import')) {
            assert.equal(request.data.notify_state, 'inactive');
            return { data: { TRACK123: 'package-1' } };
        }
        if (request.url.includes('/package/tracking/')) return { data: packageData(latestStatus) };
        if (request.url.includes('/package/state/')) {
            stateChanges.push(request.url.split('/').at(-1));
            return { data: { ok: true } };
        }
        throw new Error(`未預期的 Track.TW 請求：${request.method} ${request.url}`);
    } }));

    const command = createCommand(localConfig);
    const interaction = createInteraction();
    await command.execute(interaction, context);
    assert.equal(interaction.calls.at(-1)[0], 'reply');

    interaction.customId = 'package_panel_add';
    await command.buttonHandlers.package_panel_add(interaction, context);
    interaction.customId = 'package_panel_add_modal';
    interaction.deferred = false;
    await command.modalSubmitHandlers.package_panel_add_modal(interaction, context);

    const repository = createPackageTrackingRepository(store.packageTracking, { maxActivePackages: 20 });
    let record = await repository.getPackage(interaction.user.id, 'package-1');
    assert.equal(record.status, 'active');
    assert.equal(record.userID, interaction.user.id);

    interaction.customId = 'package_panel_active';
    await command.buttonHandlers.package_panel_active(interaction, context);
    interaction.customId = 'package_panel_select_active_package';
    interaction.values = ['package-1'];
    latestStatus = '抵達配送站';
    await command.componentHandlers.package_panel_select_active_package(interaction, context);

    interaction.customId = 'package_panel_note:package-1';
    await command.buttonHandlers.package_panel_note(interaction, context);
    interaction.customId = 'package_panel_note_modal:package-1';
    interaction.setFields({ note: '更新後備註' });
    await command.modalSubmitHandlers.package_panel_note_modal(interaction, context);
    assert.equal((await repository.getPackage(interaction.user.id, 'package-1')).note, '更新後備註');

    interaction.customId = 'package_panel_refresh:package-1';
    await command.buttonHandlers.package_panel_refresh(interaction, context);
    interaction.customId = 'package_panel_archive:package-1';
    await command.buttonHandlers.package_panel_archive(interaction, context);
    assert.equal((await repository.getPackage(interaction.user.id, 'package-1')).status, 'archived');

    interaction.customId = 'package_panel_archived';
    await command.buttonHandlers.package_panel_archived(interaction, context);
    interaction.customId = 'package_panel_select_archived_package';
    interaction.values = ['package-1'];
    await command.componentHandlers.package_panel_select_archived_package(interaction, context);

    interaction.customId = 'package_panel_wake:package-1';
    await command.buttonHandlers.package_panel_wake(interaction, context);
    assert.equal((await repository.getPackage(interaction.user.id, 'package-1')).status, 'active');

    interaction.customId = 'package_panel_archive:package-1';
    await command.buttonHandlers.package_panel_archive(interaction, context);
    assert.equal((await repository.getPackage(interaction.user.id, 'package-1')).status, 'archived');

    interaction.customId = 'package_panel_delete_archived';
    interaction.deferred = false;
    interaction.replied = false;
    await command.buttonHandlers.package_panel_delete_archived(interaction, context);
    const deleteMenu = interaction.calls.at(-1)[1];
    assert.equal(deleteMenu.components[0].components[0].data.custom_id, 'package_panel_delete_archived_select');
    interaction.customId = 'package_panel_delete_archived_select';
    interaction.values = ['package-1'];
    await command.componentHandlers.package_panel_delete_archived_select(interaction, context);
    const deleteModal = interaction.calls.filter(([name]) => name === 'showModal').at(-1)[1];
    interaction.customId = deleteModal.data.custom_id;
    interaction.setFields({ confirmation: 'y' });
    interaction.deferred = false;
    await command.modalSubmitHandlers.package_panel_delete_confirm(interaction, context);
    assert.equal(await repository.getPackage(interaction.user.id, 'package-1'), null);
    assert.deepEqual(stateChanges, ['archive', 'inbox', 'archive', 'delete']);

    interaction.deferred = false;
    interaction.replied = false;
    await command.modalSubmitHandlers.package_panel_delete_confirm(interaction, context);
    assert.deepEqual(stateChanges, ['archive', 'inbox', 'archive', 'delete'], '重放不得再次呼叫遠端刪除');
});

test('封存包裹刪除選單完整分頁，遠端失敗時保留本機資料', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-package-delete-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const context = { store };
    const localConfig = structuredClone(loadConfig());
    localConfig.commands.packageTracking.trackTwToken = 'test-track-token';
    const command = createCommand(localConfig);
    const records = Array.from({ length: 51 }, (_, index) => ({
        userID: 'package-owner', userPackageID: `archived-${index}`,
        carrierName: '測試物流', trackingNumber: `TRACK-${index}`,
        note: '', status: 'archived', updatedAt: new Date(51 - index).toISOString()
    }));
    await store.packageTracking.write('package-owner', { packages: records, reservations: [], outbox: [] });

    const lastPage = command._test.createArchivedDeletePayload(records, 2);
    assert.match(lastPage.embeds[0].data.description, /3 \/ 3/);
    assert.equal(lastPage.components[0].components[0].options.length, 1);
    assert.equal(lastPage.components[0].components[0].data.min_values, 1);
    assert.equal(lastPage.components[0].components[0].data.max_values, 1);

    setDefaultHttpClient(createHttpClient({ transport: async request => {
        if (request.url.includes('/package/state/')) throw new Error('Track.TW 暫時失敗');
        throw new Error(`未預期請求 ${request.url}`);
    } }));
    const interaction = createInteraction();
    interaction.customId = 'package_panel_delete:archived-0';
    await command.buttonHandlers.package_panel_delete(interaction, context);
    const modal = interaction.calls.filter(([name]) => name === 'showModal').at(-1)[1];
    interaction.customId = modal.data.custom_id;
    interaction.setFields({ confirmation: 'Y' });
    await command.modalSubmitHandlers.package_panel_delete_confirm(interaction, context);

    const repository = createPackageTrackingRepository(store.packageTracking);
    assert.equal((await repository.getPackage(interaction.user.id, 'archived-0')).status, 'archived');

    interaction.setFields({ confirmation: 'y' });
    interaction.deferred = false;
    interaction.replied = false;
    await command.modalSubmitHandlers.package_panel_delete_confirm(interaction, context);

    assert.equal((await repository.getPackage(interaction.user.id, 'archived-0')).status, 'archived');
});

test('多物流商 session 與額外欄位流程拒絕重放並完成匯入', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-package-session-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const context = { store };
    const localConfig = structuredClone(loadConfig());
    localConfig.commands.packageTracking.trackTwToken = 'test-track-token';
    let detection = 'multiple';
    let sequence = 0;
    const carriers = [
        { id: 'carrier-1', name: '一般物流', requirements: [] },
        { id: 'carrier-extra', name: '海關物流', requirements: [{ key: 'identity', desc: '身分末四碼', regex: '^\\d{4}$', placeholder: '1234' }] }
    ];
    setDefaultHttpClient(createHttpClient({ transport: async request => {
        if (request.url.endsWith('/carrier/available')) return { data: carriers };
        if (request.url.endsWith('/carrier/detect')) {
            return { data: { carriers: detection === 'multiple' ? ['carrier-1', 'carrier-extra'] : ['carrier-extra'] } };
        }
        if (request.url.endsWith('/package/import')) {
            sequence += 1;
            const tracking = request.data.tracking_number[0].split(',')[0];
            return { data: { [tracking]: `session-package-${sequence}` } };
        }
        if (request.url.includes('/package/tracking/')) return { data: packageData('已匯入') };
        throw new Error(`未預期請求 ${request.url}`);
    } }));

    const command = createCommand(localConfig);
    const interaction = createInteraction();
    interaction.customId = 'package_panel_add_modal';
    await command.modalSubmitHandlers.package_panel_add_modal(interaction, context);
    const carrierPayload = interaction.calls.filter(([name]) => name === 'editReply').at(-1)[1];
    const selectID = carrierPayload.components[0].components[0].data.custom_id;
    interaction.customId = selectID;
    interaction.values = ['0'];
    await command.componentHandlers.package_panel_select_carrier(interaction, context);

    // 同一 session 第二次使用時 stage 已不是 carrier，因此必須以私密驗證拒絕。
    await command.componentHandlers.package_panel_select_carrier(interaction, context);
    assert.equal(interaction.calls.at(-1)[0], 'followUp');

    detection = 'extra';
    interaction.setFields({ trackingNumber: 'EXTRA123', note: '' });
    interaction.customId = 'package_panel_add_modal:detached';
    interaction.deferred = false;
    await command.modalSubmitHandlers.package_panel_add_modal(interaction, context);
    const extraPayload = interaction.calls.filter(([name]) => name === 'editReply').at(-1)[1];
    const extraButtonID = extraPayload.components[0].components[0].data.custom_id;
    interaction.customId = extraButtonID;
    interaction.message.id = 'detached-message';
    await command.buttonHandlers.package_panel_extra_fields(interaction, context);
    const modal = interaction.calls.filter(([name]) => name === 'showModal').at(-1)[1];
    interaction.customId = modal.data.custom_id;
    interaction.setFields({ identity: '1234' });
    await command.modalSubmitHandlers.package_panel_extra_fields_modal(interaction, context);

    const repository = createPackageTrackingRepository(store.packageTracking);
    assert.equal((await repository.listPackages({ ownerID: interaction.user.id })).length, 2);
});

test('Track.TW view helpers 正規化歷史、按鈕與本機 snapshot', () => {
    const localConfig = structuredClone(loadConfig());
    localConfig.commands.packageTracking.trackTwToken = 'test-track-token';
    const tools = createPackageTrackingTools(localConfig);
    assert.equal(tools.hasTrackTwToken(), true);
    assert.equal(tools.getPackageTrackingConfig().archiveAfterDays > 0, true);
    const data = packageData('非常非常非常非常非常非常非常非常長的貨態 | https://unsafe.example');
    assert.match(tools.createHistorySignature(data), /已收件|shipping/);
    const record = tools.createPackageRecord({
        interaction: createInteraction(), carrier: { id: 'c', name: 'Carrier' },
        trackingNumber: 'TRACK', note: 'note', userPackageID: 'p', packageData: data
    });
    assert.equal(tools.createPackageEmbed(record, data).data.fields.length, 5);
    assert.equal(tools.createStoredPackageEmbed({ ...record, lastPackageData: null }).data.fields.length, 5);
    assert.equal(tools.withAddPackageRow([]).length, 1);
});
