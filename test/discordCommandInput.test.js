const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchSourceMessage } = require('../util/discordCommandInput');

/** 建立最小化 Interaction，專門驗證來源訊息解析，不依賴 Discord 網路。 */
function createInteraction() {
    const fetched = [];
    const sourceChannel = { messages: { fetch: async id => { fetched.push(['link', id]); return { id }; } } };
    return {
        fetched,
        interaction: {
            guildId: '12345678901234567',
            channel: { messages: { fetch: async id => { fetched.push(['id', id]); return { id }; } } },
            guild: { channels: { fetch: async () => sourceChannel } }
        }
    };
}

test('純訊息 ID 會從目前頻道取得訊息', async () => {
    const { interaction, fetched } = createInteraction();
    const message = await fetchSourceMessage(interaction, '34567890123456789');
    assert.equal(message.id, '34567890123456789');
    assert.deepEqual(fetched, [['id', '34567890123456789']]);
});

test('同伺服器訊息連結會從連結指定的頻道取得訊息', async () => {
    const { interaction, fetched } = createInteraction();
    const message = await fetchSourceMessage(
        interaction,
        'https://discord.com/channels/12345678901234567/23456789012345678/34567890123456789'
    );
    assert.equal(message.id, '34567890123456789');
    assert.deepEqual(fetched, [['link', '34567890123456789']]);
});

test('訊息連結接受 Discord 常見的貼上包裝與尾端參數', async () => {
    const variants = [
        '<https://discord.com/channels/12345678901234567/23456789012345678/34567890123456789>',
        '[查看訊息](https://discord.com/channels/12345678901234567/23456789012345678/34567890123456789)',
        'https://canary.discord.com/channels/12345678901234567/23456789012345678/34567890123456789/?jump=true#message'
    ];
    for (const input of variants) {
        const { interaction } = createInteraction();
        assert.equal((await fetchSourceMessage(interaction, input)).id, '34567890123456789');
    }
});

test('外部網域即使路徑相同也不視為 Discord 訊息連結', async () => {
    const { interaction } = createInteraction();
    await assert.rejects(
        fetchSourceMessage(
            interaction,
            'https://example.com/channels/12345678901234567/23456789012345678/34567890123456789'
        ),
        /有效的 Discord 訊息 ID 或訊息連結/
    );
});

test('拒絕其他伺服器的訊息連結', async () => {
    const { interaction } = createInteraction();
    await assert.rejects(
        fetchSourceMessage(
            interaction,
            'https://discord.com/channels/99999999999999999/23456789012345678/34567890123456789'
        ),
        /必須屬於目前伺服器/
    );
});
