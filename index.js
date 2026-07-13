global.crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, REST, Routes, Collection } = require('discord.js');
const { config } = require(path.join(process.cwd(), 'core/config'));
const { applyAdminCommandPolicy, createAdminCommand, isAdminCommandPath } = require(path.join(process.cwd(), 'core/commandPolicy'));
const { sendLog } = require(path.join(process.cwd(), 'core/sendLog'));
const { errorReply } = require(path.join(process.cwd(), 'core/Reply'));
const { getHitokoto } = require(path.join(process.cwd(), 'util/getHitokoto'));

// Discord bot 設定
const TOKEN = config.Startup.token; // 讀取機器人 TOKEN
const CLIENT_ID = config.Startup.clientID; //應用程式ID
const READY_TYPE = config.Startup.activityType; // 讀取活動狀態類型
const STATUS_TYPE = config.Startup.StatusType; // 讀取線上狀態類型

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

// 載入模組
function loadModules(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            loadModules(fullPath);
        } else if (file.isFile() && file.name.endsWith('.js')) {
            const module = require(path.resolve(fullPath));
            module(client); // 將 client 傳遞給模組
            sendLog(client, `✅ 已載入模組：${file.name}`);
        }
    }
}

loadModules('./src/modules');

// 載入指令
client.commands = new Collection();
client.modalSubmitHandlers = {};
const commands = [];
const COMMANDS_ROOT = path.resolve('./src/commands');
const adminCommands = [];

function registerCommand(command, fileName) {
    client.commands.set(command.data.name, command);
    commands.push(command.data.toJSON());
    sendLog(client, `✅ 已載入指令：${fileName}`);

    if (command.modalSubmitHandlers) {
        Object.assign(client.modalSubmitHandlers, command.modalSubmitHandlers);
    }
}

function loadCommands(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
            loadCommands(fullPath);
        } else if (file.isFile() && file.name.endsWith('.js')) {
            const command = require(path.resolve(fullPath));
            if (isAdminCommandPath(fullPath, COMMANDS_ROOT)) {
                adminCommands.push(applyAdminCommandPolicy(command));
                sendLog(client, `✅ 已載入管理指令模組：${file.name}`);
            } else {
                registerCommand(command, file.name);
            }
        }
    }
}

loadCommands('./src/commands');
const adminCommand = createAdminCommand(adminCommands);
if (adminCommand) registerCommand(adminCommand, 'admin/');

function getInteractionHandler(handlers, customId) {
    if (!handlers) return null;
    // 支援 package_panel_xxx:payload 這類帶參數的元件 ID，讓同一個 handler 可處理指定包裹的按鈕。
    return handlers[customId] || handlers[customId.split(':')[0]] || null;
}

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
            const handler = getInteractionHandler(client.modalSubmitHandlers, interaction.customId);
            if (handler) {
                await handler(interaction);
            }
        }
        // 處理按鈕點擊
        else if (interaction.isButton()) {
            let handler = null;
            const command = client.commands.find(cmd => {
                handler = getInteractionHandler(cmd.buttonHandlers, interaction.customId);
                return handler;
            });
            if (command && handler) {
                await handler(interaction);
            }
        }
        // 處理選單選擇
        else if (interaction.isStringSelectMenu()) {
            let handler = null;
            const command = client.commands.find(cmd => {
                handler = getInteractionHandler(cmd.componentHandlers, interaction.customId);
                return handler;
            });
            if (command && handler) {
                await handler(interaction);
            }
        }
    } catch (error) {
        console.error(error);
        await errorReply(interaction, error, { context: '執行 Discord 指令' });
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
        client.user.setStatus(STATUS_TYPE);
        sendLog(client, `✅ 已設定活動狀態：${STATUS_TYPE} ${READY_TYPE} ${hitokotoText}`);
    } catch (error) {
        sendLog(client, "❌ 無法獲取 Hitokoto API 資料：", "ERROR", error);
    }
});

client.login(TOKEN);
