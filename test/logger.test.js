const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig } = require('../core/config');
const { createLogTools } = require('../core/sendLog');
const config = loadConfig();
const { sanitizeLogText, sendLog } = createLogTools(config);

test('Logger 清理 code fence、控制字元、Token 與呼叫端敏感值', () => {
    const token = 'abcdefghijklmnopqrstuvwx.abcdef.abcdefghijklmnopqrstuvwxyz';
    const output = sanitizeLogText(`before\u0000\`\`\` @everyone ${token} TRACK-123 IP-ADDR`, ['TRACK-123', 'IP-ADDR']);
    assert.doesNotMatch(output, /\u0000|```|TRACK-123|IP-ADDR|abcdefghijklmnopqrstuvwx/);
    assert.match(output, /@everyone/);
    assert.match(output, /\[已遮罩\]/);
});

test('Logger 遮罩 Authorization、access token 與 URL token 參數', () => {
    const encryptionKey = config.commands.gameCheckIn.credentialEncryptionKey;
    const output = sanitizeLogText(`Authorization: Bearer abcdef access_token="secret-value" https://x.test?a=1&token=url-secret ${encryptionKey}`);
    assert.doesNotMatch(output, new RegExp(`abcdef|secret-value|url-secret|${encryptionKey}`));
});

test('Discord Logger 固定停用 mentions', async () => {
    let payload;
    const client = {
        isReady: () => true,
        channels: { cache: { get: () => ({ send: async value => { payload = value; } }) } }
    };
    const originalConsoleLog = console.log;
    console.log = () => {};
    try {
        await sendLog(client, '``` @everyone <@&12345678901234567>');
    } finally {
        console.log = originalConsoleLog;
    }
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.match(payload.content, /ˋˋˋ @everyone/);
});
