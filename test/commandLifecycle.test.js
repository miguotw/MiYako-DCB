'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChannelType, Collection } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createHttpClient, setDefaultHttpClient } = require('../core/http');
const { createStoreRegistry } = require('../core/storeRegistry');

const config = loadConfig();

function createOptions(values = {}) {
    return {
        getSubcommand: () => values.subcommand,
        getBoolean: name => values[name] ?? null,
        getInteger: name => values[name] ?? null,
        getString: name => values[name] ?? null,
        getChannel: name => values[name] ?? null,
        getRole: name => values[name] ?? null,
        getUser: name => values[name] ?? null,
        getMember: name => values[`${name}Member`] ?? null
    };
}

function createInteraction(values = {}) {
    const replies = [];
    const sourceMessage = {
        id: '34567890123456789',
        channelId: '23456789012345678',
        content: '來源訊息',
        attachments: { first: () => ({ url: 'https://example.test/image.png', contentType: 'image/png' }) }
    };
    const guilds = new Collection([
        ['111111111111111111', { id: '111111111111111111', name: '測試站', memberCount: 12 }]
    ]);
    const client = {
        isReady: () => false,
        user: { id: '999999999999999999', username: 'MiYako', displayAvatarURL: () => 'https://example.test/bot.png' },
        guilds: { cache: guilds },
        channels: { cache: new Collection(), fetch: async () => null },
        users: { fetch: async id => ({
            id, username: 'target_user', globalName: '目標用戶', bot: false,
            createdTimestamp: 1_600_000_000_000,
            displayAvatarURL: () => 'https://example.test/avatar.png',
            bannerURL: () => 'https://example.test/banner.png'
        }) }
    };
    const channel = values.currentChannel || {
        id: '23456789012345678',
        type: ChannelType.GuildText,
        messages: { fetch: async () => sourceMessage },
        bulkDelete: async () => {},
        send: async payload => ({ id: '45678901234567890', channelId: '23456789012345678', ...payload }),
        toString: () => '<#23456789012345678>'
    };
    const interaction = {
        client,
        options: createOptions(values),
        user: {
            id: values.userID || '123456789012345678', tag: 'tester#0001', username: 'tester', bot: false,
            send: async () => ({ id: 'dm' })
        },
        guildId: '111111111111111111',
        channelId: channel.id,
        channel,
        guild: {
            id: '111111111111111111',
            members: {
                me: { id: client.user.id },
                fetch: async () => null,
                cache: new Collection()
            },
            roles: { cache: new Collection() },
            channels: { fetch: async () => channel }
        },
        memberPermissions: { has: () => true },
        createdTimestamp: Date.now() - 25,
        deferred: false,
        replied: false,
        replies,
        inGuild: () => true,
        async deferReply() { this.deferred = true; },
        async reply(payload) { this.replied = true; replies.push(['reply', payload]); return payload; },
        async editReply(payload) { this.replied = true; replies.push(['editReply', payload]); return { id: 'progress', ...payload }; },
        async update(payload) { this.replied = true; replies.push(['update', payload]); return payload; },
        async followUp(payload) { replies.push(['followUp', payload]); return payload; },
        async showModal(payload) { replies.push(['modal', payload]); return payload; }
    };
    return interaction;
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => {
    setDefaultHttpClient(createHttpClient({ transport: async () => { throw new Error('測試結束後禁止 HTTP'); } }));
    test.mock.restoreAll();
});

test('一般查詢指令完整執行成功與驗證路徑', async () => {
    const context = {
        router: { commandNames: ['延遲', '一言'] },
        signal: new AbortController().signal,
        http: { get: async () => ({ data: { hitokoto: '测试句子', from: '测试出处' } }) }
    };

    await require('../src/commands/about').createCommand(config)
        .execute(createInteraction({ '顯示伺服器唯一編號': true }), context);
    await require('../src/commands/ping').createCommand(config)
        .execute(createInteraction(), context);
    const hitokoto = createInteraction();
    await require('../src/commands/hitokoto').createCommand(config).execute(hitokoto, context);
    assert.equal(hitokoto.replies.at(-1)[0], 'editReply');

    const invalidIP = createInteraction({ '位址': 'example.com', userID: 'ip-invalid' });
    await require('../src/commands/ipQuery').createCommand(config).execute(invalidIP, context);
    assert.equal(invalidIP.replies.at(-1)[0], 'reply');

    setDefaultHttpClient(createHttpClient({ transport: async () => ({
        data: { status: 'success', country: 'TW', city: 'Taipei', isp: 'ISP', as: 'AS1', mobile: false, proxy: true, hosting: false }
    }) }));
    const validIP = createInteraction({ '位址': '203.0.113.10', userID: 'ip-valid' });
    await require('../src/commands/ipQuery').createCommand(config).execute(validIP, context);
    assert.equal(validIP.replies.at(-1)[0], 'editReply');
});

test('Minecraft 玩家與伺服器指令使用 fake transport，且預設圖示不依賴 CWD', async () => {
    const command = require('../src/commands/minecraft').createCommand(config);
    const player = createInteraction({ subcommand: '玩家外觀資訊', '玩家名稱': 'Steve' });
    await command.execute(player, {});
    assert.equal(player.replies.at(-1)[0], 'editReply');

    setDefaultHttpClient(createHttpClient({ transport: async request => {
        assert.match(request.url, /mcsrvstat/);
        return { data: {
            online: true, hostname: 'mc.example.test', ip: '203.0.113.20', port: 25565,
            version: '1.21', protocol: 767, motd: { clean: ['Hello'] },
            players: { online: 1, max: 20, list: ['Test_Player'] }
        } };
    } }));
    const server = createInteraction({ subcommand: '伺服器狀態資訊', '輸入伺服器位址': 'mc.example.test' });
    const originalCwd = process.cwd();
    process.chdir(os.tmpdir());
    try { await command.execute(server, {}); }
    finally { process.chdir(originalCwd); }
    assert.equal(server.replies.at(-1)[0], 'editReply');

    const missing = createInteraction({ subcommand: '伺服器狀態資訊' });
    await command.execute(missing, {});
    assert.equal(missing.replies.at(-1)[0], 'editReply');
});

test('時間戳指令涵蓋立即回覆、Modal 與輸入驗證', async () => {
    const command = require('../src/commands/unixTimestamp').createCommand(config);
    const now = createInteraction({ subcommand: '現在時間' });
    await command.execute(now, {});
    assert.equal(now.replies.at(-1)[0], 'editReply');

    const specified = createInteraction({ subcommand: '指定時間' });
    await command.execute(specified, {});
    assert.equal(specified.replies.at(-1)[0], 'modal');

    const values = { dateInput: '2026-07-14', timeInput: '12:34:56', timezoneInput: '+8' };
    const modal = createInteraction();
    modal.fields = { getTextInputValue: id => values[id] };
    await command.modalSubmitHandlers.unixTimestamp_modal(modal);
    assert.equal(modal.replies.at(-1)[0], 'reply');

    for (const invalid of [
        { dateInput: '14/07/2026', timeInput: '12:34:56', timezoneInput: '+8' },
        { dateInput: '2026-07-14', timeInput: 'noon', timezoneInput: '+8' },
        { dateInput: '2026-07-14', timeInput: '12:34:56', timezoneInput: 'UTC+8' },
        { dateInput: '2026-07-14', timeInput: '12:34:56', timezoneInput: '+15' }
    ]) {
        const interaction = createInteraction();
        interaction.fields = { getTextInputValue: id => invalid[id] };
        await command.modalSubmitHandlers.unixTimestamp_modal(interaction);
        assert.equal(interaction.replies.at(-1)[0], 'reply');
    }
});

test('管理查詢、公告與近期訊息刪除皆完成 Discord 生命週期', async () => {
    const selectedUser = { id: '222222222222222222' };
    const userInfo = createInteraction({ '用戶': selectedUser, '用戶Member': { displayName: 'Guild Name' } });
    await require('../src/commands/admin/userInfo').createCommand(config).execute(userInfo, {});
    assert.equal(userInfo.replies.at(-1)[0], 'editReply');

    const target = createInteraction().channel;
    const announcement = createInteraction({
        '訊息id或連結': '34567890123456789', '選擇頻道': target, '選擇身分組': { id: '333333333333333333', toString: () => '<@&333333333333333333>' }
    });
    await require('../src/commands/admin/announcement').createCommand(config).execute(announcement, {});
    assert.equal(announcement.replies.at(-1)[0], 'editReply');

    const messages = new Collection([
        ['a', { id: 'a', createdTimestamp: Date.now(), delete: async () => {} }],
        ['b', { id: 'b', createdTimestamp: Date.now(), delete: async () => {} }]
    ]);
    const currentChannel = {
        id: '23456789012345678',
        messages: { fetch: async () => messages },
        bulkDelete: async items => assert.equal(items.length, 2)
    };
    const deletion = createInteraction({ '數量': 2, currentChannel });
    await require('../src/commands/admin/messageDelete').createCommand(config).execute(deletion, {});
    assert.equal(deletion.replies.at(-1)[0], 'editReply');
});

test('臨時語音與 Twitch 管理指令經 repository 保存、更新及移除', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-command-lifecycle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const context = { store };

    const voiceChannel = {
        id: '444444444444444444', guildId: '111111111111111111', type: ChannelType.GuildVoice,
        permissionsFor: () => ({ missing: () => [] }), toString: () => '<#444444444444444444>'
    };
    const temporaryVoice = require('../src/commands/admin/temporaryVoice').createCommand(config);
    const add = createInteraction({ subcommand: '新增', '語音頻道': voiceChannel, '前綴': '小房間' });
    await temporaryVoice.execute(add, context);
    const remove = createInteraction({ subcommand: '移除', '語音頻道': voiceChannel });
    await temporaryVoice.execute(remove, context);
    assert.equal(remove.replies.at(-1)[0], 'editReply');

    let checks = 0;
    let reconciled = 0;
    const twitch = require('../src/commands/admin/twitchStream').createCommand(config, {
        requestTwitchCheck: async () => { checks += 1; },
        reconcileRemovedSubscription: async () => { reconciled += 1; }
    });
    const notificationChannel = {
        id: '555555555555555555', isTextBased: () => true, send: async () => {},
        toString: () => '<#555555555555555555>'
    };
    const addTwitch = createInteraction({ subcommand: '新增', 'twitch頻道id': 'https://twitch.tv/Test_Channel', '通知頻道': notificationChannel });
    await twitch.execute(addTwitch, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 1);

    const openRemove = createInteraction({ subcommand: '移除' });
    await twitch.execute(openRemove, context);
    assert.equal(openRemove.replies.at(-1)[0], 'reply');

    openRemove.customId = `twitch_stream_remove:${openRemove.user.id}`;
    openRemove.values = ['test_channel'];
    await twitch.componentHandlers.twitch_stream_remove(openRemove, context);
    assert.equal(reconciled, 1);
});
