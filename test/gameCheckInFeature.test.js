'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MessageFlags, TextInputStyle } = require('discord.js');
const { createStoreRegistry } = require('../core/storeRegistry');
const { createCommand } = require('../src/commands/gameCheckIn');
const {
    createGameCheckInDeadlineCoordinator,
    dateKeyAt,
    isPermanentDiscordDmError,
    nextDateKey,
    resultEmbed,
    runWithConcurrency,
    scheduledEpoch
} = require('../src/modules/event/game_check_in');
const { GameCheckInAdapterError } = require('../util/gameCheckInAdapters');
const { gameIDsForPlatform } = require('../util/gameCheckInCatalog');
const {
    CREDENTIAL_FORMAT,
    GameCheckInCredentialCryptoError,
    createGameCheckInCredentialCodec
} = require('../util/gameCheckInCredentialCodec');
const { createGameCheckInRepository } = require('../util/gameCheckInRepository');
const { createValidConfigDocuments } = require('./helpers/configFixture');

const configDocuments = createValidConfigDocuments();
const config = {
    ...configDocuments['config.yml'],
    commands: configDocuments['configCommands.yml'],
    modules: configDocuments['configModules.yml']
};

function createCredentialCodec() {
    return createGameCheckInCredentialCodec(config.commands.gameCheckIn.credentialEncryptionKey);
}

function createInteraction({
    userID = '123456789012345678',
    username = 'miguo_tw',
    guildID = '123456789012345679',
    channelID = '234567890123456789',
    messageID = '345678901234567890',
    customId = '',
    credential = '',
    ltokenV2 = '',
    ltuidV2 = '',
    dmError = null,
    client = null
} = {}) {
    const calls = [];
    const interaction = {
        customId,
        deferred: false,
        replied: false,
        calls,
        guildId: guildID,
        channelId: channelID,
        message: { id: messageID },
        client: client || {
            isReady: () => false,
            user: { id: '987654321098765432' }
        },
        user: {
            id: userID,
            username,
            async send(payload) {
                calls.push(['dm', payload]);
                if (dmError) throw dmError;
                return { id: 'dm-message' };
            }
        },
        fields: {
            getTextInputValue(name) {
                return { credential, ltoken_v2: ltokenV2, ltuid_v2: ltuidV2 }[name] ?? '';
            }
        },
        async reply(payload) { this.replied = true; calls.push(['reply', payload]); return payload; },
        async fetchReply() { return { id: messageID, channelId: channelID }; },
        async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
        async editReply(payload) { this.replied = true; calls.push(['editReply', payload]); return payload; },
        async followUp(payload) { calls.push(['followUp', payload]); return payload; },
        async update(payload) { this.replied = true; calls.push(['update', payload]); return payload; },
        async showModal(payload) { calls.push(['showModal', payload]); return payload; }
    };
    return interaction;
}

function createCommandFixture(t, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const validations = [];
    const logs = [];
    const wakes = [];
    const now = overrides.now || (() => new Date(2026, 6, 21, 9, 0).getTime());
    const repository = createGameCheckInRepository(store.gameCheckIn, {
        now,
        credentialCodec: createCredentialCodec()
    });
    const adapters = overrides.adapters || {
        validate: {
            async hoyolab(value) { validations.push(['hoyolab', value]); return { games: ['genshin'] }; },
            async skport(value) { validations.push(['skport', value]); return { roles: 1 }; }
        },
        run: {}
    };
    const command = createCommand(overrides.config || config, {
        adapters,
        logTools: { sendLog: (...args) => logs.push(args) },
        repositoryFactory: () => repository,
        wakeCoordinator: overrides.wakeCoordinator || (() => wakes.push('wake')),
        now
    });
    async function activatePanel(interaction) {
        const scope = interaction.guildId
            ? { type: 'guild', id: interaction.guildId }
            : { type: 'dm', id: interaction.channelId };
        return repository.savePanel(scope, {
            channelId: interaction.channelId,
            id: interaction.message.id
        });
    }
    return {
        command,
        context: { store, http: {}, signal: new AbortController().signal },
        logs,
        repository,
        validations,
        wakes,
        activatePanel
    };
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => test.mock.restoreAll());

test('公開遊戲簽到面板固定三個按鈕且不包含個人狀態', async t => {
    const setup = createCommandFixture(t);
    const interaction = createInteraction();
    await setup.command.execute(interaction, setup.context);
    const payload = interaction.calls.at(-1)[1];
    assert.equal(interaction.calls.at(-1)[0], 'reply');
    assert.equal(payload.flags, undefined);
    assert.equal(payload.components.length, 1);
    assert.equal(payload.components[0].components.length, 3);
    assert.deepEqual(payload.components[0].components.map(item => item.data.custom_id), [
        'game_checkin_credentials', 'game_checkin_games', 'game_checkin_notifications'
    ]);
    assert.equal(
        payload.embeds[0].data.fields.find(field => field.name === '下次排程').value,
        `<t:${new Date(2026, 6, 21, 10, 0).getTime() / 1000}:R>`
    );
    assert.doesNotMatch(payload.embeds[0].data.description, /已設定|未設定/);
    assert.deepEqual(await setup.repository.listPanels(), [{
        scopeType: 'guild',
        scopeID: '123456789012345679',
        channelID: '234567890123456789',
        messageID: '345678901234567890',
        updatedAt: new Date(2026, 6, 21, 9, 0).toISOString()
    }]);
});

test('同 Guild 或 DM 建立新主面板會停用舊按鈕、停止追蹤並拒絕舊互動', async t => {
    const setup = createCommandFixture(t);
    const channels = new Map();
    const messages = new Map();
    function addMessage(guildId, channelId, id) {
        const edits = [];
        const message = {
            id, guildId, channelId, edits,
            async edit(payload) { edits.push(payload); return this; }
        };
        messages.set(`${channelId}:${id}`, message);
        if (!channels.has(channelId)) {
            channels.set(channelId, {
                messages: { fetch: async messageID => messages.get(`${channelId}:${messageID}`) || null }
            });
        }
        return message;
    }
    const client = {
        isReady: () => false,
        user: { id: '987654321098765432' },
        channels: { cache: channels }
    };

    const oldGuildMessage = addMessage('guild-1', 'channel-1', 'message-1');
    addMessage('guild-1', 'channel-2', 'message-2');
    await setup.command.execute(createInteraction({
        guildID: 'guild-1', channelID: 'channel-1', messageID: 'message-1', client
    }), setup.context);
    await setup.command.execute(createInteraction({
        guildID: 'guild-1', channelID: 'channel-2', messageID: 'message-2', client
    }), setup.context);
    assert.equal(oldGuildMessage.edits.length, 1);
    assert.equal(oldGuildMessage.edits[0].components[0].components
        .every(button => button.data.disabled === true), true);
    assert.deepEqual((await setup.repository.listPanels()).map(panel => panel.messageID), ['message-2']);

    const expired = createInteraction({
        guildID: 'guild-1', channelID: 'channel-1', messageID: 'message-1',
        customId: 'game_checkin_credentials', client
    });
    await setup.command.buttonHandlers.game_checkin_credentials(expired, setup.context);
    assert.equal(expired.calls.at(-1)[0], 'reply');
    assert.match(JSON.stringify(expired.calls.at(-1)[1]), /面板已被取代/);

    addMessage('guild-2', 'channel-3', 'message-3');
    await setup.command.execute(createInteraction({
        guildID: 'guild-2', channelID: 'channel-3', messageID: 'message-3', client
    }), setup.context);
    assert.deepEqual((await setup.repository.listPanels()).map(panel => panel.messageID), ['message-2', 'message-3']);

    const oldDmMessage = addMessage(null, 'dm-channel', 'dm-message-1');
    addMessage(null, 'dm-channel', 'dm-message-2');
    await setup.command.execute(createInteraction({
        guildID: null, channelID: 'dm-channel', messageID: 'dm-message-1', client
    }), setup.context);
    await setup.command.execute(createInteraction({
        guildID: null, channelID: 'dm-channel', messageID: 'dm-message-2', client
    }), setup.context);
    assert.equal(oldDmMessage.edits[0].components[0].components
        .every(button => button.data.disabled === true), true);
    assert.deepEqual((await setup.repository.listPanels()).map(panel => panel.messageID), [
        'message-2', 'message-3', 'dm-message-2'
    ]);
});

test('啟用/停用簽到面板為 ephemeral 七按鈕，切換後原地更新並喚醒排程', async t => {
    const setup = createCommandFixture(t);
    const opened = createInteraction({ customId: 'game_checkin_games' });
    await setup.activatePanel(opened);
    await setup.command.buttonHandlers.game_checkin_games(opened, setup.context);
    const payload = opened.calls.at(-1)[1];
    assert.equal(opened.calls.at(-1)[0], 'reply');
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.equal(payload.embeds[0].data.title, '🎮 ┃ 遊戲自動簽到（BETA） - 啟用/停用簽到');
    assert.deepEqual(payload.components.map(row => row.components.length), [5, 2]);
    assert.equal(payload.components.flatMap(row => row.components)
        .every(button => button.data.style === 3 && button.data.emoji === undefined), true);
    assert.deepEqual(payload.components.flatMap(row => row.components).map(button => button.data.custom_id), [
        'game_checkin_game_toggle:hoyolab:genshin',
        'game_checkin_game_toggle:hoyolab:starRail',
        'game_checkin_game_toggle:hoyolab:honkai3',
        'game_checkin_game_toggle:hoyolab:tearsOfThemis',
        'game_checkin_game_toggle:hoyolab:zenlessZoneZero',
        'game_checkin_game_toggle:skport:arknights',
        'game_checkin_game_toggle:skport:endfield'
    ]);

    const toggled = createInteraction({ customId: 'game_checkin_game_toggle:hoyolab:genshin' });
    await setup.command.buttonHandlers.game_checkin_game_toggle(toggled, setup.context);
    assert.equal(toggled.calls.at(-1)[0], 'update');
    const updatedButtons = toggled.calls.at(-1)[1].components.flatMap(row => row.components);
    assert.equal(updatedButtons[0].data.style, 4);
    assert.equal(updatedButtons[0].data.emoji, undefined);
    assert.deepEqual((await setup.repository.readUser(toggled.user.id)).disabledGames, ['hoyolab:genshin']);
    assert.deepEqual(setup.wakes, ['wake']);

    const reopened = createInteraction({ customId: 'game_checkin_games' });
    await setup.command.buttonHandlers.game_checkin_games(reopened, setup.context);
    assert.equal(reopened.calls.at(-1)[1].components[0].components[0].data.style, 4);

    const expired = createInteraction({ customId: 'game_checkin_game_toggle:unknown:game' });
    await setup.command.buttonHandlers.game_checkin_game_toggle(expired, setup.context);
    assert.equal(expired.calls.at(-1)[0], 'reply');
    assert.equal(expired.calls.at(-1)[1].flags, MessageFlags.Ephemeral);

    const customConfig = structuredClone(config);
    customConfig.commands.gameCheckIn.toggleEmojis = { enabled: '🟩', disabled: '⬜' };
    const customized = createCommandFixture(t, { config: customConfig });
    await customized.repository.toggleGame(opened.user.id, 'skport:endfield');
    const customOpened = createInteraction({ customId: 'game_checkin_games' });
    await customized.activatePanel(customOpened);
    await customized.command.buttonHandlers.game_checkin_games(customOpened, customized.context);
    const customPayload = customOpened.calls.at(-1)[1];
    assert.match(customPayload.embeds[0].data.description, /🟩 啟用.*⬜ 停用/);
    const customButtons = customPayload.components.flatMap(row => row.components);
    assert.equal(customButtons.every(button => button.data.emoji === undefined), true);
    assert.equal(customButtons[0].data.style, 3);
    assert.equal(customButtons.at(-1).data.style, 4);
});

test('憑證教學合併為單一私密 Embed，並以兩個平台按鈕開啟 Modal', async t => {
    const setup = createCommandFixture(t);
    await setup.repository.setCredential('123456789012345678', 'skport', 'stored-token');
    await setup.repository.cycleNotification('123456789012345678');
    await setup.repository.cycleNotification('123456789012345678');
    const guide = createInteraction({ customId: 'game_checkin_credentials' });
    await setup.activatePanel(guide);
    await setup.command.buttonHandlers.game_checkin_credentials(guide, setup.context);
    const payload = guide.calls.at(-1)[1];
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].data.title, '🎮 ┃ 遊戲自動簽到（BETA） - 輸入/更新憑證');
    assert.match(payload.embeds[0].data.description, /## 狀態/);
    assert.match(payload.embeds[0].data.description, /- HoYoLAB：未設定（不自動簽到）/);
    assert.match(payload.embeds[0].data.description, /- SKPORT：已設定/);
    assert.match(payload.embeds[0].data.description, /- 通知模式：啟用所有通知/);
    assert.match(payload.embeds[0].data.description, /\[HoYoLAB\]\(https:\/\/www\.hoyolab\.com\/\)/);
    assert.match(payload.embeds[0].data.description, /```\nltoken_v2:"v2_xxxxxxxxxx"\n```/);
    assert.match(payload.embeds[0].data.description, /```json/);
    assert.deepEqual(payload.components[0].components.map(item => item.data.custom_id), [
        'game_checkin_credentials_hoyolab', 'game_checkin_credentials_skport'
    ]);
    assert.equal(payload.components[0].components.every(item => item.toJSON().type === 2), true);
    assert.equal(setup.command.componentHandlers, undefined);

    const selected = createInteraction({ customId: 'game_checkin_credentials_hoyolab' });
    await setup.command.buttonHandlers.game_checkin_credentials_hoyolab(selected, setup.context);
    const modal = selected.calls.at(-1)[1];
    assert.equal(modal.data.custom_id, 'game_checkin_credentials_modal:hoyolab');
    assert.equal(modal.components.length, 2);
    assert.deepEqual(modal.components.map(row => row.components[0].data.custom_id), ['ltoken_v2', 'ltuid_v2']);
    for (const row of modal.components) {
        assert.equal(row.components[0].data.required, false);
        assert.equal(row.components[0].data.value, undefined);
        assert.equal(row.components[0].data.style, TextInputStyle.Short);
    }

    const skport = createInteraction({ customId: 'game_checkin_credentials_skport' });
    await setup.command.buttonHandlers.game_checkin_credentials_skport(skport, setup.context);
    const skportModal = skport.calls.at(-1)[1];
    assert.equal(skportModal.data.custom_id, 'game_checkin_credentials_modal:skport');
    assert.equal(skportModal.components[0].components[0].data.style, TextInputStyle.Short);
});

test('Modal 分欄組合 HoYoLAB 憑證，唯讀驗證成功才保存且空白會停用平台', async t => {
    const setup = createCommandFixture(t);
    const submitted = createInteraction({
        customId: 'game_checkin_credentials_modal:hoyolab',
        ltokenV2: 'ltoken_v2:"secret"',
        ltuidV2: 'ltuid_v2:"1"'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(submitted, setup.context);
    assert.deepEqual(setup.validations, [['hoyolab', 'ltoken_v2=secret; ltuid_v2=1;']]);
    assert.equal(submitted.calls.some(call => call[0] === 'dm'), false);
    const savedCredential = (await setup.repository.readUser(submitted.user.id)).credentials.hoyolab;
    assert.equal(savedCredential.format, CREDENTIAL_FORMAT);
    assert.doesNotMatch(JSON.stringify(await setup.context.store.gameCheckIn.read(submitted.user.id)), /secret|ltoken|ltuid/);
    assert.match(setup.logs.at(-1)[1], /遊戲簽到 miguo_tw 的 HoYoLAB 憑證已更新。/);
    assert.doesNotMatch(setup.logs.at(-1)[1], /secret|ltoken|ltuid/);

    const skport = createInteraction({
        customId: 'game_checkin_credentials_modal:skport',
        credential: 'skport-secret'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(skport, setup.context);
    assert.match(setup.logs.at(-1)[1], /遊戲簽到 miguo_tw 的 SKPORT 憑證已更新。/);
    assert.doesNotMatch(setup.logs.at(-1)[1], /skport-secret/);

    const cleared = createInteraction({ customId: 'game_checkin_credentials_modal:hoyolab' });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(cleared, setup.context);
    assert.equal((await setup.repository.readUser(cleared.user.id)).credentials.hoyolab, null);
    assert.equal(setup.validations.length, 2);

    const partial = createInteraction({
        customId: 'game_checkin_credentials_modal:hoyolab',
        ltokenV2: 'ltoken_v2:"only-one-field"'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(partial, setup.context);
    assert.match(JSON.stringify(partial.calls.at(-1)[1]), /必須同時填寫/);
    assert.equal(setup.validations.length, 2);

    const expired = createInteraction({ customId: 'game_checkin_credentials_modal:unknown', credential: 'x' });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(expired, setup.context);
    assert.equal(expired.calls.at(-1)[0], 'reply');
});

test('驗證錯誤保留舊憑證且不將秘密放入回覆', async t => {
    const adapters = {
        validate: {
            hoyolab: async () => { throw new GameCheckInAdapterError('BAD', 'Cookie 已失效。', { validation: true }); },
            skport: async () => ({})
        },
        run: {}
    };
    const setup = createCommandFixture(t, { adapters });
    await setup.repository.setCredential('123456789012345678', 'hoyolab', 'old-secret');
    const oldCredential = (await setup.repository.readUser('123456789012345678')).credentials.hoyolab;
    const interaction = createInteraction({
        customId: 'game_checkin_credentials_modal:hoyolab',
        ltokenV2: 'ltoken_v2:"new-secret"',
        ltuidV2: 'ltuid_v2:"123"'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(interaction, setup.context);
    assert.deepEqual((await setup.repository.readUser(interaction.user.id)).credentials.hoyolab, oldCredential);
    const reply = JSON.stringify(interaction.calls.at(-1)[1]);
    assert.match(reply, /Cookie 已失效/);
    assert.doesNotMatch(reply, /new-secret|old-secret/);
});

test('通知依 all → failures → off → all 循環，切換至 all 或 failures 時顯示通知測試', async t => {
    const setup = createCommandFixture(t);
    const toOff = createInteraction();
    await setup.activatePanel(toOff);
    await setup.command.buttonHandlers.game_checkin_notifications(toOff, setup.context);
    assert.equal((await setup.repository.readUser(toOff.user.id)).notificationMode, 'off');
    assert.equal(toOff.calls.some(call => call[0] === 'dm'), false);
    assert.equal(toOff.calls.some(call => call[0] === 'followUp'), false);

    const toAll = createInteraction();
    await setup.command.buttonHandlers.game_checkin_notifications(toAll, setup.context);
    assert.equal((await setup.repository.readUser(toAll.user.id)).notificationMode, 'all');
    assert.equal(toAll.calls.some(call => call[0] === 'dm'), false);
    const settingResult = toAll.calls.find(call => call[0] === 'editReply')[1];
    assert.equal(settingResult.embeds[0].data.description, '**通知模式已切換為：啟用所有通知。**');
    const notificationTest = toAll.calls.find(call => call[0] === 'followUp')[1];
    assert.equal(notificationTest.flags, MessageFlags.Ephemeral);
    assert.equal(notificationTest.embeds[0].data.color, config.embed.color.default);
    assert.equal(notificationTest.embeds[0].data.title, '🎮 ┃ 遊戲自動簽到（BETA） - 通知測試');
    assert.match(notificationTest.embeds[0].data.description, /<@987654321098765432>/);
    assert.deepEqual(notificationTest.allowedMentions, {
        parse: [], users: ['987654321098765432']
    });

    const toFailures = createInteraction();
    await setup.command.buttonHandlers.game_checkin_notifications(toFailures, setup.context);
    assert.equal((await setup.repository.readUser(toFailures.user.id)).notificationMode, 'failures');
    const failureTest = toFailures.calls.find(call => call[0] === 'followUp')[1];
    assert.equal(failureTest.flags, MessageFlags.Ephemeral);
    assert.match(failureTest.embeds[0].data.description, /僅失敗時通知/);
});

test('時區工具以主機本機時間套用人工校正，能跨月與換日', () => {
    const localMidnight = new Date(2026, 6, 21, 0, 30).getTime();
    assert.equal(dateKeyAt(localMidnight, 0), '2026-07-21');
    assert.equal(dateKeyAt(localMidnight, -1), '2026-07-20');
    assert.equal(
        scheduledEpoch('2026-07-21', '20:10', 0),
        new Date(2026, 6, 21, 20, 10).getTime()
    );
    assert.equal(
        scheduledEpoch('2026-07-21', '20:10', 1),
        new Date(2026, 6, 21, 19, 10).getTime()
    );
    assert.equal(nextDateKey('2026-12-31'), '2027-01-01');
    assert.equal(isPermanentDiscordDmError({ code: 50007 }), true);
    assert.equal(isPermanentDiscordDmError({ code: '10013' }), true);
    assert.equal(isPermanentDiscordDmError({ code: 500 }), false);
});

test('deadline coordinator 使用 config.yml 本機時區校正補跑兩平台、彙總 DM 並排到下一日', async () => {
    const localConfig = { ...config, log: { ...config.log, timezone: 0 } };
    let now = new Date(2026, 6, 21, 10, 0).getTime();
    const completed = [];
    const logs = [];
    const panelEdits = [];
    let delivered = false;
    const outbox = {
        id: 'outbox-1', userID: '123456789012345678', date: '2026-07-21', generation: 1,
        result: { outcomes: [{ platform: 'hoyolab', game: '原神', status: 'success', message: '成功', account: null }] }
    };
    const repository = {
        async listDuePlatforms() {
            return completed.length ? [] : [
                { userID: outbox.userID, platform: 'hoyolab' },
                { userID: outbox.userID, platform: 'skport' }
            ];
        },
        async reservePlatform(userID, platform, date) {
            return {
                id: platform, userID, platform, date, generation: 1, credentialRevision: 1,
                credential: `${platform}-secret`, gameIDs: gameIDsForPlatform(platform).slice(0, 1)
            };
        },
        async completePlatform(reservation, result) { completed.push([reservation.platform, result]); },
        async finalizeReady() {},
        async listDueOutbox() { return completed.length === 2 && !delivered ? [outbox] : []; },
        async prepareOutboxDelivery() { return outbox; },
        async markOutboxDelivered() { delivered = true; },
        async markOutboxFailed() {},
        async earliestPending() { return null; },
        async earliestOutbox() { return null; },
        async listPanels() { return [{ channelID: 'panel-channel', messageID: 'panel-message' }]; },
        async removePanel() {}
    };
    const sent = [];
    let descriptor;
    const rescheduled = [];
    const coordinator = createGameCheckInDeadlineCoordinator(localConfig, {
        now: () => now,
        repositoryFactory: () => repository,
        adapters: { run: {
            hoyolab: async (value, options) => {
                assert.deepEqual(options.gameIDs, ['hoyolab:genshin']);
                return { platform: 'hoyolab', retryable: false, outcomes: [{ status: 'success', message: value }] };
            },
            skport: async (value, options) => {
                assert.deepEqual(options.gameIDs, ['skport:arknights']);
                return { platform: 'skport', retryable: false, outcomes: [{ status: 'success', message: value }] };
            }
        } },
        logTools: { sendLog: (...args) => logs.push(args) }
    });
    const stop = await coordinator.start({
        store: { gameCheckIn: {} }, http: {},
        client: {
            users: { fetch: async () => ({ send: async payload => sent.push(payload) }) },
            channels: {
                cache: new Map(),
                fetch: async () => ({
                    messages: {
                        fetch: async () => ({ edit: async payload => panelEdits.push(payload) })
                    }
                })
            }
        },
        scheduler: {
            scheduleDeadline(value) {
                descriptor = value;
                return { reschedule: value => rescheduled.push(value), async stop() {} };
            }
        }
    });
    assert.equal(descriptor.name, 'gameCheckIn.deadline');
    assert.equal(coordinator.wake(), true);
    assert.equal(rescheduled.at(-1), now);
    await descriptor.run({ signal: new AbortController().signal });
    assert.deepEqual(completed.map(item => item[0]), ['hoyolab', 'skport']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].allowedMentions.parse.length, 0);
    assert.equal(delivered, true);
    assert.equal(rescheduled.at(-1), new Date(2026, 6, 22, 10, 0).getTime());
    assert.equal(logs.some(call => /已觸發.*1 位使用者、2 個平台/.test(call[1])), true);
    assert.equal(logs.some(call => /處理完成/.test(call[1])), true);
    assert.equal(panelEdits.length, 1);
    assert.deepEqual(panelEdits[0].components[0].components.map(button => button.data.custom_id), [
        'game_checkin_credentials', 'game_checkin_games', 'game_checkin_notifications'
    ]);
    assert.equal(
        panelEdits[0].embeds[0].data.fields.find(field => field.name === '下次排程').value,
        `<t:${new Date(2026, 6, 22, 10, 0).getTime() / 1000}:R>`
    );
    await stop();
    assert.equal(coordinator.wake(), false);
});

test('啟動同步會辨識舊格式同 Guild 面板，只追蹤最新一個並停用其餘按鈕', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-panels-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    await store.gameCheckIn.update('panels', () => ({ panels: [
        {
            channelID: 'old-channel', messageID: 'old-message',
            updatedAt: '2026-07-20T00:00:00.000Z'
        },
        {
            channelID: 'new-channel', messageID: 'new-message',
            updatedAt: '2026-07-21T00:00:00.000Z'
        }
    ] }));
    const edits = { old: [], latest: [] };
    const messages = new Map([
        ['old-channel', {
            id: 'old-message', channelId: 'old-channel', guildId: 'guild-1',
            async edit(payload) { edits.old.push(payload); }
        }],
        ['new-channel', {
            id: 'new-message', channelId: 'new-channel', guildId: 'guild-1',
            async edit(payload) { edits.latest.push(payload); }
        }]
    ]);
    const channels = new Map([...messages].map(([channelID, message]) => [channelID, {
        messages: { fetch: async messageID => message.id === messageID ? message : null }
    }]));
    const coordinator = createGameCheckInDeadlineCoordinator(config, {
        logTools: { sendLog() {} }
    });
    await coordinator.start({
        store,
        client: { channels: { cache: channels } },
        scheduler: { scheduleDeadline: () => ({ reschedule() {}, async stop() {} }) }
    });
    await coordinator._test.syncPanels();

    assert.equal(edits.old.at(-1).components[0].components
        .every(button => button.data.disabled === true), true);
    assert.equal(edits.latest.at(-1).components[0].components
        .every(button => button.data.disabled === false), true);
    const repository = createGameCheckInRepository(store.gameCheckIn, {
        credentialCodec: createCredentialCodec()
    });
    assert.deepEqual((await repository.listPanels()).map(panel => ({
        scopeType: panel.scopeType,
        scopeID: panel.scopeID,
        messageID: panel.messageID
    })), [{ scopeType: 'guild', scopeID: 'guild-1', messageID: 'new-message' }]);
    const oldEditCount = edits.old.length;
    await coordinator._test.syncPanels();
    assert.equal(edits.old.length, oldEditCount);
    await coordinator.stop();
});

test('Coordinator 在 scheduler 建立前驗證全部 AES 憑證，錯誤金鑰會阻止啟動', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-key-validation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const repository = createGameCheckInRepository(store.gameCheckIn, {
        credentialCodec: createCredentialCodec()
    });
    await repository.setCredential('123456789012345678', 'hoyolab', 'private-cookie');

    const wrongKeyConfig = structuredClone(config);
    wrongKeyConfig.commands.gameCheckIn.credentialEncryptionKey = '44'.repeat(32);
    let scheduled = false;
    const coordinator = createGameCheckInDeadlineCoordinator(wrongKeyConfig, {
        logTools: { sendLog() {} }
    });
    await assert.rejects(() => coordinator.start({
        store,
        client: {},
        scheduler: {
            scheduleDeadline() {
                scheduled = true;
                return { reschedule() {}, async stop() {} };
            }
        }
    }), error => {
        assert.ok(error instanceof GameCheckInCredentialCryptoError);
        assert.match(error.message, /123456789012345678.*hoyolab/);
        assert.doesNotMatch(error.message, /private-cookie|44{10}/);
        return true;
    });
    assert.equal(scheduled, false);
    assert.equal(coordinator.wake(), false);
});

test('真實 repository 與 coordinator 可在重啟補跑後持久化結果及送出 failure-only DM', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-coordinator-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const currentTime = Date.parse('2026-07-21T10:05:00Z');
    const repository = createGameCheckInRepository(store.gameCheckIn, {
        now: () => currentTime,
        credentialCodec: createCredentialCodec()
    });
    await repository.setCredential('123456789012345678', 'hoyolab', 'private-cookie');

    let descriptor;
    const sent = [];
    const coordinator = createGameCheckInDeadlineCoordinator(config, {
        now: () => currentTime,
        adapters: { run: {
            hoyolab: async (credential, { signal, gameIDs }) => {
                assert.equal(credential, 'private-cookie');
                assert.equal(signal.aborted, false);
                assert.deepEqual(gameIDs, gameIDsForPlatform('hoyolab'));
                return {
                    platform: 'hoyolab', retryable: false,
                    outcomes: [{ platform: 'hoyolab', game: '原神', account: null, status: 'failure', message: 'CAPTCHA' }]
                };
            }
        } },
        logTools: { sendLog() {} }
    });
    await coordinator.start({
        store,
        http: { get: async () => {}, post: async () => {} },
        client: { users: { fetch: async () => ({ send: async payload => sent.push(payload) }) } },
        scheduler: {
            scheduleDeadline(value) {
                descriptor = value;
                return { reschedule() {}, async stop() {} };
            }
        }
    });
    await descriptor.run({ signal: new AbortController().signal });
    const stored = await repository.readUser('123456789012345678');
    assert.equal(stored.daily.date, '2026-07-21');
    assert.equal(stored.daily.platforms.hoyolab.status, 'complete');
    assert.equal(stored.outbox.length, 0);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(JSON.stringify(sent), /private-cookie/);
    await coordinator.stop();
});

test('DM 永久拒絕會停止 outbox，暫時錯誤則保留重試', async () => {
    for (const code of [50007, 500]) {
        const failures = [];
        const item = {
            id: `dm-${code}`, userID: '123456789012345678', date: '2026-07-21', generation: 1,
            result: { outcomes: [{ game: '原神', status: 'failure', message: '失敗', account: null }] }
        };
        const repository = {
            async listDueOutbox() { return [item]; },
            async prepareOutboxDelivery() { return item; },
            async markOutboxFailed(_userID, _id, options) { failures.push(options); }
        };
        const error = new Error('dm failed');
        error.code = code;
        const coordinator = createGameCheckInDeadlineCoordinator(config, {
            repositoryFactory: () => repository,
            logTools: { sendLog() {} }
        });
        await coordinator.start({
            store: { gameCheckIn: {} },
            client: { users: { fetch: async () => ({ send: async () => { throw error; } }) } },
            scheduler: { scheduleDeadline: () => ({ reschedule() {}, async stop() {} }) }
        });
        await coordinator._test.deliverOutbox();
        assert.equal(failures[0].permanent, code === 50007);
        await coordinator.stop();
    }
});

test('結果 Embed 依狀態分組顯示遊戲，錯誤項目保留原因', () => {
    const resultEmojis = config.commands.gameCheckIn.resultEmojis;
    const embed = resultEmbed(config, {
        date: '2026-07-21',
        result: { outcomes: [
            { game: '原神', account: null, status: 'success', message: '簽到成功。' },
            { game: '崩壞：星穹鐵道', account: null, status: 'success', message: '簽到成功。' },
            { game: '明日方舟：終末地', account: 'Endmin（Asia）', status: 'already', message: '今日已完成簽到。' },
            { game: '未定事件簿', account: null, status: 'skipped', message: '帳號未綁定此遊戲。' },
            { game: '絕區零', account: null, status: 'failure', message: 'HoYoLAB 絕區零拒絕了請求。' },
            { game: '明日方舟', account: '猫又みやこ#4629', status: 'failure', message: 'SKPORT 明日方舟拒絕了請求。' },
            { game: 'HoYoLAB', account: null, status: 'unknown', message: 'HoYoLAB 無法辨識結果。' }
        ] }
    });
    assert.equal(embed.data.title, '🎮 ┃ 遊戲自動簽到（BETA） - 結果');
    assert.equal(embed.data.description, undefined);
    assert.deepEqual(embed.data.fields, [
        { name: `${resultEmojis.success} 簽到成功`, value: '`原神`、`崩壞：星穹鐵道`' },
        { name: `${resultEmojis.already} 重複簽到`, value: '`明日方舟：終末地`' },
        { name: `${resultEmojis.skipped} 未綁定遊戲`, value: '`未定事件簿`' },
        {
            name: `${resultEmojis.error} 錯誤`,
            value: [
                '`絕區零` HoYoLAB 拒絕了請求。',
                '`明日方舟` SKPORT 拒絕了請求。',
                '`HoYoLAB` 無法辨識結果。'
            ].join('\n')
        }
    ]);
    assert.equal(embed.data.color, config.embed.color.default);
    assert.equal(embed.data.footer, undefined);
    assert.equal(embed.data.timestamp, undefined);

    const customConfig = {
        ...config,
        commands: {
            ...config.commands,
            gameCheckIn: {
                ...config.commands.gameCheckIn,
                resultEmojis: { success: '⭐', already: '🔵', skipped: '⚪', error: '⛔' }
            }
        }
    };
    const custom = resultEmbed(customConfig, {
        result: { outcomes: [{ game: '原神', status: 'success' }] }
    });
    assert.equal(custom.data.fields[0].name, '⭐ 簽到成功');
});

test('結果 Embed 截斷過長內容，並行 helper 不超過指定工作數', async () => {
    const embed = resultEmbed(config, {
        date: '2026-07-21',
        result: { outcomes: Array.from({ length: 100 }, (_, index) => ({
            game: `遊戲${index}`, account: '角色', status: index === 0 ? 'failure' : 'success', message: 'x'.repeat(80)
        })) }
    });
    assert.equal(embed.data.color, config.embed.color.default);
    assert.equal(embed.data.fields.every(field => field.value.length <= 1024), true);

    let active = 0;
    let maximum = 0;
    await runWithConcurrency([1, 2, 3, 4], 2, async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
    });
    assert.equal(maximum, 2);
});
