'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createInteractionRouter: createRouter } = require('../core/router');
const createInteractionRouter = () => createRouter({ config: loadConfig() });

const noop = async () => {};

function command(name, access = 'public', execute = noop) {
    return {
        name,
        access,
        data: { name, toJSON: () => ({ name }) },
        execute
    };
}

function component(kind, id, match = 'exact', access = 'public', execute = noop) {
    return { kind, id, match, access, execute };
}

function createInteraction({
    kind = 'button',
    customId = 'unused',
    commandName,
    inGuild = true,
    administrator = false
} = {}) {
    const replies = [];
    const interaction = {
        customId,
        commandName,
        deferred: false,
        replied: false,
        inGuild: () => inGuild,
        memberPermissions: {
            has(permission) {
                assert.equal(permission, PermissionFlagsBits.Administrator);
                return administrator;
            }
        },
        isChatInputCommand: () => kind === 'command',
        isCommand: () => false,
        isButton: () => kind === 'button',
        isModalSubmit: () => kind === 'modal',
        isAnySelectMenu: () => kind === 'select',
        isStringSelectMenu: () => false,
        async reply(payload) {
            replies.push(payload);
            return payload;
        }
    };
    return { interaction, replies };
}

function assertEphemeralValidation(replies, messagePattern) {
    assert.equal(replies.length, 1);
    assert.equal(replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(replies[0].embeds.length, 1);
    assert.match(replies[0].embeds[0].data.description, messagePattern);
}

test('Router 拒絕重複 Slash Command 名稱', () => {
    const router = createInteractionRouter();
    router.registerCommand(command('重複'));

    assert.throws(
        () => router.registerCommand(command('重複', 'admin')),
        /Slash Command 名稱重複：重複/
    );
});

test('Router 拒絕同 kind 的重複 exact 與 prefix 路由', () => {
    const exactRouter = createInteractionRouter();
    exactRouter.registerInteraction(component('button', 'refresh'));
    assert.throws(
        () => exactRouter.registerInteraction(component('button', 'refresh')),
        /Interaction 路由重複/
    );

    const prefixRouter = createInteractionRouter();
    prefixRouter.registerInteraction(component('modal', 'record', 'prefix'));
    assert.throws(
        () => prefixRouter.registerInteraction(component('modal', 'record', 'prefix')),
        /Interaction prefix 路由重複/
    );
});

test('Router 不受註冊順序影響，雙向拒絕 exact/prefix namespace 覆蓋', () => {
    const exactFirst = createInteractionRouter();
    exactFirst.registerInteraction(component('select', 'queue:remove'));
    assert.throws(
        () => exactFirst.registerInteraction(component('select', 'queue', 'prefix')),
        /exact\/prefix namespace 衝突/
    );

    const prefixFirst = createInteractionRouter();
    prefixFirst.registerInteraction(component('select', 'queue', 'prefix'));
    assert.throws(
        () => prefixFirst.registerInteraction(component('select', 'queue:remove')),
        /exact\/prefix namespace 衝突/
    );
});

test('Router 拒絕 admin/public 路由衝突，但不同 interaction kind 可共用 ID', () => {
    const exactRouter = createInteractionRouter();
    exactRouter.registerInteraction(component('button', 'guarded', 'exact', 'public'));
    assert.throws(
        () => exactRouter.registerInteraction(component('button', 'guarded', 'exact', 'admin')),
        /Interaction 路由重複/
    );

    const prefixRouter = createInteractionRouter();
    prefixRouter.registerInteraction(component('modal', 'guarded', 'prefix', 'admin'));
    assert.throws(
        () => prefixRouter.registerInteraction(component('modal', 'guarded', 'prefix', 'public')),
        /Interaction prefix 路由重複/
    );

    const crossKindRouter = createInteractionRouter();
    assert.doesNotThrow(() => {
        crossKindRouter.registerInteraction(component('button', 'shared'));
        crossKindRouter.registerInteraction(component('modal', 'shared'));
        crossKindRouter.registerInteraction(component('select', 'shared'));
    });
});

test('Router 正確分派 Slash、exact 與帶非空 payload 的 prefix 路由', async () => {
    const calls = [];
    const context = { marker: 'runtime context' };
    const router = createInteractionRouter();
    router.registerCommand(command('測試', 'public', async (interaction, receivedContext) => {
        calls.push(['command', interaction.commandName, receivedContext]);
    }));
    router.registerInteraction(component('button', 'fixed', 'exact', 'public', async (interaction, receivedContext) => {
        calls.push(['exact', interaction.customId, receivedContext]);
    }));
    router.registerInteraction(component('button', 'page', 'prefix', 'public', async (interaction, receivedContext) => {
        calls.push(['prefix', interaction.customId, receivedContext]);
    }));

    const slash = createInteraction({ kind: 'command', commandName: '測試' });
    const exact = createInteraction({ customId: 'fixed' });
    const prefix = createInteraction({ customId: 'page:2' });
    assert.equal(await router.dispatch(slash.interaction, context), true);
    assert.equal(await router.dispatch(exact.interaction, context), true);
    assert.equal(await router.dispatch(prefix.interaction, context), true);
    assert.deepEqual(calls, [
        ['command', '測試', context],
        ['exact', 'fixed', context],
        ['prefix', 'page:2', context]
    ]);

    for (const customId of ['page', 'page:']) {
        const invalidPrefix = createInteraction({ customId });
        assert.equal(await router.dispatch(invalidPrefix.interaction, context), undefined);
        assertEphemeralValidation(invalidPrefix.replies, /操作已過期或目前無法使用/);
    }
});

test('未知與關機期間的互動會立即回覆 ephemeral validation Embed', async () => {
    const router = createInteractionRouter();
    const unknown = createInteraction({ kind: 'modal', customId: 'expired' });
    assert.equal(await router.dispatch(unknown.interaction, {}), undefined);
    assertEphemeralValidation(unknown.replies, /操作已過期或目前無法使用/);

    let executed = false;
    router.registerInteraction(component('button', 'known', 'exact', 'public', async () => {
        executed = true;
    }));
    router.close();
    const closing = createInteraction({ customId: 'known' });
    assert.equal(await router.dispatch(closing.interaction, {}), undefined);
    assert.equal(executed, false);
    assertEphemeralValidation(closing.replies, /服務正在關閉/);
});

test('Router 集中執行 admin gate，無權限與 DM 均無法觸發 handler', async () => {
    let executions = 0;
    const router = createInteractionRouter();
    router.registerInteraction(component('button', 'admin-only', 'exact', 'admin', async () => {
        executions += 1;
    }));

    const member = createInteraction({ customId: 'admin-only', administrator: false });
    assert.equal(await router.dispatch(member.interaction, {}), false);
    assert.equal(executions, 0);
    assertEphemeralValidation(member.replies, /必須是伺服器管理員/);

    const dm = createInteraction({ customId: 'admin-only', inGuild: false, administrator: true });
    assert.equal(await router.dispatch(dm.interaction, {}), false);
    assert.equal(executions, 0);
    assertEphemeralValidation(dm.replies, /僅能在伺服器中使用/);

    const administrator = createInteraction({ customId: 'admin-only', administrator: true });
    assert.equal(await router.dispatch(administrator.interaction, {}), true);
    assert.equal(executions, 1);
    assert.equal(administrator.replies.length, 0);
});

test('handler 與 Discord 錯誤回覆同時失敗時，dispatch 仍會收斂 rejection', async () => {
    const errors = [];
    const router = createRouter({
        config: loadConfig(),
        logger: { error: (message, error) => errors.push({ message, error }) }
    });
    router.registerInteraction(component('button', 'failure', 'exact', 'public', async () => {
        throw new Error('handler failed');
    }));
    const target = createInteraction({ customId: 'failure' });
    target.interaction.reply = async () => { throw new Error('reply failed'); };
    const originalConsoleLog = console.log;
    console.log = () => {};
    try {
        assert.equal(await router.dispatch(target.interaction, {}), false);
    } finally {
        console.log = originalConsoleLog;
    }
    assert.equal(errors.some(item => /系統錯誤回覆失敗/.test(item.message)), true);
});
