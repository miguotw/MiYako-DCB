const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags } = require('discord.js');
const { createStatusEmbed, errorReply, infoReply, validationReply } = require('../core/Reply');

function createInteraction(state = {}) {
    const calls = [];
    const interaction = { deferred: false, replied: false, ...state };
    for (const method of ['reply', 'editReply', 'update', 'followUp']) {
        interaction[method] = async payload => {
            calls.push({ method, payload });
            return payload;
        };
    }
    return { calls, interaction };
}

test('Reply auto 依生命週期選擇 reply 或 editReply', async () => {
    const fresh = createInteraction();
    await infoReply(fresh.interaction, '成功');
    assert.equal(fresh.calls[0].method, 'reply');

    const deferred = createInteraction({ deferred: true });
    await infoReply(deferred.interaction, '成功');
    assert.equal(deferred.calls[0].method, 'editReply');

    const replied = createInteraction({ replied: true });
    await infoReply(replied.interaction, '成功');
    assert.equal(replied.calls[0].method, 'editReply');
});

test('Reply 支援明確 method、components 與 ephemeral follow-up', async () => {
    for (const method of ['reply', 'editReply', 'update', 'followUp']) {
        const target = createInteraction();
        const components = [{ type: 1 }];
        await infoReply(target.interaction, '成功', {
            method,
            components,
            ephemeral: ['reply', 'followUp'].includes(method)
        });
        assert.equal(target.calls[0].method, method);
        assert.equal(target.calls[0].payload.components, components);
        if (['reply', 'followUp'].includes(method)) {
            assert.equal(target.calls[0].payload.flags, MessageFlags.Ephemeral);
        }
    }
});

test('deferUpdate 後的驗證錯誤可使用私密 follow-up', async () => {
    const target = createInteraction({ deferred: true });
    await validationReply(target.interaction, '沒有權限', { method: 'followUp', ephemeral: true });
    assert.equal(target.calls[0].method, 'followUp');
    assert.equal(target.calls[0].payload.flags, MessageFlags.Ephemeral);
});

test('update/editReply 不允許設定 ephemeral', async () => {
    for (const method of ['update', 'editReply']) {
        const target = createInteraction();
        await assert.rejects(infoReply(target.interaction, '成功', { method, ephemeral: true }), /無法.*可見性/);
    }
});

test('驗證錯誤不含 Issue 資訊，未知錯誤只顯示事件 ID', async () => {
    const validation = createStatusEmbed({ status: 'validation', message: '輸入錯誤' }).toJSON();
    assert.doesNotMatch(validation.description, /Issue|GitHub|repository/i);

    const originalConsoleLog = console.log;
    console.log = () => {};
    try {
        const target = createInteraction();
        await errorReply(target.interaction, new Error('secret internal detail'), { context: '測試' });
        const description = target.calls[0].payload.embeds[0].data.description;
        assert.doesNotMatch(description, /secret internal detail/);
        assert.match(description, /事件 ID：`[0-9a-f-]{36}`/);
    } finally {
        console.log = originalConsoleLog;
    }
});

test('Discord 回覆失敗會向呼叫端拋出', async () => {
    const originalConsoleLog = console.log;
    console.log = () => {};
    try {
        const interaction = { deferred: false, replied: false, reply: async () => { throw new Error('send failed'); } };
        await assert.rejects(infoReply(interaction, '成功'), /send failed/);
    } finally {
        console.log = originalConsoleLog;
    }
});
