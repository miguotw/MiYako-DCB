'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MessageFlags } = require('discord.js');
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
const { createGameCheckInRepository } = require('../util/gameCheckInRepository');
const { createValidConfigDocuments } = require('./helpers/configFixture');

const configDocuments = createValidConfigDocuments();
const config = {
    ...configDocuments['config.yml'],
    commands: configDocuments['configCommands.yml'],
    modules: configDocuments['configModules.yml']
};

function createInteraction({
    userID = '123456789012345678',
    customId = '',
    credential = '',
    ltokenV2 = '',
    ltuidV2 = '',
    dmError = null
} = {}) {
    const calls = [];
    const interaction = {
        customId,
        deferred: false,
        replied: false,
        calls,
        client: { isReady: () => false },
        user: {
            id: userID,
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
        async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
        async editReply(payload) { this.replied = true; calls.push(['editReply', payload]); return payload; },
        async showModal(payload) { calls.push(['showModal', payload]); return payload; }
    };
    return interaction;
}

function createCommandFixture(t, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-command-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const validations = [];
    const adapters = overrides.adapters || {
        validate: {
            async hoyolab(value) { validations.push(['hoyolab', value]); return { games: ['genshin'] }; },
            async skport(value) { validations.push(['skport', value]); return { roles: 1 }; }
        },
        run: {}
    };
    const command = createCommand(config, { adapters });
    return {
        command,
        context: { store, http: {}, signal: new AbortController().signal },
        repository: createGameCheckInRepository(store.gameCheckIn),
        validations
    };
}

test.before(() => {
    test.mock.method(console, 'log', () => {});
    test.mock.method(console, 'error', () => {});
});

test.after(() => test.mock.restoreAll());

test('公開遊戲簽到面板固定兩個按鈕且不包含個人狀態', async t => {
    const setup = createCommandFixture(t);
    const interaction = createInteraction();
    await setup.command.execute(interaction, setup.context);
    const payload = interaction.calls.at(-1)[1];
    assert.equal(interaction.calls.at(-1)[0], 'reply');
    assert.equal(payload.flags, undefined);
    assert.equal(payload.components.length, 1);
    assert.equal(payload.components[0].components.length, 2);
    assert.deepEqual(payload.components[0].components.map(item => item.data.custom_id), [
        'game_checkin_credentials', 'game_checkin_notifications'
    ]);
    assert.doesNotMatch(payload.embeds[0].data.description, /已設定|未設定/);
});

test('憑證教學合併為單一私密 Embed，並以兩個平台按鈕開啟 Modal', async t => {
    const setup = createCommandFixture(t);
    await setup.repository.setCredential('123456789012345678', 'skport', 'stored-token');
    await setup.repository.cycleNotification('123456789012345678');
    await setup.repository.cycleNotification('123456789012345678');
    const guide = createInteraction({ customId: 'game_checkin_credentials' });
    await setup.command.buttonHandlers.game_checkin_credentials(guide, setup.context);
    const payload = guide.calls.at(-1)[1];
    assert.equal(payload.flags, MessageFlags.Ephemeral);
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].data.title, '遊戲自動簽到 - 輸入/更新憑證');
    assert.match(payload.embeds[0].data.description, /## 狀態/);
    assert.match(payload.embeds[0].data.description, /- HoYoLAB：未設定（不自動簽到）/);
    assert.match(payload.embeds[0].data.description, /- SKPORT：已設定/);
    assert.match(payload.embeds[0].data.description, /- 通知模式：啟用所有通知/);
    assert.match(payload.embeds[0].data.description, /\[HoYoLAB\]\(https:\/\/www\.hoyolab\.com\/\)/);
    assert.match(payload.embeds[0].data.description, /```\nv2_xxxxxxxxxx\n```/);
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
    }

    const skport = createInteraction({ customId: 'game_checkin_credentials_skport' });
    await setup.command.buttonHandlers.game_checkin_credentials_skport(skport, setup.context);
    assert.equal(skport.calls.at(-1)[1].data.custom_id, 'game_checkin_credentials_modal:skport');
});

test('Modal 分欄組合 HoYoLAB 憑證，唯讀驗證成功才保存且空白會停用平台', async t => {
    const setup = createCommandFixture(t);
    const submitted = createInteraction({
        customId: 'game_checkin_credentials_modal:hoyolab',
        ltokenV2: 'secret',
        ltuidV2: '1'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(submitted, setup.context);
    assert.deepEqual(setup.validations, [['hoyolab', 'ltoken_v2=secret; ltuid_v2=1;']]);
    assert.equal(submitted.calls.some(call => call[0] === 'dm'), false);
    assert.equal(
        (await setup.repository.readUser(submitted.user.id)).credentials.hoyolab.value,
        'ltoken_v2=secret; ltuid_v2=1;'
    );

    const cleared = createInteraction({ customId: 'game_checkin_credentials_modal:hoyolab' });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(cleared, setup.context);
    assert.equal((await setup.repository.readUser(cleared.user.id)).credentials.hoyolab, null);
    assert.equal(setup.validations.length, 1);

    const partial = createInteraction({
        customId: 'game_checkin_credentials_modal:hoyolab',
        ltokenV2: 'only-one-field'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(partial, setup.context);
    assert.match(JSON.stringify(partial.calls.at(-1)[1]), /必須同時填寫/);
    assert.equal(setup.validations.length, 1);

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
    const interaction = createInteraction({
        customId: 'game_checkin_credentials_modal:hoyolab', ltokenV2: 'new-secret', ltuidV2: '123'
    });
    await setup.command.modalSubmitHandlers.game_checkin_credentials_modal(interaction, setup.context);
    assert.equal((await setup.repository.readUser(interaction.user.id)).credentials.hoyolab.value, 'old-secret');
    const reply = JSON.stringify(interaction.calls.at(-1)[1]);
    assert.match(reply, /Cookie 已失效/);
    assert.doesNotMatch(reply, /new-secret|old-secret/);
});

test('通知依 all → failures → off → all 循環，啟用測試失敗仍保留設定', async t => {
    const setup = createCommandFixture(t);
    const toOff = createInteraction();
    await setup.command.buttonHandlers.game_checkin_notifications(toOff, setup.context);
    assert.equal((await setup.repository.readUser(toOff.user.id)).notificationMode, 'off');
    assert.equal(toOff.calls.some(call => call[0] === 'dm'), false);

    const error = new Error('Cannot send messages to this user');
    error.code = 50007;
    const toAll = createInteraction({ dmError: error });
    await setup.command.buttonHandlers.game_checkin_notifications(toAll, setup.context);
    assert.equal((await setup.repository.readUser(toAll.user.id)).notificationMode, 'all');
    assert.equal(toAll.calls.some(call => call[0] === 'dm'), true);
    assert.match(JSON.stringify(toAll.calls.at(-1)[1]), /Content & Social/);

    const toFailures = createInteraction();
    await setup.command.buttonHandlers.game_checkin_notifications(toFailures, setup.context);
    assert.equal((await setup.repository.readUser(toFailures.user.id)).notificationMode, 'failures');
});

test('時區工具以 UTC epoch 套用偏移，能跨月與換日', () => {
    assert.equal(dateKeyAt(Date.parse('2026-07-20T16:30:00Z'), 8), '2026-07-21');
    assert.equal(dateKeyAt(Date.parse('2026-07-21T04:00:00Z'), -5), '2026-07-20');
    assert.equal(scheduledEpoch('2026-07-21', '10:00', 8), Date.parse('2026-07-21T02:00:00Z'));
    assert.equal(nextDateKey('2026-12-31'), '2027-01-01');
    assert.equal(isPermanentDiscordDmError({ code: 50007 }), true);
    assert.equal(isPermanentDiscordDmError({ code: '10013' }), true);
    assert.equal(isPermanentDiscordDmError({ code: 500 }), false);
});

test('deadline coordinator 使用 config.yml 共用時區補跑兩平台、彙總 DM 並排到下一日', async () => {
    const utc8Config = { ...config, log: { ...config.log, timezone: 8 } };
    let now = Date.parse('2026-07-21T02:00:00Z');
    const completed = [];
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
            return { id: platform, userID, platform, date, generation: 1, credentialRevision: 1, credential: `${platform}-secret` };
        },
        async completePlatform(reservation, result) { completed.push([reservation.platform, result]); },
        async finalizeReady() {},
        async listDueOutbox() { return completed.length === 2 && !delivered ? [outbox] : []; },
        async prepareOutboxDelivery() { return outbox; },
        async markOutboxDelivered() { delivered = true; },
        async markOutboxFailed() {},
        async earliestPending() { return null; },
        async earliestOutbox() { return null; }
    };
    const sent = [];
    let descriptor;
    const rescheduled = [];
    const coordinator = createGameCheckInDeadlineCoordinator(utc8Config, {
        now: () => now,
        repositoryFactory: () => repository,
        adapters: { run: {
            hoyolab: async value => ({ platform: 'hoyolab', retryable: false, outcomes: [{ status: 'success', message: value }] }),
            skport: async value => ({ platform: 'skport', retryable: false, outcomes: [{ status: 'success', message: value }] })
        } },
        logTools: { sendLog() {} }
    });
    const stop = await coordinator.start({
        store: { gameCheckIn: {} }, http: {},
        client: { users: { fetch: async () => ({ send: async payload => sent.push(payload) }) } },
        scheduler: {
            scheduleDeadline(value) {
                descriptor = value;
                return { reschedule: value => rescheduled.push(value), async stop() {} };
            }
        }
    });
    assert.equal(descriptor.name, 'gameCheckIn.deadline');
    await descriptor.run({ signal: new AbortController().signal });
    assert.deepEqual(completed.map(item => item[0]), ['hoyolab', 'skport']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].allowedMentions.parse.length, 0);
    assert.equal(delivered, true);
    assert.equal(rescheduled.at(-1), Date.parse('2026-07-22T02:00:00Z'));
    await stop();
});

test('真實 repository 與 coordinator 可在重啟補跑後持久化結果及送出 failure-only DM', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-game-checkin-coordinator-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createStoreRegistry({ dataRoot: root });
    const currentTime = Date.parse('2026-07-21T10:05:00Z');
    const repository = createGameCheckInRepository(store.gameCheckIn, { now: () => currentTime });
    await repository.setCredential('123456789012345678', 'hoyolab', 'private-cookie');

    let descriptor;
    const sent = [];
    const coordinator = createGameCheckInDeadlineCoordinator(config, {
        now: () => currentTime,
        adapters: { run: {
            hoyolab: async (credential, { signal }) => {
                assert.equal(credential, 'private-cookie');
                assert.equal(signal.aborted, false);
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

test('結果 Embed 截斷過長內容，並行 helper 不超過指定工作數', async () => {
    const embed = resultEmbed(config, {
        date: '2026-07-21',
        result: { outcomes: Array.from({ length: 100 }, (_, index) => ({
            game: `遊戲${index}`, account: '角色', status: index === 0 ? 'failure' : 'success', message: 'x'.repeat(80)
        })) }
    });
    assert.equal(embed.data.color, config.embed.color.error);
    assert.ok(embed.data.description.length <= 3910);

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
