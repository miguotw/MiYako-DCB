'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonRepository } = require('../core/jsonRepository');
const { loadConfig } = require('../core/config');
const { createInitializer: createKeywordInitializer } = require('../src/modules/event/keywords');
const { createInitializer: createTemporaryVoiceInitializer } = require('../src/modules/event/temporary_voice');
const { createTemporaryVoiceRepository } = require('../util/temporaryVoiceRepository');

test('關鍵字同一 guild/channel/group 最多一個 pending，不同 key 互不阻塞', async () => {
    const config = structuredClone(loadConfig());
    config.modules.keywords.cooldown = 1000;
    const tools = createKeywordInitializer(config)._test;
    let release;
    const sent = [];
    const group = { reaction: [], message: ['response'] };
    const createMessage = (guildId, channelId) => ({
        guildId,
        channel: {
            id: channelId,
            name: channelId,
            send: value => new Promise(resolve => {
                sent.push(`${channelId}:${value}`);
                release ||= resolve;
            })
        },
        author: { tag: 'user' },
        client: {},
        react: async () => {}
    });
    const firstMessage = createMessage('guild', 'channel');
    const first = tools.respond(firstMessage, 'group', group, 'keyword');
    const duplicate = await tools.respond(firstMessage, 'group', group, 'keyword');
    const other = tools.respond(createMessage('guild', 'other'), 'group', { reaction: [], message: [] }, 'keyword');
    assert.equal(duplicate, false);
    assert.equal(await other, true);
    assert.equal(sent.length, 1);
    release();
    assert.equal(await first, true);
});

test('臨時語音刪除前成員返回時不刪頻道並提高 generation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-temp-voice-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const json = createJsonRepository({ directory: path.join(root, 'voice'), schemaVersion: 1 });
    const repository = createTemporaryVoiceRepository(json);
    const scheduled = [];
    const scheduler = {
        scheduleDeadline(descriptor) {
            scheduled.push(descriptor);
            return { reschedule() {}, async stop() {}, trigger: () => descriptor.run() };
        }
    };
    const listeners = new Map();
    let deletes = 0;
    const channel = { id: 'channel', type: 2, members: { size: 1 }, delete: async () => { deletes += 1; } };
    const guild = {
        id: 'guild',
        channels: { cache: new Map([['channel', channel]]), fetch: async () => channel }
    };
    const client = {
        guilds: { cache: new Map([['guild', guild]]) },
        on: (event, listener) => listeners.set(event, listener),
        off: event => listeners.delete(event)
    };
    const initializer = createTemporaryVoiceInitializer(loadConfig());
    const stop = await initializer(client, { scheduler, store: { temporaryVoice: json } });
    await repository.addChannel('guild', 'channel', { emptySince: new Date(0).toISOString(), generation: 1 });
    await initializer._test.deleteIfStillEmpty(client, 'guild', 'channel', { generation: 1 });
    const record = (await repository.readGuild('guild')).channels.channel;
    assert.equal(deletes, 0);
    assert.equal(record.emptySince, null);
    assert.equal(record.generation, 2);
    await stop();
});

test('臨時語音暫時性 fetch 錯誤會保存 retry 並重新排程', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-temp-voice-retry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const json = createJsonRepository({ directory: path.join(root, 'voice'), schemaVersion: 1 });
    const repository = createTemporaryVoiceRepository(json);
    const scheduled = [];
    const scheduler = {
        scheduleDeadline(descriptor) {
            scheduled.push(descriptor);
            return { reschedule(value) { scheduled.push({ rescheduledAt: value }); }, async stop() {} };
        }
    };
    const guild = {
        id: 'guild',
        channels: {
            cache: new Map(),
            fetch: async () => { throw Object.assign(new Error('network'), { code: 'ECONNRESET' }); }
        }
    };
    const client = {
        guilds: { cache: new Map([['guild', guild]]) }, on() {}, off() {}
    };
    const initializer = createTemporaryVoiceInitializer(loadConfig());
    const stop = await initializer(client, { scheduler, store: { temporaryVoice: json } });
    await repository.addChannel('guild', 'channel', { emptySince: new Date().toISOString(), generation: 1 });
    await initializer._test.deleteIfStillEmpty(client, 'guild', 'channel', { generation: 1 });
    assert.equal((await repository.readGuild('guild')).channels.channel.retryAttempts, 1);
    assert.equal(scheduled.length, 1);
    await stop();
});
