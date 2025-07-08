global.crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply, infoReply } = require(path.join(process.cwd(), 'core/Reply'));
const { getHitokoto } = require(path.join(process.cwd(), 'util/getHitokoto'));

// Discord bot 設定
const TOKEN = config.Startup.token; // 讀取機器人 TOKEN
const CLIENT_ID = config.Startup.clientID; //應用程式ID
const READY_TYPE = config.Startup.activityType; // 讀取狀態類型

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages
    ]
});
sendLog(client, '✅ 創建 Discord 客戶端成功！');

// 載入指令
client.commands = new Collection();
client.modalSubmitHandlers = {};
const commands = [];

function loadCommands(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            loadCommands(fullPath);
        } else if (file.isFile() && file.name.endsWith('.js')) {
            const command = require(path.resolve(fullPath));
            client.commands.set(command.data.name, command);
            commands.push(command.data.toJSON());
            sendLog(client, `✅ 已載入指令：${file.name}`);

            // 收集 modalSubmitHandlers
            if (command.modalSubmitHandlers) {
                Object.assign(client.modalSubmitHandlers, command.modalSubmitHandlers);
            }
        }
    }
}

loadCommands('./src/commands');

// 註冊指令
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        sendLog(client, '✅ 已註冊完成：Slash Commands');
    } catch (error) {
        sendLog(client, '❌ 註冊指令時發生錯誤：', "ERROR", error);
    }
})();

// 事件：處理指令
client.on('interactionCreate', async interaction => {
    try {
        // 處理 Slash Command
        if (interaction.isCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) return;

            await command.execute(interaction);

        // 處理 Modal 提交
        } else if (interaction.isModalSubmit()) {
            // 根據 customId 分派
            const handler = client.modalSubmitHandlers[interaction.customId];
            if (handler) {
                await handler(interaction);
            }
        }
        // 處理按鈕點擊
        else if (interaction.isButton()) {
            const command = client.commands.find(cmd => 
                cmd.buttonHandlers && cmd.buttonHandlers[interaction.customId]
            );
            if (command) {
                const handler = command.buttonHandlers[interaction.customId];
                await handler(interaction);
            }
        }
    } catch (error) {
        console.error(error);
        errorReply(interaction, '**執行指令時發生錯誤**');
    }
});

// 當機器人啟動時，發送日誌訊息到指定頻道
client.once('ready', async () => {
    sendLog(client, `✅ 機器人已啟動！以「${client.user.tag}」身分登入！在 ${client.guilds.cache.size} 個伺服器提供服務！`);

    try {
        // 獲取短句
        const { hitokotoText } = await getHitokoto();

        // 設定機器人活動狀態
        client.user.setActivity(hitokotoText, { type: READY_TYPE });
        sendLog(client, `✅ 已設定活動狀態：${READY_TYPE} ${hitokotoText}`);
    } catch (error) {
        sendLog(client, "❌ 無法獲取 Hitokoto API 資料：", "ERROR", error);
    }
});

client.login(TOKEN);