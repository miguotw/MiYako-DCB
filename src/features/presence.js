const { GatewayIntentBits } = require('discord.js');
const { getHitokoto } = require('../../util/getHitokoto');
const { createLogTools } = require('../../core/sendLog');
function createManifest(config) {
    const { sendLog } = createLogTools(config);
    return {
        name: 'presence', enabled: true, intents: [GatewayIntentBits.Guilds], commands: [], interactions: [],
        async start(context) {
            try {
                const { hitokotoText } = await getHitokoto({ http: context.http, signal: context.signal });
                context.client.user.setActivity(hitokotoText, { type: config.startup.activityType });
                context.client.user.setStatus(config.startup.statusType);
                sendLog(context.client, `✅ 已設定活動狀態：${config.startup.statusType} ${config.startup.activityType} ${hitokotoText}`);
            } catch (error) {
                sendLog(context.client, '❌ 無法獲取 Hitokoto API 資料：', 'ERROR', error);
            }
        },
        async stop() {}
    };
}
module.exports = { createManifest };
