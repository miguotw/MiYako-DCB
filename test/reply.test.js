const assert = require('node:assert/strict');
const test = require('node:test');
const { MessageFlags } = require('discord.js');
const { loadConfig } = require('../core/config');
const { createReplyTools } = require('../core/Reply');
const { commandInputError } = require('../util/discordCommandInput');
const { createStatusEmbed, errorReply, infoReply, validationReply } = createReplyTools(loadConfig());

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

test('系統錯誤顯示遮罩後第一行與事件 ID，不洩漏後續內容', async () => {
    const validation = createStatusEmbed({ status: 'validation', message: '輸入錯誤' }).toJSON();
    assert.doesNotMatch(validation.description, /Issue|GitHub|repository/i);

    const originalConsoleLog = console.log;
    console.log = () => {};
    try {
        const target = createInteraction();
        await errorReply(target.interaction, new Error(`可辨識的第一行 /home/bot/private/config.yml\n後續秘密 ${loadConfig().startup.token}`), { context: '測試' });
        const description = target.calls[0].payload.embeds[0].data.description;
        assert.match(description, /可辨識的第一行/);
        assert.match(description, /路徑已遮罩/);
        assert.doesNotMatch(description, /\/home\/bot/);
        assert.doesNotMatch(description, /後續秘密|Discord Bot Token/);
        assert.match(description, /事件 ID：`[0-9a-f-]{36}`/);
    } finally {
        console.log = originalConsoleLog;
    }
});

test('輸入驗證錯誤經 errorReply 仍使用 validation，且不寫 ERROR 日誌', async () => {
    const target = createInteraction();
    const originalConsoleLog = console.log;
    let logCount = 0;
    console.log = () => { logCount += 1; };
    try {
        await errorReply(target.interaction, commandInputError('白名單僅接受 @用戶。'), { context: '測試' });
    } finally {
        console.log = originalConsoleLog;
    }
    const embed = target.calls[0].payload.embeds[0].data;
    assert.match(embed.title, /無法完成操作/);
    assert.match(embed.description, /白名單僅接受/);
    assert.doesNotMatch(embed.description, /事件 ID/);
    assert.equal(logCount, 0);
});

test('單一系統錯誤只各送一次終端與 Discord 日誌', async () => {
    const logMessages = [];
    const discordLogs = [];
    const originalConsoleLog = console.log;
    console.log = message => { logMessages.push(message); };
    const target = createInteraction({
        client: {
            isReady: () => true,
            channels: { cache: new Map([[loadConfig().log.channel, { send: async payload => { discordLogs.push(payload); } }]]) }
        }
    });
    try {
        await errorReply(target.interaction, new Error('單次錯誤'), { context: '測試' });
        await new Promise(resolve => setImmediate(resolve));
    } finally {
        console.log = originalConsoleLog;
    }
    assert.equal(logMessages.length, 1);
    assert.equal(discordLogs.length, 1);
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
