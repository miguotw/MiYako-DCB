'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Collection, PermissionFlagsBits } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createStoreRegistry } = require('../core/storeRegistry');
const { createDataCollectionRepository } = require('../util/dataCollectionRepository');
const { createRaffleRepository } = require('../util/raffleRepository');
const { createCommand: createDataCollectionCommand } = require('../src/commands/admin/dataCollection');
const { createCommand: createRaffleCommand } = require('../src/commands/admin/raffle');

function createChannel(id, sourceMessage) {
    const messages = new Collection();
    let sequence = 0;
    const channel = {
        id,
        isTextBased: () => true,
        toString: () => `<#${id}>`,
        messages: {
            fetch: async messageID => messageID === sourceMessage.id ? sourceMessage : messages.get(messageID) || null
        },
        async send(payload) {
            const message = {
                id: `${id}-message-${++sequence}`, channelId: id, payload,
                edit: async next => { message.payload = next; return message; },
                delete: async () => { messages.delete(message.id); }
            };
            messages.set(message.id, message);
            return message;
        }
    };
    return channel;
}

function createInteraction({ values = {}, channel, publicChannel, sourceMessage, userID = '12345678901234567' }) {
    const calls = [];
    const fields = {};
    const user = {
        id: userID, tag: 'Admin#0001', username: 'Admin', bot: false,
        send: async payload => { calls.push(['dm', payload]); return payload; },
        createDM: async () => channel
    };
    const member = { id: userID, user };
    const guild = {
        id: 'guild-admin',
        members: {
            cache: new Collection([[userID, member]]),
            fetch: async id => id ? member : new Collection([[userID, member]])
        },
        roles: { cache: new Collection() },
        channels: { fetch: async id => id === publicChannel.id ? publicChannel : channel }
    };
    const client = {
        isReady: () => false,
        channels: { fetch: async id => id === publicChannel.id ? publicChannel : channel }
    };
    return {
        client, guild, guildId: guild.id, channelId: channel.id, channel, user,
        memberPermissions: { has: permission => permission === PermissionFlagsBits.Administrator },
        message: { edit: async payload => { calls.push(['message.edit', payload]); return payload; } },
        customId: '', deferred: false, replied: false, calls,
        options: {
            getString: name => values[name] ?? null,
            getChannel: name => name === '選擇頻道' ? publicChannel : values[name] ?? null,
            getInteger: name => values[name] ?? null,
            getBoolean: name => values[name] ?? null,
            getRole: name => values[name] ?? null
        },
        fields: { getTextInputValue: id => fields[id] ?? '' },
        setFields(next) { Object.assign(fields, next); },
        inGuild: () => true,
        async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); return payload; },
        async editReply(payload) { this.replied = true; calls.push(['editReply', payload]); return payload; },
        async followUp(payload) { calls.push(['followUp', payload]); return payload; },
        async showModal(payload) { calls.push(['showModal', payload]); return payload; },
        sourceMessage
    };
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => test.mock.restoreAll());

test('資料收集建立、白名單提交、管理面板同步與人工刪除', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-data-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const context = { store };
    const sourceMessage = {
        id: '34567890123456789', channelId: 'admin-channel', content: '請填寫以下資料',
        attachments: new Collection([['image', { contentType: 'image/png', url: 'https://example.test/form.png' }]])
    };
    const adminChannel = createChannel('admin-channel', sourceMessage);
    const publicChannel = createChannel('public-channel', sourceMessage);
    const values = {
        '訊息id或連結': sourceMessage.id,
        '截止時間': '2099-12-31 23:59',
        '白名單': '<@12345678901234567>',
        '管理面板': 'channel',
        '資料1': '姓名',
        '資料2': '聯絡方式'
    };
    let scheduled = null;
    const command = createDataCollectionCommand(loadConfig(), { scheduleCollection: record => { scheduled = record; } });
    const create = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    await command.execute(create, context);
    assert.ok(scheduled?.id);

    const repository = createDataCollectionRepository(store.dataCollection);
    let record = (await repository.list())[0];
    assert.equal(record.status, 'open');
    assert.equal(record.adminSyncPending, false);

    const submit = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    submit.customId = `data_collection_submit:${record.id}`;
    await command.publicButtonHandlers.data_collection_submit(submit, context);
    assert.equal(submit.calls.at(-1)[0], 'showModal');

    const modal = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    modal.customId = `data_collection_modal:${record.id}`;
    modal.setFields({ data_1: '王小明', data_2: 'test@example.test' });
    await command.publicModalSubmitHandlers.data_collection_modal(modal, context);
    record = await repository.get(create.guildId, record.id);
    assert.deepEqual(record.submissions[create.user.id].values, ['王小明', 'test@example.test']);
    assert.equal(modal.calls.some(([name]) => name === 'dm'), true);

    const deleteButton = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    deleteButton.customId = `data_collection_delete:${record.id}`;
    await command.publicButtonHandlers.data_collection_delete(deleteButton, context);
    assert.equal(deleteButton.calls.at(-1)[0], 'showModal');

    const deletion = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    deletion.customId = `data_collection_delete_modal:${record.id}`;
    deletion.setFields({ confirmation: 'y' });
    await command.publicModalSubmitHandlers.data_collection_delete_modal(deletion, context);
    assert.equal(await repository.get(create.guildId, record.id), null);
});

test('抽選建立後參與按鈕可加入及取消，結果更新同一則 Discord 訊息', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-raffle-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const context = { store };
    const sourceMessage = {
        id: '34567890123456789', channelId: 'admin-channel', content: '抽選介紹',
        attachments: new Collection()
    };
    const adminChannel = createChannel('admin-channel', sourceMessage);
    const publicChannel = createChannel('raffle-channel', sourceMessage);
    const values = {
        '訊息id或連結': sourceMessage.id,
        '截止時間': '2099-12-31 23:59',
        '抽選數量': 2,
        '自動抽選': true,
        '白名單': '',
        '黑名單': ''
    };
    let scheduled = null;
    const command = createRaffleCommand(loadConfig(), { scheduleRaffle: record => { scheduled = record; } });
    const create = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    await command.execute(create, context);
    assert.ok(scheduled?.id);

    const repository = createRaffleRepository(store.raffle);
    const raffle = (await repository.list())[0];
    const join = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    join.customId = `raffle_join:${raffle.id}`;
    await command.publicButtonHandlers.raffle_join(join, context);
    assert.deepEqual((await repository.get(create.guildId, raffle.id)).participants, [join.user.id]);

    const cancel = createInteraction({ values, channel: adminChannel, publicChannel, sourceMessage });
    cancel.customId = `raffle_join:${raffle.id}`;
    await command.publicButtonHandlers.raffle_join(cancel, context);
    assert.deepEqual((await repository.get(create.guildId, raffle.id)).participants, []);
    assert.equal(cancel.calls.some(([name]) => name === 'message.edit'), true);
});
