'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ChannelType, Collection, PermissionFlagsBits } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createCommand } = require('../src/commands/globalAnnouncement');

const PROVIDER_ID = '123456789012345678';
const SOURCE_MESSAGE_ID = '34567890123456789';

function testConfig() {
    const config = structuredClone(loadConfig());
    config.startup.clientId = PROVIDER_ID;
    config.commands.about.provider = PROVIDER_ID;
    config.commands.globalAnnouncement.emoji = '📢';
    return config;
}

function embedDescription(payload) {
    return payload.embeds[0].data?.description ?? payload.embeds[0].description;
}

function createChannel({
    id,
    rawPosition = 0,
    nsfw = false,
    permissions = true,
    send
}) {
    const sent = [];
    return {
        id,
        type: ChannelType.GuildText,
        rawPosition,
        nsfw,
        sent,
        permissionsFor: () => ({
            has(permission) {
                assert.equal([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks
                ].includes(permission), true);
                return permissions;
            }
        }),
        async send(payload) {
            sent.push(payload);
            if (send) return send(payload);
            return { id: `message-${id}` };
        }
    };
}

function createGuild({ id = '111111111111111111', name = '測試伺服器', systemChannel = null, channels = [] } = {}) {
    return {
        id,
        name,
        systemChannel,
        members: { me: { id: '999999999999999999' } },
        channels: { cache: new Collection(channels.map(channel => [channel.id, channel])) }
    };
}

function createInteraction({ sourceMessage, guilds = [], customId = '', userID = PROVIDER_ID } = {}) {
    const replies = [];
    const message = sourceMessage || {
        id: SOURCE_MESSAGE_ID,
        content: '服務將於今晚進行維護。',
        attachments: new Collection([
            ['banner', { id: 'banner', contentType: 'image/png', url: 'https://example.test/banner.png' }]
        ])
    };
    const client = {
        isReady: () => false,
        user: {
            id: '999999999999999999',
            username: 'MiYako',
            displayAvatarURL: () => 'https://example.test/avatar.png'
        },
        guilds: { cache: new Collection(guilds.map(guild => [guild.id, guild])) },
        channels: { cache: new Collection() }
    };
    const sourceChannel = { messages: { fetch: async () => message } };
    return {
        client,
        customId,
        user: { id: userID, tag: 'provider#0001' },
        guildId: '111111111111111111',
        channel: sourceChannel,
        guild: { channels: { fetch: async () => sourceChannel } },
        options: { getString: () => SOURCE_MESSAGE_ID },
        deferred: false,
        replied: false,
        replies,
        async deferReply(payload) { this.deferred = true; replies.push(['deferReply', payload]); },
        async deferUpdate() { this.deferred = true; replies.push(['deferUpdate']); },
        async reply(payload) { this.replied = true; replies.push(['reply', payload]); return payload; },
        async editReply(payload) { this.replied = true; replies.push(['editReply', payload]); return payload; },
        async update(payload) { this.replied = true; replies.push(['update', payload]); return payload; }
    };
}

function confirmationId(interaction, action = 'confirm') {
    const preview = interaction.replies.find(([method]) => method === 'editReply')[1];
    const row = preview.components.at(-1);
    return row.components.find(component => component.custom_id.includes(action)).custom_id;
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => test.mock.restoreAll());

test('全域消息預覽包含主要內文、Bot 頭像、來源 Banner、說明與安裝按鈕', async () => {
    const config = testConfig();
    const command = createCommand(config, { randomUUID: () => 'preview-token' });
    const interaction = createInteraction();
    await command.execute(interaction, {});

    assert.equal(interaction.replies[0][0], 'deferReply');
    const preview = interaction.replies.at(-1)[1];
    assert.equal(preview.allowedMentions.parse.length, 0);
    assert.equal(preview.embeds[0].title, '📢 ┃ MiYako 最新消息');
    assert.equal(preview.embeds[0].thumbnail.url, 'https://example.test/avatar.png');
    assert.equal(preview.embeds[0].image.url, 'https://example.test/banner.png');
    assert.equal(preview.embeds[0].description, '服務將於今晚進行維護。');
    assert.equal(preview.embeds[0].footer.text, '這是一則自動消息，旨在傳達 MiYako 的最新消息或服務狀態。');
    assert.doesNotMatch(preview.embeds[0].footer.text, /<@|\*\*/);
    assert.equal(preview.components[0].components[0].label, '新增應用程式');
    assert.equal(preview.components[0].components[0].url, 'https://discord.com/oauth2/authorize?client_id=123456789012345678');
    assert.equal(preview.components[1].components[0].custom_id, 'global_announcement_confirm:preview-token');
});

test('預覽允許省略 Banner，但拒絕沒有主要內文的來源訊息', async () => {
    const config = testConfig();
    const command = createCommand(config);
    const withoutBanner = createInteraction({
        sourceMessage: { id: SOURCE_MESSAGE_ID, content: '純文字消息', attachments: new Collection() }
    });
    await command.execute(withoutBanner, {});
    assert.equal(withoutBanner.replies.at(-1)[1].embeds[0].image, undefined);

    const empty = createInteraction({
        sourceMessage: { id: SOURCE_MESSAGE_ID, content: '   ', attachments: new Collection() }
    });
    await command.execute(empty, {});
    assert.match(embedDescription(empty.replies.at(-1)[1]), /來源訊息必須包含主要文字內容/);
});

test('新預覽取代舊預覽，舊按鈕不會清除新 session，取消與過期均為單次操作', async () => {
    const config = testConfig();
    let currentTime = 1000;
    const tokens = ['old-token', 'new-token', 'expired-token'];
    const command = createCommand(config, {
        now: () => currentTime,
        randomUUID: () => tokens.shift()
    });

    const oldPreview = createInteraction();
    await command.execute(oldPreview, {});
    const newPreview = createInteraction();
    await command.execute(newPreview, {});
    const oldButton = createInteraction({ customId: confirmationId(oldPreview) });
    await command.buttonHandlers.global_announcement_confirm(oldButton, {});
    assert.match(embedDescription(oldButton.replies.at(-1)[1]), /已失效/);
    assert.equal(command._test.sessions.get(PROVIDER_ID).token, 'new-token');

    const cancel = createInteraction({ customId: confirmationId(newPreview, 'cancel') });
    await command.buttonHandlers.global_announcement_cancel(cancel, {});
    assert.match(embedDescription(cancel.replies.at(-1)[1]), /已取消/);
    assert.equal(command._test.sessions.size, 0);
    const duplicateCancel = createInteraction({ customId: cancel.customId });
    await command.buttonHandlers.global_announcement_cancel(duplicateCancel, {});
    assert.match(embedDescription(duplicateCancel.replies.at(-1)[1]), /已失效/);

    const expiring = createInteraction();
    await command.execute(expiring, {});
    currentTime += 10 * 60 * 1000;
    const expired = createInteraction({ customId: confirmationId(expiring) });
    await command.buttonHandlers.global_announcement_confirm(expired, {});
    assert.match(embedDescription(expired.replies.at(-1)[1]), /已失效/);
});

test('廣播優先系統頻道，安全備援排除 NSFW 並依頻道位置選擇', async () => {
    const command = createCommand(testConfig());
    const payload = { embeds: [], components: [], allowedMentions: { parse: [] } };
    const system = createChannel({ id: 'system', rawPosition: 10 });
    const unused = createChannel({ id: 'unused', rawPosition: 0 });
    const systemGuild = createGuild({ systemChannel: system, channels: [unused, system] });
    assert.equal((await command._test.sendToGuild(systemGuild, payload)).status, 'system');
    assert.equal(system.sent.length, 1);
    assert.equal(unused.sent.length, 0);

    const deniedSystem = createChannel({ id: 'denied', permissions: false });
    const nsfw = createChannel({ id: 'nsfw', rawPosition: 0, nsfw: true });
    const later = createChannel({ id: 'later', rawPosition: 2 });
    const first = createChannel({ id: 'first', rawPosition: 1 });
    const fallbackGuild = createGuild({
        id: '222222222222222222', systemChannel: deniedSystem, channels: [deniedSystem, nsfw, later, first]
    });
    const result = await command._test.sendToGuild(fallbackGuild, payload);
    assert.deepEqual({ status: result.status, channelId: result.channelId }, { status: 'fallback', channelId: 'first' });
    assert.equal(nsfw.sent.length + later.sent.length, 0);
    assert.equal(first.sent.length, 1);
});

test('系統頻道權限錯誤才切換備援，一般 API 錯誤不重複投遞', async () => {
    const command = createCommand(testConfig());
    const payload = { embeds: [], components: [], allowedMentions: { parse: [] } };
    const permissionSystem = createChannel({
        id: 'permission-system',
        send: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); }
    });
    const permissionFallback = createChannel({ id: 'permission-fallback' });
    const permissionGuild = createGuild({ systemChannel: permissionSystem, channels: [permissionSystem, permissionFallback] });
    const permissionResult = await command._test.sendToGuild(permissionGuild, payload);
    assert.equal(permissionResult.status, 'fallback');
    assert.equal(permissionFallback.sent.length, 1);

    const networkSystem = createChannel({
        id: 'network-system',
        send: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); }
    });
    const networkFallback = createChannel({ id: 'network-fallback' });
    const networkGuild = createGuild({
        id: '333333333333333333', systemChannel: networkSystem, channels: [networkSystem, networkFallback]
    });
    const networkResult = await command._test.sendToGuild(networkGuild, payload);
    assert.equal(networkResult.status, 'failed');
    assert.equal(networkFallback.sent.length, 0);
});

test('確認發布只執行一次，並彙總系統、備援、無頻道與失敗結果', async () => {
    const config = testConfig();
    const system = createChannel({ id: 'system' });
    const denied = createChannel({ id: 'denied', permissions: false });
    const fallback = createChannel({ id: 'fallback' });
    const failed = createChannel({
        id: 'failed',
        send: async () => { throw Object.assign(new Error('network failed'), { code: 'ECONNRESET' }); }
    });
    const guilds = [
        createGuild({ id: '111111111111111111', systemChannel: system, channels: [system] }),
        createGuild({ id: '222222222222222222', systemChannel: denied, channels: [denied, fallback] }),
        createGuild({ id: '333333333333333333', channels: [] }),
        createGuild({ id: '444444444444444444', systemChannel: failed, channels: [failed] })
    ];
    const command = createCommand(config, { randomUUID: () => 'confirm-token' });
    const preview = createInteraction({ guilds });
    await command.execute(preview, {});
    const confirm = createInteraction({ guilds, customId: confirmationId(preview) });
    await command.buttonHandlers.global_announcement_confirm(confirm, { signal: new AbortController().signal });

    const summary = embedDescription(confirm.replies.at(-1)[1]);
    assert.match(summary, /系統頻道成功：\*\*1\*\*/);
    assert.match(summary, /備援頻道成功：\*\*1\*\*/);
    assert.match(summary, /無可用頻道：\*\*1\*\*/);
    assert.match(summary, /發送失敗：\*\*1\*\*/);
    assert.equal(system.sent.length + fallback.sent.length + failed.sent.length, 3);

    const duplicate = createInteraction({ guilds, customId: confirm.customId });
    await command.buttonHandlers.global_announcement_confirm(duplicate, {});
    assert.match(embedDescription(duplicate.replies.at(-1)[1]), /已失效/);
    assert.equal(system.sent.length + fallback.sent.length + failed.sent.length, 3);
});

test('全域發布維持五路 worker，進行中會拒絕建立另一份預覽', async () => {
    const config = testConfig();
    let active = 0;
    let maximumActive = 0;
    const guilds = Array.from({ length: 12 }, (_, index) => {
        const channel = createChannel({
            id: `channel-${index}`,
            async send() {
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                await new Promise(resolve => setImmediate(resolve));
                active -= 1;
            }
        });
        return createGuild({
            id: String(500000000000000000n + BigInt(index)),
            systemChannel: channel,
            channels: [channel]
        });
    });
    const command = createCommand(config, { randomUUID: () => 'single-flight-token' });
    const preview = createInteraction({ guilds });
    await command.execute(preview, {});
    const confirm = createInteraction({ guilds, customId: confirmationId(preview) });
    const publishing = command.buttonHandlers.global_announcement_confirm(confirm, {});
    while (!command._test.broadcasting) await new Promise(resolve => setImmediate(resolve));

    const competing = createInteraction({ guilds });
    await command.execute(competing, {});
    assert.match(embedDescription(competing.replies.at(-1)[1]), /已有一則全域消息正在發布/);
    await publishing;
    assert.equal(maximumActive, 5);
});
