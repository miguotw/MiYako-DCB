'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Collection, Events } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createLogger } = require('../core/logger');
const { createStoreRegistry } = require('../core/storeRegistry');
const { createFeature } = require('../src/features/factory');
const { createManifest: createDataCollectionManifest } = require('../src/features/dataCollection');
const { createManifest: createPresenceManifest } = require('../src/features/presence');
const { createManifest: createRaffleManifest } = require('../src/features/raffle');
const { createInitializer: createMemberLifecycle } = require('../src/modules/event/member_lifecycle');
const { createInitializer: createKeywordInitializer } = require('../src/modules/event/keywords');
const { createInitializer: createMemberLogger } = require('../src/modules/logger/member');
const { createInitializer: createMessageLogger } = require('../src/modules/logger/message');
const { createInitializer: createRoleLogger } = require('../src/modules/logger/role');
const { createInitializer: createVoiceLogger } = require('../src/modules/logger/voice');

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.channels = { cache: new Collection() };
    }
    isReady() { return false; }
}

const config = loadConfig();

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => test.mock.restoreAll());

test('logger facade 與四種 Discord logger listener 都可啟動並處理事件', async () => {
    const client = new FakeClient();
    const logger = createLogger(config);
    logger.attachClient(client);
    logger.info('info');
    logger.warn('warn', { error: new Error('warning') });
    logger.error('error', new Error('failure'));

    createMemberLogger(config)(client);
    createMessageLogger(config)(client);
    createRoleLogger(config)(client);
    createVoiceLogger(config)(client);

    const member = { user: { username: 'Member', tag: 'Member#1' }, guild: { name: 'Guild' } };
    client.emit(Events.GuildMemberAdd, member);
    client.emit(Events.GuildMemberRemove, member);
    client.emit(Events.MessageCreate, { author: { bot: false, tag: 'User#1' }, channel: { name: 'general' }, content: 'hello' });
    client.emit(Events.MessageUpdate,
        { author: { bot: false, tag: 'User#1' }, channel: { name: 'general' }, content: 'old' },
        { content: 'new' });
    client.emit(Events.MessageDelete, { author: { bot: false, tag: 'User#1' }, channel: { name: 'general' }, content: '' });

    const role = (name, permissions = []) => ({ name, permissions: { toArray: () => permissions } });
    client.emit(Events.GuildMemberUpdate,
        { roles: { cache: new Collection([['old', role('Old', ['ViewChannel'])]]) } },
        { user: { tag: 'User#1' }, roles: { cache: new Collection([['new', role('New', ['SendMessages'])]]) } });
    client.emit(Events.VoiceStateUpdate,
        { channel: null },
        { member: { user: { tag: 'User#1' } }, channel: { id: 'a', name: 'Alpha' } });
    client.emit(Events.VoiceStateUpdate,
        { channel: { id: 'a', name: 'Alpha' } },
        { member: { user: { tag: 'User#1' } }, channel: null });
    client.emit(Events.VoiceStateUpdate,
        { channel: { id: 'a', name: 'Alpha' } },
        { member: { user: { tag: 'User#1' } }, channel: { id: 'b', name: 'Beta' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(client.eventNames().length >= 6);
});

test('member lifecycle 註冊加入離開通知，缺少 system channel 時安全略過', async () => {
    const client = new FakeClient();
    createMemberLifecycle(config)(client);
    const sent = [];
    const member = {
        user: { username: 'NewUser', displayAvatarURL: () => 'https://example.test/avatar.png' },
        guild: { name: 'Guild', systemChannel: { send: async payload => sent.push(payload) } }
    };
    client.emit(Events.GuildMemberAdd, member);
    client.emit(Events.GuildMemberRemove, member);
    client.emit(Events.GuildMemberAdd, { ...member, guild: { ...member.guild, systemChannel: null } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2);
});

test('manifest lifecycle 只啟動一次、追蹤新增 listener 並在停止時清除', async () => {
    const client = new FakeClient();
    let starts = 0;
    let stops = 0;
    const feature = createFeature({
        name: 'lifecycle-test',
        command: null,
        initializer: async value => {
            starts += 1;
            value.on('custom', () => {});
            return async () => { stops += 1; };
        }
    });
    const context = { client };
    await feature.start(context);
    await feature.start(context);
    assert.equal(starts, 1);
    assert.equal(client.listenerCount('custom'), 1);
    await feature.stop(context);
    await feature.stop(context);
    assert.equal(stops, 1);
    assert.equal(client.listenerCount('custom'), 0);
});

test('feature command 與 interaction descriptor 將 context 原樣傳給 handler', async () => {
    const calls = [];
    const command = {
        data: { toJSON: () => ({ name: 'descriptor-test' }) },
        execute: async (...args) => calls.push(['command', ...args]),
        buttonHandlers: { descriptor_button: async (...args) => calls.push(['button', ...args]) }
    };
    const feature = createFeature({ name: 'descriptor-test', command });
    const interaction = { id: 'interaction' };
    const context = { id: 'context' };
    await feature.commands[0].execute(interaction, context);
    await feature.interactions[0].execute(interaction, context);
    assert.deepEqual(calls.map(call => call[0]), ['command', 'button']);
    assert.equal(calls[0][2], context);
    assert.equal(calls[1][2], context);
});

test('presence 與 keyword initializer 只使用注入 transport，停止後移除 listener', async () => {
    const client = new FakeClient();
    const activities = [];
    client.user = {
        setActivity: (...args) => activities.push(['activity', ...args]),
        setStatus: value => activities.push(['status', value])
    };
    const presence = createPresenceManifest(config);
    await presence.start({
        client,
        signal: new AbortController().signal,
        http: { get: async () => ({ data: { hitokoto: '測試狀態', from: '來源' } }) }
    });
    await presence.stop({ client });
    assert.equal(activities.length, 2);

    const keyword = createKeywordInitializer(config);
    const stop = keyword(client);
    const message = {
        guildId: 'guild', author: { bot: false, tag: 'User#1' }, content: '早安',
        channel: { id: 'channel', name: 'general', send: async () => {} }, react: async () => {}, client
    };
    client.emit(Events.MessageCreate, message);
    await new Promise(resolve => setImmediate(resolve));
    stop();
    assert.equal(client.listenerCount(Events.MessageCreate), 0);
});

test('deadline feature manifest 可在空 repository 啟動並反向停止', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-empty-deadlines-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const context = {
        client: new FakeClient(),
        store: createStoreRegistry({ dataRoot: root }),
        scheduler: {
            scheduleDeadline() {
                return { reschedule() {}, async stop() {} };
            }
        }
    };
    for (const manifest of [createDataCollectionManifest(config), createRaffleManifest(config)]) {
        await manifest.start(context);
        await manifest.stop(context);
    }
});
